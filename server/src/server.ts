/**
 * Entry point. Elysia serves the live WebSocket fan-out, the auth endpoints, a health check, and a
 * Prometheus /metrics endpoint; the MQTT ingest runs alongside it in the same process (Bun event loop),
 * then publishes into Elysia's native pub/sub rooms.
 *
 *   bun run src/server.ts          # start
 *   bun --watch src/server.ts      # dev (reload on change)
 *
 * Env: PORT (default 3000; public /live + /auth + /sessions), METRICS_PORT (default 9464; loopback
 *      /health + /metrics), PUBLIC_HOST (bind interface — see BIND INTERFACE below), MQTT_URL,
 *      MQTT_USERNAME/MQTT_PASSWORD (broker auth), DB_PATH, LOG_LEVEL,
 *      APP_VERSION, RETENTION_DAYS (see retention.ts / ADR-0010).
 *      Auth (Phase 2 — see docs/frontend/phase-2-auth-contract.md, ADR-0015/0008): AUTH_ACCOUNTS_FILE,
 *      AUTH_SESSION_TTL_SECONDS, AUTH_COOKIE_SECURE, AUTH_ACCOUNTS_RELOAD_SECONDS, ANON_SESSIONS,
 *      MAX_INFLIGHT_LOGINS / AUTH_LOGIN_BURST / AUTH_LOGIN_WINDOW_S (login DoS controls),
 *      ALLOWED_ORIGINS (CSWSH allow-list — STRICT: absent Origin is rejected on /auth + /live),
 *      ALLOW_ANONYMOUS_LIVE (+ ANON_SESSIONS) for an isolated-LAN bypass — LIVE PITCH ONLY, see
 *      sessionGetGate: names and bulk history always require a real login.
 *
 * Observability: structured JSON logs (log.ts), Prometheus metrics (metrics.ts), readiness on /health.
 */

import { Elysia, t } from 'elysia';
import { wsRoom, type Telemetry } from './types';
import { startIngest } from './ingest';
import { metrics, registry, updateRuntimeMetrics, capLabel, seedLabel } from './metrics';
import { envInt, envNumber, envString, envBool, logResolvedConfig } from './env';
import { dbProbe } from './db';
import { startRetention, refreshRetentionGauges } from './retention';
import { log } from './log';
import {
  initAuth,
  attemptLogin,
  logout,
  currentPrincipal,
  authorizedFor,
  sessionsFor,
  principalBody,
  registerLiveSocket,
  setCookieHeader,
  clearCookieHeader,
  validSessionId,
  ANON_MODE,
  ANON_SESSIONS,
  accountSessionIds,
  type Principal,
} from './auth';
import { initRoster, rosterFor, rosterSessionIds } from './roster';
import { initSessionConfig, ageBandFor, thresholdsFor, configuredSessionIds } from './sessionConfig';
import {
  validateHistoryParams,
  readHistory,
  historyGate,
  releaseInflight,
  HistoryParamError,
  type HistoryParams,
} from './history';
import {
  validateEventsParams,
  readEvents,
  eventsGate,
  releaseEventsInflight,
  EventsParamError,
  type EventsParams,
} from './events';

const PORT = envInt('PORT', 3000, { min: 1, max: 65535 });
const METRICS_PORT = envInt('METRICS_PORT', 9464, { min: 1, max: 65535 });
const VERSION = envString('APP_VERSION', 'dev');

