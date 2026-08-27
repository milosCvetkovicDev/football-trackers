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

import { chmodSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';

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

// Phase 5: a synthetic ~105 x 68 m pitch in on-screen corner order (TL, TR, BR, BL), built from metre
// offsets so the geometry is legible. The CLI takes each corner as one "lat,lon" argument.
const BASE = { lat: 44.812806, lon: 20.460535 };
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((BASE.lat * Math.PI) / 180);
const pt = (east: number, north: number) => ({
  lat: BASE.lat + north / M_PER_DEG_LAT,
  lon: BASE.lon + east / M_PER_DEG_LON,
});
const PITCH = [pt(0, 0), pt(105, 0), pt(105, -68), pt(0, -68)];
const asArgs = (corners: Array<{ lat: number; lon: number }>) => corners.map((c) => `${c.lat},${c.lon}`);
const PITCH_ARGS = asArgs(PITCH);
// Three collinear corners — the geometry that makes the client's homography solve throw.
const BAD_PITCH_ARGS = asArgs([pt(0, 0), pt(50, 0), pt(105, 0), pt(0, -68)]);

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

interface SessionConfigEntry {
  ageBand: string;
  pitch?: { corners: Array<{ lat: number; lon: number }> };
}
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

  // --- 1a-ii. PHASE 6 (audit §6 "Server"): an EXISTING loose file must be TIGHTENED, not left as found.
  // `writeFileSync(path, text, { mode: 0o600 })` applies the mode only when the file is CREATED, so
  // every write over a file that already existed — one restored from a backup, `scp`ed, or made by an
  // editor — silently kept its old permissions while the docs claimed owner-only. The case above cannot
  // catch that: it only ever inspects a file the CLI itself just created.
  chmodSync(CONFIG_FILE, 0o644);
    const tighten = await runCli(['set', SESSION_A, BAND_A]);
  assert(tighten.code === 0, `set over a 0644 file should exit 0, got ${tighten.code}`);
  assert(
    (statSync(CONFIG_FILE).mode & 0o777) === 0o600,
    'a pre-existing 0644 file must be rewritten as 0600 — writeFileSync mode is a no-op on an existing file',
  );

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

  // --- 4b. PHASE 5 (audit §6 "Client"): the pitch corners live here too now -----------------------------
  // `set-pitch` writes the four GPS corners in on-screen order (TL, TR, BR, BL). Same validate-before-write
  // discipline as the band: an unusable quad is refused with the file untouched, because the client solves a
  // homography from these four points and a degenerate one throws.
  {
    const setPitch = await runCli(['set-pitch', SESSION_A, ...PITCH_ARGS]);
    assert(setPitch.code === 0, `set-pitch should exit 0, got ${setPitch.code} (stderr: ${setPitch.stderr.trim()})`);
    let s = readConfig();
    assert(s[SESSION_A].pitch?.corners?.length === 4,
      `${SESSION_A} must carry 4 corners, got ${JSON.stringify(s[SESSION_A].pitch)}`);
    assert(s[SESSION_A].pitch!.corners[1].lat === PITCH[1].lat && s[SESSION_A].pitch!.corners[1].lon === PITCH[1].lon,
      'corner order (TL,TR,BR,BL) must be preserved exactly as given');
    assert(s[SESSION_A].ageBand === BAND_A_UPDATED, 'set-pitch must not disturb the band');
    assert((statSync(CONFIG_FILE).mode & 0o777) === 0o600, 'set-pitch must keep the file 0o600');

    // THE MERGE PROPERTY: setting the band later must PRESERVE the pitch. (The pre-Phase-5 `set` replaced
    // the whole entry — a routine band correction would have silently wiped a measured pitch.)
    const reband = await runCli(['set', SESSION_A, BAND_A]);
    assert(reband.code === 0, `re-setting the band should exit 0, got ${reband.code}`);
    s = readConfig();
    assert(s[SESSION_A].ageBand === BAND_A, 'the band must be updated');
    assert(s[SESSION_A].pitch?.corners?.length === 4, 'setting the band must NOT wipe a configured pitch');

    // A degenerate quad (three collinear corners) is refused, and the previously-good pitch survives intact.
    const bad = await runCli(['set-pitch', SESSION_A, ...BAD_PITCH_ARGS]);
    assert(bad.code !== 0, `set-pitch with a degenerate quad must exit nonzero, got ${bad.code}`);
    assert(bad.stderr.length > 0, 'a rejected pitch must explain itself on stderr');
    s = readConfig();
    assert(s[SESSION_A].pitch?.corners?.[1].lat === PITCH[1].lat,
      'a rejected set-pitch must leave the existing pitch untouched');

    // Wrong arity / non-numeric input is refused the same way.
    const short = await runCli(['set-pitch', SESSION_A, PITCH_ARGS[0], PITCH_ARGS[1], PITCH_ARGS[2]]);
    assert(short.code !== 0, 'set-pitch with three corners must exit nonzero');
    const junk = await runCli(['set-pitch', SESSION_A, 'a,b', ...PITCH_ARGS.slice(1)]);
    assert(junk.code !== 0, 'set-pitch with a non-numeric corner must exit nonzero');
    s = readConfig();
    assert(s[SESSION_A].pitch?.corners?.length === 4, 'rejected set-pitch calls must not corrupt the file');

    // `list` must make it visible that a session HAS a measured pitch — otherwise the only way to find out
    // is to read the JSON, and "is this the real pitch or the built-in placeholder?" is the exact question
    // the audit finding is about.
    const listed = await runCli(['list']);
    assert(/pitch/i.test(listed.stdout), `list must indicate which sessions have a pitch; got:\n${listed.stdout}`);

    // clear-pitch drops the corners and keeps the band.
    const clear = await runCli(['clear-pitch', SESSION_A]);
    assert(clear.code === 0, `clear-pitch should exit 0, got ${clear.code} (stderr: ${clear.stderr.trim()})`);
    s = readConfig();
    assert(s[SESSION_A].pitch === undefined, 'clear-pitch must remove the pitch');
    assert(s[SESSION_A].ageBand === BAND_A, 'clear-pitch must keep the band');
    const clearAgain = await runCli(['clear-pitch', SESSION_A]);
    assert(clearAgain.code !== 0, 'clearing an absent pitch must exit nonzero rather than silently succeed');

    // Put the pitch back so case 5 proves `remove` takes the whole entry with it.
    assert((await runCli(['set-pitch', SESSION_A, ...PITCH_ARGS])).code === 0, 're-set the pitch for case 5');
  }

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
    + 'remove drops one & keeps the other, remove-absent errors without corrupting the file, and (Phase 5) '
    + 'set-pitch/clear-pitch round-trip four corners in order, a band set PRESERVES the pitch, and a '
    + 'degenerate/short/non-numeric quad is refused with the file left intact');
  if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE);
  process.exit(0);
} catch (err) {
  console.error('\n❌ SESSION-CONFIG CLI FAILED:', (err as Error).message);
  try { if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE); } catch { /* noop */ }
  process.exit(1);
}
