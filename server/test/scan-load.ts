/**
 * scan-load.ts — the cross-surface shared off-loop inflight cap (PM-1 / PB-1; event-detection-contract §6.7).
 *
 * The #1 loop-protection control: /history and /events must draw from ONE global scanLoad counter so the
 * worst-case interleaved-scan count can't exceed OFFLOOP_MAX_INFLIGHT no matter how the two surfaces are mixed.
 * The history unit test only exercises historyGate, and events-e2e fires events-only concurrency — both pass
 * even with a PRIVATE per-surface counter (the exact pre-PM-1 bug). This test proves the cap is genuinely
 * SHARED: a slot taken via one surface's gate denies the OTHER surface, in BOTH directions, and the combined
 * inflight count is one number.
 *
 *   bun run test/scan-load.ts   — exits 0 on success, 1 on any failed assertion.
 */

process.env.OFFLOOP_MAX_INFLIGHT = '2'; // small shared cap so the contention is deterministic
process.env.DB_PATH = '/tmp/ft-scanload-test.db';
process.env.LOG_LEVEL = 'error';

import { existsSync, rmSync } from 'node:fs';
for (const f of ['/tmp/ft-scanload-test.db', '/tmp/ft-scanload-test.db-wal', '/tmp/ft-scanload-test.db-shm'])
  if (existsSync(f)) rmSync(f);

const { eventsGate, releaseEventsInflight } = await import('../src/events');
const { historyGate, releaseInflight, _inflightCount } = await import('../src/history');
const { _scanInflight } = await import('../src/scanLoad');

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

try {
  assert(_scanInflight() === 0, 'shared counter starts at 0');

  // Take BOTH slots via the EVENTS surface (fresh principals so the per-surface rate bucket never bites).
  const e1 = eventsGate('coachA');
  const e2 = eventsGate('coachB');
  assert(e1.ok && e2.ok, 'two events scans should acquire the two shared slots');
  // Both surfaces report the SAME combined counter — history's _inflightCount re-exports scanLoad's.
  assert(_scanInflight() === 2, `shared inflight should be 2, got ${_scanInflight()}`);
  assert(_inflightCount() === 2, `history's _inflightCount must reflect the COMBINED count (2), got ${_inflightCount()}`);

  // THE CROSS-SURFACE PROOF (forward): a HISTORY scan is denied because EVENTS took the shared slots. A private
  // events counter would leave history's own counter at 0 here and WRONGLY admit this — the pre-PM-1 bug.
  const h1 = historyGate('coachC');
  assert(!h1.ok && h1.result === 'busy', 'history must be denied (503 busy) by the slots EVENTS holds — shared cap');

  // Free one EVENTS slot → a HISTORY scan can now take it (the slot is genuinely shared, not per-surface).
  releaseEventsInflight();
  assert(_scanInflight() === 1, `releasing one events slot drops the shared count to 1, got ${_scanInflight()}`);
  const h2 = historyGate('coachD');
  assert(h2.ok, 'history must acquire the slot freed by an events release (shared)');
  assert(_scanInflight() === 2, 'shared count back to 2 (1 events + 1 history)');

  // THE CROSS-SURFACE PROOF (reverse): with the cap full (1 events + 1 history), a NEW EVENTS scan is denied
  // by the slot HISTORY holds.
  const e3 = eventsGate('coachE');
  assert(!e3.ok && e3.result === 'busy', 'events must be denied by the slot HISTORY holds — shared cap, reverse direction');

  // Balance the counter back to 0.
  releaseEventsInflight(); // free the remaining events slot
  releaseInflight(); // free the history slot
  assert(_scanInflight() === 0, `shared counter must return to 0 after balanced release, got ${_scanInflight()}`);

  console.log('\n✅ SCAN-LOAD PASSED — the off-loop inflight cap is genuinely SHARED across /history + /events (both directions); a private per-surface counter would fail this');
  for (const f of ['/tmp/ft-scanload-test.db', '/tmp/ft-scanload-test.db-wal', '/tmp/ft-scanload-test.db-shm'])
    if (existsSync(f)) rmSync(f);
  process.exit(0);
} catch (err) {
  console.error('\n❌ SCAN-LOAD FAILED:', (err as Error).message);
  process.exit(1);
}
