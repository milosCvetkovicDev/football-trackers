/**
 * The provisioning CLIs must never lie about their own outcome (audit follow-up, 2026-08-28).
 *
 * WHY THIS FILE EXISTS. `test/auth-cli.ts` asserts the contract — every reported success is on disk,
 * every account on disk reported success — and it caught a violation roughly one run in five:
 *
 *     conc-2 reported FAILURE (exit 1) but IS in the file
 *
 * The captured stderr showed the whole chain. TWO contenders logged
 * `broke a dead lock … holderPid:16821 ageMs:15` — the same stale reading, fifteen milliseconds
 * old — so both entered the critical section. Both then called `writeSecretFile`, which used ONE
 * temp name for the path rather than one per call. One rename won; the other raised
 * `ENOENT: rename '…json.tmp' -> '…json'` as a raw stack trace and exited 1, while the account it
 * had written sat on disk, published under the winner's rename. A different coach, reported added,
 * had been silently overwritten. An operator reading that output would re-add a coach who exists
 * and never learn about the one who does not.
 *
 * That is two defects wearing one symptom, so there are two kinds of test here: DETERMINISTIC ones
 * pinning each mechanism, and a stress loop for the emergent behaviour. The stress loop matters
 * because neither mechanism is visible from a single-process test — which is exactly why both
 * shipped.
 *
 *   bun run test/write-concurrency.ts        (or: bun run test:write-concurrency)
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Source with comments blanked out (newlines kept, so any line numbers still line up).
 *
 * Necessary, and found the hard way: the first version of the static check below flagged
 * `readPassword` as a process-exiting function because the comment EXPLAINING why it must not exit
 * says the words `process.exit()`. A guard that fires on prose describing the rule is a guard the
 * next person deletes. Strings are not handled — this scans control flow in four known files, not
 * arbitrary JavaScript, and a `process.exit(` inside a string literal in one of them would be a
 * false positive worth having.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/** The text between a `(` and its matching `)` — one call's arguments, inline callbacks included. */
