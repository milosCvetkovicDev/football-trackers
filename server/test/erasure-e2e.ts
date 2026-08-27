/**
 * erasure-e2e.ts — combined right-to-erasure across the telemetry DB AND the player-name roster (ADR-0010 +
 * ADR-0016 §1.4). The whole point of Phase 3 shipping a name roster is that erasing a player must now wipe
 * BOTH stores in one operator action, or the name lingers after the location is gone.
 *
 * Flow (all via subprocesses, the way an operator runs it — no server, no broker):
 *   1. roster-user.ts set <sess> <pl> <name>   provisions a roster entry.
 *   2. seed raw fixes for that (session, player) directly via db.ts insertTelemetry (in-process).
 *   3. purge-player.ts <pl> <sess>             erases both — assert the JSON receipt has
 *      rosterEntriesErased:1 AND erased>0, the DB rows for the player are 0, and the entry is gone from
 *      roster.json.
 *   4. a SECOND purge-player.ts run (nothing left) exits 0 with rosterEntriesErased:0 and does NOT corrupt
 *      the roster file (matches the DB-purge 0-rows semantics — the erasure goal is met regardless).
 *
 * Unique temp AUTH_ROSTER_FILE + DB_PATH so the run is isolated from other tests/the dev DB.
 * NB §0.1: 'Alex M.' is a dev placeholder, never a real child.
 *
 *   bun run test/erasure-e2e.ts
 *
 * Exits 0 on success, 1 on any failed assertion; cleans up its temp files.
 */

const DB_PATH = '/tmp/ft-erasure-e2e.db';
const ROSTER_FILE = '/tmp/ft-erasure-e2e-roster.json';

// Must be set before importing db.ts (opens the DB on import).
process.env.DB_PATH = DB_PATH;
process.env.LOG_LEVEL = 'error';

import { existsSync, readFileSync, rmSync } from 'node:fs';
import type { Telemetry } from '../src/types';

const SESSION = 's1';
const PLAYER = '07';
const NAME = 'Alex M.';
const OTHER_PLAYER = '09'; // a second player whose rows + roster entry must SURVIVE the targeted erasure
const OTHER_NAME = 'Bo T.';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

interface RosterEntry { playerId: string; displayName: string }
function readRosterSessions(): Record<string, RosterEntry[]> {
  const parsed = JSON.parse(readFileSync(ROSTER_FILE, 'utf8')) as { sessions?: Record<string, RosterEntry[]> };
  assert(parsed.sessions && typeof parsed.sessions === 'object', 'roster file must have a sessions object');
  return parsed.sessions!;
}

/** Run a CLI as a subprocess from server/, with our temp DB + roster file. Returns code + parsed stdout JSON. */
async function runCli(
  script: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', script, ...args], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, AUTH_ROSTER_FILE: ROSTER_FILE, DB_PATH, ...extraEnv },
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

for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, ROSTER_FILE]) {
  if (existsSync(f)) rmSync(f);
}

