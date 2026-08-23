/**
 * erasure-audit.ts — the ways right-to-erasure was broken (audit 2026-08-03 §4.5) and the ways the Phase 2b
 * repair was itself found broken by its checker pass, each pinned as an executable assertion so none of them
 * can come back. Every defect was originally REPRODUCED BY EXECUTION against the real CLI; this suite keeps
 * reproducing them the same way — subprocess `purge-player.ts` runs against a temp DB + roster file — so a
 * green here means the erasure actually happened on disk, not that a receipt said so.
 *
 *   (a) on-disk residue  — after a purge the playerId must be absent from telemetry.db AND its -wal, with the
 *                          erased rows INTERLEAVED with a survivor's (the real ingest layout): secure_delete
 *                          zeroes freed pages but not the gap of a rebalanced leaf page a survivor still lives
 *                          on, so only a VACUUM before the checkpoint makes the bytes go.
 *   (b) duplicate id     — a duplicate playerId in a session must be ERASED (both copies), not silently skipped
 *                          with a success receipt (the fail-closed serving loader was fail-OPEN for erasure).
 *   (c) collateral       — erasing one player from one session leaves every other session semantically
 *                          identical (order + unknown keys preserved), including entries the serving loader
 *                          would reject and unknown top-level keys.
 *   (b') unreadable file — an unreadable/malformed roster must exit NON-ZERO, never a success receipt — and it
 *                          must be detected BEFORE any row is deleted, so "nothing was changed" is true.
 *   (f)  honest failure  — a roster WRITE failure after rows were deleted must report the rows actually erased
 *                          and still truncate the WAL (exit 5: permissions are permanent); the re-run must exit 0.
 *   (g)  locked file     — a concurrent roster writer (the retention sweep) holds a lock; the CLI must wait,
 *                          then fail non-zero rather than race it; a stale lock is broken.
 *   (e) wrong DB         — a DB_PATH that does not exist, is empty, or is not a SQLite file must exit with a
 *                          DISTINCT non-zero code and must NOT be created/initialised.
 *   (h) pinned reader    — with a reader pinning the WAL the CLI exits 4 QUICKLY (it must not hold the write
 *                          lock for 5 s per attempt while the live server stalls) and the re-run exits 0.
 *   (+) index + batching — the delete must SEARCH an index (not SCAN the table) and run in bounded batches so
 *                          a wipe during a match cannot hold the write lock for tens of seconds.
 *   (i) id validation    — an id the system cannot contain (whitespace, quotes) is a usage error, not an
 *                          "erased 0" success record an operator could file for the real player.
 *
 * (d) — the Docker named-volume split — is a deployment property, pinned in test/deploy-posture.ts.
 *
 * NB §0.1: every name here is a dev placeholder, never a real child. PlayerIds are deliberately long and
 * distinctive so a byte-level scan of the DB files cannot match them by accident.
 *
 *   bun run test/erasure-audit.ts
 *
 * Exits 0 on success, 1 on any failed assertion; cleans up its temp files.
 */

const DIR = '/tmp/ft-erasure-audit';
const DB_PATH = `${DIR}/telemetry.db`;
const ROSTER_FILE = `${DIR}/roster.json`;
const RO_DIR = `${DIR}/ro`;
const RO_ROSTER = `${RO_DIR}/roster.json`; // the real file, in a directory we make unwritable
const RO_LINK = `${DIR}/link-roster.json`; // a symlink to it, in the writable directory (what AUTH_ROSTER_FILE points at)
const MISSING_DB = `${DIR}/MISSING.db`;
const EMPTY_DB = `${DIR}/empty.db`;
const TEXT_DB = `${DIR}/text.db`;

// Must be set before importing db.ts (opens the DB on import).
process.env.DB_PATH = DB_PATH;
process.env.AUTH_ROSTER_FILE = ROSTER_FILE;
process.env.LOG_LEVEL = 'error';

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import type { Telemetry } from '../src/types';