function parenArgs(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/** The text between a `{` and its matching `}` — enough to scope a callback body. */
function braceBody(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

import { writeSecretFile } from '../src/secretFile';
import { withFileLock } from '../src/fileLock';

let checks = 0;
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  checks++;
}

const DIR = mkdtempSync(join(tmpdir(), 'ft-writeconc-'));
const SERVER_DIR = join(import.meta.dir, '..');

async function runAdd(file: string, name: string) {
  const proc = Bun.spawn(['bun', 'run', 'auth-user.ts', 'add', name, '--role', 'coach', '--sessions', 's1'], {
    cwd: SERVER_DIR,
    env: { ...process.env, AUTH_ACCOUNTS_FILE: file },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  proc.stdin!.write(`pw-for-${name}-longenough\n`);
  await proc.stdin!.end();
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { name, code, stdout, stderr };
}

const readNames = (file: string): string[] =>
  existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).accounts as Array<{ username: string }>).map((a) => a.username) : [];

try {
  console.log('\nwrite concurrency — the CLIs must not lie about their own outcome\n');

  // ── 1. DETERMINISTIC: the temp file is per-CALL, not per-PATH ────────────────────────────────
  // The bug was `const tmp = ${path}.tmp`. Two processes writing the same file shared one temp, so
  // the winner's rename removed the loser's file out from under it. This pins it without needing
  // any concurrency at all: a foreign file sitting at the old fixed name must be irrelevant to us.
  {
    const target = join(DIR, 'det-accounts.json');
    const fixedTemp = `${target}.tmp`;
    writeFileSync(fixedTemp, 'ANOTHER WRITER OWNS THIS', 'utf8');

    writeSecretFile(target, '{"accounts":[]}\n');

    assert(readFileSync(target, 'utf8').includes('accounts'), 'the target must be written');
    assert(
      existsSync(fixedTemp) && readFileSync(fixedTemp, 'utf8') === 'ANOTHER WRITER OWNS THIS',
      `writeSecretFile touched ${fixedTemp} — it is still using ONE temp name per path, so two ` +
        'concurrent writers will consume each other’s temp file',
    );
    rmSync(fixedTemp, { force: true });
    console.log('  ✓ the temp file is unique per call, not per path');
  }

  // ── 2. DETERMINISTIC: a failed write must not remove a bystander's temp ──────────────────────
  // The old catch did `rmSync(tmp)` on the shared name, so a writer that failed deleted a healthy
  // writer's in-flight temp — turning one failure into two.
  {
    const target = join(DIR, 'nested', 'no-such-dir', 'x.json'); // parent missing -> write fails
    const fixedTemp = join(DIR, 'bystander.json.tmp');
    writeFileSync(fixedTemp, 'BYSTANDER', 'utf8');
    let threw = false;
    try {
      writeSecretFile(target, 'x');
    } catch {
      threw = true;
    }
    assert(threw, 'writing into a missing directory must throw');
    assert(readFileSync(fixedTemp, 'utf8') === 'BYSTANDER', 'a failed write removed a bystander temp file');
    rmSync(fixedTemp, { force: true });
    console.log('  ✓ a failed write cleans up only its own temp');
  }

  // ── 3. DETERMINISTIC: a FRESH lock is never broken, even with a dead holder pid ──────────────
  // The stale-decision race needed the fast path — a lock judged breakable at 15 ms old. A lock
  // that young belongs to somebody who is almost certainly mid-write, whatever its pid says.
  {
    const target = join(DIR, 'lockage.json');
    const lock = `${target}.lock`;
    // pid 2^22 is above every configured pid_max on macOS and Linux, so it cannot be alive.
    writeFileSync(lock, String(4_194_303), 'utf8');

    const t0 = Date.now();
    let ran = false;
    let failed = false;
    try {
      await withFileLock(target, { what: 'test' }, async () => {
        ran = true;
      });
    } catch {
      failed = true;
    }
    const waited = Date.now() - t0;

    assert(ran || failed, 'the lock call must either run or fail, not vanish');
    assert(
      waited >= 900,
      `a lock only ${waited} ms old was broken immediately (dead holder pid). It must sit still ` +
        'for the minimum age first — that window is what let two contenders act on one stale reading.',
    );
    rmSync(lock, { force: true });
    console.log(`  ✓ a fresh lock is not broken on pid-death alone (waited ${waited} ms)`);
  }

  // ── 4. DETERMINISTIC: a lock held by a LIVE process is never broken, however long we wait ────
  {
    const target = join(DIR, 'liveheld.json');
    const lock = `${target}.lock`;
    writeFileSync(lock, String(process.pid), 'utf8'); // this very process: definitely alive
    let error: unknown;
    try {
      await withFileLock(target, { what: 'test' }, async () => undefined);
    } catch (e) {
      error = e;
    }
    assert(error !== undefined, 'a lock held by a live process must NOT be taken');
    assert(
      String((error as Error).message).includes('locked by another writer'),
      `the refusal must name the holder, got: ${(error as Error).message}`,
    );
    rmSync(lock, { force: true });
    console.log('  ✓ a live holder’s lock is never broken');
  }

  // ── 5. DETERMINISTIC: THE ROOT CAUSE — a failing command must still release its lock ─────────
  // This is the one that actually mattered. `fail()` called `process.exit(1)`, which runs no
  // `finally`, so an ORDINARY usage error inside the critical section left the lock file on disk
  // with a dead holder's pid. A single `remove <nonexistent>` was enough. Every writer after that
  // was forced down the lock-BREAKING recovery path — a path meant for a crashed process, not for a
  // typo — and it is there that accounts were lost.
  //
  // roster-user.ts has always thrown a CliError instead, with a comment saying exactly why. Phase 6
  // shared the roster's proven lock with the other two CLIs and left that discipline behind.
  {
    for (const [cli, seed, failing, env] of [
      ['auth-user.ts', ['add', 'seeded', '--role', 'admin'], ['remove', 'definitely-not-there'], 'AUTH_ACCOUNTS_FILE'],
      ['session-config.ts', ['set', 'sess-1', 'u12'], ['remove', 'no-such-session'], 'SESSION_CONFIG_FILE'],
    ] as Array<[string, string[], string[], string]>) {
      const file = join(DIR, `orphan-${cli}.json`);
      const run = async (args: string[], stdin?: string) => {
        const proc = Bun.spawn(['bun', 'run', cli, ...args], {
          cwd: SERVER_DIR,
          env: { ...process.env, [env]: file },
          stdin: stdin !== undefined ? 'pipe' : 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        });
        if (stdin !== undefined) {
          proc.stdin!.write(stdin);
          await proc.stdin!.end();
        }
        const [code, , err] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        return { code, err };
      };

      await run(seed, cli === 'auth-user.ts' ? 'seed-password-longenough\n' : undefined);
      const failed = await run(failing);

      assert(failed.code !== 0, `${cli}: the failing command must exit non-zero, got ${failed.code}`);
      assert(
        !existsSync(`${file}.lock`),
        `${cli}: a FAILED command left ${file}.lock behind. fail() must throw so the lock's finally ` +
          'runs — process.exit() skips it, and every later writer is then pushed onto the ' +
          'lock-breaking recovery path, which is where accounts get lost.',
      );
      assert(
        !/at fail|CliError/.test(failed.err) && failed.err.includes('❌'),
        `${cli}: the error must still be this CLI's contract, not a stack trace: ${failed.err.slice(0, 200)}`,
      );
      console.log(`  ✓ ${cli}: a failed command releases its lock and keeps its error contract`);
    }
  }

  // ── 6. purge-player.ts: the ERASURE CLI must not orphan the roster lock either ───────────────
  // It was checked by hand after the auth-user fix and found already correct — and correct by a
  // STRONGER pattern than the CliError one: every process.exit() sits outside the try, the two
  // withRosterLock callbacks contain nothing but assignments, and the VACUUM + WAL checkpoint run
  // in a `finally` so they happen even on the failure paths. This pins that, because "already
  // correct" is a property, not a permanent fact — auth-user.ts was also correct until Phase 6
  // moved the lock into it.
  {
    const db = join(DIR, 'purge.db');
    const roster = join(DIR, 'purge-roster.json');
    const purge = async (args: string[], env: Record<string, string> = {}) => {
      const proc = Bun.spawn(['bun', 'run', 'purge-player.ts', ...args], {
        cwd: SERVER_DIR,
        env: { ...process.env, DB_PATH: db, AUTH_ROSTER_FILE: roster, ...env },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return code;
    };

    for (const [label, args, env] of [
      ['no playerId (usage, exit 2)', [], {}],
      ['topic-unsafe playerId (usage, exit 2)', ['bad/id'], {}],
      ['wrong DB path (permanent, exit 5)', ['07'], { DB_PATH: join(DIR, 'absent.db') }],
    ] as Array<[string, string[], Record<string, string>]>) {
      const code = await purge(args, env);
      assert(code !== 0, `purge-player: "${label}" must exit non-zero, got ${code}`);
      assert(
        !existsSync(`${roster}.lock`),
        `purge-player: "${label}" left ${roster}.lock behind — an exit path has moved inside the ` +
          'roster lock. Every process.exit() must stay outside the try block.',
      );
    }
    console.log('  ✓ purge-player.ts: no failure path orphans the roster lock');
  }

  // ── 7. STATIC: no CLI may exit from inside a locked region ───────────────────────────────────
  // The check that would have caught the original regression at review time. Phase 6 gave
  // auth-user.ts and session-config.ts the roster's proven lock but not the roster's `fail()`, which
  // throws precisely so the lock's `finally` runs. Nothing could see that: each file was internally
  // consistent, and the damage only showed up as a 1-in-5 flake in a different test.
  //
  // Indirection is resolved TRANSITIVELY, because the real cases are never a `process.exit()` sitting
  // next to a lock. They were `fail()`, three lines away — and, found by this check while writing it,
  // the interactive password prompt: `mutate(cmdAdd)` -> `cmdAdd` -> `readPassword` -> Ctrl-C ->
  // `process.exit(1)`, three hops down, which meant an operator ABORTING A PASSWORD PROMPT orphaned
  // the accounts lock. No test types Ctrl-C, so nothing else was ever going to find that.
  {
    const CLIS = ['auth-user.ts', 'session-config.ts', 'roster-user.ts', 'purge-player.ts'];
    for (const cli of CLIS) {
      const src = stripComments(readFileSync(join(SERVER_DIR, cli), 'utf8'));

      // Every named function body in the file: `function f(...) {...}` and `const f = (...) => {...}`.
      const bodies = new Map<string, string>();
      for (const m of src.matchAll(/(?:function\s+(\w+)\s*\(|const\s+(\w+)\s*=\s*(?:async\s*)?(?:function\s*)?\()/g)) {
        const name = m[1] ?? m[2];
        const open = src.indexOf('{', m.index! + m[0].length);
        if (open !== -1) bodies.set(name, braceBody(src, open));
      }

      // Fixpoint: a function exits if it calls process.exit, or calls something that does.
      const exits = new Set<string>();
      for (const [name, body] of bodies) if (/process\.exit\s*\(/.test(body)) exits.add(name);
      for (let changed = true; changed; ) {
        changed = false;
        for (const [name, body] of bodies) {
          if (exits.has(name)) continue;
          for (const e of exits) {
            if (new RegExp(`\\b${e}\\s*\\(`).test(body)) { exits.add(name); changed = true; break; }
          }
        }
      }

      const offenders: string[] = [];
      for (const m of src.matchAll(/\b(withFileLock|withRosterLock|mutate)\s*\(/g)) {
        const args = parenArgs(src, m.index! + m[0].length - 1);
        if (/process\.exit\s*\(/.test(args)) offenders.push(`${m[1]}(…) contains a direct process.exit()`);
        for (const e of exits) {
          if (new RegExp(`\\b${e}\\s*[(,)]`).test(args)) {
            offenders.push(`${m[1]}(…) reaches ${e}(), which terminates the process`);
          }
        }
      }
      assert(
        offenders.length === 0,
        `${cli}: a locked region can terminate the process, which skips the lock's finally and ` +
          `orphans the lock file:\n    ${[...new Set(offenders)].join('\n    ')}\n  Throw instead, and exit ` +
          'at the top level once the lock has been released (see roster-user.ts).',
      );
    }
    console.log(`  ✓ no CLI exits from inside a locked region (${CLIS.length} files, indirection resolved transitively)`);
  }

  // ── 8. STRESS: the emergent contract, over enough rounds to have caught the original ─────────
  // Measured failure rate before the fix: roughly 1 round in 5. ROUNDS=40 makes a surviving bug a
  // ~1-in-10^3 escape rather than a coin toss, and the whole loop costs a few seconds because the
  // argon2id hash is the only slow part and five run at once.
  {
    const ROUNDS = 40;
    const NAMES = ['c1', 'c2', 'c3', 'c4', 'c5'];
    for (let round = 1; round <= ROUNDS; round++) {
      const file = join(DIR, `stress-${round}.json`);
      const results = await Promise.all(NAMES.map((n) => runAdd(file, n)));
      const persisted = readNames(file);

      for (const r of results) {
        if (r.code === 0) {
          assert(
            persisted.includes(r.name),
            `round ${round}: ${r.name} reported SUCCESS (exit 0) but is NOT in the file — a lost ` +
              `account. persisted=${JSON.stringify(persisted)}`,
          );
        } else {
          assert(
            !persisted.includes(r.name),
            `round ${round}: ${r.name} reported FAILURE (exit ${r.code}) but IS in the file — the ` +
              `operator was told provisioning failed for an account that exists.\n  stderr=${r.stderr.trim().slice(0, 400)}`,
          );
        }
        assert(
          !/ENOENT: no such file or directory, rename/.test(r.stderr),
          `round ${round}: ${r.name} failed with a raw rename ENOENT — two writers shared a temp ` +
            `file.\n  stderr=${r.stderr.trim().slice(0, 400)}`,
        );
      }
      assert(
        persisted.length === NAMES.length,
        `round ${round}: expected all ${NAMES.length} accounts, got ${persisted.length} ` +
          `(${JSON.stringify(persisted)}) — an update was lost under the lock`,
      );
      rmSync(file, { force: true });
    }
    console.log(`  ✓ ${ROUNDS} rounds x ${NAMES.length} concurrent adds: no lost account, no false failure`);
  }

  rmSync(DIR, { recursive: true, force: true });
  console.log(`\n✅ WRITE CONCURRENCY PASSED — ${checks} checks: unique temps, no bystander deletion, ` +
    'locks broken only when genuinely stale, and the exit code always matches what is on disk\n');
  process.exit(0);
} catch (err) {
  console.error(`\n❌ WRITE CONCURRENCY FAILED: ${(err as Error).message}\n`);
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(1);
}
