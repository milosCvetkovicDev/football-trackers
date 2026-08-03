import { useEffect, useMemo, useRef, useState } from 'react';
import { applyHomography, computeHomography, type Pt } from './homography';
import { makeProjector } from './geo';
import { PITCH_CORNERS } from './config';
import { ZONE_LABEL, ZONE_COLOR, type Zone } from './zones';
import type { ZoneThresholds } from './types';
import {
  useHistory,
  type AggregatePlayer,
  type AggregateResult,
  type Heatmap as HeatmapData,
  type HistoryCursor,
  type RawFix,
  type RawResult,
} from './useHistory';
import { EventTimeline } from './EventTimeline';

/**
 * Phase 3 (ADR-0017): the review/replay shell — "one renderer, two modes". A coach picks a recorded
 * window, sees per-player aggregates + an occupancy heatmap, then optionally scrubs one player's raw
 * trace. It shares the live view's pitch geometry (the homography from PITCH_CORNERS via the imported
 * helpers — NOT duplicated maths, NOT a second PitchCanvas) so review dots land where live dots did.
 *
 * Security posture (§0.1 / §0.2):
 *   - Names are render-only. `roster` (playerId → displayName) is joined at draw time via
 *     `displayName ?? playerId`; it is NEVER written into `data` and NEVER persisted — `useHistory`
 *     keeps the (pseudonymous) history in memory only. The heatmap is occupancy-only (no identity).
 *   - Fail closed: a history read error shows explicit text, never a misleading empty pitch (the
 *     `'error'` vs `'empty'` distinction comes straight from `useHistory`).
 *
 * Perf note (§0.3): this is a background/off-the-live-loop surface, but it still shares the one event
 * loop, so the heatmap + replay canvases are drawn imperatively (no per-frame React churn) and the
 * scrubber redraws on demand (a value change), not on a rAF treadmill.
 */

type Theme = 'normal' | 'outdoor';

interface ReviewViewProps {
  session: string;
  /** playerId → displayName, from useRoster. Render-only join; never stored/persisted (§1.5). */
  roster: Map<string, string>;
  /** Session speed-zone thresholds (Phase 4) — fetched config or U14 defaults; shown as panel provenance. */
  thresholds: ZoneThresholds;
  theme: Theme;
  reducedMotion: boolean;
}

// Palette echoes PitchCanvas's two-mode feel: a darker review pitch (this is analysis, not the bright
// pitch-side live view) with the same outdoor high-contrast bump. Heat ramp goes cool → hot on occupancy.
interface ReviewPalette {
  pitch: string;
  line: string;
  lineWidth: number;
  dot: string;
  dotStroke: string;
  label: string;
  trail: string; // rgba prefix; alpha appended per point
  heatLow: [number, number, number]; // RGB at the lowest non-zero occupancy
  heatHigh: [number, number, number]; // RGB at peak occupancy
}
const PALETTES: Record<Theme, ReviewPalette> = {
  normal: {
    pitch: '#15321f', // muted review green (darker than the live pitch)
    line: 'rgba(255,255,255,.65)',
    lineWidth: 2,
    dot: '#ffd23f',
    dotStroke: 'rgba(0,0,0,.45)',
    label: '#0a0a0a',
    trail: 'rgba(255,210,63,',
    heatLow: [42, 92, 170],
    heatHigh: [255, 93, 93],
  },
  outdoor: {
    pitch: '#10301c',
    line: 'rgba(255,255,255,1)',
    lineWidth: 3,
    dot: '#ffdf2b',
    dotStroke: 'rgba(0,0,0,.85)',
    label: '#000',
    trail: 'rgba(255,223,43,',
    heatLow: [60, 120, 200],
    heatHigh: [255, 80, 80],
  },
};

const PITCH_ASPECT = 105 / 68; // matches PitchCanvas — keep the review rectangle the same shape
const MARGIN_FRAC = 0.05;
const DPR_CAP = 2;

/** Default review window: the most recent 90 minutes (≈ a full match), clamped to the server span cap. */
const DEFAULT_WINDOW_MS = 90 * 60 * 1_000;
/**
 * Hard ceiling on accumulated replay fixes so a long window can't grow the in-memory trace unbounded.
 * (Each raw page is the server's default 2000 fixes — `useHistory` sends no explicit `limit`, so the
 * server default applies; we just keep folding pages until `nextCursor` is null or we hit this cap.)
 */
const RAW_MAX_FIXES = 200_000;

