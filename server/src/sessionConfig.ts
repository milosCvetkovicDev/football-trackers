/**
 * Per-session coaching config — the age band that selects youth speed-zone thresholds (Phase 4; ADR-0019,
 * within metric-definitions.md §1/§3). See docs/frontend/phase-4-contract.md §2.
 *
 * Modelled EXACTLY on roster.ts (async fail-closed load, size-cap, periodic reload) so its robustness carries
 * over. UNLIKE the roster, the age band is NOT a name or location — it is non-sensitive config — so there is no
 * name-leak concern here and the config endpoint needs no `no-store`/rate-limit. Still fail-closed: a missing/
 * malformed/oversized file → 0 configured sessions, and every session then resolves to the documented DEFAULT
 * band (U14) so zones ALWAYS render.
 *
 * THIS MODULE IS THE SINGLE SOURCE OF TRUTH for the band→threshold mapping (the §3.2 table). The client never
 * re-implements it — it receives resolved thresholds from GET /sessions/:id/config — and the server review
 * aggregate reads the same band, so live colour and review breakdown can never disagree.
 */
import { readFile, stat } from 'node:fs/promises';
import { envNumber, envString } from './env';
import { log } from './log';
import type { AgeBand, LatLon, ZoneThresholds } from './types';

// ----- config (env) ---------------------------------------------------------------------
const CONFIG_FILE = envString('SESSION_CONFIG_FILE', './session-config.json');
const RELOAD_MS = envNumber('SESSION_CONFIG_RELOAD_SECONDS', 15, { min: 1, max: 2_147_483 }) * 1000; // max: 32-bit timer clamp
const CONFIG_MAX_BYTES = 1_000_000; // over cap → 0 configured sessions (defaults apply), never a crash
const BANDS: readonly AgeBand[] = ['U12', 'U14', 'U16', 'U19'];

/** The default band for an unconfigured session — documented in ADR-0019 so zones always resolve. */
export const DEFAULT_AGE_BAND: AgeBand = 'U14';

// The §3.2 youth threshold table — the ONE place the band→threshold mapping lives. Zones 1–3 use the FIXED
// adult walking/jogging/running breaks (2.0 / 4.0 m/s); only HSR and Sprint scale by age. These values are
// transcribed verbatim from metric-definitions.md §3.2 — do NOT invent or "round" them (a wrong cut-off makes
// a child's sprint metric a measurement artefact, the exact failure §0 of that doc warns against).
const THRESHOLDS: Record<AgeBand, ZoneThresholds> = {
  U12: { jogMps: 2.0, runMps: 4.0, hsrMps: 4.44, sprintMps: 5.28 },
  U14: { jogMps: 2.0, runMps: 4.0, hsrMps: 4.86, sprintMps: 5.83 },
  U16: { jogMps: 2.0, runMps: 4.0, hsrMps: 5.28, sprintMps: 6.39 },
  U19: { jogMps: 2.0, runMps: 4.0, hsrMps: 5.5, sprintMps: 6.94 },
};

function isBand(v: unknown): v is AgeBand {
  return typeof v === 'string' && (BANDS as readonly string[]).includes(v);
}

// ----- the pitch (Phase 5; audit §6 "Client") ---------------------------------------------
// The four GPS corners used to be a compile-time constant in the client bundle — and the committed
// value pointed at a bench in Belgrade, so every real pitch mapped to the wrong box and a coach had
// to edit source and rebuild to fix it. They live here now, per session, served by
// GET /sessions/:id/config alongside the band.
//
// THE SERVER VALIDATES THE GEOMETRY because the CLIENT solves a homography from these four points:
// a degenerate quad throws inside that solve and white-screens the coach view mid-match. These rules
// MUST match client/src/pitchFrame.ts parsePitchCorners (which re-validates defensively — nothing
// off the wire is trusted there either); the duplication is deliberate and marked on both sides.
const PITCH_MIN_SIDE_M = 10;   // a youth 5-a-side pitch is ~30 x 20
const PITCH_MAX_SIDE_M = 250;  // the laws cap a pitch at 120 x 90; beyond this is a units mistake
const MIN_CORNER_SEPARATION_M = 1;
const M_PER_DEG_LAT = 111_320;

/** Equirectangular projection to metres around `ref` — mirrors client/src/geo.ts makeProjector. */
function projector(ref: LatLon): (p: LatLon) => [number, number] {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((ref.lat * Math.PI) / 180);
  return ({ lat, lon }) => [(lon - ref.lon) * mPerDegLon, (lat - ref.lat) * M_PER_DEG_LAT];
}

function inRange(v: unknown, lo: number, hi: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
}

/**
 * Validate a `pitch: { corners: [TL, TR, BR, BL] }` entry. Returns fresh `{lat, lon}` literals, or null
 * when the quad is unusable — in which case the session keeps its band and the client keeps its
 * built-in corners. Rejects: wrong arity/shape, out-of-range coordinates, coincident or collinear
 * corners (the solver throws), a self-crossing order (it solves, but folds the pitch over itself and
 * maps players to mirrored nonsense), and sides outside plausible pitch dimensions.
 *
 * KNOWN LIMIT, shared with the client's copy: the flat-plane projection means a quad straddling the
 * ±180° meridian projects to a ~40 000 km "side" and is rejected by the length bound rather than
 * wrapped. The consequence is a fallback to the built-in corners, never a wrong mapping.
 * (A 426-quad differential run — both hemispheres, 78°N, the antimeridian, 400 random quads — found
 * zero disagreements between this validator and the client's.)
 */
