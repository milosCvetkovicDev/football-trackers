/**
 * The telemetry store's path, resolved in ONE place so the server (which may create it) and the
 * erasure CLI (which must NEVER create it — audit §4.5 e) agree on what "the default" is.
 *
 * Relative paths resolve against the process cwd (bun:sqlite semantics) — the CLI reports the absolute
 * form so an operator can see which file was actually looked for.
 */
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const DB_PATH = process.env.DB_PATH ?? 'telemetry.db';

const SQLITE_MAGIC = 'SQLite format 3\0';

/**
 * Why `path` is NOT an existing telemetry store, or null if it is one. Checks existence, that it is a
 * regular non-empty file, and the 16-byte SQLite header — because bun:sqlite happily CREATES a missing
 * path and INITIALISES an empty one, either of which turns "wrong file" into "erased 0, exit 0".
 */
export function sqliteFileProblem(path: string): string | null {
  let st;
  try {
    st = statSync(path);
  } catch {
    return 'DB_PATH does not exist';
  }
  if (!st.isFile()) return 'DB_PATH is not a regular file';
  if (st.size === 0) return 'DB_PATH is an empty (0-byte) file — not a database';
  if (st.size < 100) return 'DB_PATH is too small to be a SQLite database';
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(16);
    readSync(fd, buf, 0, 16, 0);
    if (buf.toString('latin1') !== SQLITE_MAGIC) return 'DB_PATH is not a SQLite database (bad header)';
  } finally {
    closeSync(fd);
  }
  return null;
}

/** Absolute form of a DB path, for receipts. */
export const absoluteDbPath = (path: string = DB_PATH): string => resolve(path);
