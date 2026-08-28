#!/usr/bin/env bun
/**
 * auth-user.ts — provision coach/admin accounts for /auth/login (Phase 2; ADR-0008/0015).
 *
 * Accounts are argon2id-hashed (Bun-native) into the JSON file the server loads and periodically reloads
 * (AUTH_ACCOUNTS_FILE, default ./auth-accounts.json). The running server picks up add/remove/sessions
 * edits within AUTH_ACCOUNTS_RELOAD_SECONDS — so this is also the revocation path (remove a coach → their
 * live sockets are closed and their cookie stops resolving). Passwords are read from stdin (piped) or a
 * hidden TTY prompt; they are NEVER echoed, logged, or passed as a process argument.
 *
 *   bun run auth-user.ts add coach-amy --role coach --sessions u12-sat,u12-sun
 *   bun run auth-user.ts add club-admin --role admin
 *   echo 's3cret' | bun run auth-user.ts add coach-bo --role coach --sessions u10   # non-interactive
 *   bun run auth-user.ts remove coach-amy
 *   bun run auth-user.ts list
 *
 * Exit 0 on success; non-zero with a clear message on error. Mirrors purge-player.ts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeSecretFile } from './src/secretFile';
import { withFileLock } from './src/fileLock';

type Role = 'coach' | 'admin';
interface Account {
  username: string;
  hash: string;
  role: Role;
  sessions: string[];
}

const FILE = process.env.AUTH_ACCOUNTS_FILE ?? './auth-accounts.json';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};

/**
 * Thrown, NOT exited — the file lock must be released by its `finally` before the process ends.
 *
 * `process.exit()` runs no `finally` blocks. This CLI's mutating commands run inside
 * `withFileLock`, so exiting from `fail()` while holding the lock ORPHANED the lock file, leaving a
 * dead holder's pid behind for the next writer to trip over. Reproduced 2026-08-28: a single
 * `remove <nonexistent>` left `<file>.lock` on disk, and the next five concurrent writers then all
 * ran the lock-BREAKING recovery path — which is where the real damage happened (an account written
 * by one process, silently overwritten by another; the operator told it was added).
 *
 * roster-user.ts has always done this correctly, with this same comment. When Phase 6 shared the
 * roster's proven lock with the other two CLIs, it took the lock and left behind the discipline
 * that makes the lock safe. The recovery path is for a real crash, not for an ordinary usage error.
 */
class CliError extends Error {}
function fail(msg: string): never {
  throw new CliError(msg);
}

function load(): Account[] {
  if (!existsSync(FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8')) as { accounts?: Account[] };
    return Array.isArray(parsed.accounts) ? parsed.accounts : [];
  } catch {
    fail(`accounts file is not valid JSON: ${FILE} (fix or delete it before re-running)`);
  }
}

function save(accounts: Account[]): void {
  // 0600 via an atomic temp+rename+chmod (src/secretFile.ts). `writeFileSync(..., { mode })`
  // applies the mode only when the file is CREATED, so an existing 0644 file stayed 0644 —
  // the audit's "mode 0o600 is a no-op" finding, verified on both write paths.
  writeSecretFile(FILE, JSON.stringify({ accounts }, null, 2) + '\n');
}

/** Read a password without echoing it. Piped stdin → first line; a TTY → hidden raw-mode read. */
async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    const txt = await new Response(Bun.stdin.stream()).text();
    return (txt.split('\n')[0] ?? '').replace(/\r$/, '');
  }
  process.stderr.write('Password: ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return await new Promise<string>((resolve) => {
    let pw = '';
    process.stdin.on('data', (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        const code = ch.charCodeAt(0);
        if (ch === '\n' || ch === '\r') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stderr.write('\n');
          return resolve(pw);
        }
        if (code === 3) process.exit(1); // Ctrl-C (ETX)
        else if (code === 127 || code === 8) pw = pw.slice(0, -1); // DEL / Backspace
        else pw += ch;
      }
    });
  });
}

async function cmdAdd(): Promise<void> {
  const username = argv[1];
  if (!username || username.startsWith('--')) fail('usage: add <username> --role <coach|admin> [--sessions a,b,c]');
  if (username.length > 64) fail('username too long (max 64)');
  const role = (flag('role') ?? 'coach') as Role;
  if (role !== 'coach' && role !== 'admin') fail(`invalid --role "${role}" (coach|admin)`);
  const sessions = (flag('sessions') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (role === 'coach' && sessions.length === 0) {
    console.error('⚠️  coach with no --sessions can read nothing until assigned one. Continuing.');
  }

  const pw = await readPassword();
  if (!pw) fail('empty password');
  if (pw.length > 256) fail('password too long (max 256)');
  const hash = await Bun.password.hash(pw, { algorithm: 'argon2id' });

  const accounts = load();
  const i = accounts.findIndex((a) => a.username === username);
  const entry: Account = { username, hash, role, sessions };
  if (i >= 0) accounts[i] = entry;
  else accounts.push(entry);
  save(accounts);
  console.log(
    `✅ ${i >= 0 ? 'updated' : 'added'} ${role} "${username}"` +
      (role === 'admin' ? ' (all sessions)' : ` (sessions: ${sessions.join(', ') || 'none'})`) +
      ` → ${FILE}`,
  );
}

function cmdRemove(): void {
  const username = argv[1];
  if (!username) fail('usage: remove <username>');
  const accounts = load();
  const next = accounts.filter((a) => a.username !== username);
  if (next.length === accounts.length) fail(`no such account: "${username}"`);
  save(next);
  console.log(`✅ removed "${username}" → ${FILE} (the server revokes it within AUTH_ACCOUNTS_RELOAD_SECONDS)`);
}

function cmdList(): void {
  const accounts = load();
  if (accounts.length === 0) {
    console.log(`(no accounts in ${FILE})`);
    return;
  }
  console.log(`${accounts.length} account(s) in ${FILE}:`);
  for (const a of accounts) {
    console.log(`  - ${a.username} [${a.role}]${a.role === 'coach' ? ` sessions: ${a.sessions.join(', ') || '(none)'}` : ''}`);
  }
}

/**
 * MUTATING commands run under the shared file lock (src/fileLock.ts), the same one the roster has always
 * used. Without it every command is an unguarded read-modify-write: a checker pass ran five concurrent
 * `add`s and TWO accounts that reported success were silently lost, while two that reported failure were
 * persisted — with a raw Bun stack trace instead of this CLI's error contract. `list` is a pure read and
 * needs no lock.
 */
const mutate = async (fn: () => void | Promise<void>): Promise<void> => {
  await withFileLock(FILE, { what: 'accounts', envHint: 'AUTH_ACCOUNTS_FILE' }, async () => {
    await fn();
  });
};

try {
  switch (cmd) {
    case 'add':
      await mutate(cmdAdd);
      break;
    case 'remove':
      await mutate(cmdRemove);
      break;
    case 'list':
      cmdList();
      break;
    default:
      console.error('usage: bun run auth-user.ts <add|remove|list> …');
      console.error('  add <username> --role <coach|admin> [--sessions a,b,c]   (password via stdin or hidden prompt)');
      console.error('  remove <username>');
      console.error('  list');
      process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  // CliError messages are the CLI's own error contract; anything else is a lock/IO error, which is
  // code-only. Either way the lock's `finally` has already run by the time we get here — that is the
  // whole point of throwing rather than exiting.
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