// --- BIND INTERFACE (§4.1) ---------------------------------------------------------------------------
// ANON_MODE means "the live feed needs no login". A feed of children's live positions that needs no login
// must not ALSO be reachable from the LAN, so anon mode defaults the bind to LOOPBACK. This is structural
// on purpose: the Origin allow-list is CSWSH defence and carries no authorization weight (an absent Origin
// — what every non-browser client sends — cannot be authenticated), so it must never be the only thing
// standing between a subnet and a child's position.
//
// PUBLIC_HOST overrides it, and a CONTAINER legitimately needs to: inside its own network namespace
// 0.0.0.0 reaches only the compose network, and the real exposure boundary is the Docker port publish
// (docker-compose.yml pins that to 127.0.0.1). The override is deliberately loud — see the boot warning.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const PUBLIC_HOST = envString('PUBLIC_HOST', ANON_MODE ? '127.0.0.1' : '0.0.0.0');
const MAX_BODY_BYTES = 4096; // /auth POST bodies are tiny; reject anything bigger BEFORE parse/hash.

// --- CSWSH / CSRF Origin allow-list (children's live location must never be world-readable) ----------
// ALLOWED_ORIGINS is the browser-Origin allow-list. Phase 2 makes it STRICT for the cookie-authenticated
// surfaces (/auth POST and the /live upgrade): an ABSENT Origin is now REJECTED, not allowed — the old
// lenient "no Origin → ok" branch (for the retired shared-token machine clients) would otherwise let any
// header-omitting curl bypass the CSWSH/CSRF layer. See ADR-0015 + the pre-mortem.
const ALLOWED_ORIGINS = envString('ALLOWED_ORIGINS', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function originOkStrict(origin: string | undefined): boolean {
  return !!origin && ALLOWED_ORIGINS.includes(origin);
}

// LENIENT variant for the GET data endpoints (/roster, /history). A same-origin browser GET via fetch()
// sends NO Origin header (browsers omit it on same-origin GET/HEAD), so the STRICT "absent → reject" rule
// would 403 the real coach UI. Here: absent Origin is allowed (same-origin read), but a PRESENT Origin must
// still be allow-listed — a cross-origin fetch is rejected outright (and is already cookie-less under the
// SameSite=Lax session cookie, so this is defense-in-depth, not the primary control). POST /auth + the WS
// upgrade keep originOkStrict: browsers DO send Origin there, and those paths are state-changing/CSWSH-sensitive.
// (This matches the existing /auth/me + /sessions GETs, which carry no Origin requirement at all.)
function originOkLenient(origin: string | undefined): boolean {
  return !origin || ALLOWED_ORIGINS.includes(origin);
}

// TRUST_PROXY: set to 'true' ONLY when the server sits behind a single trusted reverse proxy (Caddy in
// Profile B) that appends the real client to X-Forwarded-For. The LEFTMOST XFF hop is client-supplied and
// spoofable — trusting it would let an attacker rotate it to dodge the per-IP login rate-limiter — so we
// default to the unspoofable socket peer and only consult XFF (the RIGHTMOST hop, added by the trusted proxy)
// when TRUST_PROXY is explicitly set.
const TRUST_PROXY = envBool('TRUST_PROXY', false);

/** Client IP for the login rate-limiter. Socket peer by default; the rightmost XFF hop iff TRUST_PROXY. */
function clientIp(request: Request, server: { requestIP?: (r: Request) => { address: string } | null } | null): string {
  let sockIp: string | undefined;
  try {
    sockIp = server?.requestIP?.(request)?.address;
  } catch {
    sockIp = undefined;
  }
  if (TRUST_PROXY) {
    const xff = request.headers.get('x-forwarded-for');
    if (xff) {
      const hops = xff.split(',').map((s) => s.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1]; // rightmost = the peer the trusted proxy actually saw
    }
  }
  return sockIp ?? 'unknown';
}

/** Content-type + size guards BEFORE JSON.parse — the login body is untrusted and unauthenticated. */
async function readJsonBody(
  request: Request,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: number; error: string }> {
  const ct = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!ct.includes('application/json')) return { ok: false, status: 415, error: 'unsupported_media_type' };
  const len = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) return { ok: false, status: 413, error: 'too_large' };
  let txt: string;
  try {
    txt = await request.text();
  } catch {
    return { ok: false, status: 400, error: 'bad_body' };
  }
  // Authoritative size check on BYTE length (Content-Length can be absent/forged, and txt.length counts
  // UTF-16 code units — a multibyte body could slip past a code-unit cap).
  if (Buffer.byteLength(txt, 'utf8') > MAX_BODY_BYTES) return { ok: false, status: 413, error: 'too_large' };
  try {
    const parsed = JSON.parse(txt);
    if (!parsed || typeof parsed !== 'object') return { ok: false, status: 400, error: 'bad_json' };
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, status: 400, error: 'bad_json' };
  }
}

