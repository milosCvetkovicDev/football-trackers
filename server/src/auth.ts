/**
 * Auth & access control core (Phase 2). See docs/frontend/phase-2-auth-contract.md and
 * ADR-0015 (frontend auth transport) + ADR-0008 (auth & access control).
 *
 * THREAT MODEL #1: this gates the LIVE LOCATION OF MINORS, and Profile B is internet-exposed.
 * Everything here is security-first and FAILS CLOSED — a misconfiguration degrades to no-access,
 * never open-access, and every dangerous posture is logged LOUDLY at boot.
 *
 * What this module owns (the server's crown jewels):
 *  - Accounts: a JSON file (AUTH_ACCOUNTS_FILE), validated on load AND reloaded periodically so the
 *    provisioning CLI's edits + revocations take effect without a restart. Malformed/duplicate/oversized
 *    → 0 accounts (fail closed), never a crash.
 *  - Auth sessions: an in-memory bearer-token store. A token is valid IFF it's in the store AND unexpired;
 *    logout and account-removal both delete it. Authz is re-resolved against the LIVE accounts map by
 *    username on every use — never a login-time snapshot (so a removed coach loses access promptly).
 *  - Login controls (ALL run-and-reject BEFORE any argon2id call): per-IP token bucket, per-username
 *    soft-lock, a global concurrent-hash cap (bounds peak argon2id RAM), and constant-work dummy-hash
 *    verification on unknown users (no enumeration timing oracle).
 *  - Cookie (__Host- prefixed when Secure) + a CSRF SYNCHRONIZER token delivered in the response body
 *    (not a readable cookie — stronger, no cookie-injection class) compared against the stored value.
 *  - A live-socket registry so an accounts reload can CLOSE the sockets of a just-revoked principal.
 *
 * No heavyweight dependency: argon2id is Bun-native (Bun.password); tokens via node:crypto.
 */
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { envBool, envInt, envNumber, envString } from './env';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeSecretFile } from './secretFile';
import { metrics } from './metrics';
import { log } from './log';
import { onShutdown, STEP } from './shutdown';

export type Role = 'coach' | 'admin';

export interface Account {
  username: string;
  hash: string; // argon2id
  role: Role;
  sessions: string[]; // coach: authorized session ids; admin: ignored (all sessions)
}

/** What the client receives + what authz reads. Never contains the cookie token or the password hash. */
export interface Principal {
  username: string | null; // null only for the anonymous principal
  role: Role;
  sessions: string[];
  wildcard: boolean; // admin → true
  anonymous: boolean;
  csrf: string; // synchronizer token ('' for anon)
}

interface AuthSession {
  username: string;
  csrf: string;
  expiresAt: number; // epoch ms
}

// ----- config (env) ---------------------------------------------------------------------
const ACCOUNTS_FILE = envString('AUTH_ACCOUNTS_FILE', './auth-accounts.json');
const SESSION_TTL_MS = envNumber('AUTH_SESSION_TTL_SECONDS', 43200, { min: 1, max: 2_592_000 }) * 1000; // 12h; max 30 d ('valid forever' was the audit's S-3 example)
const COOKIE_SECURE = envBool('AUTH_COOKIE_SECURE', true); // default true; dev/sim set false
const RELOAD_MS = envNumber('AUTH_ACCOUNTS_RELOAD_SECONDS', 15, { min: 1, max: 2_147_483 }) * 1000; // max: 32-bit timer clamp
const MAX_SESSIONS = envInt('AUTH_MAX_SESSIONS', 1000, { min: 1 }); // global backstop
// Per-username live-token cap. Bounds the store to ~(users × this), and — crucially — means a single
// principal spamming /auth/login can only ever evict its OWN oldest tokens, never another coach/admin's
// (the global-FIFO-eviction force-logout DoS the expert review found).
const MAX_SESSIONS_PER_USER = envInt('AUTH_MAX_SESSIONS_PER_USER', 8, { min: 1 });
const MAX_INFLIGHT_LOGINS = envInt('MAX_INFLIGHT_LOGINS', 4, { min: 1 });
const LOGIN_BURST = envInt('AUTH_LOGIN_BURST', 5, { min: 1 });
const LOGIN_WINDOW_MS = envNumber('AUTH_LOGIN_WINDOW_S', 30, { min: 1, max: 86_400 }) * 1000;
const LOCKOUT_FAILS = 10;
const LOCKOUT_WINDOW_MS = 15 * 60_000;
const LOCKOUT_MS = 15 * 60_000;
const MAX_ACCOUNTS_BYTES = 1_000_000;