try {
  // Seed raw fixes for BOTH players in this same process (db.ts opens DB_PATH on import).
  const { db, insertTelemetry } = await import('../src/db');
  const fix = (over: Partial<Telemetry>): Telemetry => ({
    id: 'trk', pl: PLAYER, ts: 1, lat: 44.8, lon: 20.4, spd: 1, hdg: 0,
    fix: 3, sats: 10, pdop: 1, sessionId: SESSION, playerId: PLAYER, serverTs: 1_700_000_000_000, ...over,
  });
  const rowsFor = (playerId: string): number =>
    (db.query('SELECT COUNT(*) AS c FROM telemetry WHERE player_id = ?').get(playerId) as { c: number }).c;

  for (let i = 0; i < 5; i++) insertTelemetry(fix({ serverTs: 1_700_000_000_000 + i }));
  for (let i = 0; i < 3; i++) insertTelemetry(fix({ playerId: OTHER_PLAYER, pl: OTHER_PLAYER, serverTs: 1_700_000_001_000 + i }));
  assert(rowsFor(PLAYER) === 5, `precondition: ${PLAYER} should have 5 seeded rows, got ${rowsFor(PLAYER)}`);
  assert(rowsFor(OTHER_PLAYER) === 3, `precondition: ${OTHER_PLAYER} should have 3 seeded rows, got ${rowsFor(OTHER_PLAYER)}`);

  // --- 1. provision roster entries for both players -----------------------------------------------------
  const set1 = await runCli('roster-user.ts', ['set', SESSION, PLAYER, NAME]);
  assert(set1.code === 0, `roster set ${PLAYER} should exit 0, got ${set1.code} (stderr: ${set1.stderr.trim()})`);
  const set2 = await runCli('roster-user.ts', ['set', SESSION, OTHER_PLAYER, OTHER_NAME]);
  assert(set2.code === 0, `roster set ${OTHER_PLAYER} should exit 0, got ${set2.code}`);
  let sessions = readRosterSessions();
  assert(sessions[SESSION].length === 2, `precondition: roster should hold 2 entries, got ${sessions[SESSION].length}`);

  // --- 2. erase player 07 from session s1: receipt rosterEntriesErased:1, erased>0 ----------------------
  const purge1 = await runCli('purge-player.ts', [PLAYER, SESSION]);
  assert(purge1.code === 0, `purge-player ${PLAYER} ${SESSION} should exit 0, got ${purge1.code} (stderr: ${purge1.stderr.trim()})`);
  const receipt1 = JSON.parse(purge1.stdout) as { erased: number; rosterEntriesErased: number; playerId: string };
  assert(receipt1.rosterEntriesErased === 1, `receipt rosterEntriesErased must be 1, got ${receipt1.rosterEntriesErased} (stdout: ${purge1.stdout.trim()})`);
  assert(receipt1.erased === 5, `receipt erased (DB rows) must be 5, got ${receipt1.erased}`);
  assert(receipt1.playerId === PLAYER, `receipt playerId must be ${PLAYER}`);

  // --- 2a. DB rows for the erased player are 0; the OTHER player's rows survive --------------------------
  assert(rowsFor(PLAYER) === 0, `DB rows for ${PLAYER} must be 0 after purge, got ${rowsFor(PLAYER)}`);
  assert(rowsFor(OTHER_PLAYER) === 3, `the OTHER player's rows must survive a targeted erasure, got ${rowsFor(OTHER_PLAYER)}`);

  // --- 2b. roster entry for the erased player is gone; the OTHER entry survives -------------------------
  sessions = readRosterSessions();
  const remaining = sessions[SESSION] ?? [];
  assert(!remaining.some((e) => e.playerId === PLAYER), `${PLAYER}'s roster entry must be gone after purge`);
  assert(remaining.some((e) => e.playerId === OTHER_PLAYER && e.displayName === OTHER_NAME),
    `the OTHER player's roster entry must survive the targeted erasure`);
  assert(!readFileSync(ROSTER_FILE, 'utf8').includes(NAME), `the erased player's NAME must be gone from roster.json`);

  // --- 3. a SECOND purge (nothing left for 07): exit 0, rosterEntriesErased:0, file NOT corrupted --------
  const purge2 = await runCli('purge-player.ts', [PLAYER, SESSION]);
  assert(purge2.code === 0, `a second purge with nothing left should STILL exit 0, got ${purge2.code} (stderr: ${purge2.stderr.trim()})`);
  const receipt2 = JSON.parse(purge2.stdout) as { erased: number; rosterEntriesErased: number };
  assert(receipt2.rosterEntriesErased === 0, `second-run rosterEntriesErased must be 0, got ${receipt2.rosterEntriesErased}`);
  assert(receipt2.erased === 0, `second-run erased (DB rows) must be 0, got ${receipt2.erased}`);
  // The file must still be valid JSON and still hold the OTHER player's intact entry.
  sessions = readRosterSessions();
  assert((sessions[SESSION] ?? []).length === 1 && sessions[SESSION][0].playerId === OTHER_PLAYER,
    `a no-op second purge must not corrupt the file (only ${OTHER_PLAYER} left), got ${JSON.stringify(sessions[SESSION])}`);

  // --- 4. PHASE 6: the receipt must NAME the backup directory it searched, and whether it EXISTED -------
  // `backups: []` alone cannot distinguish "this box takes no backups" from "BACKUP_DIR is the host path
  // and the container's copies were never opened". A checker pass ran the purge with a typo'd BACKUP_DIR:
  // exit 0, a clean receipt, and every real backup still holding 1,800 of the child's rows. That receipt
  // is the compliance record — it must not be able to say "erased" over copies it never looked at. Same
  // signal, same reason, as `rosterFound` (audit §4.5 e).
  {
    const typo = '/tmp/ft-erasure-e2e-backups-typo';
    if (existsSync(typo)) rmSync(typo, { recursive: true, force: true });
    const r = await runCli('purge-player.ts', [OTHER_PLAYER, SESSION], { BACKUP_DIR: typo });
    assert(r.code === 0, `purge with an empty backup dir should still exit 0, got ${r.code}`);
    const receipt = JSON.parse(r.stdout) as { backupDir?: string; backupsFound?: boolean; backups?: unknown[] };
    assert(typeof receipt.backupDir === 'string' && receipt.backupDir.includes('typo'),
      `the receipt must NAME the directory it searched, got ${JSON.stringify(receipt.backupDir)}`);
    assert(receipt.backupsFound === false,
      `backupsFound must be false when the directory does not exist, got ${JSON.stringify(receipt.backupsFound)}`);
    assert(/no backup directory/.test(r.stderr),
      `a missing backup directory must produce an operator-visible note, got: ${r.stderr.slice(0, 300)}`);
  }

  // ...and when the directory DOES exist, it says so and erases from it.
  {
    const real = '/tmp/ft-erasure-e2e-backups';
    rmSync(real, { recursive: true, force: true });
    const { createBackup } = await import('../src/backup');
    createBackup(DB_PATH, real, Date.now());
    const r = await runCli('purge-player.ts', ['99', SESSION], { BACKUP_DIR: real });
    const receipt = JSON.parse(r.stdout) as { backupsFound?: boolean; backups?: { path: string; ok: boolean }[] };
    assert(receipt.backupsFound === true, 'backupsFound must be true when the directory exists');
    assert((receipt.backups ?? []).length === 1, `the one backup must be processed, got ${(receipt.backups ?? []).length}`);
    assert((receipt.backups ?? []).every((b) => b.ok), 'the backup must report ok');
    assert(!/no backup directory/.test(r.stderr), 'no missing-directory note when it exists');
    rmSync(real, { recursive: true, force: true });
  }

  console.log('\n✅ ERASURE E2E PASSED — roster set → purge-player erases BOTH stores (rosterEntriesErased:1, DB rows 0), '
    + 'the other player survives, the name is gone from roster.json, and a no-op second run exits 0 with '
    + 'rosterEntriesErased:0 without corrupting the file');
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, ROSTER_FILE]) {
    if (existsSync(f)) rmSync(f);
  }
  process.exit(0);
} catch (err) {
  console.error('\n❌ ERASURE E2E FAILED:', (err as Error).message);
  try {
    for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, ROSTER_FILE]) {
      if (existsSync(f)) rmSync(f);
    }
  } catch { /* noop */ }
  process.exit(1);
}