// --- shared authz gate for the Phase-3 session-scoped GET data endpoints (/roster, /history) -----------
// THE ORDER MATTERS (ADR-0016 §1.2, pre-mortem authz-reuse fix): Origin → currentPrincipal → validSessionId
// → authorizedFor — currentPrincipal BEFORE validSessionId so an UNAUTHENTICATED caller always gets 401
// regardless of the :id shape (no 400-vs-401 oracle for whether a session id is well-formed). Matches the
// existing /auth/me + /sessions GET handlers. `username` rides the reject so the audit log can name the
// principal on a 403 (authed-but-wrong-session) — null where we don't yet have one (origin / 401).
type GateOk = { ok: true; principal: Principal };
type GateReject = { ok: false; status: number; result: string; username: string | null };
/**
 * @param allowAnonymous  opt THIS endpoint out of the anon-scope rule below. Default `false` (deny) so a
 *                        new session-scoped endpoint is closed to the anon principal unless someone
 *                        deliberately decides it carries nothing worth a login.
 */
function sessionGetGate(request: Request, id: string, allowAnonymous = false): GateOk | GateReject {
  const origin = request.headers.get('origin') ?? undefined;
  // Lenient: a same-origin browser GET omits Origin (allowed); a present cross-origin Origin must match.
  if (!originOkLenient(origin)) return { ok: false, status: 403, result: 'forbidden_origin', username: null };
  const p = currentPrincipal(request.headers.get('cookie') ?? undefined);
  if (!p) return { ok: false, status: 401, result: 'unauthorized', username: null };
  // ANON SCOPE (Phase 2 §4.1): ALLOW_ANONYMOUS_LIVE exists so the LIVE PITCH VIEW needs no login on an
  // isolated LAN — which is not a reason to hand out child NAMES (/roster) or a bulk raw location export
  // (/history), nor the review series built from them (/events). Those need a real, named account, so an
  // access to them is always attributable to a person in the audit log. 403, not 401: the anon caller IS
  // authenticated, just not permitted — and a 401 would look like an expired cookie to a client that has
  // none. Runs BEFORE validSessionId, like the 401 above, so the reject leaks no session-id oracle.
  if (p.anonymous && !allowAnonymous) {
    return { ok: false, status: 403, result: 'login_required', username: null };
  }
  if (!validSessionId(id)) return { ok: false, status: 400, result: 'bad_session', username: p.username };
  if (!authorizedFor(p, id)) return { ok: false, status: 403, result: 'forbidden', username: p.username };
  return { ok: true, principal: p };
}

