/**
 * Player-name roster store (Phase 3; ADR-0016 player-name roster, within ADR-0010 minimisation).
 * See docs/frontend/phase-3-contract.md §1.1/§1.3/§1.4 + §0 standing invariants.
 *
 * THIS IS THE ONLY PLACE PLAYER NAMES LIVE AT REST. The telemetry DB, every history row, every
 * Prometheus label/HELP line, every structured log line, and all client persistence stay pseudonymous
 * (playerId only). Names exist in exactly two places: (a) this access-controlled file at rest, and
 * (b) the coach-screen render + the operator's own CLI/console. The roster endpoint (server.ts) gates
 * the file's contents behind auth+origin+session-scope+rate-limit+no-store before any name leaves the box.
 *
 * Modelled EXACTLY on auth.ts's accounts loader so its security properties carry over: async (never blocks
 * the shared Bun event loop that also runs the MQTT ingest + WS fan-out), fail-closed (a missing/malformed/
 * oversized/duplicate roster → 0 names, never a crash, never names from a stale cache), size-capped, and
 * periodically reloaded so a CLI edit takes effect without a server restart.
 *
 * INVARIANT §0.1: this module MUST NEVER log a displayName value. Every WARN/ERROR carries the playerId
 * (pseudonymous) and/or counts ONLY — a name in a log line would defeat the whole minimisation posture.
 */
import { readFile, stat, writeFile } from 'node:fs/promises';
import { log } from './log';

// ----- config (env) ---------------------------------------------------------------------
const ROSTER_FILE = process.env.AUTH_ROSTER_FILE ?? './roster.json';
const RELOAD_MS = Math.max(1, Number(process.env.AUTH_ROSTER_RELOAD_SECONDS ?? 15)) * 1000;
const ROSTER_MAX_BYTES = 1_000_000; // mirrors auth.ts MAX_ACCOUNTS_BYTES — over cap = 0 names (fail closed)
const ROSTER_NAME_MAX = 64; // max displayName length in chars
// Per-session player cap == MAX_TRACKED_PLAYERS (the live store's cap); a session can't roster more
// players than it can ever render, and it bounds the worst-case file/response size.
const ROSTER_MAX_PLAYERS_PER_SESSION = 64;

// playerId charset/length bound — the SAME shape as auth.ts's SESSION_ID_RE so a roster playerId can't be
// attacker-shaped beyond what the rest of the pipeline already accepts on the wire/topic.
const PLAYER_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** A single roster entry as it appears in the file and in the endpoint response. */
export interface RosterEntry {
  playerId: string;
  displayName: string;
}

// ----- state -----------------------------------------------------------------------------
// sessionId → (playerId → displayName). A Map-of-Maps mirrors auth.ts's `accounts` Map: O(1) lookup,
// insertion-order-stable, and the inner Map's key uniqueness is what the duplicate-playerId rule enforces.
let roster = new Map<string, Map<string, string>>();

// ----- roster: load + validate (fail closed, never crash) --------------------------------
// Async (node:fs/promises) so the periodic reload never blocks the shared Bun event loop. `file` is
// parameterised (defaults to ROSTER_FILE) ONLY so the fail-closed validation can be unit-tested directly
// against fixtures (mirrors loadAccounts); production callers pass no argument.
export async function loadRoster(
  file: string = ROSTER_FILE,
): Promise<Map<string, Map<string, string>>> {
  let size = 0;
  try {
    size = (await stat(file)).size;
  } catch {
    // Missing file → 0 names. A session with no roster is a VALID posture (ids-only render), so this is
    // not a dangerous misconfiguration — no WARN beyond the one-time info initRoster emits.
    return new Map();
  }
  if (size > ROSTER_MAX_BYTES) {
    log.warn('roster: file exceeds size cap — ignoring (0 names, fail closed)', {
      bytes: size,
      cap: ROSTER_MAX_BYTES,
    });
    return new Map();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    // Content-free error: a V8 JSON SyntaxError message can embed a SNIPPET of the offending file content,
    // and THIS file holds child names — so log only the error TYPE, never String(e) (the §0.1 guard).
    log.warn('roster: file is not valid JSON — 0 names (fail closed)', { err: e instanceof Error ? e.name : 'parse_error' });
    return new Map();
  }
  const sessions = (parsed as { sessions?: unknown })?.sessions;
  if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) {
    log.warn('roster: file has no "sessions" object — 0 names (fail closed)');
    return new Map();
  }

  const map = new Map<string, Map<string, string>>();
  for (const [sessionId, rawEntries] of Object.entries(sessions as Record<string, unknown>)) {
    if (!Array.isArray(rawEntries)) {
      log.warn('roster: session value is not an array — skipping that session', { session: sessionId });
      continue;
    }
    const players = new Map<string, string>();
    let rejected = false;
    for (const raw of rawEntries) {
      const e = raw as Partial<RosterEntry>;
      if (!e || typeof e.playerId !== 'string' || !PLAYER_ID_RE.test(e.playerId)) {
        // Bad/missing playerId — drop the entry. Log NO name value (§0.1); we may not even have a valid id.
        log.warn('roster: dropping entry with missing/invalid playerId', {
          session: sessionId,
          playerId: typeof e?.playerId === 'string' ? e.playerId.slice(0, 64) : null,
        });
        continue;
      }
      if (typeof e.displayName !== 'string' || e.displayName.length === 0 || e.displayName.length > ROSTER_NAME_MAX) {
        // Bad displayName — drop the entry. CRITICAL (§0.1): log the playerId + a length, NEVER the value.
        log.warn('roster: dropping entry with invalid displayName (logging playerId + length only)', {
          session: sessionId,
          playerId: e.playerId,
          nameLength: typeof e.displayName === 'string' ? e.displayName.length : null,
          nameMax: ROSTER_NAME_MAX,
        });
        continue;
      }
      if (players.has(e.playerId)) {
        // A duplicate playerId within one session is an identity-confusion hazard (which name wins for this
        // dot?) — mirror auth.ts's duplicate-username rule and reject the WHOLE session's roster (0 names for
        // it). Log the playerId (pseudonymous), NEVER either name value.
        log.error('roster: DUPLICATE playerId in a session — rejecting that entire session (0 names, fail closed)', {
          session: sessionId,
          playerId: e.playerId,
        });
        rejected = true;
        break;
      }
      if (players.size >= ROSTER_MAX_PLAYERS_PER_SESSION) {
        // Excess beyond the per-session cap — drop (WARN). playerId only, never the name.
        log.warn('roster: session exceeds player cap — dropping excess entry', {
          session: sessionId,
          playerId: e.playerId,
          cap: ROSTER_MAX_PLAYERS_PER_SESSION,
        });
        continue;
      }
      players.set(e.playerId, e.displayName);
    }
    if (rejected) continue; // duplicate → that whole session gets 0 names
    if (players.size > 0) map.set(sessionId, players);
  }
  return map;
}