export function ReviewView({ session, roster, thresholds, theme, reducedMotion }: ReviewViewProps) {
  // --- Window picker: default to "now − 90 min … now", editable via two datetime-local inputs. ---
  const [from, setFrom] = useState(() => Date.now() - DEFAULT_WINDOW_MS);
  const [to, setTo] = useState(() => Date.now());
  // The committed window the queries actually use — only updated on "Apply" so dragging a field doesn't
  // fire a fetch per keystroke (and an invalid intermediate from>to never reaches the server).
  const [window, setWindow] = useState<{ from: number; to: number }>(() => ({ from, to }));
  const windowValid = to > from;

  // --- Aggregate query: re-fetched whenever the committed window changes. ---
  const aggQuery = useMemo(
    () => ({ from: window.from, to: window.to, mode: 'aggregate' as const }),
    [window],
  );
  const aggResult = useHistory(session, aggQuery);

  // --- Replay selection: a playerId (or null = no replay) + the scrubber's virtual-now. ---
  const [replayPlayer, setReplayPlayer] = useState<string | null>(null);

  const palette = PALETTES[theme];
  const nameOf = (playerId: string) => roster.get(playerId) ?? playerId;

  return (
    <section
      aria-label="Match review"
      style={{
        width: '100%',
        maxWidth: 1100,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        color: '#e8e8e8',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        fontSize: 13,
      }}
    >
      <WindowPicker
        from={from}
        to={to}
        valid={windowValid}
        onFrom={setFrom}
        onTo={setTo}
        onApply={() => {
          if (to > from) setWindow({ from, to });
        }}
        theme={theme}
      />

      {/* Aggregate table + heatmap share the committed window. Both narrate loading/error/empty so the
          coach is never shown a silent blank (fail closed). */}
      <AggregateSection
        result={aggResult}
        nameOf={nameOf}
        palette={palette}
        thresholds={thresholds}
        replayPlayer={replayPlayer}
        onPickReplay={setReplayPlayer}
      />

      {/* Tactical events (ADR-0020): movement-derived phases over the committed window. Team-aggregate (no
          identity); honestly labelled heuristics, never ground truth. Shares the window the aggregate uses. */}
      <EventTimeline session={session} window={window} theme={theme} />

      {/* On-demand raw replay: only mounted once a player is chosen, so we don't fetch raw pages until
          the coach asks for them (children's raw location is the most sensitive read — §0.7). */}
      {replayPlayer ? (
        <ReplaySection
          key={`${session}:${window.from}:${window.to}:${replayPlayer}`}
          session={session}
          window={window}
          playerId={replayPlayer}
          name={nameOf(replayPlayer)}
          palette={palette}
          reducedMotion={reducedMotion}
          onClose={() => setReplayPlayer(null)}
        />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------
// Window picker
// ---------------------------------------------------------------------------------------------------

function WindowPicker({
  from,
  to,
  valid,
  onFrom,
  onTo,
  onApply,
  theme,
}: {
  from: number;
  to: number;
  valid: boolean;
  onFrom: (ms: number) => void;
  onTo: (ms: number) => void;
  onApply: () => void;
  theme: Theme;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onApply();
      }}
      style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}
    >
      <label style={fieldLabelStyle}>
        <span>From</span>
        <input
          type="datetime-local"
          value={toLocalInput(from)}
          onChange={(e) => onFrom(fromLocalInput(e.target.value, from))}
          style={inputStyle(theme)}
          aria-label="Window start"
        />
      </label>
      <label style={fieldLabelStyle}>
        <span>To</span>
        <input
          type="datetime-local"
          value={toLocalInput(to)}
          onChange={(e) => onTo(fromLocalInput(e.target.value, to))}
          style={inputStyle(theme)}
          aria-label="Window end"
        />
      </label>
      <button type="submit" disabled={!valid} style={buttonStyle(theme === 'outdoor', !valid)}>
        Apply
      </button>
      {!valid ? (
        <span role="alert" style={{ color: '#ff5d5d', alignSelf: 'center' }}>
          End must be after start.
        </span>
      ) : null}
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------
// Aggregate table + heatmap
// ---------------------------------------------------------------------------------------------------

function AggregateSection({
  result,
  nameOf,
  palette,
  thresholds,
  replayPlayer,
  onPickReplay,
}: {
  result: ReturnType<typeof useHistory>;
  nameOf: (playerId: string) => string;
  palette: ReviewPalette;
  thresholds: ZoneThresholds;
  replayPlayer: string | null;
  onPickReplay: (playerId: string) => void;
}) {
  // Fail-closed narration: each non-ok status is explicit text, never a blank pitch (§0.2).
  if (result.status === 'loading') {
    return <Panel>Loading match summary…</Panel>;
  }
  if (result.status === 'error') {
    return (
      <Panel tone="bad">
        Couldn&rsquo;t load the match summary. Check the time window and try again.
      </Panel>
    );
  }
  if (result.status === 'empty') {
    return <Panel>No recorded positions in this window.</Panel>;
  }
  // Narrow to the aggregate shape we asked for (the hook returns the union; mode drives which arm).
  const data = result.data as AggregateResult;

  // Phase-4 provenance (§4.2): which band's thresholds the server's zone breakdown used. Prefer the
  // server's authoritative `ageBand` (top-level aggregate field); when absent (a pre-Phase-4 server) fall
  // back to noting the client thresholds in use. The HSR/sprint boundaries come from the resolved
  // `thresholds` prop so the coach can see the exact m/s cuts behind the zone colours.
  const bandLabel = data.ageBand ?? 'default';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div
        role="note"
        aria-label="Speed-zone thresholds provenance"
        style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', fontSize: 12 }}
      >
        <span style={{ fontWeight: 600 }}>thresholds: {bandLabel}</span>
        <span style={{ opacity: 0.6, fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>
          HSR ≥ {thresholds.hsrMps.toFixed(2)} m/s · sprint ≥ {thresholds.sprintMps.toFixed(2)} m/s
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          gap: 16,
          flexWrap: 'wrap',
          alignItems: 'flex-start',
        }}
      >
        <Heatmap heatmap={data.heatmap} palette={palette} />
        <div style={{ flex: '1 1 320px', minWidth: 280 }}>
          <AggregateTable
            data={data}
            nameOf={nameOf}
            replayPlayer={replayPlayer}
            onPickReplay={onPickReplay}
          />
        </div>
      </div>
      <p style={{ margin: 0, opacity: 0.55, fontSize: 12 }}>
        {data.players.length} player{data.players.length === 1 ? '' : 's'} ·{' '}
        {data.scannedRows.toLocaleString()} fixes scanned. Heatmap shows time-on-pitch occupancy
        (no identity); the table is identified — treat names as confidential.
      </p>
    </div>
  );
}

function AggregateTable({
  data,
  nameOf,
  replayPlayer,
  onPickReplay,
}: {
  data: AggregateResult;
  nameOf: (playerId: string) => string;
  replayPlayer: string | null;
  onPickReplay: (playerId: string) => void;
}) {
  // Stable order so the table doesn't reshuffle between renders (mirrors A11yMirror's sort rule).
  const rows = useMemo(
    () => [...data.players].sort((a, b) => a.playerId.localeCompare(b.playerId)),
    [data.players],
  );

  return (
    <div
      style={{
        border: '1px solid #2a2d33',
        borderRadius: 10,
        background: '#16181d',
        overflow: 'hidden',
      }}
    >
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontVariantNumeric: 'tabular-nums',
          fontSize: 13,
        }}
      >
        <caption style={{ textAlign: 'left', padding: '6px 12px', opacity: 0.55 }}>
          Per-player summary for the selected window. Sprint + accel/decel are GPS estimates (review-only).
        </caption>
        <thead>
          {/* The Phase-4 columns (Zones / Dist/min / Sprints / Accel·Decel) render per-cell only when the
              server supplied them, so this table degrades gracefully against a pre-Phase-4 response. */}
          <tr style={{ textAlign: 'left', opacity: 0.7 }}>
            <th style={th}>Player</th>
            <th style={{ ...th, textAlign: 'right' }}>Distance (m)</th>
            <th style={{ ...th, textAlign: 'right' }}>Avg (m/s)</th>
            <th style={{ ...th, textAlign: 'right' }}>Max (m/s)</th>
            <th style={th}>Zones</th>
            <th style={{ ...th, textAlign: 'right' }}>Dist/min (m)</th>
            <th style={th}>Sprints</th>
            <th style={th}>Accel·Decel (GPS estimate)</th>
            <th style={th}>Replay</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.playerId} data-testid="aggregate-row" style={{ borderTop: '1px solid #23262c' }}>
              {/* Name is a render-only join (displayName ?? playerId); never stored — §1.5. */}
              <td style={{ ...td, fontWeight: 600 }}>{nameOf(p.playerId)}</td>
              <td style={{ ...td, textAlign: 'right' }}>{Math.round(p.distanceM).toLocaleString()}</td>
              <td style={{ ...td, textAlign: 'right' }}>{p.avgSpeedMps.toFixed(1)}</td>
              <td style={{ ...td, textAlign: 'right' }}>{p.maxSpeedMps.toFixed(1)}</td>
              {/* Zone-distance breakdown bar — 5 segments coloured by ZONE_COLOR, widths = % of distance. */}
              <td style={td}>
                <ZoneBar zoneDistanceM={p.zoneDistanceM} />
              </td>
              <td style={{ ...td, textAlign: 'right' }}>
                {p.distancePerMin != null ? Math.round(p.distancePerMin).toLocaleString() : '—'}
              </td>
              <td style={td}>{sprintText(p.sprint)}</td>
              <td style={td}>{effortText(p.effort)}</td>
              <td style={td}>
                <button
                  type="button"
                  aria-pressed={replayPlayer === p.playerId}
                  onClick={() => onPickReplay(p.playerId)}
                  style={buttonStyle(replayPlayer === p.playerId, false)}
                >
                  {replayPlayer === p.playerId ? 'Replaying' : 'Replay'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Zone-distance breakdown bar (Phase 4, §4.2): five segments coloured by ZONE_COLOR, each segment's width
 * the share of total gated distance spent in that zone (Z1 walk … Z5 sprint). Renders only when the server
 * supplied `zoneDistanceM` (graceful degradation); an all-zero / missing array shows "—". The zone WORDS +
 * metres go into the accessible title (the colour bar is a glance cue, never the sole signal — a11y).
 */
function ZoneBar({ zoneDistanceM }: { zoneDistanceM: number[] | undefined }) {
  if (!zoneDistanceM || zoneDistanceM.length === 0) return <span style={{ opacity: 0.5 }}>—</span>;
  const total = zoneDistanceM.reduce((s, v) => s + (v > 0 ? v : 0), 0);
  if (total <= 0) return <span style={{ opacity: 0.5 }}>—</span>;
  // Accessible, AT-readable summary: "walk 120 m, jog 340 m, …" so the breakdown isn't colour-only.
  const title = zoneDistanceM
    .map((m, i) => `${ZONE_LABEL[(i + 1) as Zone]} ${Math.round(m)} m`)
    .join(', ');
  return (
    <div
      role="img"
      aria-label={`Zone distance breakdown: ${title}`}
      title={title}
      style={{ display: 'flex', width: 120, height: 12, borderRadius: 3, overflow: 'hidden' }}
    >
      {zoneDistanceM.map((m, i) => {
        const pct = total > 0 ? (Math.max(0, m) / total) * 100 : 0;
        if (pct <= 0) return null;
        const zone = (i + 1) as Zone;
        return (
          <span
            key={zone}
            aria-hidden="true"
            style={{ width: `${pct}%`, background: ZONE_COLOR[zone] }}
          />
        );
      })}
    </div>
  );
}

/** Sprint-effort cell text (Phase 4) — count + accumulated distance + max speed; "—" when absent. */
function sprintText(sprint: AggregatePlayer['sprint']): string {
  if (!sprint) return '—';
  return `${sprint.count} · ${Math.round(sprint.distanceM)} m · ${sprint.maxSpeedMps.toFixed(1)} m/s`;
}

/**
 * Accel/decel effort cell text (Phase 4) — moderate/high counts per direction. GPS-derived, so the column
 * header already flags it a "GPS estimate"; this keeps the cell compact ("A 3/1 · D 2/0" = accel mod/high,
 * decel mod/high). "—" when the server didn't supply efforts.
 */
function effortText(effort: AggregatePlayer['effort']): string {
  if (!effort) return '—';
  return `A ${effort.accelMod}/${effort.accelHigh} · D ${effort.decelMod}/${effort.decelHigh}`;
}

// ---------------------------------------------------------------------------------------------------
// Heatmap — occupancy grid drawn on the SAME pitch geometry as PitchCanvas (reused homography helpers)
// ---------------------------------------------------------------------------------------------------

function Heatmap({ heatmap, palette }: { heatmap: HeatmapData; palette: ReviewPalette }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Keep the latest inputs in refs so the draw closure reads fresh values without re-running the effect
  // (the geometry effect depends only on mount; data/theme changes redraw via the second effect below).
  const heatmapRef = useRef(heatmap);
  heatmapRef.current = heatmap;
  const paletteRef = useRef(palette);
  paletteRef.current = palette;

  // A redraw signal the geometry effect installs and the data effect pokes — so a heatmap/theme change
  // repaints without tearing down the ResizeObserver.
  const drawRef = useRef<() => void>(() => {});

  useEffect(() => {
    const container = containerRef.current!;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;

    // Geometry — identical construction to PitchCanvas: project the four corners once, then solve the
    // homography for the responsive dst rectangle on each resize. We reuse computeHomography/applyHomography
    // and makeProjector verbatim so review pixels and live pixels agree exactly (ADR-0017 "one renderer").
    const project = makeProjector(PITCH_CORNERS[0]);
    const srcM = PITCH_CORNERS.map(project);
    let cssW = 0;
    let cssH = 0;
    let dst: Pt[] = [];
    let toPx: (lat: number, lon: number) => Pt = () => [0, 0];

    const recompute = () => {
      const rect = container.getBoundingClientRect();
      cssW = Math.max(1, Math.round(rect.width));
      cssH = Math.max(1, Math.round(cssW / PITCH_ASPECT));
      const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const mx = cssW * MARGIN_FRAC;
      const my = cssH * MARGIN_FRAC;
      dst = [
        [mx, my],
        [cssW - mx, my],
        [cssW - mx, cssH - my],
        [mx, cssH - my],
      ];
      const H = computeHomography(srcM, dst);
      toPx = (lat: number, lon: number): Pt => applyHomography(H, project({ lat, lon }));
    };

    const draw = () => {
      const pal = paletteRef.current;
      const hm = heatmapRef.current;
      ctx.clearRect(0, 0, cssW, cssH);
      ctx.fillStyle = pal.pitch;
      ctx.fillRect(0, 0, cssW, cssH);
      drawPitchLines(ctx, dst, pal);
      drawHeatBins(ctx, hm, toPx, pal);
    };
    drawRef.current = draw;

    recompute();
    draw();
    const ro = new ResizeObserver(() => {
      recompute();
      draw();
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Repaint on a heatmap/palette change without rebuilding geometry.
  useEffect(() => {
    drawRef.current();
  }, [heatmap, palette]);

  const peak = useMemo(() => heatmap.bins.reduce((m, v) => (v > m ? v : m), 0), [heatmap]);

  return (
    <figure style={{ margin: 0, flex: '1 1 360px', minWidth: 300 }}>
      <div ref={containerRef} style={{ width: '100%', lineHeight: 0 }}>
        <canvas
          ref={canvasRef}
          // Occupancy-only; no identity is drawn here (§3.2). A descriptive label for AT.
          role="img"
          aria-label={`Occupancy heatmap, ${heatmap.cols} by ${heatmap.rows} grid, peak ${peak} fixes per cell`}
          style={{
            borderRadius: 10,
            background: '#15321f',
            boxShadow: '0 6px 30px rgba(0,0,0,.35)',
            display: 'block',
            width: '100%',
          }}
        />
      </div>
      <figcaption style={{ marginTop: 6, opacity: 0.55, fontSize: 12 }}>
        Time-on-pitch occupancy (all players combined) — no identity.
      </figcaption>
    </figure>
  );
}

/** Fill each occupancy cell, mapping its lat/lon centre onto the pitch via the shared homography. */
function drawHeatBins(
  ctx: CanvasRenderingContext2D,
  hm: HeatmapData,
  toPx: (lat: number, lon: number) => Pt,
  pal: ReviewPalette,
) {
  // The server scales the grid to the scan's bbox and SHIPS that bbox (heatmap.bbox); map each cell's
  // lat/lon rectangle onto the pitch via the shared homography so the occupancy lands where the players
  // actually were. A null bbox = an empty/degenerate scan → nothing to draw. Empty cells are skipped so
  // the pitch shows through. (bins index: col from lon, row from lat, both ascending from the bbox min.)
  const bbox = hm.bbox;
  if (!bbox || hm.cols <= 0 || hm.rows <= 0) return;
  const peak = hm.bins.reduce((m, v) => (v > m ? v : m), 0);
  if (peak <= 0) return;

  const latSpan = bbox.maxLat - bbox.minLat;
  const lonSpan = bbox.maxLon - bbox.minLon;
  for (let r = 0; r < hm.rows; r++) {
    for (let c = 0; c < hm.cols; c++) {
      const count = hm.bins[r * hm.cols + c] ?? 0;
      if (count <= 0) continue;
      const lon0 = bbox.minLon + (c / hm.cols) * lonSpan;
      const lon1 = bbox.minLon + ((c + 1) / hm.cols) * lonSpan;
      const lat0 = bbox.minLat + (r / hm.rows) * latSpan;
      const lat1 = bbox.minLat + ((r + 1) / hm.rows) * latSpan;
      const p00 = toPx(lat0, lon0);
      const p10 = toPx(lat0, lon1);
      const p11 = toPx(lat1, lon1);
      const p01 = toPx(lat1, lon0);
      const t = count / peak; // 0..1 occupancy intensity
      ctx.fillStyle = heatColour(t, pal);
      ctx.beginPath();
      ctx.moveTo(p00[0], p00[1]);
      ctx.lineTo(p10[0], p10[1]);
      ctx.lineTo(p11[0], p11[1]);
      ctx.lineTo(p01[0], p01[1]);
      ctx.closePath();
      ctx.fill();
    }
  }
}

/** Cool→hot ramp with intensity-scaled alpha so low-occupancy cells stay translucent over the pitch. */
function heatColour(t: number, pal: ReviewPalette): string {
  const [lr, lg, lb] = pal.heatLow;
  const [hr, hg, hb] = pal.heatHigh;
  const r = Math.round(lr + (hr - lr) * t);
  const g = Math.round(lg + (hg - lg) * t);
  const b = Math.round(lb + (hb - lb) * t);
  const alpha = 0.25 + 0.55 * t; // .25 (faint) → .80 (hot)
  return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
}

// ---------------------------------------------------------------------------------------------------
// Raw replay — pick a player, page mode=raw, scrub a "virtual now" the canvas renders dots against
// ---------------------------------------------------------------------------------------------------

function ReplaySection({
  session,
  window,
  playerId,
  name,
  palette,
  reducedMotion,
  onClose,
}: {
  session: string;
  window: { from: number; to: number };
  playerId: string;
  name: string;
  palette: ReviewPalette;
  reducedMotion: boolean;
  onClose: () => void;
}) {
  // Accumulate raw pages into one in-memory trace (capped). `cursor` advances the keyset paging; null
  // once we've requested the first page with no cursor and again means "done" via nextCursor === null.
  const [fixes, setFixes] = useState<RawFix[]>([]);
  const [cursor, setCursor] = useState<HistoryCursor | undefined>(undefined);
  const [done, setDone] = useState(false);
  // The scrubber's virtual-now (ms). Starts at the window start; dragging it reveals the trace up to t.
  const [virtualNow, setVirtualNow] = useState(window.from);

  const rawQuery = useMemo(
    () => ({ from: window.from, to: window.to, mode: 'raw' as const, player: playerId, cursor }),
    [window, playerId, cursor],
  );
  const page = useHistory(session, done ? null : rawQuery);

  // Fold each successful page into the accumulated trace, then advance the cursor (or stop). The
  // dependency is the page IDENTITY from useHistory — each fetch yields a new object, so this runs once
  // per page. We never store names here; fixes are pseudonymous coordinates only.
  useEffect(() => {
    // An empty page (first OR mid-sequence) terminates paging — otherwise `done` stays false and the UI is
    // stuck on "Loading…/loading more…" forever, and the fail-closed "no recorded positions" path (§0.2) is
    // unreachable. Mark done so emptyDone resolves and the scrubber stops showing "loading more…".
    if (page.status === 'empty') {
      setDone(true);
      return;
    }
    if (page.status !== 'ok') return;
    const data = page.data as RawResult;
    setFixes((prev) => {
      const next = prev.concat(data.fixes);
      return next.length > RAW_MAX_FIXES ? next.slice(0, RAW_MAX_FIXES) : next;
    });
    if (data.nextCursor && (fixes.length + data.fixes.length) < RAW_MAX_FIXES) {
      setCursor(data.nextCursor); // request the next page
    } else {
      setDone(true);
    }
    // `fixes.length` intentionally excluded — including it would re-run on our own setFixes; the cursor
    // change drives the next page. (The cap check uses the closed-over length, good enough for the bound.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  // Empty trace once paging is complete → explicit "no data", never a silent blank pitch (fail closed).
  const loading = !done && (page.status === 'loading' || fixes.length === 0);
  const errored = page.status === 'error';
  const emptyDone = done && fixes.length === 0;

  return (
    <div
      style={{
        border: '1px solid #2a2d33',
        borderRadius: 10,
        background: '#16181d',
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        {/* Render-only name join (§1.5). */}
        <span style={{ fontWeight: 600 }}>Replay · {name}</span>
        <button type="button" onClick={onClose} style={buttonStyle(false, false)}>
          Close replay
        </button>
      </div>

      {errored ? (
        <Panel tone="bad">Couldn&rsquo;t load this player&rsquo;s replay. Try again.</Panel>
      ) : emptyDone ? (
        <Panel>No recorded positions for this player in the window.</Panel>
      ) : loading ? (
        <Panel>Loading replay… ({fixes.length.toLocaleString()} fixes so far)</Panel>
      ) : (
        <>
          <ReplayCanvas
            fixes={fixes}
            virtualNow={virtualNow}
            palette={palette}
            reducedMotion={reducedMotion}
            label={name}
          />
          <Scrubber
            from={window.from}
            to={window.to}
            value={virtualNow}
            onChange={setVirtualNow}
            paging={!done}
            fixCount={fixes.length}
          />
        </>
      )}
    </div>
  );
}

/** A time scrubber driving the virtual-now; shows the wall-clock at the cursor + paging progress. */
function Scrubber({
  from,
  to,
  value,
  onChange,
  paging,
  fixCount,
}: {
  from: number;
  to: number;
  value: number;
  onChange: (ms: number) => void;
  paging: boolean;
  fixCount: number;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <input
        type="range"
        min={from}
        max={to}
        step={Math.max(1, Math.round((to - from) / 1000))}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Replay time"
        style={{ flex: '1 1 240px', minWidth: 200 }}
      />
      <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace', opacity: 0.85 }}>
        {new Date(value).toLocaleTimeString()}
      </span>
      <span style={{ opacity: 0.55, fontSize: 12 }}>
        {fixCount.toLocaleString()} fixes{paging ? ' · loading more…' : ''}
      </span>
    </div>
  );
}

/**
 * Draws one player's recorded trace up to `virtualNow`: a fading trail of past fixes + a solid "current"
 * dot at the most recent fix at-or-before the scrubber time. Same pitch geometry + homography as the
 * live canvas (and the heatmap) so the replayed dot lands where the live dot did.
 */
function ReplayCanvas({
  fixes,
  virtualNow,
  palette,
  reducedMotion,
  label,
}: {
  fixes: RawFix[];
  virtualNow: number;
  palette: ReviewPalette;
  reducedMotion: boolean;
  label: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Latest props in refs so the draw closure reads fresh values without rebuilding geometry every change.
  const fixesRef = useRef(fixes);
  fixesRef.current = fixes;
  const nowRef = useRef(virtualNow);
  nowRef.current = virtualNow;
  const palRef = useRef(palette);
  palRef.current = palette;
  const reducedRef = useRef(reducedMotion);
  reducedRef.current = reducedMotion;
  const labelRef = useRef(label);
  labelRef.current = label;

  const drawRef = useRef<() => void>(() => {});

  useEffect(() => {
    const container = containerRef.current!;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;

    // Same geometry construction as PitchCanvas / Heatmap (reused helpers, not duplicated maths).
    const project = makeProjector(PITCH_CORNERS[0]);
    const srcM = PITCH_CORNERS.map(project);
    let cssW = 0;
    let cssH = 0;
    let dst: Pt[] = [];
    let toPx: (lat: number, lon: number) => Pt = () => [0, 0];

    const recompute = () => {
      const rect = container.getBoundingClientRect();
      cssW = Math.max(1, Math.round(rect.width));
      cssH = Math.max(1, Math.round(cssW / PITCH_ASPECT));
      const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const mx = cssW * MARGIN_FRAC;
      const my = cssH * MARGIN_FRAC;
      dst = [
        [mx, my],
        [cssW - mx, my],
        [cssW - mx, cssH - my],
        [mx, cssH - my],
      ];
      const H = computeHomography(srcM, dst);
      toPx = (lat: number, lon: number): Pt => applyHomography(H, project({ lat, lon }));
    };

    const draw = () => {
      const pal = palRef.current;
      const trace = fixesRef.current;
      const t = nowRef.current;
      ctx.clearRect(0, 0, cssW, cssH);
      ctx.fillStyle = pal.pitch;
      ctx.fillRect(0, 0, cssW, cssH);
      drawPitchLines(ctx, dst, pal);

      // Fixes are server-ordered ascending by serverTs (keyset paging guarantees it). Find the slice
      // up to the virtual-now: a fading trail behind, a solid dot at the most recent revealed fix.
      const reduced = reducedRef.current;
      let lastIdx = -1;
      for (let i = 0; i < trace.length; i++) {
        if (trace[i].serverTs <= t) lastIdx = i;
        else break;
      }
      if (lastIdx < 0) return; // nothing revealed yet at this scrubber position

      if (!reduced) {
        // A short fading tail of the most recent fixes (presentation only; omitted under reduced motion).
        const TRAIL = 40;
        const start = Math.max(0, lastIdx - TRAIL);
        for (let i = start; i < lastIdx; i++) {
          const [x, y] = toPx(trace[i].lat, trace[i].lon);
          const alpha = ((i - start + 1) / (lastIdx - start + 1)) * 0.5;
          ctx.beginPath();
          ctx.fillStyle = `${pal.trail}${alpha.toFixed(3)})`;
          ctx.arc(x, y, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      const cur = trace[lastIdx];
      const [x, y] = toPx(cur.lat, cur.lon);
      // Solid current dot + render-only name label (displayName ?? playerId, passed in as `label`).
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.fillStyle = pal.dot;
      ctx.fill();
      ctx.lineWidth = pal.lineWidth;
      ctx.strokeStyle = pal.dotStroke;
      ctx.stroke();
      ctx.fillStyle = pal.label;
      ctx.font = 'bold 10px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(labelRef.current, x, y);
    };
    drawRef.current = draw;

    recompute();
    draw();
    const ro = new ResizeObserver(() => {
      recompute();
      draw();
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Redraw imperatively on any input change (scrubber, new pages, theme) — no rAF treadmill.
  useEffect(() => {
    drawRef.current();
  }, [fixes, virtualNow, palette, reducedMotion, label]);

  return (
    <div ref={containerRef} style={{ width: '100%', lineHeight: 0 }}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Replay trace for ${label} up to the scrubber position`}
        style={{
          borderRadius: 10,
          background: '#15321f',
          boxShadow: '0 6px 30px rgba(0,0,0,.35)',
          display: 'block',
          width: '100%',
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// Shared pitch line drawing (mirrors PitchCanvas.drawPitch — boundary, halfway line, centre circle)
// ---------------------------------------------------------------------------------------------------

function drawPitchLines(ctx: CanvasRenderingContext2D, dst: Pt[], pal: ReviewPalette) {
  if (dst.length !== 4) return;
  ctx.strokeStyle = pal.line;
  ctx.lineWidth = pal.lineWidth;

  // boundary
  ctx.beginPath();
  ctx.moveTo(dst[0][0], dst[0][1]);
  for (let i = 1; i < 4; i++) ctx.lineTo(dst[i][0], dst[i][1]);
  ctx.closePath();
  ctx.stroke();

  // halfway line: midpoint of top touchline → midpoint of bottom touchline
  const midTop: Pt = [(dst[0][0] + dst[1][0]) / 2, (dst[0][1] + dst[1][1]) / 2];
  const midBot: Pt = [(dst[3][0] + dst[2][0]) / 2, (dst[3][1] + dst[2][1]) / 2];
  ctx.beginPath();
  ctx.moveTo(midTop[0], midTop[1]);
  ctx.lineTo(midBot[0], midBot[1]);
  ctx.stroke();

  // centre spot (the centre-circle radius needs px/m, which the live canvas tracks; a spot is enough
  // orientation for the review surface without re-deriving the scale here).
  const cx = (dst[0][0] + dst[1][0] + dst[2][0] + dst[3][0]) / 4;
  const cy = (dst[0][1] + dst[1][1] + dst[2][1] + dst[3][1]) / 4;
  ctx.beginPath();
  ctx.fillStyle = pal.line;
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fill();
}

// ---------------------------------------------------------------------------------------------------
// Small shared UI bits (dark-palette panels, controls) — match App.tsx's control styling feel
// ---------------------------------------------------------------------------------------------------

function Panel({ children, tone }: { children: React.ReactNode; tone?: 'bad' }) {
  return (
    <p
      // role=alert only for the error tone so a screen reader announces a failed read (fail closed = loud).
      role={tone === 'bad' ? 'alert' : undefined}
      style={{
        margin: 0,
        padding: '12px 14px',
        border: '1px solid #2a2d33',
        borderRadius: 10,
        background: '#16181d',
        color: tone === 'bad' ? '#ff8d8d' : '#e8e8e8',
        opacity: tone === 'bad' ? 1 : 0.8,
      }}
    >
      {children}
    </p>
  );
}

const fieldLabelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 13,
};

function inputStyle(theme: Theme): React.CSSProperties {
  return {
    fontSize: 13,
    padding: '4px 8px',
    borderRadius: 8,
    border: '1px solid #2a2d33',
    background: theme === 'outdoor' ? '#111' : '#0e0f12',
    color: '#e8e8e8',
    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
  };
}

function buttonStyle(active: boolean, disabled: boolean): React.CSSProperties {
  return {
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 12,
    padding: '4px 10px',
    borderRadius: 8,
    border: '1px solid #2a2d33',
    background: active ? '#ffdf2b' : '#16181d',
    color: active ? '#000' : '#e8e8e8',
    opacity: disabled ? 0.5 : 1,
  };
}

const th: React.CSSProperties = { padding: '6px 12px', fontWeight: 600 };
const td: React.CSSProperties = { padding: '6px 12px' };

// --- datetime-local <-> epoch-ms helpers (the input speaks local wall-clock; we store epoch ms) --------

/** Format an epoch-ms to the `datetime-local` value string (local time, minute precision). */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  // Adjust to local time then trim to "YYYY-MM-DDTHH:mm" (the input's required shape).
  const off = d.getTimezoneOffset() * 60_000;
  return new Date(ms - off).toISOString().slice(0, 16);
}

/** Parse a `datetime-local` value back to epoch ms; fall back to the previous value if unparseable. */
function fromLocalInput(value: string, fallback: number): number {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : fallback;
}
