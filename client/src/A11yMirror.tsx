import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Telemetry, DeviceHealth, LiveDist, ZoneThresholds } from './types';
import type { ConnectionState, ConnectionTone, PlayerFreshness } from './contracts';
import { describeConnection, playerFreshness, deviceHealthLevel } from './contracts';
import { DROP_MS } from './config';
import { speedZone, ZONE_LABEL, ZONE_COLOR, type Zone } from './zones';
import { useReducedMotion } from './hooks/useReducedMotion';
import { makePitchFrame, type PitchFrame } from './pitchFrame';
import { serverNow } from './serverClock';
import type { LatLon } from './geo';

interface Props {
  store: RefObject<Map<string, Telemetry>>;
  /** Per-player device health from the second /live envelope (Phase 3); may be empty / lag the fixes. */
  health: RefObject<Map<string, DeviceHealth>>;
  /** Per-player LIVE running distance (Phase 4, §3.3); best-effort glance, resets on reconnect. */
  dist: RefObject<Map<string, LiveDist>>;
  conn: ConnectionState;
  /** Render-only playerId→displayName join (ADR-0016); empty ⇒ ids-only. Never persisted, never in the store. */
  roster: Map<string, string>;
  /** Session speed-zone thresholds (Phase 4) — fetched config or U14 defaults; classify the Zone column. */
  thresholds: ZoneThresholds;
  /** The pitch's four GPS corners (Phase 5) — the SAME ones the canvas draws with, so "off pitch"
   *  here and the edge-pinned marker there are one decision, not two that can drift apart. */
  corners: LatLon[];
}

/** A lightweight, render-friendly row — decoupled from the full Telemetry the ref holds. */
interface PlayerRow {
  playerId: string;
  freshness: PlayerFreshness;
  spd: number;
  ageMs: number;
  /** Health snapshot sampled with the fix (null until a status frame arrives for this player). */
  health: DeviceHealth | null;
  /** Overall device-health tone from the shared classifier, or null when no health yet. */
  level: ConnectionTone | null;
  /** Phase-4 speed zone (1..5) for the current fix, classified against the session thresholds. */
  zone: Zone;
  /** Phase-4 LIVE running distance in metres (null until the accumulator has seen this player). */
  distM: number | null;
  /** Phase-4 distance per active minute (null when there's no distance / not enough span yet). */
  distPerMin: number | null;
  /** Phase-5: outside the pitch rectangle (beyond the GNSS-noise margin) — the canvas pins these to
   *  its edge instead of clipping them away, and this column says so in words. */
  offPitch: boolean;
}

/** How often we sample the ref into React state — the table is glanceable, not a 10 Hz feed. */
const SAMPLE_MS = 1_000;

// Status shown by SHAPE + WORD, never colour alone, so it reads for colour-blind users and
// is announced verbatim by screen readers. Colour is a redundant extra, not the signal.
const FRESHNESS_GLYPH: Record<PlayerFreshness, string> = {
  fresh: '●',
  stale: '◐',
  lost: '○',
};
const FRESHNESS_COLOR: Record<PlayerFreshness, string> = {
  fresh: '#3ddc84',
  stale: '#ffd23f',
  lost: '#ff5d5d',
};

// Device-health tone → word + colour. The WORD carries the meaning for assistive tech + colour-blind
// users; colour is a redundant extra (a11y), exactly as the freshness column does.
const LEVEL_WORD: Record<ConnectionTone, string> = { ok: 'ok', warn: 'check', bad: 'alert' };
const LEVEL_COLOR: Record<ConnectionTone, string> = { ok: '#3ddc84', warn: '#ffd23f', bad: '#ff5d5d' };

/** Compact, AT-friendly cell text for each health field; "—" when no status frame has arrived yet. */
function battText(h: DeviceHealth | null): string {
  if (!h) return '—';
  return h.battPct >= 0 ? `${h.battPct}%` : `${h.battVolts.toFixed(2)} V`;
}
function gpsText(h: DeviceHealth | null): string {
  if (!h) return '—';
  const fix = h.fix >= 3 ? '3D' : h.fix === 2 ? '2D' : 'no fix';
  return `${fix} · ${h.sats} sats`;
}

/**
 * A non-canvas, accessible mirror of the live scene. The `<canvas>` is opaque to assistive
 * tech and to colour-blind users; this component re-states the same state as semantic DOM:
 *   - a `role="img"` container with a one-line scene summary as its label,
 *   - a polite ARIA live region that announces connection changes (not every tick), and
 *   - a ~1 Hz player table (status by shape+text, speed, last-fix age).
 *
 * It reads the same ref the rAF loop draws from, but on a 1 Hz timer (NOT per frame) so it
 * never adds React churn to the render hot path.
 */