export function validatePitchCorners(value: unknown): LatLon[] | null {
  const corners = (value as { corners?: unknown })?.corners;
  if (!Array.isArray(corners) || corners.length !== 4) return null;

  const out: LatLon[] = [];
  for (const raw of corners) {
    if (typeof raw !== 'object' || raw === null) return null;
    const c = raw as Record<string, unknown>;
    if (!inRange(c.lat, -90, 90) || !inRange(c.lon, -180, 180)) return null;
    out.push({ lat: c.lat, lon: c.lon }); // fresh literal — nothing else rides along
  }

  const project = projector(out[0]);
  const m = out.map(project);

  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      if (Math.hypot(m[i][0] - m[j][0], m[i][1] - m[j][1]) < MIN_CORNER_SEPARATION_M) return null;
    }
  }
  for (let i = 0; i < 4; i++) {
    const a = m[i];
    const b = m[(i + 1) % 4];
    const side = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (side < PITCH_MIN_SIDE_M || side > PITCH_MAX_SIDE_M) return null;
  }
  // Convex + consistently wound: every corner turns the same way, and none turns by ~nothing.
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = m[i];
    const [bx, by] = m[(i + 1) % 4];
    const [cx, cy] = m[(i + 2) % 4];
    const z = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(z) < 1) return null; // three collinear corners
    const s = z > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return null; // reflex corner ⇒ self-crossing quad
  }
  return out;
}

// ----- state -----------------------------------------------------------------------------
/** One session's resolved config. `pitchCorners` is absent unless a USABLE pitch was configured. */
export interface SessionEntry {
  ageBand: AgeBand;
  pitchCorners?: LatLon[];
}

let config = new Map<string, SessionEntry>(); // sessionId → entry (unset → DEFAULT_AGE_BAND, no pitch)

// ----- load + validate (fail closed, never crash) ---------------------------------------
// Async (node:fs/promises) so the periodic reload never blocks the shared Bun loop. `file` is parameterised
// (defaults to CONFIG_FILE) ONLY for unit-testing the validation against fixtures (mirrors loadRoster/loadAccounts).
export async function loadSessionConfig(file: string = CONFIG_FILE): Promise<Map<string, SessionEntry>> {
  let size = 0;
  try {
    size = (await stat(file)).size;
  } catch {
    return new Map(); // missing file → 0 configured sessions; the default band applies everywhere
  }
  if (size > CONFIG_MAX_BYTES) {
    log.warn('session-config: file exceeds size cap — ignoring (defaults apply)', { bytes: size, cap: CONFIG_MAX_BYTES });
    return new Map();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    // Content-free error (no file holds names here, but keep the roster-loader hygiene): log the TYPE only.
    log.warn('session-config: file is not valid JSON — defaults apply', { err: e instanceof Error ? e.name : 'parse_error' });
    return new Map();
  }
  const sessions = (parsed as { sessions?: unknown })?.sessions;
  if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) {
    log.warn('session-config: file has no "sessions" object — defaults apply');
    return new Map();
  }
  const map = new Map<string, SessionEntry>();
  for (const [sessionId, raw] of Object.entries(sessions as Record<string, unknown>)) {
    const band = (raw as { ageBand?: unknown })?.ageBand;
    if (!isBand(band)) {
      log.warn('session-config: dropping entry with invalid ageBand', {
        session: sessionId,
        ageBand: typeof band === 'string' ? band.slice(0, 16) : null,
      });
      continue;
    }
    const entry: SessionEntry = { ageBand: band };
    // A pitch is OPTIONAL, and an unusable one costs the session its PITCH only — never its band.
    // (Fail-closed here means "the client keeps its built-in corners", which still renders.)
    const pitch = (raw as { pitch?: unknown })?.pitch;
    if (pitch !== undefined) {
      const corners = validatePitchCorners(pitch);
      if (corners) entry.pitchCorners = corners;
      else log.warn('session-config: dropping unusable pitch (band kept)', { session: sessionId });
    }
    map.set(sessionId, entry);
  }
  return map;
}

// ----- periodic reload (re-entrancy guarded, like roster.ts/auth.ts) ---------------------
let reloading = false;
async function reload(): Promise<void> {
  if (reloading) return; // never let a slow read pile up overlapping reloads (and race the swap)
  reloading = true;
  try {
    config = await loadSessionConfig();
  } finally {
    reloading = false;
  }
}

/** Load the config + start the periodic reload. Awaited by server.ts before serving. */
export async function initSessionConfig(): Promise<void> {
  config = await loadSessionConfig();
  log.info('session-config: loaded', { sessions: config.size, default: DEFAULT_AGE_BAND });
  setInterval(() => void reload(), RELOAD_MS).unref?.();
}

/** The session's configured band, or the documented U14 default (so zones always resolve). */
/** Session ids with a configured band — for boot-time metric label seeding. */
export function configuredSessionIds(): string[] {
  return [...config.keys()];
}

export function ageBandFor(sessionId: string): AgeBand {
  return config.get(sessionId)?.ageBand ?? DEFAULT_AGE_BAND;
}

/**
 * The session's configured pitch corners (TL, TR, BR, BL), or null when none is configured or the
 * configured one was unusable. Null means "the client keeps its built-in corners" — the endpoint
 * omits the field entirely rather than sending a null, so no reader has to special-case one.
 */
export function pitchCornersFor(sessionId: string): LatLon[] | null {
  return config.get(sessionId)?.pitchCorners ?? null;
}

/** The youth zone thresholds for a band (the §3.2 table). */
export function thresholdsFor(band: AgeBand): ZoneThresholds {
  return THRESHOLDS[band];
}

/** Resolved thresholds for a session: band-or-default → thresholds. Used by the aggregate + the /config route. */
export function thresholdsForSession(sessionId: string): ZoneThresholds {
  return THRESHOLDS[ageBandFor(sessionId)];
}
