/**
 * Pure-function unit test for the fail-closed roster loader (`loadRoster` in src/roster.ts).
 *
 * THREAT MODEL §0: this map is the ONLY at-rest store of child/player NAMES. Two properties must hold no
 * matter how malformed the file is:
 *   1. FAIL CLOSED — a missing/oversized/malformed/no-"sessions"/duplicate file degrades to ZERO names,
 *      never throws, never partially trusts a bad file (mirrors loadAccounts).
 *   2. NAMES NEVER LOGGED (§0.1) — when the loader drops a bad/over-long entry it WARNs with the playerId +
 *      counts ONLY. A return-value assertion alone is insufficient for this, so the bad-entry + over-long
 *      cases CAPTURE console.error (where log.warn/error write) and assert the displayName VALUE is ABSENT
 *      from the captured output.
 *
 * Importing src/roster runs its top-level consts but starts no timers (we never call initRoster).
 *
 *   bun run test/roster-loader.ts
 *
 * Exits 0 on success, 1 on any failed assertion; cleans up its temp dir. NB: only match-session ids
 * (e.g. 's1') and dev player display names (e.g. 'Alex M.') appear here — never any real child's name.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRoster } from '../src/roster';

const ROSTER_MAX_BYTES = 1_000_000; // mirrors the un-exported const in src/roster.ts
const ROSTER_NAME_MAX = 64;
const ROSTER_MAX_PLAYERS_PER_SESSION = 64;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

// One temp dir for all fixtures; a unique filename per case so nothing collides.
const dir = mkdtempSync(join(tmpdir(), 'ft-roster-loader-'));
let n = 0;
const fixture = (json: string): string => {
  const p = join(dir, `roster-${n++}.json`);
  writeFileSync(p, json);
  return p;
};

let passed = 0;
const ok = (msg: string) => { passed++; console.log(`  ok: ${msg}`); };

/**
 * Run `fn` with console.error AND console.log captured (log.warn/error → console.error, log.info →
 * console.log) so a test can assert a name value never reaches ANY log sink. Returns the captured text.
 */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ value: T; captured: string }> {
  const origErr = console.error;
  const origLog = console.log;
  let buf = '';
  const sink = (...args: unknown[]) => { buf += args.map(String).join(' ') + '\n'; };
  console.error = sink as typeof console.error;
  console.log = sink as typeof console.log;
  try {
    const value = await fn();
    return { value, captured: buf };
  } finally {
    console.error = origErr;
    console.log = origLog;
  }
}