export const ANON_MODE = envBool('ALLOW_ANONYMOUS_LIVE', false);
export const ANON_SESSIONS = envString('ANON_SESSIONS', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** Cookie name — __Host- prefix (when Secure) forces Secure+Path=/+no-Domain, blocking subdomain shadowing. */
export const COOKIE_NAME = COOKIE_SECURE ? '__Host-ft_session' : 'ft_session';

// Session ids are NOT secrets, but they key the WS room — bound the shape (charset + length) so the room
// namespace can't be attacker-shaped. NB on duplicate query params: under the pinned Elysia (1.4.28),
// `/live?sessionId=A&sessionId=B` does NOT yield an array — it coerces to the LAST value as a plain string
// ("B"). validSessionId therefore accepts it, but that is safe: the SAME last-value string is used for both
// authz (authorizedFor) and the room key (wsRoom), so a client can only join a room it is authorized for —
// there is no authz/room desync. (auth-e2e pins this last-wins behaviour so an Elysia upgrade can't silently
// change the authz key shape.)
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
export function validSessionId(v: unknown): v is string {
  return typeof v === 'string' && SESSION_ID_RE.test(v);
}

const ARGON = { algorithm: 'argon2id' } as const;
const b64 = () => randomBytes(32).toString('base64url'); // 256-bit opaque token

// ----- state ----------------------------------------------------------------------------
let accounts = new Map<string, Account>();
let dummyHash = ''; // boot-precomputed argon2id hash for constant-work unknown-user verification
/**
 * Live sessions, keyed by sha256(token) — NOT by the token itself (Phase 6).
 *
 * Two reasons, and the second is why it changed. (1) The raw bearer token now exists in this process
 * only for the microseconds between minting it and writing it into the Set-Cookie header; a heap dump
 * of a running field box no longer yields usable credentials. (2) It is what makes surviving a restart
 * safe: `saveSessions()` writes these keys verbatim, so the file on disk holds a VERIFIER, not a key —
 * possession of it grants nothing without a sha256 preimage.
 */
const sessions = new Map<string, AuthSession>();

/** Token -> store key. Fast hash on purpose: the token is 256 bits of CSPRNG, not a human password. */
function tokenKey(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}
const ipBuckets = new Map<string, { tokens: number; last: number }>();
const lockouts = new Map<string, { fails: number; windowStart: number; until: number }>();
let inflight = 0;

/** Open /live sockets, so an accounts reload can revoke (close) a removed/reassigned principal's feed. */
interface LiveHandle {
  username: string;
  sessionId: string;
  close: () => void;
}
const liveSockets = new Set<LiveHandle>();

// ----- accounts: load + validate (fail closed, never crash) -----------------------------
// Async (node:fs/promises) so the periodic reload never blocks the shared Bun event loop that also runs the
// MQTT ingest (~100 msg/s) + WS fan-out. `file` is parameterised (defaults to ACCOUNTS_FILE) ONLY so the
// fail-closed validation can be unit-tested directly against fixtures; production callers pass no argument.
export async function loadAccounts(file: string = ACCOUNTS_FILE): Promise<Map<string, Account>> {
  let size = 0;
  try {
    size = (await stat(file)).size;
  } catch {
    return new Map(); // missing file → 0 accounts (the empty-accounts boot warning covers this)
  }
  if (size > MAX_ACCOUNTS_BYTES) {
    log.warn('auth: accounts file exceeds size cap — ignoring (0 accounts, fail closed)', {
      bytes: size,
      cap: MAX_ACCOUNTS_BYTES,
    });
    return new Map();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    log.warn('auth: accounts file is not valid JSON — 0 accounts (fail closed)', { err: String(e) });
    return new Map();
  }
  const arr = (parsed as { accounts?: unknown })?.accounts;
  if (!Array.isArray(arr)) {
    log.warn('auth: accounts file has no "accounts" array — 0 accounts (fail closed)');
    return new Map();
  }
  const map = new Map<string, Account>();
  for (const raw of arr) {
    const a = raw as Partial<Account>;
    if (!a || typeof a.username !== 'string' || !a.username) {
      log.warn('auth: skipping account entry with missing/blank username');
      continue;
    }
    if (typeof a.hash !== 'string' || !a.hash.startsWith('$argon2id$')) {
      // A non-argon2id hash could throw per-request in verify(); drop it at load so it never gets there.
      log.warn('auth: dropping account with missing/non-argon2id hash', { username: a.username });
      continue;
    }
    if (a.role !== 'coach' && a.role !== 'admin') {
      log.warn('auth: dropping account with invalid role', { username: a.username, role: String(a.role) });
      continue;
    }
    if (map.has(a.username)) {
      // Duplicate usernames are a privilege-confusion hazard (which entry wins?) — reject the whole file.
      log.error('auth: DUPLICATE username in accounts file — rejecting entire file (0 accounts, fail closed)', {
        username: a.username,
      });
      return new Map();
    }
    const sess = Array.isArray(a.sessions) ? a.sessions.filter((s): s is string => typeof s === 'string') : [];
    map.set(a.username, { username: a.username, hash: a.hash, role: a.role, sessions: sess });
  }
  return map;
}

/** Reload accounts and apply revocations: drop orphaned sessions + close any now-unauthorized live sockets. */
let reloading = false;
async function reload(): Promise<void> {
  if (reloading) return; // never let a slow file read pile up overlapping reloads (and race the `accounts` swap)
  reloading = true;
  try {
    accounts = await loadAccounts();
  } finally {
    reloading = false;
  }
  // Drop auth sessions whose account vanished (so /auth/me + future upgrades fail immediately).
  for (const [tok, s] of sessions) if (!accounts.has(s.username)) sessions.delete(tok);
  // Close open /live sockets whose principal is no longer authorized for their room.
  for (const h of [...liveSockets]) {
    const acc = accounts.get(h.username);
    const ok = !!acc && (acc.role === 'admin' || acc.sessions.includes(h.sessionId));
    if (!ok) {
      liveSockets.delete(h);
      log.info('auth: revoking live socket (account removed or session unassigned)', {
        username: h.username,
        session: h.sessionId,
      });
      try {
        h.close();
      } catch {
        /* socket already gone */
      }
    }
  }
  updateSessionGauge();
}

// ----- periodic maintenance -------------------------------------------------------------
function sweep(): void {
  const now = Date.now();
  for (const [tok, s] of sessions) if (s.expiresAt <= now) sessions.delete(tok); // active expiry (not lazy-only)
  for (const [ip, b] of ipBuckets) if (now - b.last > 2 * LOGIN_WINDOW_MS) ipBuckets.delete(ip);
  for (const [u, l] of lockouts) if (now > l.until && now - l.windowStart > LOCKOUT_WINDOW_MS) lockouts.delete(u);
  updateSessionGauge();
}

function updateSessionGauge(): void {
  metrics.authSessions.set({}, sessions.size);
}

/**
 * Load accounts, precompute the constant-work dummy hash, start the reload + sweep timers, and emit the
 * LOUD boot warnings for every dangerous posture. Awaited by server.ts before it serves.
 */
export async function initAuth(): Promise<void> {
  accounts = await loadAccounts();
  // The value is irrelevant — this hash only exists so an unknown-username login does the SAME argon2id
  // work as a real one (no fast-path), closing the user-enumeration timing channel.
  dummyHash = await Bun.password.hash(b64(), ARGON);

  metrics.anonMode.set({}, ANON_MODE ? 1 : 0);
  if (ANON_MODE) {
    log.warn(
      'ALLOW_ANONYMOUS_LIVE=true — /live skips login for sessions ' +
        (ANON_SESSIONS.length ? `[${ANON_SESSIONS.join(',')}]` : '[] (NONE — reads nothing until ANON_SESSIONS is set)') +
        '. The anon principal is scoped to the LIVE PITCH: /roster (names), /history and /events still ' +
        'require a real login (403 login_required). Acceptable ONLY on a physically isolated LAN; NEVER ' +
        'on an internet-exposed deploy.',
    );
  }
  if (!COOKIE_SECURE) {
    log.warn('AUTH_COOKIE_SECURE=false — session cookies are NOT Secure. Acceptable ONLY on http://localhost dev or a physically isolated LAN.');
  }
  if (!ANON_MODE && accounts.size === 0) {
    log.warn('auth: no accounts loaded — every login will fail. Provision one: bun run auth-user.ts add <username> --role coach --sessions <sessionId>');
  } else {
    log.info('auth: accounts loaded', { count: accounts.size });
  }

  // AFTER accounts: a restored session for an account that has since been removed must be dropped, and
  // that check needs the account map. Before the listeners open, so no request can race a half-loaded store.
  //
  // The save step is registered RIGHT HERE, not in server.ts's block, and that is the whole point: this
  // call CONSUMES the handover file, so from the moment it returns the only copy of those sessions is in
  // memory. A SIGTERM between here and server.ts's registrations would previously have exited with the
  // file already deleted and no step to write it back — measured: every coach logged out by a stop that
  // landed 40-80 ms into boot, with `restored:0` in the log of the next boot, which the observability doc
  // calls "a bug after a docker stop".
  loadSessions();
  onShutdown('auth-sessions', STEP.SESSIONS, () => {
    saveSessions();
  });

  setInterval(() => void reload(), RELOAD_MS).unref?.(); // async; fire-and-forget (re-entrancy-guarded)
  setInterval(sweep, 60_000).unref?.();
  updateSessionGauge();
}

// ----- surviving a restart (Phase 6; audit §6 "Server") -----------------------------------
//
// THE PROBLEM. Sessions live in a Map, so every restart logged out every coach — including the restart
// an operator performs *because something is wrong mid-match*, which is exactly when a coach cannot
// spare 30 seconds to find a password. Phase 6 makes planned restarts a normal, graceful operation, so
// it also has to stop them costing the people using the thing.
//
// WHAT GOES ON DISK, AND WHY IT IS SAFE TO *READ*. The map is keyed by sha256(token), so what is
// written is a VERIFIER: an attacker who can READ this file cannot mint a cookie from it without a
// sha256 preimage. The CSRF synchronizer value is in the clear and is useless alone — it is only ever
// checked against a request that ALSO carries the matching session cookie. 0600, next to
// auth-accounts.json (argon2id password hashes, a strictly juicier target), gitignored alongside it.
//
// Someone who can WRITE it is a different matter, and the checker pass was right to press on it: they
// can put sha256(a token they chose) in the file and walk in. That is not a privilege escalation — the
// same write access lets them add an admin to auth-accounts.json — but a forged handover is a BETTER
// backdoor, because the file deletes itself on read and leaves no artefact. So the restore applies the
// live policy to every record rather than trusting it: the key must be the right SHAPE, a duplicate key
// is dropped, the per-user and global caps apply, and the lifetime is CLAMPED to the current TTL.
//
// SINGLE USE. The file is deleted as soon as it is read — including when it is unreadable. A restart
// hands the sessions over exactly once; a stale file can never resurrect sessions days later, and there
// is no window where a copy sits around after the process that wrote it has started serving again.
//
// AN HONEST LIMIT: this only covers a GRACEFUL exit. A crash or a SIGKILL still logs everyone out,
// because nothing wrote the file. That is stated rather than hidden — `ft_auth_sessions_restored_total`
// reads 0 in exactly that case.
const SESSIONS_FILE = envString('AUTH_SESSIONS_FILE', join(dirname(ACCOUNTS_FILE), 'auth-sessions.json'));
const SESSIONS_MAX_BYTES = 1_000_000; // ~MAX_SESSIONS records; refuse to parse anything larger

/** What saveSessions writes as a key: sha256 as base64url is exactly 43 chars of [A-Za-z0-9_-]. */
const SESSION_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

interface PersistedSession {
  h: string; // sha256(token), base64url — the map key, never the token
  u: string; // username
  c: string; // csrf synchronizer
  e: number; // expiresAt, epoch ms
}

/**
 * Write the live sessions out. Called as a shutdown step; safe to call when there are none (it removes
 * any earlier file rather than leaving a stale one behind).
 *
 * Temp-file + rename, and an EXPLICIT chmod: `writeFile(..., { mode })` applies the mode only when the
 * file is CREATED, so writing over an existing 0644 file would silently keep it world-readable — the
 * audit's §6 "mode 0o600 is a no-op" finding, which this new file must not reproduce.
 */
export function saveSessions(): number {
  const now = Date.now();
  const live: PersistedSession[] = [];
  for (const [h, s] of sessions) if (s.expiresAt > now) live.push({ h, u: s.username, c: s.csrf, e: s.expiresAt });

  try {
    if (live.length === 0) {
      rmSync(SESSIONS_FILE, { force: true });
      return 0;
    }
    // Atomic temp+rename+chmod, the same writer the roster/accounts CLIs use (src/secretFile.ts) —
    // `writeFileSync(..., { mode })` honours the mode only on CREATE, and a half-written handover file
    // would be parsed as corrupt and thrown away, logging every coach out for no reason.
    writeSecretFile(SESSIONS_FILE, JSON.stringify({ v: 1, saved: now, sessions: live }))
    log.info('auth sessions saved', { count: live.length, file: SESSIONS_FILE });
    return live.length;
  } catch (err) {
    // Never fail the shutdown over this — losing sessions is an inconvenience, a stuck shutdown is an outage.
    log.warn('auth sessions not saved', { err: String(err), file: SESSIONS_FILE });
    return 0;
  }
}

/** Read the file written by the previous process, restore what is still valid, and delete it. */
export function loadSessions(): number {
  if (!existsSync(SESSIONS_FILE)) return 0;
  let restored = 0;
  let expired = 0;
  let orphaned = 0;
  let capped = 0;

  // 1. READ, with the size checked BEFORE the read (mirrors loadAccounts). Reading first and measuring
  //    afterwards means a 400 MB file at this path is a 1.3 GB RSS spike inside initAuth() — measured —
  //    which on the production container's 512 MB limit is an OOM kill before the listeners open, and
  //    `restart: unless-stopped` turns that into a crashloop. Bytes, not `raw.length`: that is UTF-16
  //    units, so it under-counts a multi-byte file by up to 3x.
  let raw: string;
  try {
    const size = statSync(SESSIONS_FILE).size;
    if (size > SESSIONS_MAX_BYTES) throw new Error(`sessions file too large (${size} bytes)`);
    raw = readFileSync(SESSIONS_FILE, 'utf8');
  } catch (err) {
    log.warn('auth sessions not restored', { err: String(err), file: SESSIONS_FILE });
    metrics.authSessionsRestored.inc({ outcome: 'unreadable' });
    try { rmSync(SESSIONS_FILE, { force: true }); } catch { /* reported on the next boot too */ }
    return 0;
  }

  // 2. CONSUME BEFORE RESTORING. "Single use" has to be unconditional, and doing the delete in a
  //    `finally` was not: when the unlink failed (a read-only /config after an SD-card remount is the
  //    realistic trigger on a Pi) the sessions were restored anyway and the file survived — so a coach
  //    who pressed "sign out" had their session handed back at the next boot, and every boot after
  //    that, with a cheerful "auth sessions restored" line and nothing said about the failed delete.
  //    If the handover cannot be consumed, it is not a handover: restore NOTHING and say so loudly.
  try {
    rmSync(SESSIONS_FILE);
  } catch (err) {
    log.error('auth sessions file could not be removed — restoring NOTHING rather than risk replaying it', {
      err: String(err),
      file: SESSIONS_FILE,
    });
    metrics.authSessionsRestored.inc({ outcome: 'unreadable' });
    return 0;
  }

  // 3. PARSE + restore, applying every control the live path applies.
  try {
    const parsed = JSON.parse(raw) as { v?: number; sessions?: unknown };
    if (parsed.v !== 1 || !Array.isArray(parsed.sessions)) throw new Error('unrecognised sessions file shape');
    const now = Date.now();
    const perUser = new Map<string, number>();
    for (const e of parsed.sessions as PersistedSession[]) {
      // Fail closed per record: anything that is not exactly the expected shape is skipped, never coerced.
      // `h` must LOOK like what saveSessions writes — sha256, base64url, 43 chars — so a hand-edited file
      // cannot introduce a key of some other shape into the store.
      if (typeof e?.h !== 'string' || !SESSION_KEY_RE.test(e.h)) { orphaned++; continue; }
      if (typeof e?.u !== 'string' || typeof e?.c !== 'string' || e.c.length > 128) { orphaned++; continue; }
      if (typeof e?.e !== 'number' || !Number.isFinite(e.e)) { orphaned++; continue; }
      // One key, one owner. Duplicate `h` was last-wins, which is a silent identity swap on a key an
      // earlier record already claimed.
      if (sessions.has(e.h)) { orphaned++; continue; }
      if (e.e <= now) { expired++; continue; }
      if (!accounts.has(e.u)) { orphaned++; continue; } // account removed while we were down → revoked
      const mine = perUser.get(e.u) ?? 0;
      if (mine >= MAX_SESSIONS_PER_USER) { capped++; continue; } // the per-user cap, not just the global one
      if (sessions.size >= MAX_SESSIONS) { capped++; break; }
      // CLAMP the lifetime to the CURRENT policy. A restart is precisely how an operator applies a
      // shortened AUTH_SESSION_TTL_SECONDS — the response to a lost or stolen coach tablet — so trusting
      // the persisted expiry would exempt the very sessions being tightened against. (It also bounds a
      // hand-written `e`: 1e308 was accepted before this line.)
      const expiresAt = Math.min(e.e, now + SESSION_TTL_MS);
      sessions.set(e.h, { username: e.u, csrf: e.c, expiresAt });
      perUser.set(e.u, mine + 1);
      restored++;
    }
    log.info('auth sessions restored', { restored, expired, orphaned, capped });
  } catch (err) {
    // A bad file must not stop the server booting — it just means everyone logs in again.
    log.warn('auth sessions not restored', { err: String(err), file: SESSIONS_FILE });
    metrics.authSessionsRestored.inc({ outcome: 'unreadable' });
  }

  metrics.authSessionsRestored.inc({ outcome: 'restored' }, restored);
  metrics.authSessionsRestored.inc({ outcome: 'expired' }, expired);
  metrics.authSessionsRestored.inc({ outcome: 'orphaned' }, orphaned);
  metrics.authSessionsRestored.inc({ outcome: 'capped' }, capped);
  return restored;
}

/** Test seam: the resolved path, so a test can assert the file's mode and that it is consumed. */
export function _sessionsFile(): string {
  return SESSIONS_FILE;
}

// ----- login controls -------------------------------------------------------------------
function ipAllowed(ip: string): boolean {
  const now = Date.now();
  let b = ipBuckets.get(ip);
  if (!b) {
    b = { tokens: LOGIN_BURST, last: now };
    ipBuckets.set(ip, b);
  }
  b.tokens = Math.min(LOGIN_BURST, b.tokens + ((now - b.last) / LOGIN_WINDOW_MS) * LOGIN_BURST);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function lockedOut(username: string): boolean {
  const l = lockouts.get(username);
  return !!l && Date.now() < l.until;
}
function recordFailure(username: string): void {
  const now = Date.now();
  let l = lockouts.get(username);
  if (!l || now - l.windowStart > LOCKOUT_WINDOW_MS) {
    l = { fails: 0, windowStart: now, until: 0 };
    lockouts.set(username, l);
  }
  l.fails += 1;
  if (l.fails >= LOCKOUT_FAILS) {
    l.until = now + LOCKOUT_MS;
    log.warn('auth: account soft-locked after repeated failures', { username });
  }
}

export interface LoginResult {
  ok: boolean;
  status: number; // 200 | 401 | 429 | 503
  error?: string;
  token?: string;
  principal?: Principal;
}

/**
 * Verify credentials and (on success) mint an auth session. The per-IP bucket and the concurrent-hash cap
 * reject BEFORE any argon2id work, so an unauthenticated attacker can neither brute-force cheaply nor exhaust
 * CPU/RAM and starve the in-process MQTT ingest. Unknown users still pay one dummy-hash verify (constant work).
 *
 * The per-username soft-lock is DETECT-don't-deny: it does NOT short-circuit before the verify, so a real
 * operator typing the CORRECT password is NEVER refused (success always clears the counter). This is a
 * deliberate availability choice for a children's-safety live feed — a username-keyed hard lock would let an
 * attacker force-lock a guessable coach out mid-match (the targeted-lockout DoS the expert review found).
 * Online brute-force is bounded instead by argon2id's cost + the per-IP bucket + the inflight cap; the lock
 * counter drives the WARN audit log and a 429 (throttle) signal on repeated failures.
 */
export async function attemptLogin(username: unknown, password: unknown, ip: string): Promise<LoginResult> {
  if (
    typeof username !== 'string' ||
    typeof password !== 'string' ||
    !username ||
    username.length > 64 ||
    password.length > 256
  ) {
    metrics.authLogins.inc({ result: 'failure' });
    return { ok: false, status: 401, error: 'invalid_credentials' };
  }
  if (!ipAllowed(ip)) {
    metrics.authLogins.inc({ result: 'throttled' });
    return { ok: false, status: 429, error: 'throttled' };
  }
  if (inflight >= MAX_INFLIGHT_LOGINS) {
    metrics.authLogins.inc({ result: 'throttled' });
    return { ok: false, status: 503, error: 'busy' };
  }
  inflight += 1;
  try {
    const acc = accounts.get(username);
    let valid = false;
    try {
      // Constant work: verify the real hash if the user exists, else the dummy — same cost either way.
      valid = await Bun.password.verify(password, acc ? acc.hash : dummyHash);
    } catch {
      valid = false;
    }
    if (!acc || !valid) {
      recordFailure(username);
      // A correct password is never gated by the lock, but repeated FAILURES past the threshold return 429
      // (throttle) rather than 401 — a back-off signal that's symmetric for known/unknown usernames.
      const throttled = lockedOut(username);
      metrics.authLogins.inc({ result: throttled ? 'throttled' : 'failure' });
      log.warn('auth login failed', { username });
      return { ok: false, status: throttled ? 429 : 401, error: throttled ? 'throttled' : 'invalid_credentials' };
    }
    lockouts.delete(username); // correct password clears any soft-lock — the real operator always gets in
    const token = b64();
    const csrf = b64();
    // Per-username cap FIRST: evict THIS user's own oldest token(s) so one principal can only ever evict its
    // own sessions, never force-logout another (global-FIFO-eviction DoS fix).
    const mine: string[] = [];
    for (const [tok, s] of sessions) if (s.username === username) mine.push(tok);
    while (mine.length >= MAX_SESSIONS_PER_USER) {
      const drop = mine.shift(); // oldest first (Map insertion order)
      if (drop) sessions.delete(drop);
    }
    sessions.set(tokenKey(token), { username, csrf, expiresAt: Date.now() + SESSION_TTL_MS });
    // Global cap stays as a hard backstop (the per-user cap keeps the map ~= users × MAX_SESSIONS_PER_USER).
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value; // Map preserves insertion order ≈ expiry order (const TTL)
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
    updateSessionGauge();
    metrics.authLogins.inc({ result: 'success' });
    log.info('auth login', { username, role: acc.role });
    return { ok: true, status: 200, token, principal: principalFor(acc, csrf) };
  } finally {
    inflight -= 1;
  }
}

/** Server-authoritative logout: delete the token (so a captured cookie cannot be replayed) after CSRF check. */
export function logout(
  cookieHeader: string | undefined,
  csrfHeader: string | undefined,
): { ok: boolean; status: number; error?: string } {
  const token = parseCookie(cookieHeader);
  const key = token ? tokenKey(token) : undefined;
  const s = key ? sessions.get(key) : undefined;
  if (!key || !s) return { ok: false, status: 401 };
  // Synchronizer-token CSRF: compare the header against the value STORED IN THE SESSION (constant-time),
  // never against a cookie — so an attacker who can set a cookie cannot forge this.
  if (!csrfHeader || !constantTimeEqual(csrfHeader, s.csrf)) return { ok: false, status: 403, error: 'csrf' };
  sessions.delete(key);
  updateSessionGauge();
  log.info('auth logout', { username: s.username });
  return { ok: true, status: 204 };
}

// ----- principal resolution + authz -----------------------------------------------------
function principalFor(acc: Account, csrf: string): Principal {
  return {
    username: acc.username,
    role: acc.role,
    sessions: acc.sessions,
    wildcard: acc.role === 'admin',
    anonymous: false,
    csrf,
  };
}

// One shared anon principal (isolated-LAN bypass): scoped to ANON_SESSIONS, NEVER wildcard.
const ANON_PRINCIPAL: Principal = {
  username: null,
  role: 'coach',
  sessions: ANON_SESSIONS,
  wildcard: false,
  anonymous: true,
  csrf: '',
};

/**
 * Resolve the current principal from a request's Cookie header: token → session (unexpired) → LIVE
 * account by username (so a revoked/removed account resolves to null even with a valid cookie).
 *
 * In anon mode the synthetic principal is the FALLBACK, not an override. This used to short-circuit —
 * `if (ANON_MODE) return ANON_PRINCIPAL` before the cookie was even parsed — which had two costs. The
 * audit named the first (§4.1): the cookie layer was dead code on that stack, so the only gate left was
 * an Origin check that treats an absent Origin as trusted. The second surfaced the moment /roster and
 * /history began requiring a named account: a coach who DID log in was silently downgraded to the
 * shared anon identity, so they could never reach the very endpoints the login was for, and every
 * audit line for their reads said `username: null`. Cookie first, anon second: anon mode now means
 * "a login is not REQUIRED for the live pitch", not "a login is impossible".
 */
/** Every session id any account is assigned to — for boot-time metric label seeding. */
export function accountSessionIds(): string[] {
  const out = new Set<string>();
  for (const a of accounts.values()) for (const sid of a.sessions) out.add(sid);
  return [...out];
}

export function currentPrincipal(cookieHeader: string | undefined): Principal | null {
  const p = principalFromCookie(cookieHeader);
  if (p) return p;
  return ANON_MODE ? ANON_PRINCIPAL : null;
}

/** The cookie half of currentPrincipal — null when there is no valid, unexpired, still-provisioned session. */
function principalFromCookie(cookieHeader: string | undefined): Principal | null {
  const token = parseCookie(cookieHeader);
  if (!token) return null;
  const key = tokenKey(token);
  const s = sessions.get(key);
  if (!s) return null;
  if (s.expiresAt <= Date.now()) {
    sessions.delete(key);
    updateSessionGauge();
    return null;
  }
  const acc = accounts.get(s.username);
  if (!acc) {
    sessions.delete(key); // account removed → revoke
    updateSessionGauge();
    return null;
  }
  return principalFor(acc, s.csrf);
}

/** Is this principal authorized to read this (already-validated) match session? */
export function authorizedFor(p: Principal, sessionId: string): boolean {
  if (p.anonymous) return ANON_SESSIONS.includes(sessionId);
  if (p.role === 'admin' || p.wildcard) return true;
  return p.sessions.includes(sessionId);
}

/** Shape of /sessions for a principal — only session-id strings, never any child/player name. */
export function sessionsFor(p: Principal): { sessions: string[]; wildcard: boolean } {
  if (p.role === 'admin' || p.wildcard) return { sessions: [], wildcard: true };
  return { sessions: p.sessions, wildcard: false };
}

/**
 * Body shape returned by /auth/login and /auth/me. The return type is `Principal` itself — that interface is
 * ALREADY the safe public view (it never carries the cookie token or the password hash, which live only in
 * AuthSession/Account), so re-spelling its fields here was pure duplication. The explicit literal is kept as
 * the field whitelist: TS will reject it if `Principal` ever gains a field this projection forgets to forward,
 * and equally if it gains a secret field this would then have to be updated deliberately to expose.
 */
export function principalBody(p: Principal): Principal {
  return {
    username: p.username,
    role: p.role,
    sessions: p.sessions,
    wildcard: p.wildcard,
    anonymous: p.anonymous,
    csrf: p.csrf,
  };
}

// ----- live-socket registry (revocation on reload) --------------------------------------
/** Register an admitted /live socket so a later accounts reload can close it if access is revoked. */
export function registerLiveSocket(username: string, sessionId: string, close: () => void): () => void {
  const h: LiveHandle = { username, sessionId, close };
  liveSockets.add(h);
  return () => liveSockets.delete(h);
}

// ----- cookie / csrf helpers ------------------------------------------------------------
export function setCookieHeader(token: string): string {
  const parts = [`${COOKIE_NAME}=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (COOKIE_SECURE) parts.push('Secure');
  return parts.join('; ');
}
export function clearCookieHeader(): string {
  const parts = [`${COOKIE_NAME}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (COOKIE_SECURE) parts.push('Secure');
  return parts.join('; ');
}
export function parseCookie(header: string | undefined, name: string = COOKIE_NAME): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || undefined;
  }
  return undefined;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