const ERASE_ME = 'ERASE-ME-7A1B';
const KEEP_SAT = 'KEEP-SAT-01';
const DUP_ID = 'DUP-PLAYER-07';
const BATCH_PLAYER = 'BATCH-PLAYER-X';
const SUN_A = 'SUN-A-9C2D';
const PIN_ID = 'PIN-PLAYER-3E4F';
const SQUAD = Array.from({ length: 10 }, (_, i) => `SQUAD-${String(i).padStart(2, '0')}-RR`);

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function runCli(
  script: string,
  args: string[],
  envOverride: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string; ms: number }> {
  const t0 = Date.now();
  const proc = Bun.spawn(['bun', 'run', script, ...args], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, AUTH_ROSTER_FILE: ROSTER_FILE, DB_PATH, ...envOverride },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr, ms: Date.now() - t0 };
}
/** The receipt is the LAST JSON line on the given stream (log lines may precede it). */
const lastJson = (s: string): Record<string, unknown> => JSON.parse(s.trim().split('\n').pop() ?? '{}') as Record<string, unknown>;

/** Byte-level scan of the DB file AND its WAL sidecar (the audit found 9,214 hits in the -wal alone). */
function occurrencesOnDisk(needle: string, db: string = DB_PATH): { db: number; wal: number } {
  const count = (path: string): number => {
    if (!existsSync(path)) return 0;
    const buf = readFileSync(path);
    let n = 0;
    let i = buf.indexOf(needle);
    while (i !== -1) {
      n++;
      i = buf.indexOf(needle, i + 1);
    }
    return n;
  };
  return { db: count(db), wal: count(`${db}-wal`) };
}

function cleanup(): void {
  try { chmodSync(RO_DIR, 0o700); } catch { /* absent */ }
  rmSync(DIR, { recursive: true, force: true });
}
cleanup();
mkdirSync(DIR, { recursive: true });

// The roster as an operator might actually leave it: one departing child, a sibling session, a session
// with a DUPLICATE playerId, an entry the serving loader rejects (name over the 64-char cap), and an
// unknown top-level key. Erasure must touch ONLY what it is asked to touch.
const SUNDAY = [
  { playerId: SUN_A, displayName: 'Sunday A' },
  { playerId: 'SUN-B', displayName: 'Sunday B' },
  { playerId: 'SUN-C', displayName: 'X'.repeat(65) }, // loader-rejected; must still survive on disk
];
const DUP = [
  { playerId: DUP_ID, displayName: 'Dup Name One' },
  { playerId: DUP_ID, displayName: 'Dup Name Two' },
];
const ROSTER = {
  note: 'unknown key — must be preserved',
  sessions: {
    sat: [
      { playerId: ERASE_ME, displayName: 'Departing Child' },
      { playerId: KEEP_SAT, displayName: 'Keep Me Sat' },
    ],
    sun: SUNDAY,
    dup: DUP,
  },
};
const writeRoster = (obj: unknown, file: string = ROSTER_FILE) =>
  writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });

try {
  const { db, insertTelemetry, purgePlayer, purgePlayerBatch } = await import('../src/db');
  const fix = (over: Partial<Telemetry>): Telemetry => ({
    id: 'trk', pl: '00', ts: 1, lat: 44.8, lon: 20.4, spd: 1, hdg: 0,
    fix: 3, sats: 10, pdop: 1, sessionId: 'sat', playerId: '00', serverTs: 1_700_000_000_000, ...over,
  });
  const rowsFor = (playerId: string): number =>
    (db.query('SELECT COUNT(*) AS c FROM telemetry WHERE player_id = ?').get(playerId) as { c: number }).c;
  const plan = (sql: string): string => {
    // prepare()+finalize(), NOT the cached db.query(): an EXPLAIN statement left alive on this connection
    // pins a WAL read snapshot once any later statement runs (bun 1.3 / SQLite quirk, EXPLAIN-specific —
    // plain .get()/.all()/.run() do not), which would make the CLI's TRUNCATE checkpoint below report busy
    // for a reason that has nothing to do with erasure.
    const explain = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
    const out = (explain.all() as { detail: string }[]).map((r) => r.detail).join(' | ');
    explain.finalize();
    return out;
  };

  // ── (+) the delete path is indexed and bounded ──────────────────────────────────────────────────
  assert((db.query('PRAGMA journal_size_limit').get() as { journal_size_limit: number }).journal_size_limit === 0,
    'PRAGMA journal_size_limit must be 0 so every WAL reset truncates the file instead of leaving old page images in it');
  for (const where of ['player_id = ?1', 'player_id = ?1 AND session_id = ?2']) {
    const p = plan(`SELECT rowid FROM telemetry WHERE ${where} LIMIT 10`);
    assert(/SEARCH/.test(p) && /idx_telemetry_player/.test(p) && !/SCAN telemetry/.test(p),
      `the purge lookup for "${where}" must SEARCH idx_telemetry_player, got: ${p}`);
  }
  for (let i = 0; i < 12_000; i++) insertTelemetry(fix({ playerId: BATCH_PLAYER, pl: BATCH_PLAYER, sessionId: 'batch', serverTs: 1_700_000_000_000 + i }));
  assert(rowsFor(BATCH_PLAYER) === 12_000, 'precondition: 12,000 rows for the batch player');
  const first = purgePlayerBatch(BATCH_PLAYER, undefined, 5_000);
  assert(first === 5_000, `one batch must delete at most its limit (5,000), got ${first}`);
  const rest = await purgePlayer(BATCH_PLAYER, undefined, { batch: 5_000 });
  assert(rest === 7_000, `purgePlayer must loop until every row is gone (expected 7,000 more), got ${rest}`);
  assert(rowsFor(BATCH_PLAYER) === 0, 'no rows may remain for the batch player');

  // ── (i) ids the system cannot contain are a usage error, never an "erased 0" success record ─────
  for (const bad of [`${ERASE_ME} `, `07' OR '1'='1`, 'a;b', '']) {
    const r = await runCli('purge-player.ts', bad === '' ? [] : [bad]);
    assert(r.code === 2, `(i) playerId ${JSON.stringify(bad)} must exit 2 (usage), got ${r.code} (stdout: ${r.stdout.trim()})`);
  }
  const badSession = await runCli('purge-player.ts', [ERASE_ME, 'sat; drop']);
  assert(badSession.code === 2, `(i) an invalid sessionId must exit 2, got ${badSession.code}`);

  // ── seed: the erased child's rows INTERLEAVED with survivors, the way 10 Hz ingest actually lays them out
  // (round-robin squad + a 3:1 burst), then checkpoint so the rows live in the MAIN file before the purge ──
  let ts = 1_700_000_000_000;
  for (let i = 0; i < 600; i++) for (const p of SQUAD) insertTelemetry(fix({ playerId: p, pl: p, sessionId: 'rr', serverTs: ts++ }));
  for (let i = 0; i < 1000; i++) {
    for (let k = 0; k < 3; k++) insertTelemetry(fix({ playerId: ERASE_ME, pl: ERASE_ME, serverTs: ts++ }));
    insertTelemetry(fix({ playerId: KEEP_SAT, pl: KEEP_SAT, serverTs: ts++ }));
  }
  for (let i = 0; i < 10; i++) insertTelemetry(fix({ playerId: DUP_ID, pl: DUP_ID, sessionId: 'dup', serverTs: ts++ }));
  for (let i = 0; i < 20; i++) insertTelemetry(fix({ playerId: SUN_A, pl: SUN_A, sessionId: 'sun', serverTs: ts++ }));
  for (let i = 0; i < 200; i++) insertTelemetry(fix({ playerId: PIN_ID, pl: PIN_ID, sessionId: 'pin', serverTs: ts++ }));
  {
    const other = new Database(DB_PATH); // a second connection, like the live server next to the CLI
    other.exec('PRAGMA busy_timeout = 5000');
    other.query('PRAGMA wal_checkpoint(PASSIVE)').get();
    other.close();
  }
  writeRoster(ROSTER);
  const before = occurrencesOnDisk(ERASE_ME);
  assert(before.db >= 3000, `precondition: the playerId must be in the MAIN file before erasure (db ${before.db}, wal ${before.wal})`);

  // ── (a) + (c): erase ERASE_ME from session sat ──────────────────────────────────────────────────
  const purge = await runCli('purge-player.ts', [ERASE_ME, 'sat']);
  assert(purge.code === 0, `purge-player ${ERASE_ME} sat should exit 0, got ${purge.code} (stderr: ${purge.stderr.trim().slice(-400)})`);
  const receipt = lastJson(purge.stdout) as { erased: number; rosterEntriesErased: number; walTruncated: boolean; vacuumed: boolean; storeBytes: number };
  assert(receipt.erased === 3000, `receipt erased must be 3000, got ${receipt.erased}`);
  assert(receipt.rosterEntriesErased === 1, `receipt rosterEntriesErased must be 1, got ${receipt.rosterEntriesErased}`);
  assert(receipt.walTruncated === true, `receipt must report walTruncated:true, got ${JSON.stringify(receipt)}`);
  assert(receipt.vacuumed === true, `receipt must report vacuumed:true — without a VACUUM the gap of a rebalanced leaf page keeps whole rows, got ${JSON.stringify(receipt)}`);
  for (const k of ['deleteMs', 'vacuumMs', 'checkpointMs', 'totalMs', 'storeBytes'] as const) {
    const v = (receipt as unknown as Record<string, unknown>)[k];
    assert(typeof v === 'number' && v >= 0, `receipt must carry ${k} (the compliance record shows how long the store was under the knife), got ${JSON.stringify(receipt)}`);
  }
  assert(rowsFor(ERASE_ME) === 0 && rowsFor(KEEP_SAT) === 1000, 'the departing child is gone from the table; the sibling survives');
  for (const p of SQUAD) assert(rowsFor(p) === 600, `squad player ${p} must be untouched`);

  const after = occurrencesOnDisk(ERASE_ME);
  assert(after.db === 0 && after.wal === 0,
    `(a) the erased playerId must be absent from the DB file AND its WAL after the purge — found db:${after.db} wal:${after.wal} ` +
      `(secure_delete zeroes freed pages, not the unused gap of a leaf page a survivor still occupies — that takes a VACUUM)`);
  assert(!existsSync(`${DB_PATH}-wal`) || statSync(`${DB_PATH}-wal`).size === 0, 'the WAL must be truncated to 0 bytes');

  const onDisk = JSON.parse(readFileSync(ROSTER_FILE, 'utf8')) as typeof ROSTER;
  assert(onDisk.note === ROSTER.note, '(c) an unknown top-level key must be preserved');
  assert(JSON.stringify(onDisk.sessions.sun) === JSON.stringify(SUNDAY),
    `(c) the sibling session must be identical after erasing someone else — got ${JSON.stringify(onDisk.sessions.sun)}`);
  assert(JSON.stringify(onDisk.sessions.dup) === JSON.stringify(DUP),
    `(c) a session the serving loader rejects (duplicate id) must be preserved untouched — got ${JSON.stringify(onDisk.sessions.dup)}`);
  assert(JSON.stringify(onDisk.sessions.sat) === JSON.stringify([{ playerId: KEEP_SAT, displayName: 'Keep Me Sat' }]),
    `only the departing child leaves session sat — got ${JSON.stringify(onDisk.sessions.sat)}`);
  assert(!readFileSync(ROSTER_FILE, 'utf8').includes('Departing Child'), 'the erased name must be gone from the file');

  // ── (a) again for a plain round-robin squad member (the everyday layout, no burst) ──────────────
  const squadPurge = await runCli('purge-player.ts', [SQUAD[3]]);
  assert(squadPurge.code === 0, `purge-player ${SQUAD[3]} should exit 0, got ${squadPurge.code} (stderr: ${squadPurge.stderr.trim().slice(-300)})`);
  const squadAfter = occurrencesOnDisk(SQUAD[3]);
  assert(squadAfter.db === 0 && squadAfter.wal === 0, `(a) a round-robin squad member must leave no residue — found db:${squadAfter.db} wal:${squadAfter.wal}`);
  for (const p of SQUAD) if (p !== SQUAD[3]) assert(rowsFor(p) === 600, `squad player ${p} must be untouched by erasing ${SQUAD[3]}`);

  // ── (b): a duplicate playerId is ERASED (both copies), never skipped with a success receipt ─────
  const dupPurge = await runCli('purge-player.ts', [DUP_ID]);
  assert(dupPurge.code === 0, `purge-player ${DUP_ID} should exit 0, got ${dupPurge.code} (stderr: ${dupPurge.stderr.trim().slice(-300)})`);
  const dupReceipt = lastJson(dupPurge.stdout) as { erased: number; rosterEntriesErased: number };
  assert(dupReceipt.rosterEntriesErased === 2, `(b) both duplicate entries must be erased (rosterEntriesErased:2), got ${dupReceipt.rosterEntriesErased}`);
  assert(dupReceipt.erased === 10, `(b) the duplicate player's rows must be erased, got ${dupReceipt.erased}`);
  const afterDup = readFileSync(ROSTER_FILE, 'utf8');
  assert(!afterDup.includes('Dup Name One') && !afterDup.includes('Dup Name Two'),
    '(b) a duplicate playerId must not leave EITHER name on disk behind a success receipt');
  assert(JSON.stringify((JSON.parse(afterDup) as typeof ROSTER).sessions.sun) === JSON.stringify(SUNDAY),
    '(c) the sibling session survives the duplicate-id erasure too');

  // ── (b'): an unreadable roster is a FAILED erasure — non-zero, retry:true, and NOTHING deleted ──
  writeFileSync(ROSTER_FILE, '{ this is not json', { mode: 0o600 });
  const bad = await runCli('purge-player.ts', [SUN_A]);
  assert(bad.code === 5, `(b') a malformed roster must exit 5 (not erased — fix the file, a blind retry cannot succeed), got ${bad.code} (stdout: ${bad.stdout.trim()})`);
  const badReceipt = lastJson(bad.stderr) as { retry?: boolean; error?: string; erased?: number };
  assert(badReceipt.retry === false, `(b') the failure receipt must say retry:false, got ${bad.stderr.trim()}`);
  assert(!/this is not json/.test(bad.stderr), '(b\') the receipt must never echo roster file CONTENT (it holds names)');
  assert(readFileSync(ROSTER_FILE, 'utf8') === '{ this is not json', '(b\') a failed erasure must not rewrite the file');
  assert(rowsFor(SUN_A) === 20 && badReceipt.erased === 0,
    `(b') the roster must be checked BEFORE any row is deleted — "nothing was changed" must be TRUE (rows left: ${rowsFor(SUN_A)}, receipt erased: ${badReceipt.erased})`);
  writeRoster({ sessions: { sun: SUNDAY } });

  // ── (f): a roster WRITE failure after the delete reports the truth and still truncates the WAL ───
  // The roster is a SYMLINK (writable dir) to the real file (dir made unwritable): the lock and the read
  // succeed, the rows go, and the atomic rename at the symlink's TARGET fails — the honest-failure path.
  mkdirSync(RO_DIR, { recursive: true });
  writeRoster({ sessions: { sun: SUNDAY } }, RO_ROSTER);
  symlinkSync(RO_ROSTER, RO_LINK);
  chmodSync(RO_DIR, 0o500);
  const roFail = await runCli('purge-player.ts', [SUN_A], { AUTH_ROSTER_FILE: RO_LINK });
  chmodSync(RO_DIR, 0o700);
  assert(roFail.code === 5, `(f) a roster write failure (permissions) must exit 5 — fix it, a blind retry cannot succeed — got ${roFail.code} (stdout: ${roFail.stdout.trim()})`);
  const roReceipt = lastJson(roFail.stderr) as { erased?: number; rosterEntriesErased?: number; walTruncated?: boolean; retry?: boolean; error?: string };
  assert(roReceipt.erased === 20, `(f) the failure receipt must report the rows ACTUALLY erased (20), got ${JSON.stringify(roReceipt)}`);
  assert(roReceipt.rosterEntriesErased === 0 && roReceipt.retry === false, `(f) …and rosterEntriesErased:0, retry:false, got ${JSON.stringify(roReceipt)}`);
  assert(roReceipt.walTruncated === true, `(f) the WAL must still be truncated on the failure path, got ${JSON.stringify(roReceipt)}`);
  assert(!/Sunday A/.test(roFail.stderr) && !/Sunday A/.test(roFail.stdout), '(f) no name may reach the console on the failure path');
  assert(!existsSync(`${RO_DIR}`) || !readFileSync(RO_ROSTER, 'utf8').includes('tmp'), 'sanity');
  const leftovers = Bun.spawnSync(['sh', '-c', `ls ${RO_DIR}`]).stdout.toString().trim().split('\n').filter(Boolean);
  assert(leftovers.length === 1 && leftovers[0] === 'roster.json', `(f) a failed write must leave no temp file beside the roster, found: ${leftovers.join(', ')}`);
  const roRetry = await runCli('purge-player.ts', [SUN_A], { AUTH_ROSTER_FILE: RO_LINK });
  assert(roRetry.code === 0, `(f) the re-run must exit 0 once the directory is writable, got ${roRetry.code} (stderr: ${roRetry.stderr.trim().slice(-300)})`);
  const roRetryReceipt = lastJson(roRetry.stdout) as { rosterEntriesErased: number };
  assert(roRetryReceipt.rosterEntriesErased === 1 && !readFileSync(RO_ROSTER, 'utf8').includes('Sunday A'), '(f) the re-run erases the name IN THE TARGET file');
  assert(lstatSync(RO_LINK).isSymbolicLink(), '(f) the rewrite must happen at the symlink TARGET — the symlink itself must survive, not be replaced by a plain copy');
  assert(!existsSync(`${RO_LINK}.lock`), '(f) the lock is released');

  // ── (g): a concurrent roster writer's lock is respected — wait, then fail non-zero; stale locks break ──
  writeRoster({ sessions: { sun: SUNDAY } });
  for (let i = 0; i < 5; i++) insertTelemetry(fix({ playerId: SUN_A, pl: SUN_A, sessionId: 'sun', serverTs: ts++ }));
  const LOCK = `${ROSTER_FILE}.lock`;
  writeFileSync(LOCK, String(process.pid));
  const locked = await runCli('purge-player.ts', [SUN_A]);
  assert(locked.code === 3, `(g) with the roster locked the CLI must exit 3 (retry), got ${locked.code} (stdout: ${locked.stdout.trim()})`);
  assert(/lock/i.test(String((lastJson(locked.stderr) as { error?: string }).error)), `(g) the receipt must say the roster was locked, got ${locked.stderr.trim().slice(-300)}`);
  assert(locked.ms >= 1_000, `(g) the CLI must WAIT for the lock before giving up (took ${locked.ms} ms)`);
  assert(readFileSync(ROSTER_FILE, 'utf8').includes('Sunday A') && rowsFor(SUN_A) === 5, '(g) a locked roster must change nothing');
  const lockedErr = String((lastJson(locked.stderr) as { error?: string }).error);
  assert(new RegExp(`pid ${process.pid}`).test(lockedErr) && /alive/.test(lockedErr) && lockedErr.includes(LOCK),
    `(g) the lock error must name the lock path, the holder pid and whether it is alive, got: ${lockedErr}`);
  // An OLD lock whose holder is STILL ALIVE is not stale — a long-running holder must never be broken from under.
  const stale = new Date(Date.now() - 10 * 60_000);
  utimesSync(LOCK, stale, stale);
  const stillHeld = await runCli('purge-player.ts', [SUN_A]);
  assert(stillHeld.code === 3, `(g) a 10-min-old lock whose pid is ALIVE must still be respected (exit 3), got ${stillHeld.code} (stdout: ${stillHeld.stdout.trim()})`);
  assert(readFileSync(ROSTER_FILE, 'utf8').includes('Sunday A') && existsSync(LOCK), '(g) a live holder\'s lock is neither broken nor changed');
  // A lock whose holder is DEAD is broken immediately (no 60 s wait), whatever its age.
  const ghost = Bun.spawnSync(['true']); // a pid that has already exited
  writeFileSync(LOCK, String(ghost.pid));
  const unstuck = await runCli('purge-player.ts', [SUN_A]);
  assert(unstuck.code === 0, `(g) a lock whose holder pid is DEAD must be broken and the purge proceed, got ${unstuck.code} (stderr: ${unstuck.stderr.trim().slice(-300)})`);
  assert(unstuck.ms < 2_500, `(g) a dead holder's lock must be broken without waiting for the deadline (took ${unstuck.ms} ms)`);
  assert(!existsSync(LOCK), '(g) the CLI must release the lock it took');
  assert(!readFileSync(ROSTER_FILE, 'utf8').includes('Sunday A'), '(g) the name is gone after the dead lock was broken');
  // A lock that cannot be removed (it is a DIRECTORY) must fail fast with a clear error, not spin forever.
  mkdirSync(LOCK);
  const dirLock = await runCli('purge-player.ts', ['SUN-B']);
  rmSync(LOCK, { recursive: true, force: true });
  assert(dirLock.code === 5 && dirLock.ms < 6_000, `(g) an un-removable lock must exit 5 promptly (permanent condition), got ${dirLock.code} in ${dirLock.ms} ms (stderr: ${dirLock.stderr.trim().slice(-300)})`);
  assert((lastJson(dirLock.stderr) as { retry?: boolean }).retry === false, '(g) …with retry:false');

  // ── (j): permanent roster-path/permission problems are exit 5, not "retry" ────────────────────────
  const noDir = await runCli('purge-player.ts', ['SUN-B'], { AUTH_ROSTER_FILE: `${DIR}/no-such-dir/roster.json` });
  assert(noDir.code === 5 && (lastJson(noDir.stderr) as { retry?: boolean }).retry === false,
    `(j) a roster path in a non-existent directory can never be fixed by retrying — exit 5 retry:false, got ${noDir.code} (stderr: ${noDir.stderr.trim().slice(-300)})`);
  assert(rowsFor('SUN-B') === 0 && (lastJson(noDir.stderr) as { rosterFound?: unknown }).rosterFound === null,
    '(j) nothing deleted, and rosterFound is null (unknown) on a receipt emitted before the roster was read');
  // A name hidden in a structure the rewrite does not interpret must not pass for erased.
  writeRoster({ sessions: { odd: [[{ playerId: 'ODD-1', displayName: 'Nested Name' }]] } });
  const nested = await runCli('purge-player.ts', ['ODD-1']);
  assert(nested.code === 5 && /unrecognised structure/.test(String((lastJson(nested.stderr) as { error?: string }).error)),
    `(j) an entry nested where the rewrite cannot reach it must fail with "unrecognised structure" (exit 5), got ${nested.code} (stderr: ${nested.stderr.trim().slice(-300)})`);

  // ── (h): a reader pinning the WAL → exit 4 QUICKLY, then the re-run exits 0 ──────────────────────
  writeRoster({ sessions: { pin: [{ playerId: PIN_ID, displayName: 'Pinned Child' }] } });
  // A reader only pins a TRUNCATE if its snapshot includes WAL frames — the previous run left the WAL at
  // 0 bytes, so write a few uncheckpointed rows first (as the live server always would have).
  for (let i = 0; i < 5; i++) insertTelemetry(fix({ playerId: PIN_ID, pl: PIN_ID, sessionId: 'pin', serverTs: ts++ }));
  const pinner = Bun.spawn(['bun', '-e', `
    const { Database } = require('bun:sqlite');
    const d = new Database(${JSON.stringify(DB_PATH)});
    d.exec('BEGIN'); d.query('SELECT COUNT(*) c FROM telemetry').get();  // an open read txn pins the WAL snapshot
    globalThis.keep = d; // an UNREFERENCED Database gets garbage-collected (closed) mid-sleep — and the pin with it
    console.log('pinned'); await Bun.sleep(60_000);`], { stdout: 'pipe', stderr: 'inherit' });
  const reader = pinner.stdout.getReader();
  await reader.read(); // 'pinned'
  const pinned = await runCli('purge-player.ts', [PIN_ID]);
  pinner.kill();
  await pinner.exited;
  assert(pinned.code === 4, `(h) with a pinned reader the CLI must exit 4 (rows erased, WAL residue — re-run), got ${pinned.code} (stdout: ${pinned.stdout.trim()} stderr: ${pinned.stderr.trim().slice(-300)})`);
  const pinnedReceipt = lastJson(pinned.stderr) as { erased?: number; walTruncated?: boolean; retry?: boolean };
  assert(pinnedReceipt.erased === 205 && pinnedReceipt.walTruncated === false && pinnedReceipt.retry === true,
    `(h) the exit-4 receipt must report erased:205, walTruncated:false, retry:true, got ${JSON.stringify(pinnedReceipt)}`);
  assert(pinned.ms < 8_000,
    `(h) the CLI must give up FAST — each TRUNCATE attempt busy-waits holding the WRITE lock, so a 5 s busy_timeout × attempts freezes the live server; took ${pinned.ms} ms`);
  const unpinned = await runCli('purge-player.ts', [PIN_ID]);
  assert(unpinned.code === 0, `(h) the re-run without the reader must exit 0, got ${unpinned.code} (stderr: ${unpinned.stderr.trim().slice(-300)})`);
  const pinAfter = occurrencesOnDisk(PIN_ID);
  assert(pinAfter.db === 0 && pinAfter.wal === 0, `(h) after the re-run no residue may remain — found db:${pinAfter.db} wal:${pinAfter.wal}`);

  // ── (e): a DB_PATH that is missing, empty, or not SQLite is a WRONG-FILE error, distinct from "retry" ──
  writeFileSync(EMPTY_DB, '');
  writeFileSync(TEXT_DB, 'this is a text file, not a database\n');
  for (const [label, path, check] of [
    ['missing', MISSING_DB, () => !existsSync(MISSING_DB)],
    ['empty (0-byte)', EMPTY_DB, () => statSync(EMPTY_DB).size === 0],
    ['non-SQLite', TEXT_DB, () => readFileSync(TEXT_DB, 'utf8').startsWith('this is a text file')],
  ] as const) {
    const r = await runCli('purge-player.ts', [SUN_A], { DB_PATH: path });
    assert(r.code === 5, `(e) a ${label} DB_PATH must exit 5 (wrong file — fix DB_PATH, do not retry), got ${r.code} (stdout: ${r.stdout.trim()} stderr: ${r.stderr.trim().slice(-200)})`);
    const rr = lastJson(r.stderr) as { retry?: boolean; dbPath?: string };
    assert(rr.retry === false, `(e) ${label}: the receipt must say retry:false, got ${r.stderr.trim().slice(-300)}`);
    assert(typeof rr.dbPath === 'string' && rr.dbPath.endsWith(path.replace(DIR, '').replace(/^\//, '')), `(e) ${label}: the receipt must name the path it refused, got ${rr.dbPath}`);
    assert(check(), `(e) ${label}: the CLI must NOT create or initialise the file (that is how "wrong path" became "erased 0, exit 0")`);
  }

  console.log('\n✅ ERASURE AUDIT PASSED — no on-disk residue (interleaved + round-robin layouts, VACUUM + TRUNCATE), duplicate ids erased, '
    + 'other sessions preserved, unreadable roster → exit 5 before any delete, honest failure receipts, lock respected / stale lock broken, '
    + 'pinned reader → fast exit 4 then 0, wrong DB → exit 5 untouched, ids validated, delete path indexed + batched');
  cleanup();
  process.exit(0);
} catch (err) {
  console.error('\n❌ ERASURE AUDIT FAILED:', (err as Error).message);
  cleanup();
  process.exit(1);
}