// ----- periodic reload (re-entrancy guarded, like auth.ts.reload) ------------------------
let reloading = false;
async function reload(): Promise<void> {
  if (reloading) return; // never let a slow file read pile up overlapping reloads (and race the swap)
  reloading = true;
  try {
    roster = await loadRoster();
  } finally {
    reloading = false;
  }
}

/**
 * Load the roster, start the periodic reload timer, and emit ONE info with the session/entry COUNT (never
 * any name). Awaited by server.ts before it serves. The reload picks up CLI edits within
 * AUTH_ROSTER_RELOAD_SECONDS, mirroring auth.ts's accounts reload.
 */
export async function initRoster(): Promise<void> {
  roster = await loadRoster();
  let entries = 0;
  for (const players of roster.values()) entries += players.size;
  log.info('roster: loaded', { sessions: roster.size, entries }); // COUNTS only — never names
  setInterval(() => void reload(), RELOAD_MS).unref?.(); // async; fire-and-forget (re-entrancy-guarded)
}

/**
 * The roster endpoint's data source: the entries for ONE session. Returns [] for an unknown session — a
 * session may legitimately have no roster (ids-only is a valid posture), so this is never an error.
 */
export function rosterFor(sessionId: string): RosterEntry[] {
  const players = roster.get(sessionId);
  if (!players) return [];
  return [...players].map(([playerId, displayName]) => ({ playerId, displayName }));
}

// ----- erasure (§1.4; ADR-0016 + ADR-0010) -----------------------------------------------
/**
 * Right-to-erasure: delete a player's roster entry from one session (when `sessionId` is given) or every
 * session, REWRITE the file mode 0o600, and reload the in-memory map. Returns the number of entries removed.
 *
 * Operates on the file directly (read → mutate → write) so BOTH a one-shot CLI run (purge-player.ts) AND the
 * running server's next periodic reload are authoritative — there is no in-memory-only state that a separate
 * process could miss. A player absent from the roster → 0 (the erasure goal is still met; the caller exits 0).
 */
export async function purgeRosterPlayer(playerId: string, sessionId?: string): Promise<number> {
  // Read the on-disk file directly (not the in-memory map) so a one-shot CLI run sees current state and the
  // rewrite is authoritative. Reuse the fail-closed loader for the read so a corrupt file can't be made worse.
  const onDisk = await loadRoster();
  let removed = 0;
  for (const [sid, players] of onDisk) {
    if (sessionId !== undefined && sid !== sessionId) continue;
    if (players.delete(playerId)) removed += 1;
  }
  if (removed > 0) {
    // Rewrite the file in the same {sessions:{<id>:[{playerId,displayName}]}} shape, dropping now-empty
    // sessions. Mode 0o600 (owner-only — it holds child names), matching the CLI's write posture.
    const out: { sessions: Record<string, RosterEntry[]> } = { sessions: {} };
    for (const [sid, players] of onDisk) {
      if (players.size === 0) continue;
      out.sessions[sid] = [...players].map(([pid, displayName]) => ({ playerId: pid, displayName }));
    }
    await writeFile(ROSTER_FILE, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
  }
  // Reload the in-memory map so a long-running server picks up the change immediately rather than at its
  // next periodic reload (and so a test asserting rosterFor() after a purge sees the result deterministically).
  await reload();
  return removed;
}
