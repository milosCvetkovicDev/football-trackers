/**
 * roster-cli.ts — hardware-free, server-free test of the roster-provisioning CLI (roster-user.ts).
 *
 * The CLI is the set/remove/list surface that writes the AUTH_ROSTER_FILE the server loads + periodically
 * reloads (ADR-0016 §1.3). This test exercises it ONLY as a subprocess (no Elysia, no mosquitto), driving
 * every code path an operator uses:
 *   - `set` upserts an entry; the file is mode 0o600 and valid {sessions:{...}} JSON with the right shape.
 *   - a second `set` (new player + an upsert of the first) so `list` shows the current state.
 *   - `list` (all + one-session) prints sessionId/playerId/displayName (the operator's OWN console).
 *   - `remove` of a present entry (exit 0; later list no longer shows it but keeps the other).
 *   - `remove` of an ABSENT entry — clear error + nonzero exit, file NOT corrupted (still valid, others intact).
 *   - `set` with a 65-char displayName — exits NONZERO and stderr does NOT contain the supplied name string
 *     (§0.1 / §1.3: a validation-error message must never interpolate the value — stderr may be captured
 *     non-interactively; mirrors auth-user.ts never echoing the password on failure).
 *
 * INVARIANT §0.1: the names used here are dev placeholders ('Alex M.', 'Bo T.'), never a real child. The
 * OVER_LONG name is a sentinel string we assert is ABSENT from stderr on the validation-error path.
 *
 *   bun run test/roster-cli.ts
 *
 * Exits 0 on success, 1 on any failed assertion; cleans up its temp roster file + the subprocesses it spawns.
 */

import { chmodSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';

// A dedicated temp file that no other test/tool touches, so a stray leftover can't poison this run.
const ROSTER_FILE = '/tmp/ft-rostercli-roster.json';

const SESSION = 's1';
const PID_A = '07';
const NAME_A = 'Alex M.';
const NAME_A_UPDATED = 'Alex Morgan';
const PID_B = '09';
const NAME_B = 'Bo T.';
const GHOST_PID = '99'; // never set — the remove-absent case
// A 65-char name (cap is 64) — used to drive the validation-error path. This exact string must NEVER appear
// in the CLI's stderr (the rule message is value-free).
const OVER_LONG_NAME = 'Z'.repeat(65);

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

/** Run the CLI as a subprocess from server/, pointed at our temp roster file. */
async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', 'roster-user.ts', ...args], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, AUTH_ROSTER_FILE: ROSTER_FILE },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

interface RosterEntry { playerId: string; displayName: string }
function readRoster(): Record<string, RosterEntry[]> {
  const parsed = JSON.parse(readFileSync(ROSTER_FILE, 'utf8')) as { sessions?: Record<string, RosterEntry[]> };
  assert(parsed.sessions && typeof parsed.sessions === 'object', 'roster file JSON must have a sessions object');
  return parsed.sessions!;
}

// Fresh temp file each run.
for (const f of [ROSTER_FILE, `${ROSTER_FILE}.lock`]) rmSync(f, { force: true }); // a crashed earlier run must not leave a lock behind

try {
  // --- 1. set s1/07 -> exit 0; file exists, 0o600, correct shape ----------------------------------------
  const set1 = await runCli(['set', SESSION, PID_A, NAME_A]);
  assert(set1.code === 0, `set ${SESSION}/${PID_A} should exit 0, got ${set1.code} (stderr: ${set1.stderr.trim()})`);
  assert(existsSync(ROSTER_FILE), 'roster file must exist after the first set');

  // --- 1a. file mode is 0o600 (owner-only — it holds child names) ---------------------------------------
  const mode = statSync(ROSTER_FILE).mode & 0o777;
  assert(mode === 0o600, `roster file mode must be 0o600, got 0o${mode.toString(8)}`);

  // --- 1a-ii. PHASE 6 (audit §6 "Server"): an EXISTING loose file must be TIGHTENED, not left as found.
  // `writeFileSync(path, text, { mode: 0o600 })` applies the mode only when the file is CREATED, so
  // every write over a file that already existed — one restored from a backup, `scp`ed, or made by an
  // editor — silently kept its old permissions while the docs claimed owner-only. The case above cannot
  // catch that: it only ever inspects a file the CLI itself just created.
  chmodSync(ROSTER_FILE, 0o644);
    const tighten = await runCli(['set', SESSION, PID_A, NAME_A]);
  assert(tighten.code === 0, `set over a 0644 file should exit 0, got ${tighten.code}`);
  assert(
    (statSync(ROSTER_FILE).mode & 0o777) === 0o600,
    'a pre-existing 0644 file must be rewritten as 0600 — writeFileSync mode is a no-op on an existing file',
  );

  // --- 1b. JSON shape: sessions.s1 = [{playerId:'07', displayName:'Alex M.'}] ---------------------------
  let sessions = readRoster();
  assert(Array.isArray(sessions[SESSION]) && sessions[SESSION].length === 1, `${SESSION} must have 1 entry`);
  assert(sessions[SESSION][0].playerId === PID_A && sessions[SESSION][0].displayName === NAME_A,
    `${SESSION}/${PID_A} must round-trip as "${NAME_A}", got ${JSON.stringify(sessions[SESSION][0])}`);

  // --- 2. set a second player + upsert the first -> file reflects current state -------------------------
  const set2 = await runCli(['set', SESSION, PID_B, NAME_B]);
  assert(set2.code === 0, `set ${SESSION}/${PID_B} should exit 0, got ${set2.code} (stderr: ${set2.stderr.trim()})`);
  const setUpdate = await runCli(['set', SESSION, PID_A, NAME_A_UPDATED]); // upsert, not duplicate
  assert(setUpdate.code === 0, `upsert ${SESSION}/${PID_A} should exit 0, got ${setUpdate.code}`);
  sessions = readRoster();
  assert(sessions[SESSION].length === 2, `${SESSION} should have 2 entries after add + upsert, got ${sessions[SESSION].length}`);
  const a = sessions[SESSION].find((e) => e.playerId === PID_A);
  assert(a !== undefined && a.displayName === NAME_A_UPDATED, `${PID_A} must be UPDATED to "${NAME_A_UPDATED}" (upsert, not duplicated)`);
  assert(sessions[SESSION].some((e) => e.playerId === PID_B && e.displayName === NAME_B), `${PID_B} must survive`);

  // --- 3. list (all) shows both; list (one session) scoped ----------------------------------------------
  const listAll = await runCli(['list']);
  assert(listAll.code === 0, `list should exit 0, got ${listAll.code} (stderr: ${listAll.stderr.trim()})`);
  assert(listAll.stdout.includes(PID_A) && listAll.stdout.includes(NAME_A_UPDATED), `list must show ${PID_A} -> ${NAME_A_UPDATED}`);
  assert(listAll.stdout.includes(PID_B) && listAll.stdout.includes(NAME_B), `list must show ${PID_B} -> ${NAME_B}`);
  assert(listAll.stdout.includes(SESSION), `list must show the session id ${SESSION}`);
  const listOne = await runCli(['list', SESSION]);
  assert(listOne.code === 0 && listOne.stdout.includes(PID_A), `list ${SESSION} should show its entries`);

  // --- 3b. set stamps the session (audit §4.5: the retention sweep prunes roster sessions that outlived
  // their fixes, and needs to know a session was provisioned RECENTLY so it never deletes names entered
  // ahead of a match). The stamp lives beside `sessions`, not inside it, so the serving loader's shape is
  // untouched.
  const stamped = JSON.parse(readFileSync(ROSTER_FILE, 'utf8')) as { sessionMeta?: Record<string, { updatedAt?: number }> };
  const updatedAt = stamped.sessionMeta?.[SESSION]?.updatedAt;
  assert(typeof updatedAt === 'number' && Number.isFinite(updatedAt) && Math.abs(Date.now() - updatedAt) < 60_000,
    `set must write sessionMeta.${SESSION}.updatedAt as a recent epoch-ms stamp, got ${JSON.stringify(stamped.sessionMeta)}`);

  // --- 4. remove s1/07 -> exit 0; later list no longer shows 07 but still shows 09 ----------------------
  const rm = await runCli(['remove', SESSION, PID_A]);
  assert(rm.code === 0, `remove ${SESSION}/${PID_A} should exit 0, got ${rm.code} (stderr: ${rm.stderr.trim()})`);
  sessions = readRoster();
  assert(!sessions[SESSION].some((e) => e.playerId === PID_A), `${PID_A} must be gone after remove`);
  assert(sessions[SESSION].some((e) => e.playerId === PID_B), `${PID_B} must remain after removing ${PID_A}`);

  // --- 5. remove an ABSENT entry -> clear error + nonzero exit; file NOT corrupted ----------------------
  const rmGhost = await runCli(['remove', SESSION, GHOST_PID]);
  assert(rmGhost.code !== 0, `removing an absent entry should exit nonzero, got ${rmGhost.code}`);
  assert(rmGhost.stderr.toLowerCase().includes('no such roster entry'),
    `removing an absent entry should print a clear error; got stderr:\n${rmGhost.stderr}`);
  // The file must NOT be corrupted by a failed remove: still valid JSON, 09 intact.
  sessions = readRoster();
  assert(sessions[SESSION].length === 1 && sessions[SESSION][0].playerId === PID_B,
    `a failed remove must leave the file intact (only ${PID_B}), got ${JSON.stringify(sessions[SESSION])}`);

  // --- 5b. removing the LAST entry drops the session AND its stamp (no orphaned metadata) --------------
  const rmLast = await runCli(['remove', SESSION, PID_B]);
  assert(rmLast.code === 0, `remove ${SESSION}/${PID_B} should exit 0, got ${rmLast.code}`);
  const emptied = JSON.parse(readFileSync(ROSTER_FILE, 'utf8')) as { sessions: Record<string, unknown>; sessionMeta?: Record<string, unknown> };
  assert(emptied.sessions[SESSION] === undefined, 'removing the last entry drops the session');
  assert(emptied.sessionMeta?.[SESSION] === undefined, `removing the last entry must drop its stamp too, got ${JSON.stringify(emptied.sessionMeta)}`);
  const reset = await runCli(['set', SESSION, PID_B, NAME_B]); // restore the precondition for section 6
  assert(reset.code === 0, 'restoring the entry should exit 0');

  // --- 6. set with a 65-char name -> NONZERO exit AND stderr does NOT contain the name string -----------
  const setLong = await runCli(['set', SESSION, '13', OVER_LONG_NAME]);
  assert(setLong.code !== 0, `set with a 65-char name must exit nonzero, got ${setLong.code}`);
  assert(setLong.stderr.toLowerCase().includes('too long'),
    `the over-long error must state the rule; got stderr:\n${setLong.stderr}`);
  // §0.1 / §1.3: the supplied name VALUE must NEVER appear in stderr (it may be captured non-interactively).
  assert(!setLong.stderr.includes(OVER_LONG_NAME),
    `the over-long-name VALIDATION ERROR must NOT contain the supplied name string; got stderr:\n${setLong.stderr}`);
  assert(!setLong.stdout.includes(OVER_LONG_NAME),
    `the over-long-name validation error must NOT echo the name to stdout either; got stdout:\n${setLong.stdout}`);
  // And it must NOT have written the rejected entry to the file.
  sessions = readRoster();
  assert(!(sessions[SESSION] ?? []).some((e) => e.playerId === '13'), 'a rejected over-long set must not write the entry');

  console.log('\n✅ ROSTER CLI PASSED — set writes 0o600 {sessions} JSON (upsert, not dup), list shows current state, '
    + 'remove drops one & keeps the other, remove-absent errors without corrupting the file, and a 65-char name '
    + 'exits nonzero WITHOUT the name value in stderr (value-free validation error)');
  for (const f of [ROSTER_FILE, `${ROSTER_FILE}.lock`]) rmSync(f, { force: true });
  process.exit(0);
} catch (err) {
  console.error('\n❌ ROSTER CLI FAILED:', (err as Error).message);
  try { for (const f of [ROSTER_FILE, `${ROSTER_FILE}.lock`]) rmSync(f, { force: true }); } catch { /* noop */ }
  process.exit(1);
}
