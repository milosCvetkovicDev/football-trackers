import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { Telemetry, DeviceHealth, LiveDist, ZoneThresholds } from './types';
import { applyHomography, computeHomography, type Pt } from './homography';
import { makeProjector, type LatLon } from './geo';
// STALE_MS / DROP_MS aren't imported directly: playerFreshness() (contracts.ts) owns those
// thresholds so the canvas and the accessible mirror can never disagree about a player's state.
import { MAX_TRACKED_PLAYERS, ISOLATION_M, ISOLATION_MS } from './config';
import { makePitchFrame } from './pitchFrame';
import { serverNow } from './serverClock';
import { speedZone, ZONE_COLOR } from './zones';
import {
  describeConnection,
  playerFreshness,
  deviceHealthLevel,
  type ConnectionState,
  type ConnectionTone,
} from './contracts';
import {
  emptyBuffer,
  pushFix,
  resolvePosition,
  type FixBuffer,
} from './render/interpolate';
import { pushTrail, type TrailPoint } from './render/trail';

// Pitch aspect (~105x68 m). The dst rectangle is recomputed from the live CSS box each resize so
// it stays responsive; these only fix the shape and the breathing room around the lines.
const PITCH_ASPECT = 105 / 68;
const MARGIN_FRAC = 0.05; // inset the pitch from the box edge by this fraction of the box
// Data is 10 Hz; rendering faster only burns the always-on tablet's battery (ADR/plan: decouple
// render from 60 fps). Cap to ~30 fps — smooth enough for a damped lerp, half the fill of 60.
const FRAME_INTERVAL_MS = 1000 / 30;
const DPR_CAP = 2; // clamp devicePixelRatio: 4-9x fill on a 3x retina tablet blows the frame budget

/**
 * Two palettes: `normal` for indoor/desktop, `outdoor` a high-contrast sunlight mode (brighter
 * pitch, bolder lines/dots, stronger label contrast) — see the `theme` prop in contracts.
 */
interface Palette {
  pitch: string;
  line: string;
  lineWidth: number;
  dot: string;
  dotStroke: string;
  dotRadius: number;
  label: string;
  trail: string;
  arrow: string;
  staleRing: string;
  hud: string;
  hudText: string;
}
const PALETTES: Record<'normal' | 'outdoor', Palette> = {
  normal: {
    pitch: '#1b7a36',
    line: 'rgba(255,255,255,.85)',
    lineWidth: 2,
    dot: '#ffd23f',
    dotStroke: 'rgba(0,0,0,.45)',
    dotRadius: 9,
    label: '#0a0a0a',
    trail: 'rgba(255,210,63,', // alpha appended per point
    arrow: 'rgba(10,10,10,.8)',
    staleRing: 'rgba(255,255,255,.9)',
    hud: 'rgba(0,0,0,.45)',
    hudText: '#fff',
  },
  // Sunlight: a brighter pitch green, opaque white lines, a bolder/larger dot, near-black labels,
  // and an opaque HUD so the status survives glare on the pitch-side tablet.
  outdoor: {
    pitch: '#229b44', // brighter green for sun-washed screens
    line: 'rgba(255,255,255,1)',
    lineWidth: 3,
    dot: '#ffdf2b',
    dotStroke: 'rgba(0,0,0,.85)',
    dotRadius: 11,
    label: '#000',
    trail: 'rgba(255,223,43,',
    arrow: 'rgba(0,0,0,1)',
    staleRing: 'rgba(255,255,255,1)',
    hud: 'rgba(0,0,0,.7)',
    hudText: '#fff',
  },
};

const TONE_COLOUR: Record<ConnectionTone, string> = {
  ok: '#3ddc84',
  warn: '#ffd23f',
  bad: '#ff5d5d',
};

