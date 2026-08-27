#!/usr/bin/env bun
/**
 * roster-user.ts — provision the player-name roster the coach view joins at render (Phase 3; ADR-0016).
 *
 * Names live in exactly two places: this access-controlled file at rest, and the operator's own console.
 * The server loads + periodically reloads AUTH_ROSTER_FILE (default ./roster.json), so add/remove edits
 * here take effect within AUTH_ROSTER_RELOAD_SECONDS without a restart — this is also the provisioning path
 * for the right-to-erasure CLI (purge-player.ts) to delete entries from. Written mode 0o600 (owner-only — it
 * holds child names; same at-rest posture as auth-accounts.json + telemetry.db, defence-in-depth atop OS FDE).
 *
 *   bun run roster-user.ts set u12-sat 07 "Alex M."     # upsert one entry
 *   bun run roster-user.ts remove u12-sat 07            # delete one entry
 *   bun run roster-user.ts list                         # every session
 *   bun run roster-user.ts list u12-sat                 # one session
 *
 * Exit 0 on success; non-zero with a clear message on error. Mirrors auth-user.ts.
 *
 * INVARIANT §0.1 / §1.3: a VALIDATION-ERROR message MUST NOT interpolate the displayName VALUE — stderr may
 * be captured by a non-interactive caller (cron, log-shipper), which is NOT the operator's interactive
 * console. We emit "displayName too long (max 64 chars)", never the value. Printing the name on the SUCCESS
 * path and in `list` is in scope (the operator is the data controller; that is their own console). This
 * mirrors auth-user.ts, which likewise never echoes the password on a failure path.
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeSecretFile } from './src/secretFile';
import { withRosterLock } from './src/roster';

interface RosterEntry {
  playerId: string;
  displayName: string;
}
interface RosterFile {
  sessions: Record<string, RosterEntry[]>;
  /** Per-session provisioning stamp (epoch ms of the last `set`). The retention sweep prunes a session whose
   *  fixes are all gone only once this is older than the window — so names entered BEFORE a match survive. */
  sessionMeta?: Record<string, { updatedAt?: number }>;
  [other: string]: unknown; // anything else in the file is preserved untouched
}

const FILE = process.env.AUTH_ROSTER_FILE ?? './roster.json';
const NAME_MAX = 64; // must match ROSTER_NAME_MAX in src/roster.ts
const PLAYER_ID_RE = /^[A-Za-z0-9._-]{1,64}$/; // must match PLAYER_ID_RE in src/roster.ts

const argv = process.argv.slice(2);
const cmd = argv[0];

/** Thrown, not exited: the roster lock (below) must be released by its finally before the process ends. */
class CliError extends Error {}
function fail(msg: string): never {
  throw new CliError(msg);
}

function load(): RosterFile {
  if (!existsSync(FILE)) return { sessions: {} };
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<RosterFile>;
    // Normalise to a sane shape; a missing/odd `sessions` becomes an empty object rather than a crash.
    const sessions =
      parsed.sessions && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)
        ? (parsed.sessions as Record<string, RosterEntry[]>)
        : {};
    return { ...parsed, sessions };
  } catch {
    fail(`roster file is not valid JSON: ${FILE} (fix or delete it before re-running)`);
  }
}

function save(file: RosterFile): void {
  // 0600 via an atomic temp+rename+chmod (src/secretFile.ts). `writeFileSync(..., { mode })`
  // applies the mode only when the file is CREATED, so an existing 0644 file stayed 0644 —
  // the audit's "mode 0o600 is a no-op" finding, verified on both write paths.
  writeSecretFile(FILE, JSON.stringify(file, null, 2) + '\n');
}

function cmdSet(): void {
  const sessionId = argv[1];
  const playerId = argv[2];
  const displayName = argv[3];
  if (!sessionId || !playerId || displayName === undefined) {
    fail('usage: set <sessionId> <playerId> <displayName>');
  }
  if (!PLAYER_ID_RE.test(sessionId)) fail('invalid sessionId (charset [A-Za-z0-9._-], 1-64 chars)');
  if (!PLAYER_ID_RE.test(playerId)) fail('invalid playerId (charset [A-Za-z0-9._-], 1-64 chars)');
  // CRITICAL: report the RULE, never the offending value — stderr may be captured non-interactively.
  if (displayName.length === 0) fail('displayName must not be empty');
  if (displayName.length > NAME_MAX) fail(`displayName too long (max ${NAME_MAX} chars)`);

  const file = load();
  const list = (file.sessions[sessionId] ??= []);
  const i = list.findIndex((e) => e.playerId === playerId);
  const entry: RosterEntry = { playerId, displayName };
  if (i >= 0) list[i] = entry;
  else list.push(entry);
  (file.sessionMeta ??= {})[sessionId] = { ...file.sessionMeta[sessionId], updatedAt: Date.now() };
  save(file);
  // SUCCESS path: printing the name is in scope (operator console).
  console.log(
    `✅ ${i >= 0 ? 'updated' : 'added'} ${sessionId}/${playerId} → "${displayName}" → ${FILE}` +
      ` (the server reloads it within AUTH_ROSTER_RELOAD_SECONDS)`,
  );
}

function cmdRemove(): void {
  const sessionId = argv[1];
  const playerId = argv[2];
  if (!sessionId || !playerId) fail('usage: remove <sessionId> <playerId>');
  const file = load();
  const list = file.sessions[sessionId] ?? [];
  const next = list.filter((e) => e.playerId !== playerId);
  if (next.length === list.length) fail(`no such roster entry: ${sessionId}/${playerId}`);
  if (next.length > 0) file.sessions[sessionId] = next;
  else {
    delete file.sessions[sessionId]; // drop a now-empty session so the file stays tidy
    if (file.sessionMeta) delete file.sessionMeta[sessionId];
  }
  save(file);
  console.log(`✅ removed ${sessionId}/${playerId} → ${FILE} (the server reloads it within AUTH_ROSTER_RELOAD_SECONDS)`);
}

function cmdList(): void {
  const onlySession = argv[1];
  const file = load();
  const sessionIds = onlySession ? [onlySession] : Object.keys(file.sessions);
  let total = 0;
  for (const sid of sessionIds) {
    const list = file.sessions[sid] ?? [];
    if (list.length === 0) continue;
    console.log(`${sid}:`);
    for (const e of list) {
      console.log(`  - ${e.playerId} → ${e.displayName}`); // operator's OWN console — names expected here
      total += 1;
    }
  }
  if (total === 0) {
    console.log(onlySession ? `(no roster entries for ${onlySession} in ${FILE})` : `(no roster entries in ${FILE})`);
  }
}

// set/remove take the roster lock: the server's retention sweep and purge-player.ts rewrite the same file, and
// two unguarded read-modify-writes racing can silently drop one side's change (or write an erased name back).
try {
  switch (cmd) {
    case 'set':
      await withRosterLock(async () => cmdSet(), FILE);
      break;
    case 'remove':
      await withRosterLock(async () => cmdRemove(), FILE);
      break;
    case 'list':
      cmdList();
      break;
    default:
      console.error('usage: bun run roster-user.ts <set|remove|list> …');
      console.error('  set <sessionId> <playerId> <displayName>   (upsert one entry)');
      console.error('  remove <sessionId> <playerId>');
      console.error('  list [sessionId]');
      process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  // CliError messages are rule-only by construction (never a name value); anything else is a lock/IO error
  // from roster.ts, which is code-only.
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
