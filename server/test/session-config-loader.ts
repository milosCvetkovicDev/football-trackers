/**
 * Pure-function unit test for the fail-closed session-config loader (`loadSessionConfig` in
 * src/sessionConfig.ts) — Phase 4, ADR-0019, contract §2.1.
 *
 * The session-config maps sessionId → age band; the band selects youth speed-zone thresholds. UNLIKE
 * the roster this file holds NO names/locations (the band is non-sensitive config), so there is no
 * name-leak property to assert here. The property that MUST hold is FAIL CLOSED — modelled on the
 * roster loader: a missing/oversized/malformed/no-"sessions" file degrades to ZERO configured sessions
 * (every session then resolves to the documented U14 default so zones ALWAYS render), never throws,
 * never partially trusts a bad file. Per-entry, an invalid ageBand drops that entry only.
 *
 * Importing src/sessionConfig runs its top-level consts but starts no timers (we never call
 * initSessionConfig). A unique temp SESSION_CONFIG_FILE per case so nothing collides.
 *
 *   bun run test/session-config-loader.ts
 *
 * Exits 0 on success, 1 on any failed assertion; cleans up its temp dir. Only match-session ids
 * (e.g. 's1') and the four age bands appear here — never any real child's name.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSessionConfig } from '../src/sessionConfig';

const CONFIG_MAX_BYTES = 1_000_000; // mirrors CONFIG_MAX_BYTES in src/sessionConfig.ts
const BANDS = ['U12', 'U14', 'U16', 'U19'] as const;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

// One temp dir for all fixtures; a unique filename per case so nothing collides.
const dir = mkdtempSync(join(tmpdir(), 'ft-session-config-loader-'));
let n = 0;
const fixture = (json: string): string => {
  const p = join(dir, `session-config-${n++}.json`);
  writeFileSync(p, json);
  return p;
};

let passed = 0;
const ok = (msg: string) => { passed++; console.log(`  ok: ${msg}`); };

try {
  // --- 1. valid file: 2 sessions, each a recognised band -> exact shape -------------------------------
  {
    const f = fixture(JSON.stringify({
      sessions: { s1: { ageBand: 'U12' }, s2: { ageBand: 'U19' } },
    }));
    const m = await loadSessionConfig(f);
    assert(m.size === 2, `valid file should load 2 sessions, got ${m.size}`);
    assert(m.get('s1') === 'U12', `s1 band must round-trip as U12, got ${m.get('s1')}`);
    assert(m.get('s2') === 'U19', `s2 band must round-trip as U19, got ${m.get('s2')}`);
    ok('valid 2-session file -> exact sessions/bands');
  }

  // --- 2. missing file path -> empty Map, no throw (default band applies everywhere) ------------------
  {
    const m = await loadSessionConfig(join(dir, 'does-not-exist.json'));
    assert(m instanceof Map, 'missing file should still return a Map');
    assert(m.size === 0, `missing file should yield 0 configured sessions, got ${m.size}`);
    ok('missing file -> empty Map (no throw; defaults apply)');
  }

  // --- 3. file larger than the cap (valid JSON, padded) -> empty Map (fail closed) --------------------
  {
    const pad = 'x'.repeat(CONFIG_MAX_BYTES + 50_000);
    const json = JSON.stringify({ pad, sessions: { s1: { ageBand: 'U14' } } });
    assert(Buffer.byteLength(json) > CONFIG_MAX_BYTES, 'precondition: oversized fixture must exceed the cap');
    JSON.parse(json); // sanity: valid JSON, so this isolates the size cap (not a parse error)
    const m = await loadSessionConfig(fixture(json));
    assert(m.size === 0, `oversized (but valid) file should fail closed to 0 sessions, got ${m.size}`);
    ok('file > cap (valid JSON) -> empty Map (fail closed)');
  }

  // --- 4. malformed JSON -> empty Map -----------------------------------------------------------------
  {
    const m = await loadSessionConfig(fixture('{not json'));
    assert(m.size === 0, `malformed JSON should yield 0 sessions, got ${m.size}`);
    ok('malformed JSON -> empty Map');
  }

  // --- 5. valid JSON but no top-level "sessions" object -> empty Map ----------------------------------
  {
    const m = await loadSessionConfig(fixture('{}'));
    assert(m.size === 0, `JSON with no sessions object should yield 0, got ${m.size}`);
    // A "sessions" that is present but not an object (array / string) must also fail closed.
    const m2 = await loadSessionConfig(fixture(JSON.stringify({ sessions: ['nope'] })));
    assert(m2.size === 0, `array sessions field should yield 0, got ${m2.size}`);
    const m3 = await loadSessionConfig(fixture(JSON.stringify({ sessions: 'nope' })));
    assert(m3.size === 0, `string sessions field should yield 0, got ${m3.size}`);
    ok('no/invalid top-level sessions object -> empty Map');
  }

  // --- 6. entry with an invalid ageBand dropped; valid entry survives ---------------------------------
  // An unknown band ('U10'), a non-string band, and a missing-ageBand entry are dropped; the valid
  // entry survives (per-entry fail closed, not whole-file).
  {
    const f = fixture(JSON.stringify({
      sessions: {
        s1: { ageBand: 'U10' },          // not one of the 4 -> drop
        s2: { ageBand: 12 },             // non-string band -> drop
        s3: { notTheRightKey: 'U14' },   // no ageBand -> drop
        s4: { ageBand: 'U16' },          // valid -> survive
      },
    }));
    const m = await loadSessionConfig(f);
    assert(m.size === 1, `only the 1 valid entry should survive, got ${m.size}`);
    assert(m.get('s4') === 'U16', 'the valid s4/U16 entry must survive the drops');
    assert(!m.has('s1') && !m.has('s2') && !m.has('s3'), 'invalid-band entries must be dropped');
    ok('invalid ageBand entries dropped; valid survives (per-entry fail closed)');
  }

  // --- 7. each of the 4 valid bands is accepted -------------------------------------------------------
  {
    const sessions: Record<string, { ageBand: string }> = {};
    BANDS.forEach((b, i) => { sessions[`s${i}`] = { ageBand: b }; });
    const m = await loadSessionConfig(fixture(JSON.stringify({ sessions })));
    assert(m.size === BANDS.length, `all ${BANDS.length} valid bands should load, got ${m.size}`);
    BANDS.forEach((b, i) => assert(m.get(`s${i}`) === b, `s${i} must round-trip as ${b}`));
    ok(`all 4 valid bands accepted (${BANDS.join(', ')})`);
  }

  console.log(`\n✅ SESSION-CONFIG-LOADER UNIT PASSED — ${passed} cases: fail-closed on missing/oversized/`
    + `malformed/no-sessions, per-entry drop for an invalid ageBand, and all four valid bands accepted`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
} catch (err) {
  console.error('\n❌ SESSION-CONFIG-LOADER UNIT FAILED:', (err as Error).message);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(1);
}
