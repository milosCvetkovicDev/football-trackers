/**
 * session-config-cli.ts — hardware-free, server-free test of the session-config CLI (session-config.ts).
 * Phase 4, ADR-0019, contract §2.2.
 *
 * The CLI is the set/remove/list surface that writes the SESSION_CONFIG_FILE the server loads +
 * periodically reloads. This test drives it ONLY as a subprocess (no Elysia, no mosquitto), exercising
 * every operator path:
 *   - `set` upserts a session's band; the file is mode 0o600 and valid {sessions:{<id>:{ageBand}}} JSON.
 *   - `set` with a BAD band -> exits NONZERO and leaves the file INTACT (validate before write, so a typo
 *     can never corrupt an existing config). The band is non-sensitive, so the error may echo the value.
 *   - `list` prints each sessionId → its band (the band is NOT a name → printed freely).
 *   - `remove` of a present session (exit 0); later list drops it but keeps the other.
 *   - `remove` of an ABSENT session -> clear error + nonzero exit, file NOT corrupted (others intact).
 *
 * Only match-session ids and the four age bands appear here — never a real child's name.
 *
 *   bun run test/session-config-cli.ts
 *
 * Exits 0 on success, 1 on any failed assertion; cleans up its temp config file + the subprocesses.
 */

import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';

// A dedicated temp file that no other test/tool touches, so a stray leftover can't poison this run.
const CONFIG_FILE = '/tmp/ft-sessioncfg-cli.json';

const SESSION_A = 's1';
const BAND_A = 'U12';
const BAND_A_UPDATED = 'U16';
const SESSION_B = 's2';
const BAND_B = 'U19';
const GHOST_SESSION = 'nope'; // never set — the remove-absent case
const BAD_BAND = 'U10'; // not one of the four — drives the validation-error path

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

/** Run the CLI as a subprocess from server/, pointed at our temp config file. */
async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', 'session-config.ts', ...args], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, SESSION_CONFIG_FILE: CONFIG_FILE },
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

interface SessionConfigEntry { ageBand: string }
function readConfig(): Record<string, SessionConfigEntry> {
  const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as { sessions?: Record<string, SessionConfigEntry> };
  assert(parsed.sessions && typeof parsed.sessions === 'object', 'config file JSON must have a sessions object');
  return parsed.sessions!;
}

// Fresh temp file each run.
if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE);

