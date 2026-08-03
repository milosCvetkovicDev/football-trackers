import { useEffect, useRef, useState } from 'react';
import type { Telemetry, DeviceHealth, LiveDist } from './types';
import type { ConnectionState, LiveTelemetry } from './contracts';
import { liveWsUrl, MAX_TRACKED_PLAYERS, WALK_FLOOR_MPS, PDOP_MAX } from './config';
import { parseLiveFrame } from './ws/validate';

// Earth mean radius (m) for the haversine below. Matches metric-definitions §2.1; over a ~105x68 m pitch
// haversine and the client's planar projector agree to < 1 cm, but the contract (§3.3) pins haversine for the
// live accumulator so the live and server-review distances use the same metric and never disagree.
const EARTH_RADIUS_M = 6_371_000;

// Great-circle distance in metres between two GPS points. Allocation-free (pure scalar math) so it is cheap
// to call on every accepted fix. Computed inline here rather than in geo.ts (integrator-owned, planar-only).
const haversineM = (
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number => {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const sLat = Math.sin(dLat / 2);
  const sLon = Math.sin(dLon / 2);
  const h = sLat * sLat + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * sLon * sLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
};

// Capped exponential backoff with full jitter for network drops. base 1s, x2 per attempt, cap 15s.
// Jitter (random in [0,delay]) avoids a thundering herd of tablets reconnecting in lockstep after a
// relay blip. Policy rejects (1008) never reach this path — they're terminal (see onclose below).
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 15_000;
// After this many consecutive failed network reconnects, settle into a terminal 'error' rather than
// retrying forever — a visibly-stopped state, the opposite of the old silent infinite loop.
const MAX_RETRIES = 8;

// Human-readable detail for each terminal 1008 reason the server emits (ADR-0015 §5). Mapped here so
// the contract's a11y/HUD layers get a sentence, not a wire string. The Phase-2 server emits exactly
// four reasons: 'forbidden origin' | 'bad session' | 'unauthorized' | 'forbidden session'.
const CLOSE_DETAIL: Record<string, string> = {
  unauthorized: 'not signed in — please sign in again',
  'forbidden origin': 'blocked by server origin policy',
  'forbidden session': 'your account is not authorized for this session',
  'bad session': 'misconfigured client — bad session id',
};

/**
 * Subscribes to /live for one session and writes the latest validated fix per player into a Map
 * held in a ref. Deliberately does NOT setState per packet — at 10 players x 10 Hz that would thrash
 * React; the rAF render loop reads the ref each frame. Only the coarse `conn` state drives re-renders.
 *
 * Phase 2 transport (ADR-0015): the socket is opened SAME-ORIGIN via liveWsUrl(); the HttpOnly session
 * cookie rides the upgrade automatically. There is no bundled token and no ?token= query param any more.
 *
 * Security posture: every inbound frame is untrusted (children's location). Frames are validated by
 * parseLiveFrame before they touch any store — telemetry into `store`, device-health into `health`
 * (the latter structurally name-stripped, §0.1) — and BOTH Maps are hard-bounded to
 * MAX_TRACKED_PLAYERS so a flood of junk ids can't grow memory without limit.
 *
 * Connection honesty: a 1008 close (origin / session / auth) is TERMINAL — we do NOT reconnect, which
 * is the explicit fix for the old silent infinite reconnect against a policy failure. The four reasons
 * map to distinct terminal phases so the UI says *why*:
 *   - 'forbidden session' → 'forbidden' (authed but not authorized for THIS session)
 *   - 'unauthorized'      → 'unauthorized' (no/expired cookie) AND fires onUnauthorized so App can
 *                            re-check /auth/me and bounce to <Login> if the cookie truly expired
 *   - 'forbidden origin'  → 'unauthorized' (preserves Phase-1 behaviour: an origin reject is a hard stop)
 *   - 'bad session'       → 'error' (a malformed sessionId is a client misconfig, not an auth issue)
 * NB: a REJECTED socket fires onopen THEN onclose(1008) — the server accepts the 101 upgrade then
 * closes — so onclose is the source of truth; the brief onopen must NOT lock the UI to 'live'.
 * Network drops (1000/1001/1006/etc.) reconnect with capped backoff + jitter, then settle into a
 * terminal 'error' after MAX_RETRIES.
 *
 * @param sessionId   the match session to subscribe to. Falsy → no socket is opened (idle).
 * @param onUnauthorized  invoked on a 1008 'unauthorized' close so App can refresh auth state.
 */
export function useLiveTelemetry(
  sessionId: string,
  onUnauthorized?: () => void,
): LiveTelemetry {
  const store = useRef<Map<string, Telemetry>>(new Map());
  // Latest device-health per playerId from the `.../status` envelope. Bounded + GC'd like `store`, but
  // unlike telemetry it has NO TTL eviction — so it is cleared on every sessionId change (see cleanup)
  // to stop a playerId that collides across sessions from showing session A's battery/backlog.
  const health = useRef<Map<string, DeviceHealth>>(new Map());
  // Per-player LIVE running-distance accumulator (Phase 4, §3.3). Best-effort coaching glance built from the
  // live stream: a reconnect/eviction RESETS a player's running distance — that means "fresh live view", NOT
  // "the player stopped"; the authoritative distance is the server review aggregate. Bounded + GC'd like
  // `store`/`health`, and (like `health`) cleared on every sessionId change (see cleanup) so a playerId that
  // collides across sessions can't carry session A's distance into session B.
  const dist = useRef<Map<string, LiveDist>>(new Map());
  const [conn, setConn] = useState<ConnectionState>({
    phase: 'connecting',
    attempt: 0,
    willRetry: true,
  });

  // Keep onUnauthorized in a ref so a changing callback identity doesn't tear down and reopen the
  // socket — the effect intentionally depends only on sessionId.
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;

  useEffect(() => {
    // No session chosen yet (e.g. admin hasn't typed one) → stay idle; don't open a socket.
    if (!sessionId) {
      setConn({ phase: 'connecting', attempt: 0, willRetry: true });
      return;
    }

    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0; // consecutive reconnect attempts; 0 once live
    let disposed = false;
    // Capture the two stable ref Maps up front so the cleanup clears the SAME objects the effect wrote to
    // (the refs are never reassigned, so this is equivalent — and it satisfies the exhaustive-deps lint
    // that flags reading `.current` in a cleanup closure).
    const liveStore = store.current;
    const liveHealth = health.current;
    const liveDist = dist.current;

    // Bounded write: existing ids update in place; a new id at the cap evicts the player with the
    // oldest serverTs so a hostile/buggy feed can't grow the Map without limit (MAX_TRACKED_PLAYERS).
    const upsert = (t: Telemetry) => {
      const map = store.current;
      if (!map.has(t.playerId) && map.size >= MAX_TRACKED_PLAYERS) {
        let oldestId: string | null = null;
        let oldestTs = Infinity;
        for (const [id, cur] of map) {
          if (cur.serverTs < oldestTs) {
            oldestTs = cur.serverTs;
            oldestId = id;
          }
        }
        if (oldestId !== null) {
          map.delete(oldestId);
          console.warn(
            `useLiveTelemetry: tracked-player cap (${MAX_TRACKED_PLAYERS}) reached; evicted "${oldestId}"`,
          );
        }
      }
      map.set(t.playerId, t);
    };

    // Bounded write for device-health, mirroring `upsert`: existing ids update in place; a new id at
    // the cap evicts the player with the oldest serverTs so a hostile/buggy feed can't grow the Map
    // without limit (MAX_TRACKED_PLAYERS). Health for an unknown player is fine — it can arrive before
    // or after that player's first fix; the render layer joins by playerId, not by store membership.
    const upsertHealth = (h: DeviceHealth) => {
      const map = health.current;
      if (!map.has(h.playerId) && map.size >= MAX_TRACKED_PLAYERS) {
        let oldestId: string | null = null;
        let oldestTs = Infinity;
        for (const [id, cur] of map) {
          if (cur.serverTs < oldestTs) {
            oldestTs = cur.serverTs;
            oldestId = id;
          }
        }
        if (oldestId !== null) {
          map.delete(oldestId);
          console.warn(
            `useLiveTelemetry: tracked-player cap (${MAX_TRACKED_PLAYERS}) reached; evicted health "${oldestId}"`,
          );
        }
      }
      map.set(h.playerId, h);
    };

    // Per-player LIVE running-distance accumulator (§3.3). Called for an ACCEPTED telemetry fix; it adds the
    // haversine metres from the player's last known position to the current one ONLY when the §1 distance gate
    // holds (v >= 0.4 m/s walking floor AND fix >= 2 AND pdop <= 5) — so GNSS jitter while standing still can't
    // manufacture phantom distance — AND the serverTs advanced (so a re-delivered/duplicate fix can't
    // double-count). The gate is IDENTICAL to the server review aggregate's (Telemetry carries fix + pdop), a
    // hard requirement so the live and review distances never disagree. Bounded + GC'd exactly like `store` /
    // `health`: a new id at the cap evicts the player with the oldest lastTs so a hostile/buggy feed can't grow
    // the Map without limit.
    const upsertDist = (t: Telemetry) => {
      const map = dist.current;
      const prev = map.get(t.playerId);
      if (!prev) {
        if (map.size >= MAX_TRACKED_PLAYERS) {
          let oldestId: string | null = null;
          let oldestTs = Infinity;
          for (const [id, cur] of map) {
            if (cur.lastTs < oldestTs) {
              oldestTs = cur.lastTs;
              oldestId = id;
            }
          }
          if (oldestId !== null) {
            map.delete(oldestId);
            console.warn(
              `useLiveTelemetry: tracked-player cap (${MAX_TRACKED_PLAYERS}) reached; evicted dist "${oldestId}"`,
            );
          }
        }
        // First sight of this player on the live stream — seed the accumulator; no segment to add yet.
        map.set(t.playerId, {
          distM: 0,
          firstTs: t.serverTs,
          lastLat: t.lat,
          lastLon: t.lon,
          lastTs: t.serverTs,
        });
        return;
      }
      // Only advance on a strictly newer fix; a stale/duplicate serverTs neither adds distance nor rewinds.
      if (t.serverTs <= prev.lastTs) return;
      // §1 distance gate: walking floor + a real fix + acceptable dilution. Telemetry already carries fix +
      // pdop, so this is the SAME gate the server applies (its fix>=2 is guaranteed at ingest).
      if (t.spd >= WALK_FLOOR_MPS && t.fix >= 2 && t.pdop <= PDOP_MAX) {
        prev.distM += haversineM(prev.lastLat, prev.lastLon, t.lat, t.lon);
      }
      // Always advance the running position/clock — even when the gate rejects the segment — so the next
      // accepted segment is measured from the latest known point, not a stale one.
      prev.lastLat = t.lat;
      prev.lastLon = t.lon;
      prev.lastTs = t.serverTs;
    };

    const connect = () => {
      // attempt: 0 on the first connect, n>0 on the nth reconnect — drives the "reconnecting (try n)" label.
      setConn({ phase: 'connecting', attempt, willRetry: true });
      // Same-origin URL; the HttpOnly session cookie is attached by the browser on the upgrade.
      ws = new WebSocket(liveWsUrl(sessionId));

      ws.onopen = () => {
        if (disposed) return;
        // A rejected socket also fires onopen (server accepts the 101 then closes 1008), so this is
        // optimistic only — onclose is the source of truth and will overwrite it if the upgrade was
        // rejected. A clean open resets the backoff sequence.
        attempt = 0;
        setConn({ phase: 'live', attempt: 0, willRetry: true });
      };

      ws.onmessage = (ev) => {
        if (disposed || typeof ev.data !== 'string') return;
        // Route on the validated envelope kind: telemetry -> store, status -> health, null -> drop.
        const frame = parseLiveFrame(ev.data);
        if (!frame) return; // malformed/hostile/unknown frame -> dropped, never stored
        if (frame.kind === 'telemetry') {
          upsert(frame.data);
          upsertDist(frame.data); // accumulate the per-player live running distance (§3.3, gated)
        } else upsertHealth(frame.data);
      };

      ws.onclose = (ev) => {
        if (disposed) return;
        // 1008 = server policy reject (origin / session / auth). TERMINAL — do NOT reconnect.
        if (ev.code === 1008) {
          const reason = ev.reason;
          const detail = CLOSE_DETAIL[reason] ?? reason ?? 'connection refused by server';
          // Map the four wire reasons to terminal phases (see the doc-comment table above).
          let phase: ConnectionState['phase'];
          if (reason === 'forbidden session') {
            phase = 'forbidden';
          } else if (reason === 'unauthorized') {
            phase = 'unauthorized';
            // Cookie missing/expired/revoked mid-session — let App re-check /auth/me (→ <Login>).
            onUnauthorizedRef.current?.();
          } else if (reason === 'forbidden origin') {
            // Preserve Phase-1 behaviour: an origin reject is a hard, unauthorized-style stop.
            phase = 'unauthorized';
          } else {
            // 'bad session' (and any unknown 1008 reason) → a non-auth terminal failure.
            phase = 'error';
          }
          setConn({ phase, detail, attempt, willRetry: false });
          return;
        }

        // Any other close is a network drop (1000/1001/1006/etc.) — retry with capped backoff + jitter.
        attempt += 1;
        if (attempt > MAX_RETRIES) {
          // Stop the (capped) retries and show a terminal, visibly-stopped failure — never a tight loop.
          setConn({
            phase: 'error',
            detail: `gave up after ${MAX_RETRIES} reconnect attempts`,
            attempt,
            willRetry: false,
          });
          return;
        }
        setConn({ phase: 'disconnected', attempt, willRetry: true });
        const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
        const delay = Math.random() * backoff; // full jitter
        retry = setTimeout(connect, delay);
      };

      // A socket error is followed by a close; route everything through onclose so the retry/terminal
      // logic lives in one place.
      ws.onerror = () => ws?.close();
    };

    connect();

    return () => {
      // Tear down cleanly on unmount / sessionId change: cancel the pending retry, drop handlers so a
      // late close can't fire after disposal, and close the socket.
      disposed = true;
      if (retry) clearTimeout(retry);
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        ws.close();
      }
      // Clear BOTH Maps so the next session starts clean. `store` has DROP_MS as a safety net, but
      // `health` has no TTL — without this clear a playerId that collides across sessions would show
      // session A's battery/backlog the instant one new health frame arrives (§2.3 belt).
      liveStore.clear();
      liveHealth.clear();
      // `dist` likewise has no TTL — clear it on switch so a playerId that collides across sessions can't
      // carry session A's running distance into session B (§3.3). A reconnect therefore restarts each
      // player's live distance from 0 — a documented "fresh live view", not "the player stopped".
      liveDist.clear();
    };
  }, [sessionId]);

  return { store, health, dist, conn };
}