// Per-principal token bucket for the name-bearing /roster reads (bulk-export bound; ADR-0016 §1.2). Mirrors
// auth.ts's ipBuckets. Keyed on the principal (username, or 'anon') so one coach can never starve another.
// The map is naturally bounded by the (tiny) account count + the single 'anon' key, so it needs no sweep.
const ROSTER_RATE_BURST = envNumber('ROSTER_RATE_BURST', 20, { min: 1 });
const ROSTER_RATE_PER_MIN = envNumber('ROSTER_RATE_PER_MIN', 30, { min: 1 });
const rosterBuckets = new Map<string, { tokens: number; last: number }>();
function rosterRateOk(key: string): boolean {
  const now = Date.now();
  let b = rosterBuckets.get(key);
  if (!b) {
    b = { tokens: ROSTER_RATE_BURST, last: now };
    rosterBuckets.set(key, b);
  }
  b.tokens = Math.min(ROSTER_RATE_BURST, b.tokens + ((now - b.last) / 60_000) * ROSTER_RATE_PER_MIN);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// Audit S-4: /health used to latch `mqtt:true` once and never reset — broker down, /health still green while
// ft_mqtt_connected read 0. Now it follows the client's connect/close events, and it probes the DB too.
let mqttReady = false;
const startedAt = Date.now();
// The probe (db.ts dbProbe) touches the telemetry table AND folds in the last insert outcome — a plain
// SELECT 1 runs entirely in SQLite's VM and stayed green with the table dropped (checker finding). Honest
// limit: an idle server with an intact file reads true; what it catches is a dropped/corrupt table, a closed
// handle, and a store failing its writes (full disk, unlinked file).

// One admit-record per accepted /live socket. Set ONLY when a socket passes every check, so close() can
// (a) decrement ft_ws_clients exactly once and only for admitted sockets, and (b) unregister it from the
// revocation registry. Rejected sockets get no record, so their close() is a no-op (no gauge drift).
//
// KEY ON ws.data, NOT ws: Elysia constructs a FRESH ElysiaWS wrapper for each callback, so the `ws` object
// in close() is a different instance than the one in open() (a WeakMap keyed on it would always miss, leaking
// the gauge + registry). `ws.data` is the stable per-connection data object — identical across open/close.
interface Admit {
  sessionId: string;
  unregister?: () => void;
}
const admitted = new WeakMap<object, Admit>();

export function createApp() {
  return (
    new Elysia()
      // --- auth: named login → HttpOnly cookie; principal-bound; kills the bundled token (ADR-0015) ---
      .post('/auth/login', async ({ request, set, server }) => {
        const origin = request.headers.get('origin') ?? undefined;
        if (!originOkStrict(origin)) {
          set.status = 403;
          return { error: 'forbidden_origin' };
        }
        const parsed = await readJsonBody(request);
        if (!parsed.ok) {
          set.status = parsed.status;
          return { error: parsed.error };
        }
        const r = await attemptLogin(parsed.body.username, parsed.body.password, clientIp(request, server));
        if (!r.ok || !r.principal || !r.token) {
          set.status = r.status;
          return { error: r.error ?? 'invalid_credentials' };
        }
        set.headers['set-cookie'] = setCookieHeader(r.token);
        return principalBody(r.principal);
      })
      .post('/auth/logout', ({ request, set }) => {
        const origin = request.headers.get('origin') ?? undefined;
        if (!originOkStrict(origin)) {
          set.status = 403;
          return { error: 'forbidden_origin' };
        }
        const r = logout(request.headers.get('cookie') ?? undefined, request.headers.get('x-csrf-token') ?? undefined);
        if (!r.ok) {
          set.status = r.status;
          return r.error ? { error: r.error } : { error: 'unauthorized' };
        }
        set.headers['set-cookie'] = clearCookieHeader();
        set.status = 204;
        return '';
      })
      .get('/auth/me', ({ request, set }) => {
        const p = currentPrincipal(request.headers.get('cookie') ?? undefined);
        if (!p) {
          set.status = 401;
          return { authenticated: false };
        }
        return { authenticated: true, ...principalBody(p) };
      })
      .get('/sessions', ({ request, set }) => {
        const p = currentPrincipal(request.headers.get('cookie') ?? undefined);
        if (!p) {
          set.status = 401;
          return { authenticated: false };
        }
        return sessionsFor(p);
      })
      // --- roster: playerId → displayName for ONE session (ADR-0016). Identified data; gated by auth+origin+
      // session-scope+rate-limit+no-store; names NEVER logged (counts only) and NEVER cached beyond client memory.
      .get('/sessions/:id/roster', ({ request, set, params, server }) => {
        set.headers['cache-control'] = 'no-store'; // names must not survive in the browser disk cache past logout
        const g = sessionGetGate(request, params.id);
        if (!g.ok) {
          metrics.rosterRequests.inc({ result: g.result });
          log.warn('roster rejected', { reason: g.result, session: params.id, username: g.username });
          set.status = g.status;
          return g.status === 401 ? { authenticated: false } : { error: g.result };
        }
        // Per-principal bucket; the shared anon principal (username null) keys by IP so one LAN tablet
        // can't drain the bucket for the others (anon mode is the multi-tablet isolated-LAN posture).
        const key = g.principal.username ?? clientIp(request, server);
        if (!rosterRateOk(key)) {
          metrics.rosterRequests.inc({ result: 'rate_limited' });
          log.warn('roster rejected', { reason: 'rate_limited', session: params.id, username: g.principal.username });
          set.status = 429;
          return { error: 'rate_limited' };
        }
        const roster = rosterFor(params.id);
        metrics.rosterRequests.inc({ result: 'ok' });
        // Audit the read: who, which session, HOW MANY names — never a displayName value (§0.1).
        log.info('roster read', { username: g.principal.username, session: params.id, playerCount: roster.length });
        return { sessionId: params.id, roster };
      })
      // --- session config: the age band → youth speed-zone thresholds (Phase 4, ADR-0019). The band is NOT a
      // name/location, so no rate-limit / no-store is needed; it is still session-scoped + authed for uniformity
      // and so live zone colour matches what the server uses for the review breakdown. ----
      // allowAnonymous: THE ONE session-scoped read the anon principal keeps. It carries a single enum (the
      // age band) and its thresholds — no name, no position, nothing per-child — and the LIVE pitch needs it
      // to colour speed zones, which is exactly what anon mode is for. Denying it would leave the anon live
      // view silently mis-colouring speeds against the U14 client-side fallback.
      .get('/sessions/:id/config', ({ request, set, params }) => {
        const g = sessionGetGate(request, params.id, true);
        if (!g.ok) {
          metrics.configRequests.inc({ result: g.result });
          log.warn('config rejected', { reason: g.result, session: params.id, username: g.username });
          set.status = g.status;
          return g.status === 401 ? { authenticated: false } : { error: g.result };
        }
        const ageBand = ageBandFor(params.id); // configured band or the U14 default (zones always resolve)
        metrics.configRequests.inc({ result: 'ok' });
        return { sessionId: params.id, ageBand, thresholds: thresholdsFor(ageBand) };
      })
      // --- history: review/replay source (ADR-0017). Off-the-live-loop paged read; per-principal rate limit +
      // concurrent-scan inflight cap (DoS bounds on a raw children's-location export); audit log; no-store.
      .get('/sessions/:id/history', async ({ request, set, params, query, server }) => {
        set.headers['cache-control'] = 'no-store';
        const g = sessionGetGate(request, params.id);
        if (!g.ok) {
          metrics.historyRequests.inc({ result: g.result });
          log.warn('history rejected', { reason: g.result, session: params.id, username: g.username });
          set.status = g.status;
          return g.status === 401 ? { authenticated: false } : { error: g.result };
        }
        // Per-principal gate; anon (username null) keys by IP so one LAN tablet can't starve the others.
        const gate = historyGate(g.principal.username ?? clientIp(request, server)); // rate-limit BEFORE the inflight slot
        if (!gate.ok) {
          metrics.historyRequests.inc({ result: gate.result });
          log.warn('history rejected', { reason: gate.result, session: params.id, username: g.principal.username });
          set.status = gate.result === 'busy' ? 503 : 429;
          return { error: gate.result };
        }
        try {
          let p: HistoryParams;
          try {
            p = validateHistoryParams({
              sessionId: params.id,
              from: query.from,
              to: query.to,
              mode: query.mode,
              player: query.player,
              cursor_ts: query.cursor_ts,
              cursor_rowid: query.cursor_rowid,
              limit: query.limit,
            });
          } catch (e) {
            // OPAQUE 400: the reason is for the server log only — NEVER echo a query value (a misconfigured
            // client could pass a name as ?player=, and reflecting it would leak it).
            const reason = e instanceof HistoryParamError ? e.reason : 'bad_params';
            metrics.historyRequests.inc({ result: 'bad_params' });
            log.warn('history rejected', { reason, session: params.id, username: g.principal.username });
            set.status = 400;
            return { error: 'bad_params' };
          }
          const result = await readHistory(p); // paged + yields between chunks — off the live loop
          metrics.historyRequests.inc({ result: 'ok' });
          // Audit: scannedRows is the bulk-export volume signal; playerId is pseudonymous (OK per §0.1).
          log.info('history read', {
            username: g.principal.username,
            session: params.id,
            mode: p.mode,
            from: p.from,
            to: p.to,
            scannedRows: result.scannedRows,
            ...(p.mode === 'raw' ? { playerId: p.player } : {}),
          });
          return result;
        } catch (err) {
          metrics.historyRequests.inc({ result: 'internal' });
          log.error('history failed', { session: params.id, err: String(err) }); // never the raw player value
          set.status = 500;
          return { error: 'internal' };
        } finally {
          releaseInflight(); // always free the slot we took on gate.ok
        }
      })
      // --- tactical events: review-only movement-derived phases (ADR-0020). Same off-loop posture as /history
      // (sessionGetGate + per-principal rate + the SHARED inflight slot + audit + no-store + opaque errors).
      // Team-AGGREGATE result — no playerId/name ever. Detection is heuristic, never ground truth (§0.5).
      .get('/sessions/:id/events', async ({ request, set, params, query, server }) => {
        set.headers['cache-control'] = 'no-store';
        const g = sessionGetGate(request, params.id);
        if (!g.ok) {
          metrics.eventsRequests.inc({ result: g.result });
          log.warn('events rejected', { reason: g.result, session: params.id, username: g.username });
          set.status = g.status;
          return g.status === 401 ? { authenticated: false } : { error: g.result };
        }
        const gate = eventsGate(g.principal.username ?? clientIp(request, server)); // rate-limit BEFORE the inflight slot
        if (!gate.ok) {
          metrics.eventsRequests.inc({ result: gate.result });
          log.warn('events rejected', { reason: gate.result, session: params.id, username: g.principal.username });
          set.status = gate.result === 'busy' ? 503 : 429;
          return { error: gate.result };
        }
        try {
          let p: EventsParams;
          try {
            p = validateEventsParams({ sessionId: params.id, from: query.from, to: query.to });
          } catch (e) {
            const reason = e instanceof EventsParamError ? e.reason : 'bad_params';
            metrics.eventsRequests.inc({ result: 'bad_params' });
            log.warn('events rejected', { reason, session: params.id, username: g.principal.username });
            set.status = 400;
            return { error: 'bad_params' };
          }
          const result = await readEvents(p); // paged + yields between chunks — off the live loop
          metrics.eventsRequests.inc({ result: 'ok' });
          // PM-N3: audit {username, session, from, to, scannedRows} ONLY — no player dimension on this surface.
          log.info('events read', {
            username: g.principal.username,
            session: params.id,
            from: p.from,
            to: p.to,
            scannedRows: result.scannedRows,
          });
          return result;
        } catch (err) {
          metrics.eventsRequests.inc({ result: 'internal' });
          log.error('events failed', { session: params.id, err: String(err) }); // never a raw query value
          set.status = 500;
          return { error: 'internal' };
        } finally {
          releaseEventsInflight(); // always free the shared slot we took on gate.ok
        }
      })
      // --- live fan-out: cookie auto-attached on the same-origin upgrade; principal-bound session authz ---
      .ws('/live', {
        // A coach tablet connects to /live?sessionId=<id>; the session cookie rides the upgrade.
        query: t.Object({
          sessionId: t.Optional(t.String()),
        }),
        open(ws) {
          const headers = (ws.data as { headers?: Record<string, string> }).headers ?? {};
          const origin = headers.origin;
          const { sessionId } = ws.data.query;

          // 1. CSWSH: a browser always sends Origin; require it allow-listed (absent → reject, strict).
          if (!originOkStrict(origin)) {
            metrics.wsRejected.inc({ reason: 'origin' });
            log.warn('ws rejected', { reason: 'origin', origin });
            return ws.close(1008, 'forbidden origin');
          }
          // 2. sessionId must be a well-formed string (bounded charset + length). A duplicate ?sessionId=a&b
          //    coerces to the last value under Elysia 1.4.28 (not an array) and is used identically for authz
          //    and the room key, so there is no desync — see validSessionId in auth.ts.
          if (!validSessionId(sessionId)) {
            metrics.wsRejected.inc({ reason: 'no_session' });
            return ws.close(1008, 'bad session');
          }
          // 3. AuthN: resolve the principal from the cookie (or the anon principal on an isolated LAN).
          const principal = currentPrincipal(headers.cookie);
          if (!principal) {
            metrics.wsRejected.inc({ reason: 'auth' });
            log.warn('ws rejected', { reason: 'auth' });
            return ws.close(1008, 'unauthorized');
          }
          // 4. AuthZ: is THIS principal assigned to THIS session? (never trust sessionId presence alone)
          if (!authorizedFor(principal, sessionId)) {
            metrics.wsRejected.inc({ reason: 'not_authorized_for_session' });
            log.warn('ws rejected', { reason: 'not_authorized_for_session', session: sessionId, username: principal.username });
            return ws.close(1008, 'forbidden session');
          }

          ws.subscribe(wsRoom(sessionId));
          const admit: Admit = { sessionId };
          // Register non-anon sockets so an accounts reload (revocation) can close this feed immediately.
          if (!principal.anonymous && principal.username) {
            admit.unregister = registerLiveSocket(principal.username, sessionId, () => {
              try {
                ws.close(1008, 'forbidden session');
              } catch {
                /* already gone */
              }
            });
          }
          admitted.set(ws.data as object, admit);
          metrics.wsClients.inc({ session: capLabel('session', sessionId) });
          log.info('ws open', { session: sessionId, username: principal.username });
        },
        close(ws) {
          // Decrement/unregister ONLY for sockets we actually admitted (they have an Admit record), so the
          // ft_ws_clients gauge cannot drift on rejected connections. Keyed on the stable ws.data (see above).
          const a = admitted.get(ws.data as object);
          if (!a) return;
          admitted.delete(ws.data as object);
          a.unregister?.();
          metrics.wsClients.dec({ session: capLabel('session', a.sessionId) });
          log.info('ws close', { session: a.sessionId });
        },
        // The coach UI is receive-only; inbound frames are ignored.
        message() {},
      })
  );
}

// /metrics and /health carry per-child presence + version info, so they bind to LOOPBACK on a separate
// port — never the public/relay interface. Prometheus scrapes them locally; Caddy must not proxy them.
function createInternalApp() {
  return new Elysia()
    .get('/health', ({ set }) => {
      const mqtt = mqttReady;
      const dbUp = dbProbe();
      const ok = mqtt && dbUp;
      // 503 when not ok: Playwright's webServer wait (200–403 = available) and a compose healthcheck
      // (`curl -f`) then both mean what they say. Every consumer in this repo parses the body regardless.
      set.status = ok ? 200 : 503;
      return { ok, mqtt, db: dbUp, version: VERSION, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) };
    })
    .get('/metrics', ({ set }) => {
      updateRuntimeMetrics();
      refreshRetentionGauges(); // keep oldest-fix age current between hourly sweeps
      set.headers['content-type'] = 'text/plain; version=0.0.4; charset=utf-8';
      return registry.render();
    });
}

