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

import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';

/**
 * Write `text` to `path` atomically, owner-only (0600). Overwrites whatever is there.
 *
 * The chmod is belt-and-braces on top of the create mode: the create mode is the one that matters for
 * the window between write and rename, and the explicit chmod is what makes the final file's mode
 * independent of the process umask.
 */
export function writeSecretFile(path: string, text: string): void {
  const tmp = `${path}.tmp`;
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