try {
  // --- 1. valid file: 1 session with 2 players, 1 session with 1 player -> exact shape ----------------
  {
    const f = fixture(JSON.stringify({
      sessions: {
        s1: [{ playerId: '07', displayName: 'Alex M.' }, { playerId: '09', displayName: 'Bo T.' }],
        s2: [{ playerId: '11', displayName: 'Cam R.' }],
      },
    }));
    const m = await loadRoster(f);
    assert(m.size === 2, `valid file should load 2 sessions, got ${m.size}`);
    assert(m.get('s1')!.size === 2, `s1 should have 2 players, got ${m.get('s1')!.size}`);
    assert(m.get('s1')!.get('07') === 'Alex M.', 's1/07 name must round-trip');
    assert(m.get('s1')!.get('09') === 'Bo T.', 's1/09 name must round-trip');
    assert(m.get('s2')!.get('11') === 'Cam R.', 's2/11 name must round-trip');
    ok('valid file -> exact sessions/players/names');
  }

  // --- 2. missing file path -> empty Map, no throw ------------------------------------------------------
  {
    const m = await loadRoster(join(dir, 'does-not-exist.json'));
    assert(m instanceof Map, 'missing file should still return a Map');
    assert(m.size === 0, `missing file should yield 0 sessions, got ${m.size}`);
    ok('missing file -> empty Map (no throw)');
  }

  // --- 3. file larger than ROSTER_MAX_BYTES (valid JSON, padded) -> empty Map (fail closed) -------------
  {
    const pad = 'x'.repeat(ROSTER_MAX_BYTES + 50_000);
    const json = JSON.stringify({ pad, sessions: { s1: [{ playerId: '07', displayName: 'Alex M.' }] } });
    assert(Buffer.byteLength(json) > ROSTER_MAX_BYTES, 'precondition: oversized fixture must exceed the cap');
    JSON.parse(json); // sanity: valid JSON, so this isolates the size cap (not a parse error)
    const m = await loadRoster(fixture(json));
    assert(m.size === 0, `oversized (but valid) file should fail closed to 0 sessions, got ${m.size}`);
    ok('file > ROSTER_MAX_BYTES (valid JSON) -> empty Map (fail closed)');
  }

  // --- 4. malformed JSON -> empty Map -------------------------------------------------------------------
  {
    const m = await loadRoster(fixture('{not json'));
    assert(m.size === 0, `malformed JSON should yield 0 sessions, got ${m.size}`);
    ok('malformed JSON -> empty Map');
  }

  // --- 5. valid JSON but no top-level "sessions" object -> empty Map ------------------------------------
  {
    const m = await loadRoster(fixture('{}'));
    assert(m.size === 0, `JSON with no sessions object should yield 0, got ${m.size}`);
    // An "sessions" that is present but not an object (array / string) must also fail closed.
    const m2 = await loadRoster(fixture(JSON.stringify({ sessions: ['nope'] })));
    assert(m2.size === 0, `array sessions field should yield 0, got ${m2.size}`);
    const m3 = await loadRoster(fixture(JSON.stringify({ sessions: 'nope' })));
    assert(m3.size === 0, `string sessions field should yield 0, got ${m3.size}`);
    ok('no/invalid top-level sessions object -> empty Map');
  }

  // --- 6. bad entries dropped; valid entry survives; NAME VALUE NEVER LOGGED ----------------------------
  // A bad-playerId entry, an empty-name entry, and a non-string-name entry are dropped; the valid entry
  // survives. CRITICAL: capture the logs and assert NO supplied name value appears in them (§0.1).
  {
    const BAD_PID_NAME = 'ShouldNotLeakBadPid';   // attached to an entry whose playerId is invalid
    const EMPTY_NAME_PID = '08';                   // its name is '' so there's no value to leak, but assert anyway
    const NONSTR_NAME_PID = '10';                  // its name is a number
    const f = fixture(JSON.stringify({
      sessions: {
        s1: [
          { playerId: 'bad id!', displayName: BAD_PID_NAME },     // invalid playerId charset -> drop
          { playerId: EMPTY_NAME_PID, displayName: '' },          // empty name -> drop
          { playerId: NONSTR_NAME_PID, displayName: 12345 },      // non-string name -> drop
          { playerId: '07', displayName: 'Alex M.' },             // valid -> survive
        ],
      },
    }));
    const { value: m, captured } = await captureLogs(() => loadRoster(f));
    assert(m.size === 1 && m.get('s1')!.size === 1, `only the 1 valid entry should survive, got ${m.get('s1')?.size}`);
    assert(m.get('s1')!.get('07') === 'Alex M.', 'the valid s1/07 entry must survive the drops');
    assert(!m.get('s1')!.has('08') && !m.get('s1')!.has('10'), 'bad-name entries must be dropped');
    // §0.1: the dropped entry's NAME VALUE must be absent from EVERY log sink.
    assert(!captured.includes(BAD_PID_NAME), `the bad-playerId entry's NAME VALUE must NOT appear in logs; captured:\n${captured}`);
    assert(captured.length > 0, 'precondition: the loader must have logged SOMETHING about the drops (so the absence assertion is meaningful)');
    ok('bad entries dropped; valid survives; NO dropped-name value in captured logs');
  }

  // --- 7. over-long displayName (65 chars) dropped; NAME VALUE NEVER LOGGED -----------------------------
  {
    const LONG_NAME = 'Z'.repeat(ROSTER_NAME_MAX + 1); // 65 chars -> over cap -> drop
    const f = fixture(JSON.stringify({
      sessions: { s1: [{ playerId: '13', displayName: LONG_NAME }, { playerId: '07', displayName: 'Alex M.' }] },
    }));
    const { value: m, captured } = await captureLogs(() => loadRoster(f));
    assert(m.get('s1')!.size === 1 && m.get('s1')!.get('07') === 'Alex M.', 'only the in-range entry should survive the over-long drop');
    assert(!m.get('s1')!.has('13'), 'the over-long-name entry must be dropped');
    // §0.1: the over-long name value must not appear in any log line (we logged playerId + a LENGTH, not the value).
    assert(!captured.includes(LONG_NAME), `the over-long NAME VALUE must NOT appear in logs; captured:\n${captured}`);
    assert(captured.includes('13'), 'the over-long drop should be logged by playerId (proves we logged the id, not the name)');
    ok('over-long displayName dropped; NO name value in captured logs (playerId + length only)');
  }

  // --- 8. per-session player cap: excess entries dropped ------------------------------------------------
  {
    const entries = [];
    for (let i = 0; i < ROSTER_MAX_PLAYERS_PER_SESSION + 5; i++) {
      entries.push({ playerId: `p${i}`, displayName: `Player ${i}` });
    }
    const m = await loadRoster(fixture(JSON.stringify({ sessions: { s1: entries } })));
    assert(m.get('s1')!.size === ROSTER_MAX_PLAYERS_PER_SESSION,
      `session must be capped at ${ROSTER_MAX_PLAYERS_PER_SESSION}, got ${m.get('s1')!.size}`);
    ok(`per-session player cap enforced (${ROSTER_MAX_PLAYERS_PER_SESSION})`);
  }

  // --- 9. DUPLICATE playerId in a session -> that WHOLE session rejected (0 names for it); NO name logged
  {
    const DUP_NAME_A = 'DupNameAlpha';
    const DUP_NAME_B = 'DupNameBravo';
    const f = fixture(JSON.stringify({
      sessions: {
        s1: [
          { playerId: '07', displayName: DUP_NAME_A },
          { playerId: '07', displayName: DUP_NAME_B }, // dup playerId -> reject the WHOLE s1 roster
          { playerId: '09', displayName: 'Bo T.' },    // valid, but must NOT survive (whole session rejected)
        ],
        s2: [{ playerId: '11', displayName: 'Cam R.' }], // a DIFFERENT session is unaffected
      },
    }));
    const { value: m, captured } = await captureLogs(() => loadRoster(f));
    assert(!m.has('s1'), 'a duplicate playerId must reject the WHOLE session (s1 absent, fail closed)');
    assert(m.get('s2')!.get('11') === 'Cam R.', 'a different session must be unaffected by another\'s duplicate');
    // §0.1: neither duplicate name value may appear in the ERROR log line.
    assert(!captured.includes(DUP_NAME_A) && !captured.includes(DUP_NAME_B),
      `the duplicate ERROR must NOT log either name value; captured:\n${captured}`);
    assert(captured.includes('07'), 'the duplicate should be logged by playerId (the id, never the name)');
    ok('duplicate playerId -> whole session rejected; other session intact; NO name value logged');
  }

  console.log(`\n✅ ROSTER-LOADER UNIT PASSED — ${passed} cases: fail-closed on missing/oversized/malformed/`
    + `no-sessions/duplicate, per-entry drops for bad-playerId/empty-name/non-string/over-long, per-session cap, `
    + `and NO displayName value ever reaches a log sink (captured-output asserted on the drop + dup paths)`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
} catch (err) {
  console.error('\n❌ ROSTER-LOADER UNIT FAILED:', (err as Error).message);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(1);
}