export function PitchCanvas({
  store,
  health,
  dist,
  conn,
  theme,
  reducedMotion,
  roster,
  thresholds,
  corners,
}: {
  store: RefObject<Map<string, Telemetry>>;
  health: RefObject<Map<string, DeviceHealth>>;
  /** Per-player LIVE running distance (Phase 4, §3.3). Read at draw time for the dot's distance glance. */
  dist: RefObject<Map<string, LiveDist>>;
  conn: ConnectionState;
  theme: 'normal' | 'outdoor';
  reducedMotion: boolean;
  roster: Map<string, string>;
  /** Session speed-zone thresholds (Phase 4) — fetched config or U14 defaults; drive the dot's zone colour. */
  thresholds: ZoneThresholds;
  /** The pitch's four GPS corners, TL/TR/BR/BL (Phase 5) — this session's measured ones, else the
   *  built-in fallback. Validated upstream; a degenerate quad throws in the solve below and is caught
   *  by this subtree's ErrorBoundary rather than white-screening the shell. */
  corners: LatLon[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Mirror the React-driven props into refs so the rAF loop reads the latest without restarting.
  const connRef = useRef(conn);
  connRef.current = conn;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;
  // roster (names) is a state Map whose identity changes when names arrive; mirror it so the rAF loop reads
  // the latest WITHOUT restarting the effect. It is read ONLY at draw time — never written into `store`.
  const rosterRef = useRef(roster);
  rosterRef.current = roster;
  // thresholds is a prop whose identity changes when the session config resolves; mirror it (exactly like
  // roster) so the rAF loop reads the latest band WITHOUT restarting. Read only at draw time to pick the
  // zone colour for each dot — the SAME classifier the accessible mirror + review breakdown use (§3.1).
  const thresholdsRef = useRef(thresholds);
  thresholdsRef.current = thresholds;

  useEffect(() => {
    const container = containerRef.current!;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;

    // --- Per-player smoothing state (kept across frames, GC'd when a player drops). ---
    const buffers = new Map<string, FixBuffer>();
    const trails = new Map<string, TrailPoint[]>();

    // --- Isolated-player cue state (Phase 4, §3.4) — kept across frames, GC'd when a player drops. ---
    // Per-player sustained-isolation clock: the serverTs-independent wall-clock ms at which this player
    // FIRST became isolated (nearest fresh teammate > ISOLATION_M), or null while not isolated. A player
    // gets the dashed ring only once it has been continuously isolated for >= ISOLATION_MS, so a brief
    // separation doesn't flash a false positive. A lone fresh player (no other fresh player to measure
    // against) is NEVER flagged — there's no teammate to be "away from".
    const isoSince = new Map<string, number | null>();
    // Reusable per-frame scratch for the O(n^2) nearest-teammate scan, sized to the hard player cap so the
    // hot loop allocates NOTHING per frame (perf #2 / pre-mortem Q6): fresh players' ids + planar metre
    // coords (for the metre-accurate distance gate) + screen px (to draw the ring where the dot landed).
    const freshIds: string[] = new Array(MAX_TRACKED_PLAYERS).fill('');
    const freshMx = new Float64Array(MAX_TRACKED_PLAYERS); // metres east of corner 0
    const freshMy = new Float64Array(MAX_TRACKED_PLAYERS); // metres north of corner 0
    const freshPx = new Float64Array(MAX_TRACKED_PLAYERS); // screen x
    const freshPy = new Float64Array(MAX_TRACKED_PLAYERS); // screen y
    const ISO_M2 = ISOLATION_M * ISOLATION_M; // compare squared metres → no per-pair sqrt in the hot loop

    // --- Geometry, recomputed on resize (depends on the live CSS box, not a hardcoded W/H). ---
    let cssW = 0;
    let cssH = 0;
    let toPx: (lat: number, lon: number) => Pt = () => [0, 0];
    let dst: Pt[] = [];
    let pxPerM = 1;
    // Projector is box-independent (GPS→metres around corner 0); build it once.
    const project = makeProjector(corners[0]);
    const srcM = corners.map(project);
    // The SAME pitch frame the accessible mirror uses, so the two can never disagree about who is off
    // the pitch (Phase 5, audit §6: off-pitch players were clipped invisibly while still counted).
    const pitchFrame = makePitchFrame(corners);

    // Offscreen static layer (pitch lines). Re-rendered only on resize/theme change, blitted/frame.
    const staticLayer = document.createElement('canvas');
    const staticCtx = staticLayer.getContext('2d')!;
    let staticThemeKey = ''; // guards a redraw when the theme changes between frames

    const recomputeGeometry = () => {
      const rect = container.getBoundingClientRect();
      cssW = Math.max(1, Math.round(rect.width));
      // Derive height from the pitch aspect so the rectangle stays ~105x68 regardless of box height.
      cssH = Math.max(1, Math.round(cssW / PITCH_ASPECT));

      const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
      // Backing store in device pixels; CSS size in layout pixels; transform so we draw in CSS px.
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Same DPR transform for the offscreen layer so its lines land on the same grid.
      staticLayer.width = canvas.width;
      staticLayer.height = canvas.height;
      staticCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Responsive dst rectangle: inset by MARGIN_FRAC of the box, order TL,TR,BR,BL.
      const mx = cssW * MARGIN_FRAC;
      const my = cssH * MARGIN_FRAC;
      dst = [
        [mx, my],
        [cssW - mx, my],
        [cssW - mx, cssH - my],
        [mx, cssH - my],
      ];
      const Hmat = computeHomography(srcM, dst);
      toPx = (lat: number, lon: number): Pt => applyHomography(Hmat, project({ lat, lon }));

      // px/m from the top touchline (for the centre-circle radius), recomputed from the live box.
      const topPx = Math.hypot(dst[1][0] - dst[0][0], dst[1][1] - dst[0][1]);
      const topM = Math.hypot(srcM[1][0] - srcM[0][0], srcM[1][1] - srcM[0][1]);
      pxPerM = topPx / topM;

      staticThemeKey = ''; // force the static layer to re-render at the new size
    };

    const renderStaticLayer = (pal: Palette) => {
      staticCtx.clearRect(0, 0, cssW, cssH);
      staticCtx.fillStyle = pal.pitch;
      staticCtx.fillRect(0, 0, cssW, cssH);
      drawPitch(staticCtx, dst, pxPerM, pal);
    };

    // --- The render loop: capped to ~30 fps and pausable on tab-hidden. ---
    let raf = 0;
    let lastFrame = 0;
    let running = true;

    const frame = (tNow: number) => {
      if (!running) return;
      raf = requestAnimationFrame(frame);
      if (tNow - lastFrame < FRAME_INTERVAL_MS) return; // cap to ~30 fps; data is only 10 Hz
      lastFrame = tNow;
      draw();
    };

    const draw = () => {
      const pal = PALETTES[themeRef.current];
      const snapOnly = reducedMotionRef.current;

      // Re-render the static pitch only when the theme changed (resize already cleared the key).
      if (staticThemeKey !== themeRef.current) {
        renderStaticLayer(pal);
        staticThemeKey = themeRef.current;
      }

      ctx.clearRect(0, 0, cssW, cssH);
      ctx.drawImage(staticLayer, 0, 0, cssW, cssH); // blit the cached lines, then dynamic layer

      // serverNow(), not Date.now(): ages are measured against SERVER-stamped fixes, so a tablet whose
      // clock runs fast would otherwise age every fix past DROP_MS and draw an empty pitch over a
      // perfectly healthy feed (audit C-1). Inert until the first frame has been seen.
      const now = serverNow();
      const live = store.current;
      const distMap = dist.current;
      const thr = thresholdsRef.current;
      let active = 0;
      let drawn = 0;
      let freshCount = 0; // number of fresh players recorded into the isolation scratch this frame
      // Bound the work: a buggy/hostile feed can't make us draw more than MAX_TRACKED_PLAYERS.
      for (const t of live.values()) {
        if (drawn >= MAX_TRACKED_PLAYERS) break;
        const age = now - t.serverTs;
        const freshness = playerFreshness(age);
        if (freshness === 'lost') continue; // past DROP_MS — stop drawing entirely
        drawn++;
        active++; // count EVERY non-lost player (fresh + stale) so the HUD matches the DOM banner + A11yMirror —
        // otherwise the HUD reads "waiting for players" while stale dots are visibly on the pitch.

        // Render-only name join (ADR-0016): displayName when the roster has it, else the pseudonymous id.
        // rosterRef is read here and NOWHERE written — the telemetry store stays pseudonymous.
        const label = rosterRef.current.get(t.playerId) ?? t.playerId;
        // Device-health cue (Phase 3): a thin ring in the health tone when something needs attention, so a
        // coach can spot a low battery / weak signal / backlogging tracker on the pitch itself. ok ⇒ no ring.
        const dh = health.current?.get(t.playerId);
        const healthLevel = dh ? deviceHealthLevel(dh, now) : null;

        if (freshness === 'fresh') {
          // Maintain the per-player buffer + trail off the genuinely-new fix (changed serverTs).
          let buf = buffers.get(t.playerId);
          if (!buf) {
            buf = emptyBuffer();
            buffers.set(t.playerId, buf);
          }
          pushFix(buf, { serverTs: t.serverTs, lat: t.lat, lon: t.lon });

          const pos = resolvePosition(buf, now, project, snapOnly) ?? { lat: t.lat, lon: t.lon };
          const [x, y] = toPx(pos.lat, pos.lon);

          // OFF PITCH (Phase 5, audit §6): a player outside the drawn rectangle used to be CLIPPED —
          // invisible, while the HUD kept counting them, so the coach read "11 players" over a pitch
          // showing ten. Now they are pinned to the nearest edge with a distinct marker, which is the
          // honest rendering: we know where they are, and it is not on the pitch.
          if (pitchFrame.isOffPitch(pos.lat, pos.lon)) {
            isoSince.set(t.playerId, null); // not on the pitch ⇒ not part of the teammate-distance scan
            const [cx2, cy2] = clampToBox(x, y, cssW, cssH, pal.dotRadius + 6);
            drawOffPitch(ctx, cx2, cy2, label, x, y, pal);
            if (healthLevel && healthLevel !== 'ok') drawHealthCue(ctx, cx2, cy2, healthLevel, pal);
            continue;
          }

          if (!snapOnly) {
            let trail = trails.get(t.playerId);
            if (!trail) {
              trail = [];
              trails.set(t.playerId, trail);
            }
            pushTrail(trail, { serverTs: t.serverTs, lat: t.lat, lon: t.lon });
            drawTrail(ctx, trail, toPx, pal);
          }

          // Phase-4 zone colour: classify the wire speed against THIS session's thresholds (the same
          // descending `>=` cascade the mirror + review breakdown use) and tint the dot. Colour is a glance
          // cue only — the accessible mirror carries the zone WORD (a11y; colour is never the sole signal).
          const zoneColour = ZONE_COLOR[speedZone(t.spd, thr)];
          // Phase-4 live distance glance: the per-player running metres (best-effort; resets on reconnect).
          const distM = distMap?.get(t.playerId)?.distM;

          // Record this fresh player for the post-loop isolation scan (planar metres for the metre gate,
          // px for the ring). Reuses the pre-sized scratch — no per-frame allocation.
          if (freshCount < MAX_TRACKED_PLAYERS) {
            const [mx, my] = project({ lat: pos.lat, lon: pos.lon });
            freshIds[freshCount] = t.playerId;
            freshMx[freshCount] = mx;
            freshMy[freshCount] = my;
            freshPx[freshCount] = x;
            freshPy[freshCount] = y;
            freshCount++;
          }

          drawHeadingArrow(ctx, x, y, t.hdg, t.spd, pal);
          drawPlayer(ctx, x, y, label, pal, 1, zoneColour);
          drawSpeed(ctx, x, y, t.spd, distM, pal);
          if (healthLevel && healthLevel !== 'ok') drawHealthCue(ctx, x, y, healthLevel, pal);
        } else {
          // 'stale': freeze at the last KNOWN raw position (not a smoothed/drifting one) and restyle
          // to an explicit "last known" look — hollow ring + age in seconds (ADR-0018). No zone colour
          // (it's frozen, not a live speed) and no isolation scan (only FRESH players are measured).
          // Reset the isolation clock: a stale player is NOT in this frame's scan, so without this the
          // clock would keep running across the stale gap and, on recovery within ISOLATION_MS, draw an
          // instant false-positive cue. Clearing here mirrors the "not isolated this frame" reset below.
          isoSince.set(t.playerId, null);
          const [rawX, rawY] = toPx(t.lat, t.lon);
          // A stale player who is ALSO off the pitch is pinned to the edge for the same reason as a
          // fresh one — otherwise the "last known" ring is drawn outside the canvas and simply vanishes.
          const offPitch = pitchFrame.isOffPitch(t.lat, t.lon);
          const [x, y] = offPitch ? clampToBox(rawX, rawY, cssW, cssH, pal.dotRadius + 6) : [rawX, rawY];
          drawStale(ctx, x, y, label, age, pal, offPitch);
          if (healthLevel && healthLevel !== 'ok') drawHealthCue(ctx, x, y, healthLevel, pal);
        }
      }

      // --- Isolated-player cue (Phase 4, §3.4): for each FRESH player, find the nearest OTHER fresh
      // player in planar metres; if that nearest teammate is farther than ISOLATION_M and has stayed so
      // for >= ISOLATION_MS, draw a distinct dashed ring. O(n^2) over <= MAX_TRACKED_PLAYERS fresh players
      // (<= ~4096 squared-distance comparisons at the 64 cap) — cheap, and allocation-free (squared metres,
      // reused scratch). A lone fresh player (freshCount < 2) is never isolated: there's no teammate to
      // measure against, so we skip the scan entirely and clear any stale isolation clocks below.
      for (let i = 0; i < freshCount; i++) {
        const id = freshIds[i];
        let isolated = false;
        if (freshCount >= 2) {
          let nearest2 = Infinity; // nearest squared-metre distance to any OTHER fresh player
          const xi = freshMx[i];
          const yi = freshMy[i];
          for (let j = 0; j < freshCount; j++) {
            if (j === i) continue;
            const dx = xi - freshMx[j];
            const dy = yi - freshMy[j];
            const d2 = dx * dx + dy * dy;
            if (d2 < nearest2) nearest2 = d2;
          }
          isolated = nearest2 > ISO_M2;
        }
        if (isolated) {
          const since = isoSince.get(id);
          if (since == null) {
            isoSince.set(id, now); // start the sustained-isolation clock
          } else if (now - since >= ISOLATION_MS) {
            drawIsolatedCue(ctx, freshPx[i], freshPy[i], pal); // sustained long enough → flag it
          }
        } else {
          isoSince.set(id, null); // not isolated this frame → reset the clock (next isolation re-arms it)
        }
      }

      // GC smoothing + isolation state for players that have fully dropped, so the maps don't grow
      // unbounded (isoSince is keyed by playerId exactly like buffers/trails — same GC discipline).
      if (buffers.size > live.size) {
        for (const id of buffers.keys()) if (!live.has(id)) buffers.delete(id);
        for (const id of trails.keys()) if (!live.has(id)) trails.delete(id);
      }
      if (isoSince.size > live.size) {
        for (const id of isoSince.keys()) if (!live.has(id)) isoSince.delete(id);
      }

      drawHud(ctx, connRef.current, active, pal);
    };

    // --- Wiring: ResizeObserver drives geometry; visibilitychange pauses the loop. ---
    recomputeGeometry();
    const ro = new ResizeObserver(() => recomputeGeometry());
    ro.observe(container);

    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf); // stop burning battery while the tab/screen is hidden
      } else if (!running) {
        running = true;
        lastFrame = 0;
        raf = requestAnimationFrame(frame);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    raf = requestAnimationFrame(frame);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // store + health + dist are stable refs (read inside the rAF loop); roster/conn/theme/thresholds are
    // mirrored into refs above so the loop sees the latest without restarting. Listing the refs satisfies
    // exhaustive-deps (dist is added for Phase 4 — same stable-ref discipline as store/health).
    // `corners` (Phase 5) is NOT mirrored into a ref: the pitch geometry is baked into the homography
    // and the static layer, so a new pitch must rebuild both — i.e. re-run this effect. Its identity is
    // stable between renders (a session-config object or the module constant), so this cannot thrash.
  }, [store, health, dist, corners]);

  return (
    <div
      ref={containerRef}
      // The container is the responsive sizing authority — the canvas tracks its width via the
      // ResizeObserver. Integrator: give this a width (it fills its parent); height follows aspect.
      style={{ width: '100%', maxWidth: 1100, lineHeight: 0 }}
    >
      <canvas
        ref={canvasRef}
        style={{
          borderRadius: 10,
          background: '#1b7a36', // shown only for the first paint before the static layer blits
          boxShadow: '0 6px 30px rgba(0,0,0,.35)',
          display: 'block',
          width: '100%',
        }}
      />
    </div>
  );
}

function drawPitch(ctx: CanvasRenderingContext2D, dst: Pt[], pxPerM: number, pal: Palette) {
  ctx.strokeStyle = pal.line;
  ctx.lineWidth = pal.lineWidth;

  // boundary
  ctx.beginPath();
  ctx.moveTo(dst[0][0], dst[0][1]);
  for (let i = 1; i < 4; i++) ctx.lineTo(dst[i][0], dst[i][1]);
  ctx.closePath();
  ctx.stroke();

  // halfway line: midpoint of top touchline -> midpoint of bottom touchline
  const midTop: Pt = [(dst[0][0] + dst[1][0]) / 2, (dst[0][1] + dst[1][1]) / 2];
  const midBot: Pt = [(dst[3][0] + dst[2][0]) / 2, (dst[3][1] + dst[2][1]) / 2];
  ctx.beginPath();
  ctx.moveTo(midTop[0], midTop[1]);
  ctx.lineTo(midBot[0], midBot[1]);
  ctx.stroke();

  // centre circle + spot
  const cx = (dst[0][0] + dst[1][0] + dst[2][0] + dst[3][0]) / 4;
  const cy = (dst[0][1] + dst[1][1] + dst[2][1] + dst[3][1]) / 4;
  ctx.beginPath();
  ctx.arc(cx, cy, 9.15 * pxPerM, 0, Math.PI * 2); // 9.15 m centre circle
  ctx.stroke();
  ctx.beginPath();
  ctx.fillStyle = pal.line;
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fill();
}

/** Short faded tail of recent received positions — presentation only (omitted under reduced motion). */
function drawTrail(
  ctx: CanvasRenderingContext2D,
  trail: TrailPoint[],
  toPx: (lat: number, lon: number) => Pt,
  pal: Palette,
) {
  // Oldest points faintest; the newest trail point sits just behind the live dot.
  for (let i = 0; i < trail.length; i++) {
    const [x, y] = toPx(trail[i].lat, trail[i].lon);
    const alpha = ((i + 1) / trail.length) * 0.5; // up to 50% so it never competes with the dot
    ctx.beginPath();
    ctx.fillStyle = `${pal.trail}${alpha})`;
    ctx.arc(x, y, Math.max(2, pal.dotRadius * 0.4), 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Heading arrow + a small speed cue. Both are driven by `spd`/`hdg` from the wire and are VISUAL
 * ONLY — never used for position (ADR-0018). `hdg` is degrees clockwise from north; canvas y is
 * down, so north (0deg) points up: dx=sin, dy=-cos.
 */
function drawHeadingArrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  hdg: number,
  spd: number,
  pal: Palette,
) {
  if (!Number.isFinite(hdg) || !Number.isFinite(spd) || spd < 0.3) return; // hide when ~stationary
  const rad = (hdg * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const len = pal.dotRadius + 10; // a short stub past the dot edge
  const x2 = x + dx * len;
  const y2 = y + dy * len;
  ctx.strokeStyle = pal.arrow;
  ctx.lineWidth = pal.lineWidth;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  // arrowhead
  const head = 5;
  const left = rad - Math.PI * 0.85;
  const right = rad + Math.PI * 0.85;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 + Math.sin(left) * head, y2 - Math.cos(left) * head);
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 + Math.sin(right) * head, y2 - Math.cos(right) * head);
  ctx.stroke();
}

function drawPlayer(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  label: string,
  pal: Palette,
  alpha: number,
  // Phase-4 zone tint (ZONE_COLOR[speedZone(...)]) — a glance cue for the player's current speed zone.
  // Falls back to the palette dot when absent so any non-zone caller keeps the original look.
  fill: string = pal.dot,
) {
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(x, y, pal.dotRadius, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = pal.lineWidth;
  ctx.strokeStyle = pal.dotStroke;
  ctx.stroke();

  ctx.fillStyle = pal.label;
  ctx.font = `bold ${Math.round(pal.dotRadius * 1.1)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x, y);
  ctx.globalAlpha = 1;
}

/**
 * Small "x.x m/s" readout beside the dot — the only place `spd` is surfaced numerically — with the
 * Phase-4 live running distance appended ("x.x m/s · NNN m") when an accumulator value is present. The
 * distance is a best-effort live glance (it resets on reconnect — NOT "the player stopped"); the
 * authoritative distance is the server review aggregate.
 */
function drawSpeed(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  spd: number,
  distM: number | undefined,
  pal: Palette,
) {
  if (!Number.isFinite(spd) || spd < 0.3) return;
  const text =
    distM != null && Number.isFinite(distM)
      ? `${spd.toFixed(1)} m/s · ${Math.round(distM)} m`
      : `${spd.toFixed(1)} m/s`;
  ctx.fillStyle = pal.label;
  ctx.font = '9px ui-monospace, SFMono-Regular, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + pal.dotRadius + 4, y + pal.dotRadius + 4);
}

/**
 * Stale player: frozen at the last known position, drawn as a hollow ring + age in seconds so the
 * coach reads it as "last known", never as a live drifting dot (ADR-0018).
 */
function drawStale(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  label: string,
  ageMs: number,
  pal: Palette,
  /** Pinned to the canvas edge because the last known position is off the pitch (Phase 5). */
  offPitch = false,
) {
  ctx.beginPath();
  ctx.arc(x, y, pal.dotRadius, 0, Math.PI * 2);
  ctx.lineWidth = pal.lineWidth;
  ctx.strokeStyle = pal.staleRing;
  ctx.stroke(); // hollow ring, no fill

  ctx.fillStyle = pal.staleRing;
  ctx.font = `bold ${Math.round(pal.dotRadius * 1.1)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x, y);

  ctx.font = '9px ui-monospace, SFMono-Regular, monospace';
  ctx.textBaseline = 'top';
  ctx.fillText(`${Math.round(ageMs / 1000)}s${offPitch ? ' · off pitch' : ''}`, x, y + pal.dotRadius + 2);
}

/** Keep a point inside the canvas box, inset by `pad`. Used to pin an off-pitch player to the edge. */
function clampToBox(x: number, y: number, w: number, h: number, pad: number): [number, number] {
  const cx = Number.isFinite(x) ? Math.min(Math.max(x, pad), Math.max(pad, w - pad)) : pad;
  const cy = Number.isFinite(y) ? Math.min(Math.max(y, pad), Math.max(pad, h - pad)) : pad;
  return [cx, cy];
}

/**
 * Off-pitch player (Phase 5; audit §6 "Client"): pinned to the nearest canvas edge and drawn as a
 * DIAMOND — a shape nothing else on the pitch uses, so it reads as "not a normal dot" at a glance —
 * with a short arrow pointing the way they actually are. The accessible mirror carries the same fact
 * as the word "off pitch", so shape is never the only signal.
 */
function drawOffPitch(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  label: string,
  trueX: number,
  trueY: number,
  pal: Palette,
) {
  const r = pal.dotRadius;
  // Direction from the pinned point toward where the player really is (may be far off-canvas).
  const dx = trueX - x;
  const dy = trueY - y;
  const len = Math.hypot(dx, dy);
  if (len > 1) {
    ctx.strokeStyle = pal.staleRing;
    ctx.lineWidth = pal.lineWidth;
    ctx.beginPath();
    ctx.moveTo(x + (dx / len) * (r + 2), y + (dy / len) * (r + 2));
    ctx.lineTo(x + (dx / len) * (r + 10), y + (dy / len) * (r + 10));
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.lineWidth = pal.lineWidth;
  ctx.strokeStyle = pal.staleRing;
  ctx.stroke(); // hollow: an off-pitch player is not a live position ON the pitch

  ctx.fillStyle = pal.staleRing;
  ctx.font = `bold ${Math.round(r * 0.95)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x, y);

  ctx.font = '9px ui-monospace, SFMono-Regular, monospace';
  ctx.textBaseline = 'top';
  ctx.fillText('off pitch', x, y + r + 2);
}

/**
 * Device-health cue: a thin ring just outside the dot in the health tone (warn=amber, bad=red), drawn ONLY
 * when a tracker needs attention (low battery / weak signal / backlog / stale status). Cheap — one stroked
 * arc per flagged player; ok-health players get nothing so the pitch stays uncluttered (perf #2). This is a
 * glanceable hint; the accessible mirror's Device column carries the authoritative, AT-readable detail.
 */
function drawHealthCue(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  level: ConnectionTone,
  pal: Palette,
) {
  ctx.beginPath();
  ctx.arc(x, y, pal.dotRadius + 4, 0, Math.PI * 2);
  ctx.lineWidth = pal.lineWidth;
  ctx.strokeStyle = TONE_COLOUR[level];
  ctx.stroke();
}

/**
 * Isolated-player cue (Phase 4, §3.4): a distinct DASHED ring outside the dot (and outside the device-health
 * ring) for a fresh player who has been farther than ISOLATION_M from every fresh teammate for >= ISOLATION_MS.
 * The dash pattern makes it read differently from the solid health ring at a glance. Cheap — one stroked arc
 * per flagged player. The dash is reset immediately so it never bleeds into the HUD's solid strokes this frame.
 */
function drawIsolatedCue(ctx: CanvasRenderingContext2D, x: number, y: number, pal: Palette) {
  ctx.beginPath();
  ctx.setLineDash([4, 4]);
  ctx.arc(x, y, pal.dotRadius + 8, 0, Math.PI * 2);
  ctx.lineWidth = pal.lineWidth;
  ctx.strokeStyle = pal.staleRing; // a neutral, theme-aware ring colour (white-ish) — not a health/zone tone
  ctx.stroke();
  ctx.setLineDash([]); // restore solid strokes for everything drawn after this
}

/**
 * HUD: status dot + label from `describeConnection` (so the canvas text matches the accessible
 * mirror exactly) and player count. Colour comes from the shared tone — but the text carries the
 * same info, so colour is never the only signal (a11y).
 */
function drawHud(
  ctx: CanvasRenderingContext2D,
  conn: ConnectionState,
  active: number,
  pal: Palette,
) {
  const { label, tone } = describeConnection(conn, active);
  const text = label;
  ctx.font = '12px ui-monospace, SFMono-Regular, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 50;
  ctx.fillStyle = pal.hud;
  ctx.fillRect(10, 10, w, 30);
  ctx.fillStyle = TONE_COLOUR[tone];
  ctx.beginPath();
  ctx.arc(26, 25, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = pal.hudText;
  ctx.fillText(text, 40, 25);
}
