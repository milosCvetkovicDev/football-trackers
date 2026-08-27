/**
 * auth-cli.ts — hardware-free, server-free test of the account-provisioning CLI (auth-user.ts).
 *
 * The CLI (auth-user.ts) is the add/remove/list/revocation surface that writes the argon2id-hashed
 * accounts file the server loads (AUTH_ACCOUNTS_FILE; ADR-0008/0015). This test exercises it ONLY as a
 * subprocess — no Elysia server, no mosquitto — driving every code path the way an operator does:
 *   - `add` with the password piped to stdin (the non-TTY path; the password is NEVER on the argv).
 *   - the written file: it exists, is mode 0o600, is valid JSON of shape {accounts:[...]}, the stored hash
 *     is argon2id and verifies against the plaintext, and the PLAINTEXT never appears in the file.
 *   - a second `add` (admin) so `list` shows BOTH usernames.
 *   - `list` prints the username + role + sessions and never the plaintext password.
 *   - `remove` of a present account (exit 0; a later list no longer shows it but keeps the other).
 *   - `remove` of a NON-existent account — asserts the OBSERVED behavior (clear error + nonzero exit) and
 *     that the file is NOT corrupted (still valid JSON, the surviving account intact).
 *
 * INVARIANT #1: no child/player NAMES anywhere — only match-session ids ('s1','s2') and adult coach
 * usernames ('coach1','coach2'). Passwords here are throwaway test strings, never echoed to stdout.
 *
 *   bun run test/auth-cli.ts
 *
 * Exits 0 on success, 1 on any failed assertion; cleans up the temp accounts file + the subprocesses it spawns.
 */

import { chmodSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';

// A dedicated temp file that no other test/tool touches, so a stray leftover can't poison this run.
const ACCOUNTS_FILE = '/tmp/ft-authcli-accounts.json';

const COACH = 'coach1';
const COACH_PW = 'coach1-pw';
const COACH_SESSIONS = ['s1', 's2'];
const ADMIN = 'coach2';
const ADMIN_PW = 'coach2-pw';
const GHOST = 'ghost'; // never added — the remove-non-existent case

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

/** Run the CLI as a subprocess from server/, with our temp accounts file, optionally piping a password to stdin. */
async function runCli(
  args: string[],
  password?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', 'auth-user.ts', ...args], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, AUTH_ACCOUNTS_FILE: ACCOUNTS_FILE },
    stdin: password !== undefined ? 'pipe' : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (password !== undefined) {
    // Non-TTY path: the CLI reads the first stdin line as the password (no argv exposure).
    proc.stdin!.write(`${password}\n`);
    await proc.stdin!.end();
  }
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

interface Account {
  username: string;
  hash: string;
  role: string;
  sessions: string[];
}
function readAccounts(): Account[] {
  const parsed = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8')) as { accounts?: Account[] };
  assert(Array.isArray(parsed.accounts), 'accounts file JSON must have an accounts array');
  return parsed.accounts!;
}

// Fresh temp file each run.
for (const f of [ACCOUNTS_FILE]) {
  if (existsSync(f)) rmSync(f);
}

try {
  // --- 1. add coach1 (coach, sessions s1,s2) with the password piped to stdin -> exit 0 ----------------
  const add1 = await runCli(['add', COACH, '--role', 'coach', '--sessions', COACH_SESSIONS.join(',')], COACH_PW);
  assert(add1.code === 0, `add ${COACH} should exit 0, got ${add1.code} (stderr: ${add1.stderr.trim()})`);
  assert(existsSync(ACCOUNTS_FILE), 'accounts file must exist after the first add');

  // --- 1a. file mode is 0o600 (owner-only — it holds password hashes) ----------------------------------
  const mode = statSync(ACCOUNTS_FILE).mode & 0o777;
  assert(mode === 0o600, `accounts file mode must be 0o600, got 0o${mode.toString(8)}`);

  // --- 1a-ii. PHASE 6 (audit §6 "Server"): an EXISTING loose file must be TIGHTENED, not left as found.
  // `writeFileSync(path, text, { mode: 0o600 })` applies the mode only when the file is CREATED, so
  // every write over a file that already existed — one restored from a backup, `scp`ed, or made by an
  // editor — silently kept its old permissions while the docs claimed owner-only. The case above cannot
  // catch that: it only ever inspects a file the CLI itself just created.
  chmodSync(ACCOUNTS_FILE, 0o644);
    const tighten = await runCli(['add', 'coach-tighten', '--role', 'coach', '--sessions', 's1'], 'correct-horse-battery-staple-9');
  assert(tighten.code === 0, `add over a 0644 file should exit 0, got ${tighten.code}`);
  const untighten = await runCli(['remove', 'coach-tighten']); // leave the account set as the later cases expect
  assert(untighten.code === 0, 'removing the tightening probe account should exit 0');
  assert(
    (statSync(ACCOUNTS_FILE).mode & 0o777) === 0o600,
    'a pre-existing 0644 file must be rewritten as 0600 — writeFileSync mode is a no-op on an existing file',
  );

  // --- 1b. JSON contains coach1 with correct role + sessions -------------------------------------------
  let accounts = readAccounts();
  const c1 = accounts.find((a) => a.username === COACH);
  assert(c1 !== undefined, `accounts file must contain ${COACH}`);
  assert(c1!.role === 'coach', `${COACH} role must be 'coach', got '${c1!.role}'`);
  assert(
    Array.isArray(c1!.sessions) &&
      c1!.sessions.length === COACH_SESSIONS.length &&
      COACH_SESSIONS.every((s) => c1!.sessions.includes(s)),
    `${COACH} sessions must be ${JSON.stringify(COACH_SESSIONS)}, got ${JSON.stringify(c1!.sessions)}`,
  );

  // --- 1c. stored hash is argon2id and verifies against the plaintext ----------------------------------
  assert(c1!.hash.startsWith('$argon2id$'), `${COACH} hash must be argon2id, got '${c1!.hash.slice(0, 12)}…'`);
  assert(await Bun.password.verify(COACH_PW, c1!.hash), `${COACH} hash must verify against its plaintext password`);

  // --- 1d. the PLAINTEXT password must NOT appear anywhere in the file contents ------------------------
  const fileText = readFileSync(ACCOUNTS_FILE, 'utf8');
  assert(!fileText.includes(COACH_PW), 'the plaintext password must NEVER appear in the accounts file');

  // --- 2. add a second account coach2 (admin) -> list shows BOTH ---------------------------------------
  const add2 = await runCli(['add', ADMIN, '--role', 'admin'], ADMIN_PW);
  assert(add2.code === 0, `add ${ADMIN} (admin) should exit 0, got ${add2.code} (stderr: ${add2.stderr.trim()})`);
  accounts = readAccounts();
  assert(accounts.length === 2, `accounts file should now have 2 accounts, got ${accounts.length}`);
  const adm = accounts.find((a) => a.username === ADMIN);
  assert(adm !== undefined && adm.role === 'admin', `${ADMIN} must be present with role 'admin'`);
  // The second add must not corrupt or drop the first.
  assert(accounts.some((a) => a.username === COACH), `first account ${COACH} must survive the second add`);

  const listBoth = await runCli(['list']);
  assert(listBoth.code === 0, `list should exit 0, got ${listBoth.code} (stderr: ${listBoth.stderr.trim()})`);
  assert(listBoth.stdout.includes(COACH), `list must show ${COACH}; got:\n${listBoth.stdout}`);
  assert(listBoth.stdout.includes(ADMIN), `list must show ${ADMIN}; got:\n${listBoth.stdout}`);

  // --- 3. list renders each account's ROLE LABEL + the coach's sessions; never the plaintext password --
  // Assert the rendered role token '[coach]' / '[admin]' — NOT the bare substring 'coach', which the
  // username 'coach1' already contains, so that weaker check would pass even if the role label were dropped.
  assert(listBoth.stdout.includes('[coach]'), `list must render coach1's role label [coach]; got:\n${listBoth.stdout}`);
  assert(listBoth.stdout.includes('[admin]'), `list must render coach2's role label [admin]; got:\n${listBoth.stdout}`);
  // The coach's sessions render as the exact 'sessions: s1, s2' token (admin lines carry no sessions).
  assert(
    listBoth.stdout.includes(`sessions: ${COACH_SESSIONS.join(', ')}`),
    `list must render coach1's sessions as 'sessions: ${COACH_SESSIONS.join(', ')}'; got:\n${listBoth.stdout}`,
  );
  assert(!listBoth.stdout.includes(COACH_PW), 'list stdout must NEVER contain the plaintext password');
  assert(!listBoth.stdout.includes(ADMIN_PW), 'list stdout must NEVER contain the admin plaintext password');

  // --- 4. remove coach1 -> exit 0; a later list no longer shows coach1 but still shows coach2 ----------
  const rm = await runCli(['remove', COACH]);
  assert(rm.code === 0, `remove ${COACH} should exit 0, got ${rm.code} (stderr: ${rm.stderr.trim()})`);
  accounts = readAccounts();
  assert(!accounts.some((a) => a.username === COACH), `${COACH} must be gone from the file after remove`);
  assert(accounts.some((a) => a.username === ADMIN), `${ADMIN} must remain in the file after removing ${COACH}`);

  const listAfter = await runCli(['list']);
  assert(listAfter.code === 0, `list after remove should exit 0, got ${listAfter.code}`);
  assert(!listAfter.stdout.includes(COACH), `list must no longer show ${COACH}; got:\n${listAfter.stdout}`);
  assert(listAfter.stdout.includes(ADMIN), `list must still show ${ADMIN}; got:\n${listAfter.stdout}`);

  // --- 5. remove a NON-existent account -> observed behavior: clear error + nonzero exit; file intact ---
  const rmGhost = await runCli(['remove', GHOST]);
  // Observed CLI behavior (auth-user.ts cmdRemove): fail() → console.error('❌ …') + process.exit(1).
  assert(rmGhost.code !== 0, `removing a non-existent account should exit nonzero, got ${rmGhost.code}`);
  assert(
    rmGhost.stderr.toLowerCase().includes('no such account'),
    `removing a non-existent account should print a clear error; got stderr:\n${rmGhost.stderr}`,
  );
  // The accounts file must NOT be corrupted by a failed remove: still valid JSON, coach2 intact.
  accounts = readAccounts();
  assert(accounts.length === 1 && accounts[0].username === ADMIN,
    `a failed remove must leave the file intact (only ${ADMIN}), got ${JSON.stringify(accounts.map((a) => a.username))}`);

  // --- 9. PHASE 6: CONCURRENT writers must not lose an account, or lie about it ------------------------
  // Every command here is a read-modify-write. Unlocked, five concurrent `add`s produced TWO accounts
  // that reported success and were LOST, and two that reported failure and were PERSISTED — the failures
  // being raw Bun stack traces from `rename`, not this CLI's error contract. Provisioning silently
  // dropping a coach while telling the operator it worked is not something to leave to "don't do that".
  {
    const NAMES = ['conc-1', 'conc-2', 'conc-3', 'conc-4', 'conc-5'];
    const before = readAccounts().length;
    const results = await Promise.all(
      NAMES.map((n) => runCli(['add', n, '--role', 'coach', '--sessions', 's1'], `pw-for-${n}-longenough`)),
    );
    const persisted = readAccounts().map((a) => a.username);
    for (const [i, n] of NAMES.entries()) {
      // The two halves of the contract: every reported success is on disk, and every account on disk
      // reported success. Either direction failing is the bug.
      if (results[i].code === 0) {
        assert(persisted.includes(n), `${n} reported success (exit 0) but is NOT in the file — a lost account`);
      } else {
        assert(!persisted.includes(n), `${n} reported FAILURE (exit ${results[i].code}) but IS in the file`);
        assert(!/at writeSecretFile|ENOENT/.test(results[i].stderr), `a failure must be this CLI's error, not a raw stack trace: ${results[i].stderr.slice(0, 200)}`);
      }
    }
    assert(results.every((r) => r.code === 0), `all five concurrent adds should succeed under the lock: ${results.map((r) => r.code).join(',')}`);
    assert(readAccounts().length === before + NAMES.length, `all ${NAMES.length} accounts must survive, got ${readAccounts().length - before}`);
    for (const n of NAMES) assert((await runCli(['remove', n])).code === 0, `cleanup: remove ${n}`);
  }

  console.log('\n✅ AUTH CLI PASSED — add(stdin) writes 0o600 argon2id JSON (no plaintext), list shows both, remove drops one & keeps the other, remove-ghost errors without corrupting the file');
  if (existsSync(ACCOUNTS_FILE)) rmSync(ACCOUNTS_FILE);
  process.exit(0);
} catch (err) {
  console.error('\n❌ AUTH CLI FAILED:', (err as Error).message);
  try { if (existsSync(ACCOUNTS_FILE)) rmSync(ACCOUNTS_FILE); } catch { /* noop */ }
  process.exit(1);
}
