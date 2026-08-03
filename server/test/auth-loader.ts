/**
 * Pure-function unit test for the fail-closed accounts loader (`loadAccounts` in src/auth.ts).
 *
 * THREAT MODEL #1: this map is the access-control list for the LIVE LOCATION OF MINORS. Every malformed,
 * oversized, duplicate, or otherwise-suspect accounts file MUST degrade to ZERO accounts (fail closed),
 * never throw, never partially trust a bad file. This test drives `loadAccounts(path)` directly against
 * fixtures written to a temp dir and asserts on the returned Map — no server, no broker, no timers.
 *
 * Importing src/auth runs its top-level consts but starts no timers (we never call initAuth). Hashes are
 * generated at runtime with Bun.password.hash(..., argon2id) — never hardcoded.
 *
 *   bun run test/auth-loader.ts
 *
 * Exits 0 on success, 1 on any failed assertion; cleans up its temp dir. NB: only match-session ids
 * (e.g. 's1') and adult coach usernames (e.g. 'coach1') appear here — never any child/player name.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAccounts } from '../src/auth';
import type { Account } from '../src/auth';

const MAX_ACCOUNTS_BYTES = 1_000_000; // mirrors the un-exported const in src/auth.ts

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

// One temp dir for all fixtures; a unique filename per case so nothing collides.
const dir = mkdtempSync(join(tmpdir(), 'ft-auth-loader-'));
let n = 0;
const fixture = (json: string): string => {
  const p = join(dir, `accounts-${n++}.json`);
  writeFileSync(p, json);
  return p;
};

// Two known-good argon2id hashes, computed once at runtime (never hardcoded).
let HASH_A = '';
let HASH_B = '';

let passed = 0;
const ok = (msg: string) => { passed++; console.log(`  ok: ${msg}`); };

try {
  HASH_A = await Bun.password.hash('pw-a', { algorithm: 'argon2id' });
  HASH_B = await Bun.password.hash('pw-b', { algorithm: 'argon2id' });
  assert(HASH_A.startsWith('$argon2id$'), 'precondition: generated hash A must be argon2id');
  assert(HASH_B.startsWith('$argon2id$'), 'precondition: generated hash B must be argon2id');

  // --- 1. valid file, 2 accounts (1 coach w/ sessions ['s1','s2'], 1 admin) -> size 2, exact roles/sessions
  {
    const f = fixture(JSON.stringify({
      accounts: [
        { username: 'coach1', hash: HASH_A, role: 'coach', sessions: ['s1', 's2'] },
        { username: 'admin1', hash: HASH_B, role: 'admin', sessions: [] },
      ],
    }));
    const m = await loadAccounts(f);
    assert(m.size === 2, `valid 2-account file should load size 2, got ${m.size}`);
    const coach = m.get('coach1');
    const admin = m.get('admin1');
    assert(coach !== undefined, 'coach1 must be present in the map');
    assert(admin !== undefined, 'admin1 must be present in the map');
    assert(coach!.role === 'coach', `coach1 role should be 'coach', got '${coach!.role}'`);
    assert(admin!.role === 'admin', `admin1 role should be 'admin', got '${admin!.role}'`);
    assert(coach!.username === 'coach1', `coach1 username should round-trip, got '${coach!.username}'`);
    assert(JSON.stringify(coach!.sessions) === JSON.stringify(['s1', 's2']),
      `coach1 sessions should be exactly ['s1','s2'], got ${JSON.stringify(coach!.sessions)}`);
    assert(coach!.hash === HASH_A, 'coach1 hash should round-trip verbatim');
    assert(JSON.stringify(admin!.sessions) === JSON.stringify([]),
      `admin1 sessions should be [], got ${JSON.stringify(admin!.sessions)}`);
    ok('valid 2-account file -> size 2 with exact roles + sessions');
  }

  // --- 2. missing file path -> empty Map, no throw
  {
    const m = await loadAccounts(join(dir, 'does-not-exist.json'));
    assert(m instanceof Map, 'missing file should still return a Map');
    assert(m.size === 0, `missing file should yield 0 accounts, got ${m.size}`);
    ok('missing file path -> empty Map (no throw)');
  }

  // --- 3. file larger than MAX_ACCOUNTS_BYTES (VALID JSON, padded field) -> empty Map (fail closed)
  {
    // Pad a string field so the file is valid JSON yet exceeds the 1,000,000-byte cap.
    const pad = 'x'.repeat(MAX_ACCOUNTS_BYTES + 50_000);
    const json = JSON.stringify({
      pad, // oversized but parseable
      accounts: [{ username: 'coach1', hash: HASH_A, role: 'coach', sessions: ['s1'] }],
    });
    assert(Buffer.byteLength(json) > MAX_ACCOUNTS_BYTES,
      `precondition: oversized fixture must exceed ${MAX_ACCOUNTS_BYTES} bytes, was ${Buffer.byteLength(json)}`);
    // Sanity: it really is valid JSON (so this case isolates the size cap, not a parse error).
    JSON.parse(json);
    const f = fixture(json);
    const m = await loadAccounts(f);
    assert(m.size === 0, `oversized (but valid) file should fail closed to 0 accounts, got ${m.size}`);
    ok('file > MAX_ACCOUNTS_BYTES (valid JSON) -> empty Map (fail closed)');
  }

  // --- 4. malformed JSON -> empty Map
  {
    const f = fixture('{not json');
    const m = await loadAccounts(f);
    assert(m.size === 0, `malformed JSON should yield 0 accounts, got ${m.size}`);
    ok('malformed JSON -> empty Map');
  }

  // --- 5. valid JSON but no top-level "accounts" array -> empty Map
  {
    const f = fixture('{}');
    const m = await loadAccounts(f);
    assert(m.size === 0, `JSON with no accounts array should yield 0 accounts, got ${m.size}`);
    // Also: an "accounts" that is present but not an array must fail closed.
    const f2 = fixture(JSON.stringify({ accounts: 'nope' }));
    const m2 = await loadAccounts(f2);
    assert(m2.size === 0, `non-array accounts field should yield 0 accounts, got ${m2.size}`);
    ok('no/invalid top-level accounts array -> empty Map');
  }

  // --- 6. entry with missing/blank username -> skipped; the OTHER valid entry still loads
  {
    const f = fixture(JSON.stringify({
      accounts: [
        { username: '', hash: HASH_A, role: 'coach', sessions: ['s1'] },       // blank -> skip
        { hash: HASH_B, role: 'admin', sessions: [] },                          // missing -> skip
        { username: 'coach1', hash: HASH_A, role: 'coach', sessions: ['s1'] },  // valid
      ],
    }));
    const m = await loadAccounts(f);
    assert(m.size === 1, `only the valid entry should load (size 1), got ${m.size}`);
    assert(m.has('coach1'), 'the valid coach1 entry must survive while the blank/missing ones are skipped');
    assert(!m.has(''), 'a blank-username entry must never be keyed into the map');
    ok('missing/blank username entries skipped; valid entry still loads');
  }

  // --- 7. entry whose hash does NOT start with $argon2id$ -> dropped; other valid entry loads
  {
    const f = fixture(JSON.stringify({
      accounts: [
        { username: 'coach-bad', hash: 'plaintext', role: 'coach', sessions: ['s1'] }, // not argon2id -> drop
        { username: 'coach1', hash: HASH_A, role: 'coach', sessions: ['s2'] },          // valid
      ],
    }));
    const m = await loadAccounts(f);
    assert(m.size === 1, `non-argon2id entry must be dropped (size 1), got ${m.size}`);
    assert(!m.has('coach-bad'), 'a non-argon2id-hash account must be dropped');
    assert(m.has('coach1'), 'the valid argon2id account must still load');
    ok('non-argon2id hash dropped; valid entry loads');
  }

  // --- 8. entry with an invalid role -> dropped; other valid entry loads
  {
    const f = fixture(JSON.stringify({
      accounts: [
        { username: 'coach-bad', hash: HASH_A, role: 'superuser', sessions: ['s1'] }, // bad role -> drop
        { username: 'admin1', hash: HASH_B, role: 'admin', sessions: [] },            // valid
      ],
    }));
    const m = await loadAccounts(f);
    assert(m.size === 1, `invalid-role entry must be dropped (size 1), got ${m.size}`);
    assert(!m.has('coach-bad'), 'an account with an invalid role must be dropped');
    assert(m.has('admin1'), 'the valid admin account must still load');
    assert(m.get('admin1')!.role === 'admin', 'surviving account keeps its valid role');
    ok('invalid role dropped; valid entry loads');
  }

  // --- 9. DUPLICATE username across two entries -> ENTIRE file rejected (size 0, fail closed)
  {
    const f = fixture(JSON.stringify({
      accounts: [
        { username: 'coach1', hash: HASH_A, role: 'coach', sessions: ['s1'] },
        { username: 'coach1', hash: HASH_B, role: 'admin', sessions: [] }, // dup username -> reject whole file
        { username: 'admin1', hash: HASH_B, role: 'admin', sessions: [] }, // valid, but must NOT survive
      ],
    }));
    const m = await loadAccounts(f);
    assert(m.size === 0, `a duplicate username must reject the ENTIRE file (size 0), got ${m.size}`);
    assert(!m.has('coach1') && !m.has('admin1'),
      'on a duplicate username the whole map must be empty — not even the otherwise-valid admin1 survives');
    ok('duplicate username -> entire file rejected (empty Map, fail closed)');
  }

  // --- 10. non-array sessions -> sessions === []; array with non-strings -> filtered to only strings
  {
    const f = fixture(JSON.stringify({
      accounts: [
        { username: 'coach1', hash: HASH_A, role: 'coach', sessions: 's1' }, // non-array -> []
        // mixed array: keep only the string elements ('s1','u12-red'), drop number/null/object/bool
        { username: 'coach2', hash: HASH_B, role: 'coach', sessions: ['s1', 7, null, { x: 1 }, 'u12-red', true] },
      ],
    }));
    const m = await loadAccounts(f);
    assert(m.size === 2, `both accounts should load (size 2), got ${m.size}`);
    const c1 = m.get('coach1');
    const c2 = m.get('coach2');
    assert(c1 !== undefined && c2 !== undefined, 'both coach1 and coach2 must be present');
    assert(Array.isArray(c1!.sessions) && c1!.sessions.length === 0,
      `non-array sessions must become [], got ${JSON.stringify(c1!.sessions)}`);
    assert(JSON.stringify(c2!.sessions) === JSON.stringify(['s1', 'u12-red']),
      `mixed sessions must be filtered to only strings ['s1','u12-red'], got ${JSON.stringify(c2!.sessions)}`);
    assert(c2!.sessions.every((s: string) => typeof s === 'string'),
      'every surviving session id must be a string');
    ok('non-array sessions -> []; mixed array filtered to strings only');
  }

  // Belt-and-braces: every value the loader returns must conform to the Account shape (no hash leakage of
  // the wrong type, role within the union). Re-check case 1's coach since we hold a typed handle.
  {
    const f = fixture(JSON.stringify({
      accounts: [{ username: 'coach1', hash: HASH_A, role: 'coach', sessions: ['s1'] }],
    }));
    const m = await loadAccounts(f);
    const a: Account | undefined = m.get('coach1');
    assert(a !== undefined, 'typed Account handle must be present');
    assert(typeof a!.username === 'string' && typeof a!.hash === 'string'
      && (a!.role === 'coach' || a!.role === 'admin') && Array.isArray(a!.sessions),
      'returned entry must conform to the Account shape');
    ok('returned entries conform to the Account type');
  }

  console.log(`\n✅ AUTH-LOADER UNIT PASSED — ${passed} cases: fail-closed on missing/oversized/malformed/no-array/`
    + `duplicate, per-entry drops for blank-username/non-argon2id/bad-role, sessions normalised to string[]`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
} catch (err) {
  console.error('\n❌ AUTH-LOADER UNIT FAILED:', (err as Error).message);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(1);
}