// Auth must be initialised (accounts loaded, dummy hash precomputed, timers started) before we serve.
await initAuth();
// Roster (player names) — load + start the periodic reload BEFORE serving so /sessions/:id/roster has data.
await initRoster();
// Session config (Phase 4) — the per-session age band; load + start its reload before serving.
await initSessionConfig();

const app = createApp().listen({ port: PORT, hostname: PUBLIC_HOST });
const server = app.server;
if (!server) throw new Error('Elysia server failed to start');

createInternalApp().listen({ port: METRICS_PORT, hostname: '127.0.0.1' });

metrics.buildInfo.set({ version: VERSION, runtime: `bun-${Bun.version}` }, 1);

// Make the access-control posture loud — never let a children's-location feed be quietly mis-secured.
// The bind is the one control that cannot be recovered from downstream: once the socket is on a LAN
// interface with anon mode on, every request is already unauthenticated by design.
if (ANON_MODE && !LOOPBACK_HOSTS.has(PUBLIC_HOST)) {
  log.warn(
    `ALLOW_ANONYMOUS_LIVE=true AND the listener is bound to ${PUBLIC_HOST} (not loopback) — the live feed of children's positions is reachable without any login by anything that can route to this port. This is correct ONLY when something else confines it (a container whose published port is pinned to 127.0.0.1, or a trusted reverse proxy). If you did not deliberately arrange that, unset PUBLIC_HOST.`,
  );
}
if (!ANON_MODE && ALLOWED_ORIGINS.length === 0) {
  log.warn(
    'ALLOWED_ORIGINS is empty and anonymous mode is off — cookie-authenticated /live and /auth will reject ALL browser clients (a present Origin is required). Set ALLOWED_ORIGINS to your app origin (prod: https://relay.example; dev: http://localhost:5173).',
  );
}

