/**
 * A cooperative lock file, so two processes cannot lose each other's edits to the same JSON file.
 *
 * WHY IT MOVED HERE. This started life inside roster.ts, guarding the one file where two unguarded
 * read-modify-writes were known to race (the hourly sweep pruning while an operator ran purge-player.ts:
 * the sweep's rename landed last and wrote a just-erased name back behind a success receipt). Phase 6's
 * checker pass showed the same race, unguarded, on the OTHER two files written the same way — measured
 * with five concurrent `auth-user.ts add`: two coaches reported success and were lost, two reported
 * failure and were persisted, and the "failures" were raw Bun stack traces rather than the CLI's own
 * error contract. Provisioning silently dropping an account while telling the operator it worked is not
 * something to leave to "don't do that".
 *
 * The mechanics are unchanged and were already proven: O_EXCL create with the holder's pid inside; a
 * holder whose pid is DEAD is broken at once; a LIVE holder is never broken however old the lock (a long
 * erasure must not have its lock pulled out from under it) — the contender waits, then fails naming the
 * holder. Breaking is atomic (rename, then unlink), so two contenders cannot both break the same lock.
 *
 * Keep critical sections to the file round-trip (milliseconds). Never hold one across a DB delete.
 */

import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { log } from './log';

const LOCK_WAIT_MS = 3_000;
const LOCK_STALE_MS = 60_000;
const LOCK_POLL_MS = 50;

/** A lock problem no retry will fix (a directory in the way, an unwritable parent) — exit-5 territory. */
export class FileLockError extends Error {}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM'; // exists, not ours — treat as alive
  }
}

export interface LockLabels {
  /** What the file is, for the error text an operator reads ("roster", "accounts file"). */
  what: string;
  /** The env var that chooses the path, so a wrong-path failure names the knob to fix. */
  envHint?: string;
}

/**
 * Run `fn` holding a lock beside `file`.
 *
 * Beside the CONFIGURED path, not its realpath target: a file symlinked into a directory only the server
 * can write must still be lockable by the operator's CLI, which then fails honestly at the rename rather
 * than at the lock.
 */
export async function withFileLock<T>(file: string, labels: LockLabels, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  const hint = labels.envHint ? ` — wrong ${labels.envHint} path or directory permissions` : '';
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') throw new FileLockError(`${labels.what} lock ${lock} is not creatable (${code ?? 'error'})${hint}`);
    }
    // Someone holds it. Who, and are they alive?
    let ageMs = 0;
    let holderPid: number | undefined;
    try {
      const st = await stat(lock);
      ageMs = Date.now() - st.mtimeMs;
      if (st.isDirectory()) throw new FileLockError(`${labels.what} lock ${lock} is a directory — remove it by hand`);
      const pid = Number((await readFile(lock, 'utf8')).trim());
      if (Number.isInteger(pid) && pid > 0) holderPid = pid;
    } catch (e) {
      if (e instanceof FileLockError) throw e;
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') continue; // vanished — retry the create at once
    }
    const dead = holderPid !== undefined ? !pidAlive(holderPid) : ageMs > LOCK_STALE_MS;
    if (dead) {
      // Atomic break: only ONE contender's rename succeeds; the others see ENOENT and simply retry.
      const breaking = `${lock}.breaking.${process.pid}`;
      try {
        await rename(lock, breaking);
      } catch {
        continue;
      }
      try {
        await unlink(breaking);
      } catch (e) {
        throw new FileLockError(`${labels.what} lock ${lock} is stale but cannot be removed (${(e as NodeJS.ErrnoException)?.code ?? 'error'}) — remove it by hand`);
      }
      log.warn('broke a dead lock', { what: labels.what, holderPid: holderPid ?? null, ageMs: Math.round(ageMs) }); // never a name
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${labels.what} file is locked by another writer: ${lock} held by pid ${holderPid ?? '?'} (alive) for ${Math.round(ageMs / 1000)} s — retry when it finishes`,
      );
    }
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
  try {
    return await fn();
  } finally {
    await unlink(lock).catch(() => undefined);
  }
}
