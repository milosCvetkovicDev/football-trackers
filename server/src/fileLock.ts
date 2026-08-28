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
 * holder. Breaking is confirm-then-unlink IN PLACE: a candidate must stay byte-for-byte unchanged
 * across a pause before it is removed, and removing it claims nothing — the O_EXCL create in the next
 * iteration is what decides the winner. (It used to rename the lock aside to inspect it, which meant
 * the path was briefly EMPTY and a contender could walk straight in. See the break path below.)
 *
 * Keep critical sections to the file round-trip (milliseconds). Never hold one across a DB delete.
 */

import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { log } from './log';

const LOCK_WAIT_MS = 3_000;
const LOCK_STALE_MS = 60_000;
const LOCK_POLL_MS = 50;
/**
 * A lock may not be broken on pid-death until it is at least this old.
 *
 * THE RACE THIS CLOSES (reproduced 2026-08-28, ~1 in 5 runs of test/auth-cli.ts). Breaking used to be
 * a decision made about ONE file and applied to WHATEVER was at that path a moment later:
 *
 *   t0  contenders A and B both stat the lock and read holder pid P; P is dead
 *   t1  A renames the lock away, unlinks it, creates its OWN lock, enters the critical section
 *   t2  B — still acting on its t0 reading of P — renames away whatever is at the path, which is
 *       now A's LIVE lock. The rename succeeds, so B believes it broke P's lock and enters too.
 *
 * Both logged `broke a dead lock … holderPid:16821 ageMs:15` — the same stale reading, fifteen
 * milliseconds old. The rename is atomic, but atomicity of the OPERATION is not identity of the
 * OBJECT, which is the whole mistake.
 *
 * The gate below makes the fast path unreachable: a lock is only a break candidate once it has sat
 * untouched for a second, which no live holder's lock is during normal contention (the critical
 * section here is a file round-trip). It costs a crashed holder's successor one extra second.
 * It is a narrowing, not a proof — so the break is ALSO verified after the fact, below.
 */
const LOCK_BREAK_MIN_AGE_MS = 1_000;
/** How long a candidate must stay byte-for-byte unchanged before it is removed. See the break path. */
const LOCK_BREAK_CONFIRM_MS = 150;

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
    let stMtimeMs = 0;
    try {
      const st = await stat(lock);
      stMtimeMs = st.mtimeMs;
      ageMs = Date.now() - st.mtimeMs;
      if (st.isDirectory()) throw new FileLockError(`${labels.what} lock ${lock} is a directory — remove it by hand`);
      const pid = Number((await readFile(lock, 'utf8')).trim());
      if (Number.isInteger(pid) && pid > 0) holderPid = pid;
    } catch (e) {
      if (e instanceof FileLockError) throw e;
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') continue; // vanished — retry the create at once
    }
    const deadHolder = holderPid !== undefined ? !pidAlive(holderPid) : ageMs > LOCK_STALE_MS;
    // A dead holder is not enough: the lock must also have been sitting still. See
    // LOCK_BREAK_MIN_AGE_MS — a fresh lock belongs to somebody who is very likely mid-write.
    const dead = deadHolder && ageMs > LOCK_BREAK_MIN_AGE_MS;
    if (dead) {
      // BREAK BY CONFIRM-THEN-UNLINK, never by rename-to-inspect.
      //
      // The first attempt at fixing this renamed the lock aside to read it back and check identity.
      // That is worse, and measurably so: between the rename-away and the rename-back the path is
      // EMPTY, so a contender's `wx` create succeeds and it enters the critical section alongside
      // the rightful holder. Traced 2026-08-28 — two processes acquired one millisecond apart and
      // one account was silently overwritten. Moving a lock in order to inspect it means, for as
      // long as the inspection takes, there is no lock.
      //
      // So: re-read in place after a pause and require the holder to be UNCHANGED — same pid, same
      // mtime. A lock somebody is actively working under fails that (its holder is alive anyway);
      // a genuinely abandoned one does not change, because nobody is left to change it. Then unlink
      // in place and re-enter the loop, where the O_EXCL create decides the winner atomically — we
      // claim nothing by having done the cleaning.
      await new Promise((r) => setTimeout(r, LOCK_BREAK_CONFIRM_MS));
      let stillSame = false;
      try {
        const st2 = await stat(lock);
        const pid2 = Number((await readFile(lock, 'utf8')).trim());
        stillSame = st2.mtimeMs === stMtimeMs && pid2 === holderPid && !pidAlive(pid2);
      } catch {
        continue; // vanished or unreadable — somebody else dealt with it; retry the create
      }
      if (!stillSame) continue; // it changed hands while we deliberated: not ours to remove
      try {
        await unlink(lock);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') continue; // another contender cleaned it first
        throw new FileLockError(`${labels.what} lock ${lock} is stale but cannot be removed (${code ?? 'error'}) — remove it by hand`);
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