try {
  // --- 1. set s1 -> U12 -> exit 0; file exists, 0o600, correct shape ------------------------------------
  const set1 = await runCli(['set', SESSION_A, BAND_A]);
  assert(set1.code === 0, `set ${SESSION_A} ${BAND_A} should exit 0, got ${set1.code} (stderr: ${set1.stderr.trim()})`);
  assert(existsSync(CONFIG_FILE), 'config file must exist after the first set');

  // --- 1a. file mode is 0o600 (owner-only; same at-rest posture as roster.json) -------------------------
  const mode = statSync(CONFIG_FILE).mode & 0o777;
  assert(mode === 0o600, `config file mode must be 0o600, got 0o${mode.toString(8)}`);

  // --- 1b. JSON shape: sessions.s1 = { ageBand: 'U12' } -------------------------------------------------
  let sessions = readConfig();
  assert(sessions[SESSION_A] && sessions[SESSION_A].ageBand === BAND_A,
    `${SESSION_A} must round-trip as { ageBand: '${BAND_A}' }, got ${JSON.stringify(sessions[SESSION_A])}`);

  // --- 2. set a second session + upsert the first ------------------------------------------------------
  const set2 = await runCli(['set', SESSION_B, BAND_B]);
  assert(set2.code === 0, `set ${SESSION_B} ${BAND_B} should exit 0, got ${set2.code} (stderr: ${set2.stderr.trim()})`);
  const setUpdate = await runCli(['set', SESSION_A, BAND_A_UPDATED]); // upsert, not a duplicate key
  assert(setUpdate.code === 0, `upsert ${SESSION_A} should exit 0, got ${setUpdate.code}`);
  sessions = readConfig();
  assert(Object.keys(sessions).length === 2, `should have 2 sessions after add + upsert, got ${Object.keys(sessions).length}`);
  assert(sessions[SESSION_A].ageBand === BAND_A_UPDATED, `${SESSION_A} must be UPDATED to ${BAND_A_UPDATED} (upsert, not duplicated)`);
  assert(sessions[SESSION_B].ageBand === BAND_B, `${SESSION_B} must survive as ${BAND_B}`);

  // --- 3. set with a BAD band -> NONZERO exit, file INTACT (no corruption) -----------------------------
  const setBad = await runCli(['set', SESSION_B, BAD_BAND]);
  assert(setBad.code !== 0, `set with a bad band must exit nonzero, got ${setBad.code}`);
  assert(setBad.stderr.toLowerCase().includes('invalid ageband') || setBad.stderr.toLowerCase().includes('ageband'),
    `the bad-band error must state the rule; got stderr:\n${setBad.stderr}`);
  // The file must be UNTOUCHED by a rejected set: s2 still its previous valid band, both sessions present.
  sessions = readConfig();
  assert(Object.keys(sessions).length === 2, `a rejected set must not add/drop a session, got ${Object.keys(sessions).length}`);
  assert(sessions[SESSION_B].ageBand === BAND_B, `${SESSION_B} must keep its valid band after a rejected set, got ${sessions[SESSION_B].ageBand}`);
  assert(sessions[SESSION_A].ageBand === BAND_A_UPDATED, `${SESSION_A} must be untouched by a rejected set on ${SESSION_B}`);

  // --- 4. list shows each session + its band -----------------------------------------------------------
  const listAll = await runCli(['list']);
  assert(listAll.code === 0, `list should exit 0, got ${listAll.code} (stderr: ${listAll.stderr.trim()})`);
  assert(listAll.stdout.includes(SESSION_A) && listAll.stdout.includes(BAND_A_UPDATED),
    `list must show ${SESSION_A} → ${BAND_A_UPDATED}; got stdout:\n${listAll.stdout}`);
  assert(listAll.stdout.includes(SESSION_B) && listAll.stdout.includes(BAND_B),
    `list must show ${SESSION_B} → ${BAND_B}; got stdout:\n${listAll.stdout}`);

  // --- 5. remove s1 -> exit 0; later list drops s1 but keeps s2 ----------------------------------------
  const rm = await runCli(['remove', SESSION_A]);
  assert(rm.code === 0, `remove ${SESSION_A} should exit 0, got ${rm.code} (stderr: ${rm.stderr.trim()})`);
  sessions = readConfig();
  assert(!(SESSION_A in sessions), `${SESSION_A} must be gone after remove`);
  assert(sessions[SESSION_B] && sessions[SESSION_B].ageBand === BAND_B, `${SESSION_B} must remain after removing ${SESSION_A}`);
  const listAfter = await runCli(['list']);
  assert(!listAfter.stdout.includes(SESSION_A) && listAfter.stdout.includes(SESSION_B),
    `list after remove must drop ${SESSION_A} and keep ${SESSION_B}; got stdout:\n${listAfter.stdout}`);

  // --- 6. remove an ABSENT session -> clear error + nonzero exit; file NOT corrupted -------------------
  const rmGhost = await runCli(['remove', GHOST_SESSION]);
  assert(rmGhost.code !== 0, `removing an absent session should exit nonzero, got ${rmGhost.code}`);
  assert(rmGhost.stderr.toLowerCase().includes('no such session'),
    `removing an absent session should print a clear error; got stderr:\n${rmGhost.stderr}`);
  // The file must NOT be corrupted by a failed remove: still valid JSON, s2 intact.
  sessions = readConfig();
  assert(Object.keys(sessions).length === 1 && sessions[SESSION_B].ageBand === BAND_B,
    `a failed remove must leave the file intact (only ${SESSION_B}), got ${JSON.stringify(sessions)}`);

  console.log('\n✅ SESSION-CONFIG CLI PASSED — set writes 0o600 {sessions:{<id>:{ageBand}}} JSON (upsert, not dup), '
    + 'a bad band exits nonzero WITHOUT corrupting the file, list shows each session → band, '
    + 'remove drops one & keeps the other, and remove-absent errors without corrupting the file');
  if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE);
  process.exit(0);
} catch (err) {
  console.error('\n❌ SESSION-CONFIG CLI FAILED:', (err as Error).message);
  try { if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE); } catch { /* noop */ }
  process.exit(1);
}