startIngest({
  publish: (session: string, telemetry: Telemetry) => {
    server.publish(wsRoom(session), JSON.stringify({ event: 'telemetry', data: telemetry }));
    metrics.wsSent.inc({ session: capLabel('session', session) });
  },
  // Phase 3: the minimised device-health envelope rides the SAME session room, so only sockets already
  // authorised for that session (the /live open() gate) ever receive it. No name on the wire.
  publishStatus: (session: string, h) => {
    server.publish(wsRoom(session), JSON.stringify({ event: 'status', data: h }));
    metrics.wsStatusSent.inc({ session: capLabel('session', session) });
  },
  onSubscribed: () => {
    mqttReady = true;
  },
  onDisconnected: () => {
    mqttReady = false;
  },
});

// Seed the metric label slots with every session the CONFIGURATION names (checker finding): admission into
// the capped label set is otherwise first-come, and a device flooding junk session ids before kick-off could
// take the slots — configured sessions must never end up as `_other`. (roster/session-config/accounts load
// just above; ANON_SESSIONS is the bench.)
for (const sid of ANON_SESSIONS) seedLabel('session', sid);
for (const sid of rosterSessionIds()) seedLabel('session', sid);
for (const sid of configuredSessionIds()) seedLabel('session', sid);
for (const sid of accountSessionIds()) seedLabel('session', sid);

// Bound the raw-fix store in time (children's location must not linger). See ADR-0010.
startRetention();

// Audit S-3: print the whole resolved configuration once, where an operator looks — and shout about any env
// value that was rejected in favour of a default (a typo'd cap is otherwise invisible until it matters).
logResolvedConfig();

log.info('http listening', {
  host: PUBLIC_HOST, // logged so "which interface is this on" is answerable from the log alone
  port: PORT,
  metricsPort: METRICS_PORT,
  version: VERSION,
  anonMode: ANON_MODE,
  public: ['/live', '/auth/login', '/auth/logout', '/auth/me', '/sessions'],
  internalLoopback: ['/health', '/metrics'],
});
