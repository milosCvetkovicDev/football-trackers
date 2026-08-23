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
import { readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
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

// ----- permissive on-disk round-trip (erasure + pruning) ----------------------------------
// The serving loader above is fail-CLOSED: anything it does not understand becomes "0 names". That is right
// for serving and WRONG for mutation (audit §4.5 b+c): rewriting the file from the loader's filtered view
// silently dropped every entry it had rejected — a whole session on a duplicate id — and a purge that
// "found nothing" exited 0 with the name still on disk. Mutation therefore goes through THIS path: the raw
// JSON round-trip (the same one roster-user.ts uses), which preserves everything it is not asked to change
// and THROWS on a file it cannot read, so the CLI's non-zero exit fires instead of a success receipt.
//
// INVARIANT §0.1 still holds here: errors are content-free (a V8 JSON SyntaxError can quote the file, and a
// raw Node error carries a path — the path is fine, the content never is).

/** Per-session provisioning stamp, kept BESIDE `sessions` so the serving loader's shape is untouched. */
interface SessionMeta {
  updatedAt?: number; // epoch ms of the last roster-user.ts `set` for that session
}
/** The file as JSON, with unknown keys preserved. `sessions` is validated only as "an object". */
export interface RosterFileRaw {
  sessions: Record<string, unknown>;
  sessionMeta?: Record<string, SessionMeta>;
  [other: string]: unknown;
}

/** Exported for the CLIs so every tool validates ids the same way (a typo'd id must be a usage error, not "erased 0"). */
export { PLAYER_ID_RE };

/** The file's real location (a symlinked roster.json must be rewritten at its TARGET, not replaced by a copy). */
async function rosterTarget(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch {
    return file; // absent (or dangling) — rename will create it at the given path
  }
}

// ----- lock: every writer of the file (CLI purge, sweep prune, roster-user.ts) serialises on it ----
// Two unguarded read-modify-writes racing — the hourly sweep stamping/pruning while an operator runs
// purge-player.ts — let the sweep's rename land last and write a just-erased name back behind a success
// receipt. A lock file beside the roster (O_EXCL create, holder pid inside) prevents that.
//
// Breaking a lock: a holder whose pid is DEAD is broken at once; a LIVE holder is never broken, however
// old the lock (a long erasure must not have its lock pulled from under it) — the contender waits up to
// ROSTER_LOCK_WAIT_MS and then fails with the holder's pid and age. A lock we cannot read the pid from is
// treated as dead once older than ROSTER_LOCK_STALE_MS. The break itself is atomic (rename, then unlink):
// two contenders cannot both "break" the same lock and both proceed.
//
// Critical sections are kept to the file round-trip (milliseconds) — never across the DB delete.
const ROSTER_LOCK_WAIT_MS = 3_000;
const ROSTER_LOCK_STALE_MS = 60_000;
const ROSTER_LOCK_POLL_MS = 50;

/** A lock problem that no retry will fix (directory in the way, missing/unwritable parent) — exit 5 territory. */
export class RosterPermanentError extends Error {}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM'; // exists, not ours — treat as alive
  }
}

export async function withRosterLock<T>(fn: () => Promise<T>, file: string = ROSTER_FILE): Promise<T> {
  // Beside the CONFIGURED path (every writer in this repo uses the same AUTH_ROSTER_FILE string), not the
  // realpath target: a roster symlinked into a directory only the server can write must still be lockable
  // by the operator's CLI, which then fails honestly at the rename rather than at the lock.
  const lock = `${file}.lock`;
  const deadline = Date.now() + ROSTER_LOCK_WAIT_MS;
  for (;;) {
    try {
      await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') throw new RosterPermanentError(`roster lock ${lock} is not creatable (${code ?? 'error'}) — wrong AUTH_ROSTER_FILE path or directory permissions`);
    }
    // Someone holds it. Who, and are they alive?
    let ageMs = 0;
    let holderPid: number | undefined;
    try {
      const st = await stat(lock);
      ageMs = Date.now() - st.mtimeMs;
      if (st.isDirectory()) throw new RosterPermanentError(`roster lock ${lock} is a directory — remove it by hand`);
      const pid = Number((await readFile(lock, 'utf8')).trim());
      if (Number.isInteger(pid) && pid > 0) holderPid = pid;
    } catch (e) {
      if (e instanceof RosterPermanentError) throw e;
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') continue; // vanished — retry the create at once
    }
    const dead = holderPid !== undefined ? !pidAlive(holderPid) : ageMs > ROSTER_LOCK_STALE_MS;
    if (dead) {
      // Atomic break: only ONE contender's rename succeeds; the others see ENOENT and simply retry.
      const breaking = `${lock}.breaking.${process.pid}`;
      try {
        await rename(lock, breaking);
      } catch {
        continue;
      }
      try {
        await unlink(breaking);
      } catch (e) {
        throw new RosterPermanentError(`roster lock ${lock} is stale but cannot be removed (${(e as NodeJS.ErrnoException)?.code ?? 'error'}) — remove it by hand`);
      }
      log.warn('roster: broke a dead lock', { holderPid: holderPid ?? null, ageMs: Math.round(ageMs) }); // never a name
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`roster file is locked by another writer: ${lock} held by pid ${holderPid ?? '?'} (alive) for ${Math.round(ageMs / 1000)} s — a purge, the retention sweep or roster-user is running; retry when it finishes`);
    }
    await new Promise((r) => setTimeout(r, ROSTER_LOCK_POLL_MS));
  }
  try {
    return await fn();
  } finally {
    await unlink(lock).catch(() => undefined);
  }
}

