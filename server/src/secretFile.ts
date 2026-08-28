/**
 * Writing an owner-only file, correctly (audit §6 "Server").
 *
 * THE BUG THIS EXISTS FOR. Three CLIs wrote their file with `writeFileSync(path, text, { mode: 0o600 })`
 * and believed that made it owner-only. POSIX applies `mode` ONLY when the file is CREATED: writing over
 * an existing file leaves its permissions exactly as they were. Verified — a 0644 roster stayed 0644
 * through both write paths. So the documented at-rest posture silently failed for any file that already
 * existed: one restored from a backup, `scp`ed from another machine, or created by an editor. Those are
 * the files holding children's names and coaches' password hashes.
 *
 * THE FIX, and why it is a temp-file + rename rather than a bare `chmod`. Writing in place has a second
 * problem: a crash (or a full disk) partway through leaves a TRUNCATED file, and both the roster loader
 * and the accounts loader fail closed on a malformed file — meaning a bad moment during a write could
 * take out every name or every login. Writing a fresh temp file, chmod'ing it, and renaming is atomic:
 * a reader sees either the old file or the new one, never half of either, and the new inode carries the
 * mode it was created with.
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';

/**
 * Write `text` to `path` atomically, owner-only (0600). Overwrites whatever is there.
 *
 * The chmod is belt-and-braces on top of the create mode: the create mode is the one that matters for
 * the window between write and rename, and the explicit chmod is what makes the final file's mode
 * independent of the process umask.
 */
export function writeSecretFile(path: string, text: string): void {
  // THE TEMP NAME MUST BE UNIQUE PER CALL, not per path.
  //
  // It was `${path}.tmp` — one name shared by every process writing that file. Serialised by the
  // file lock that is invisible; when the lock failed (see src/fileLock.ts, the stale-decision race)
  // two `auth-user.ts add`s reached here together and the fixed name turned a lock bug into a data
  // bug: both wrote the same temp, one renamed it away, and the other's rename raised
  //   ENOENT: rename '…/auth-accounts.json.tmp' -> '…/auth-accounts.json'
  // as a raw stack trace, exiting 1 — while the account it had just written WAS on disk, published
  // under the other process's rename. An operator was told provisioning failed for a coach who
  // exists, and a different coach who was reported added had been silently overwritten.
  // The `rmSync` in the catch below made it worse: a failing writer deleted a healthy writer's temp.
  //
  // A unique name makes concurrent writers independent: both renames succeed, last write wins, and
  // nobody is told a lie about their own outcome. It does not by itself stop an update being lost —
  // that is the lock's job — but it stops a lock failure from becoming a false error report.
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    // Never leave a temp file behind to be mistaken for the real one, or to block the next attempt.
    try { rmSync(tmp, { force: true }); } catch { /* nothing more to do */ }
    throw err;
  }
}
