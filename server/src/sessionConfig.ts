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
import { log } from './log';
import type { AgeBand, ZoneThresholds } from './types';

// ----- config (env) ---------------------------------------------------------------------
const CONFIG_FILE = process.env.SESSION_CONFIG_FILE ?? './session-config.json';
const RELOAD_MS = Math.max(1, Number(process.env.SESSION_CONFIG_RELOAD_SECONDS ?? 15)) * 1000;
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

// ----- state -----------------------------------------------------------------------------
let config = new Map<string, AgeBand>(); // sessionId → configured band (unset → DEFAULT_AGE_BAND)

// ----- load + validate (fail closed, never crash) ---------------------------------------
// Async (node:fs/promises) so the periodic reload never blocks the shared Bun loop. `file` is parameterised
// (defaults to CONFIG_FILE) ONLY for unit-testing the validation against fixtures (mirrors loadRoster/loadAccounts).
export async function loadSessionConfig(file: string = CONFIG_FILE): Promise<Map<string, AgeBand>> {
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
  const map = new Map<string, AgeBand>();
  for (const [sessionId, raw] of Object.entries(sessions as Record<string, unknown>)) {
    const band = (raw as { ageBand?: unknown })?.ageBand;
    if (!isBand(band)) {
      log.warn('session-config: dropping entry with invalid ageBand', {
        session: sessionId,
        ageBand: typeof band === 'string' ? band.slice(0, 16) : null,
      });
      continue;
    }
    map.set(sessionId, band);
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
export function ageBandFor(sessionId: string): AgeBand {
  return config.get(sessionId) ?? DEFAULT_AGE_BAND;
}

/** The youth zone thresholds for a band (the §3.2 table). */
export function thresholdsFor(band: AgeBand): ZoneThresholds {
  return THRESHOLDS[band];
}

/** Resolved thresholds for a session: band-or-default → thresholds. Used by the aggregate + the /config route. */
export function thresholdsForSession(sessionId: string): ZoneThresholds {
  return THRESHOLDS[ageBandFor(sessionId)];
}