/** Read the roster file as-is. `null` = no file (a valid posture). Throws a content-free error otherwise. */
export async function readRosterFile(file: string = ROSTER_FILE): Promise<RosterFileRaw | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    const code = (e as NodeJS.ErrnoException)?.code ?? 'error';
    if (code === 'EACCES' || code === 'EPERM' || code === 'EISDIR' || code === 'ENOTDIR') throw new RosterPermanentError(`roster file is not readable (${code}) — fix the path or permissions`);
    throw new Error(`roster file is not readable (${code})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RosterPermanentError('roster file is not valid JSON — fix or restore it, then re-run (roster unchanged)');
  }
  const sessions = (parsed as { sessions?: unknown })?.sessions;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !sessions || typeof sessions !== 'object' || Array.isArray(sessions)) {
    throw new RosterPermanentError('roster file has no "sessions" object — fix or restore it, then re-run (roster unchanged)');
  }
  return parsed as RosterFileRaw;
}

/** sessionMeta as a prototype-free map (a session literally named "__proto__" must be an own key, not the prototype). */
function metaOf(raw: RosterFileRaw): Record<string, SessionMeta> {
  const out: Record<string, SessionMeta> = Object.create(null);
  const m = raw.sessionMeta;
  if (m && typeof m === 'object' && !Array.isArray(m)) {
    for (const k of Object.keys(m)) {
      const v = (m as Record<string, unknown>)[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = v as SessionMeta;
    }
  }
  return out;
}

/**
 * Atomic rewrite (temp + rename at the file's REAL path) mode 0o600 — a crash mid-write must never leave
 * a half-written name file, and a failed rename must never leave the temp copy behind. Errors are
 * content-free (code only).
 */
async function writeRosterRaw(file: string, raw: RosterFileRaw): Promise<void> {
  const target = await rosterTarget(file);
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const text = JSON.stringify(raw, null, 2) + '\n';
  if (Buffer.byteLength(text) > ROSTER_MAX_BYTES) {
    // The serving loader will refuse a file over the cap (0 names). Still write — erasure must not be
    // blocked by size — but say so, with sizes only.
    log.warn('roster: rewritten file exceeds the serving size cap — the server will serve 0 names until it is trimmed', { bytes: Buffer.byteLength(text), cap: ROSTER_MAX_BYTES });
  }
  try {
    await writeFile(tmp, text, { mode: 0o600, flag: 'wx' });
    await rename(tmp, target);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    const code = (e as NodeJS.ErrnoException)?.code ?? 'error';
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || code === 'ENOENT' || code === 'ENOTDIR') throw new RosterPermanentError(`roster file is not writable (${code}) — fix the path or permissions`);
    throw new Error(`roster file is not writable (${code})`);
  }
}

// ----- erasure (§1.4; ADR-0016 + ADR-0010) -----------------------------------------------
/**
 * Right-to-erasure: delete a player's roster entry from one session (when `sessionId` is given) or every
 * session, rewrite the file (atomically, mode 0o600), verify by re-reading, and reload the in-memory map.
 * Returns the number of entries removed — EVERY occurrence, so a duplicated id is erased rather than skipped.
 *
 * Operates on the file directly (read → mutate → write) so BOTH a one-shot CLI run (purge-player.ts) AND the
 * running server's next periodic reload are authoritative. A player absent from the roster → 0 (the erasure
 * goal is still met; the caller exits 0). An UNREADABLE file throws — the caller must report failure, never
 * "nothing to erase". Everything not targeted (other sessions, entries the serving loader would reject,
 * unknown keys) is preserved.
 *
 * Callers take withRosterLock around this. The CLI additionally reads the file (under the lock) BEFORE it
 * deletes any DB rows, so "roster unreadable" really means nothing was changed.
 */
export async function purgeRosterPlayer(playerId: string, sessionId?: string): Promise<number> {
  const raw = await readRosterFile();
  let removed = 0;
  if (raw) {
    const meta = metaOf(raw);
    for (const [sid, entries] of Object.entries(raw.sessions)) {
      if (sessionId !== undefined && sid !== sessionId) continue;
      if (!Array.isArray(entries)) continue; // not ours to interpret — leave it exactly as found (checked below)
      const kept = entries.filter((e) => !(e && typeof e === 'object' && (e as { playerId?: unknown }).playerId === playerId));
      if (kept.length === entries.length) continue;
      removed += entries.length - kept.length;
      if (kept.length > 0) raw.sessions[sid] = kept;
      else {
        delete raw.sessions[sid]; // the targeted session is now empty — drop it and its stamp (tidy, like roster-user remove)
        delete meta[sid];
      }
    }
    if (removed > 0) {
      if (raw.sessionMeta !== undefined || Object.keys(meta).length > 0) raw.sessionMeta = meta;
      await writeRosterRaw(ROSTER_FILE, raw);
    }
    // Verify by re-reading what is now on disk: the id must not appear ANYWHERE in the targeted sessions — not
    // as a recognised entry (a writer slipping past the lock), and not inside a structure the rewrite above
    // does not interpret (a hand-edited nesting). Either way "erased" would be a lie; fail so the operator fixes it.
    const check = removed > 0 ? await readRosterFile() : raw;
    for (const [sid, entries] of Object.entries(check?.sessions ?? {})) {
      if (sessionId !== undefined && sid !== sessionId) continue;
      if (mentionsPlayer(entries, playerId)) {
        if (Array.isArray(entries) && entries.some((e) => e && typeof e === 'object' && (e as { playerId?: unknown }).playerId === playerId)) {
          throw new Error('roster rewrite verification failed — the entry is still present; retry');
        }
        throw new RosterPermanentError(`roster session "${sid}" names the player inside an unrecognised structure the erasure cannot rewrite — fix the file by hand, then re-run`);
      }
    }
  }
  // Reload the in-memory map so a long-running server picks up the change immediately rather than at its
  // next periodic reload (and so a test asserting rosterFor() after a purge sees the result deterministically).
  await reload();
  return removed;
}

/** Does this JSON value, at any depth, contain an object whose playerId === id? */
function mentionsPlayer(value: unknown, id: string): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => mentionsPlayer(v, id));
  if ((value as { playerId?: unknown }).playerId === id) return true;
  return Object.values(value as Record<string, unknown>).some((v) => mentionsPlayer(v, id));
}

// ----- retention coupling (audit §4.5: "retention never touches roster.json") ----------------
/**
 * Drop roster sessions that have outlived their telemetry: no stored fix for the session AND a provisioning
 * stamp older than `maxAgeMs`. Called by the retention sweep with the same window it applies to raw fixes,
 * so the name↔playerId map is time-bounded the way the location data is.
 *
 * Why a stamp and not just "no telemetry": a coach provisions names BEFORE a match, when the session has no
 * fixes yet — pruning on absence alone would delete them the same night. The bound is real, though: names
 * for a session that never gets a fix expire RETENTION_DAYS after the last `roster-user.ts set` (the coach
 * re-runs `set` to renew). A session without a stamp (a file from before this existed) is stamped `now` and
 * becomes eligible one window later; a stamp in the future (clock was wrong at `set` time) is clamped to now.
 * Returns the number of sessions pruned. Never logs a name. Takes the roster lock.
 */
export async function pruneRosterSessions(
  hasTelemetry: (sessionId: string) => boolean,
  now: number,
  maxAgeMs: number,
): Promise<number> {
  return withRosterLock(async () => {
    const raw = await readRosterFile();
    if (!raw) return 0;
    const meta = metaOf(raw);
    let dirty = false;
    let pruned = 0;
    for (const sid of Object.keys(raw.sessions)) {
      if (hasTelemetry(sid)) continue;
      const stamp = meta[sid]?.updatedAt;
      if (typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp > now) {
        meta[sid] = { ...meta[sid], updatedAt: now };
        dirty = true;
      } else if (now - stamp > maxAgeMs) {
        delete raw.sessions[sid];
        delete meta[sid];
        pruned += 1;
        dirty = true;
        // WARN, not info: the coach view for this session will now show bare ids. Session id only (pseudonymous).
        log.warn('roster: pruned a session whose fixes are all gone and whose provisioning stamp aged past the window', { session: sid, maxAgeDays: Math.round(maxAgeMs / 86_400_000) });
      }
    }
    for (const sid of Object.keys(meta)) {
      if (!(sid in raw.sessions)) { delete meta[sid]; dirty = true; } // orphaned stamp
    }
    if (dirty) {
      raw.sessionMeta = meta;
      await writeRosterRaw(ROSTER_FILE, raw);
      await reload();
    }
    return pruned;
  });
}