export function A11yMirror({ store, health, dist, conn, roster, thresholds, corners }: Props) {
  const reducedMotion = useReducedMotion();
  const [rows, setRows] = useState<PlayerRow[]>([]);
  // Mirror thresholds into a ref (exactly like PitchCanvas) so the 1 Hz sampler reads the latest band
  // without re-running its effect — keeping the effect deps the stable refs only, as before.
  const thresholdsRef = useRef(thresholds);
  thresholdsRef.current = thresholds;
  // The pitch frame is rebuilt ONLY when the corners change (it solves a homography), and mirrored into
  // a ref so the 1 Hz sampler reads the current one without re-running its effect. Built lazily rather
  // than as `useRef(makePitchFrame(corners))`: a useRef argument is evaluated on EVERY render even
  // though only the first is kept, and this component re-renders once a second.
  const frameRef = useRef<PitchFrame | null>(null);
  const cornersKey = corners.map((c) => `${c.lat},${c.lon}`).join(';');
  const lastCornersKey = useRef('');
  if (frameRef.current === null || lastCornersKey.current !== cornersKey) {
    lastCornersKey.current = cornersKey;
    frameRef.current = makePitchFrame(corners);
  }

  useEffect(() => {
    const sample = () => {
      // serverNow(), not Date.now() — the same clock correction the canvas uses (audit C-1), so the
      // table and the pitch can never disagree about whether a player is fresh.
      const now = serverNow();
      const thr = thresholdsRef.current;
      const next: PlayerRow[] = [];
      for (const t of store.current.values()) {
        const ageMs = now - t.serverTs;
        // Match the canvas: a player older than DROP_MS is no longer tracked, so drop it here too.
        // (Rows are the players currently on the pitch; a health-only frame with no fix is not surfaced,
        // consistent with the canvas — a fix<2 packet is dropped at ingest so it has no telemetry row.)
        if (ageMs > DROP_MS) continue;
        const h = health.current.get(t.playerId) ?? null;
        // Phase-4 live distance glance (best-effort; resets on reconnect — §3.3). dist/min is the running
        // metres over the active minutes since this player's first live fix (firstTs); guarded so a
        // sub-minute span doesn't divide by ~0 and report an absurd rate.
        const d = dist.current.get(t.playerId) ?? null;
        const distM = d ? d.distM : null;
        let distPerMin: number | null = null;
        if (d && d.distM > 0) {
          const minutes = (d.lastTs - d.firstTs) / 60_000;
          distPerMin = minutes > 0 ? d.distM / minutes : null;
        }
        next.push({
          playerId: t.playerId,
          freshness: playerFreshness(ageMs),
          spd: t.spd,
          ageMs,
          health: h,
          level: h ? deviceHealthLevel(h, now) : null,
          // Same classifier the canvas + review breakdown use — live colour and the Zone word agree (§3.1).
          zone: speedZone(t.spd, thr),
          distM,
          distPerMin,
          offPitch: frameRef.current!.isOffPitch(t.lat, t.lon),
        });
      }
      // Stable order so the table doesn't reshuffle on the screen reader between samples.
      next.sort((a, b) => a.playerId.localeCompare(b.playerId));
      setRows(next);
    };

    sample(); // paint once immediately rather than waiting a full second
    const id = setInterval(sample, SAMPLE_MS);
    return () => clearInterval(id);
  }, [store, health, dist]);

  // Derive the connection label from the SAME helper the HUD uses, so the two never disagree.
  const { label: connLabel } = describeConnection(conn, rows.length);
  const sceneLabel = `Live pitch view, ${rows.length} player${
    rows.length === 1 ? '' : 's'
  } tracked, connection: ${connLabel}`;

  // Only push the connection label into the live region when it actually changes — announcing
  // it every 1 Hz sample would spam the screen reader. The label captures phase + player count.
  const [announce, setAnnounce] = useState('');
  const lastConnLabel = useRef<string>('');
  useEffect(() => {
    if (connLabel !== lastConnLabel.current) {
      lastConnLabel.current = connLabel;
      setAnnounce(`Connection: ${connLabel}`);
    }
  }, [connLabel]);

  return (
    <section
      aria-label="Accessible live status"
      style={{
        width: '100%',
        maxWidth: 900,
        color: '#e8e8e8',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        fontSize: 13,
      }}
    >
      {/* Polite, atomic: connection-status changes only. */}
      <div
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          margin: -1,
          padding: 0,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {announce}
      </div>

      <div
        style={{
          border: '1px solid #2a2d33',
          borderRadius: 10,
          background: '#16181d',
          overflow: 'hidden',
        }}
      >
        {/* role="img" is the canvas-equivalent SUMMARY for assistive tech — and it must NOT wrap
            the table: role="img" marks its descendants presentational, which would hide the
            per-player rows from screen readers (the whole point of this mirror). So it sits on the
            header strip only; the table below is a real, AT-readable <table>. */}
        <div
          role="img"
          aria-label={sceneLabel}
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 12,
            padding: '8px 12px',
            borderBottom: '1px solid #2a2d33',
          }}
        >
          <span style={{ fontWeight: 600 }}>Players</span>
          <span style={{ opacity: 0.6, fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>
            {connLabel}
          </span>
        </div>

        {rows.length === 0 ? (
          <p style={{ margin: 0, padding: '12px', opacity: 0.55 }}>No players tracked.</p>
        ) : (
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              // No transitions/animations anywhere; further honoured for reduced-motion users below.
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            <caption style={{ textAlign: 'left', padding: '6px 12px', opacity: 0.55 }}>
              Live player status, updated about once per second.
            </caption>
            <thead>
              {/* Battery..Device stay at columns 4..7 — the Phase-4 Zone/Distance/Dist/min columns are
                  APPENDED after Device so the Phase-3 health-column e2e (which reads cell indices 4..7)
                  is unaffected. */}
              <tr style={{ textAlign: 'left', opacity: 0.7 }}>
                <th style={th}>Player</th>
                <th style={th}>Status</th>
                <th style={{ ...th, textAlign: 'right' }}>Speed (m/s)</th>
                <th style={{ ...th, textAlign: 'right' }}>Last fix (s)</th>
                <th style={{ ...th, textAlign: 'right' }}>Battery</th>
                <th style={{ ...th, textAlign: 'right' }}>Signal (dBm)</th>
                <th style={th}>GPS</th>
                <th style={th}>Device</th>
                <th style={th}>Zone</th>
                <th style={{ ...th, textAlign: 'right' }}>Distance (m)</th>
                <th style={{ ...th, textAlign: 'right' }}>Dist/min (m)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                // Render-only name join (ADR-0016): displayName when the roster has it, else the pseudonymous id.
                const name = roster.get(r.playerId) ?? r.playerId;
                return (
                  <tr key={r.playerId} data-testid="player-row" style={{ borderTop: '1px solid #23262c' }}>
                    <td style={{ ...td, fontFamily: roster.has(r.playerId) ? undefined : 'ui-monospace, SFMono-Regular, monospace' }}>
                      {name}
                    </td>
                    <td style={td}>
                      {/* Glyph is decorative (aria-hidden); the word carries the meaning for AT. */}
                      <span
                        aria-hidden="true"
                        style={{
                          color: FRESHNESS_COLOR[r.freshness],
                          marginRight: 6,
                          // Reduced-motion users get nothing animated; the glyph is static anyway.
                          transition: reducedMotion ? 'none' : undefined,
                        }}
                      >
                        {FRESHNESS_GLYPH[r.freshness]}
                      </span>
                      {r.freshness}
                      {/* Phase 5: the canvas pins an off-pitch player to its edge with a distinct
                          diamond; here the same fact is a WORD, so it is never shape-only. */}
                      {r.offPitch ? ' · off pitch' : ''}
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>{r.spd.toFixed(1)}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{(r.ageMs / 1000).toFixed(1)}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{battText(r.health)}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{r.health ? r.health.rssi : '—'}</td>
                    <td style={td}>{gpsText(r.health)}</td>
                    <td style={td}>
                      {r.level ? (
                        <>
                          {/* Colour is redundant; the word ("ok"/"check"/"alert") carries the meaning for AT. */}
                          <span aria-hidden="true" style={{ color: LEVEL_COLOR[r.level], marginRight: 6 }}>
                            ●
                          </span>
                          {LEVEL_WORD[r.level]}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    {/* Phase-4 Zone: the WORD (walk/jog/run/HSR/sprint) carries the meaning for AT +
                        colour-blind users; the colour swatch is a redundant glance extra (a11y), exactly
                        like the Status + Device columns. */}
                    <td style={td}>
                      <span aria-hidden="true" style={{ color: ZONE_COLOR[r.zone], marginRight: 6 }}>
                        ●
                      </span>
                      {ZONE_LABEL[r.zone]}
                    </td>
                    {/* Phase-4 live running distance (best-effort; resets on reconnect — §3.3). "—" until
                        the accumulator has seen this player on the live stream. */}
                    <td style={{ ...td, textAlign: 'right' }}>
                      {r.distM != null ? Math.round(r.distM).toLocaleString() : '—'}
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      {r.distPerMin != null ? Math.round(r.distPerMin).toLocaleString() : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

const th: React.CSSProperties = { padding: '6px 12px', fontWeight: 600 };
const td: React.CSSProperties = { padding: '6px 12px' };
