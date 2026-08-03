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
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { metrics } from './metrics';
import { log } from './log';

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
const ACCOUNTS_FILE = process.env.AUTH_ACCOUNTS_FILE ?? './auth-accounts.json';
const SESSION_TTL_MS = Math.max(1, Number(process.env.AUTH_SESSION_TTL_SECONDS ?? 43200)) * 1000; // 12h
const COOKIE_SECURE = process.env.AUTH_COOKIE_SECURE !== 'false'; // default true; dev/sim set false
const RELOAD_MS = Math.max(1, Number(process.env.AUTH_ACCOUNTS_RELOAD_SECONDS ?? 15)) * 1000;
const MAX_SESSIONS = Math.max(1, Number(process.env.AUTH_MAX_SESSIONS ?? 1000)); // global backstop
// Per-username live-token cap. Bounds the store to ~(users × this), and — crucially — means a single
// principal spamming /auth/login can only ever evict its OWN oldest tokens, never another coach/admin's
// (the global-FIFO-eviction force-logout DoS the expert review found).
const MAX_SESSIONS_PER_USER = Math.max(1, Number(process.env.AUTH_MAX_SESSIONS_PER_USER ?? 8));
const MAX_INFLIGHT_LOGINS = Math.max(1, Number(process.env.MAX_INFLIGHT_LOGINS ?? 4));
const LOGIN_BURST = Math.max(1, Number(process.env.AUTH_LOGIN_BURST ?? 5));
const LOGIN_WINDOW_MS = Math.max(1, Number(process.env.AUTH_LOGIN_WINDOW_S ?? 30)) * 1000;
const LOCKOUT_FAILS = 10;
const LOCKOUT_WINDOW_MS = 15 * 60_000;
const LOCKOUT_MS = 15 * 60_000;
const MAX_ACCOUNTS_BYTES = 1_000_000;

export const ANON_MODE = process.env.ALLOW_ANONYMOUS_LIVE === 'true';
export const ANON_SESSIONS = (process.env.ANON_SESSIONS ?? '')
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
const sessions = new Map<string, AuthSession>();
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
        '. Acceptable ONLY on a physically isolated LAN; NEVER on an internet-exposed deploy.',
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

  setInterval(() => void reload(), RELOAD_MS).unref?.(); // async; fire-and-forget (re-entrancy-guarded)
  setInterval(sweep, 60_000).unref?.();
  updateSessionGauge();
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
    sessions.set(token, { username, csrf, expiresAt: Date.now() + SESSION_TTL_MS });
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
  const s = token ? sessions.get(token) : undefined;
  if (!token || !s) return { ok: false, status: 401 };
  // Synchronizer-token CSRF: compare the header against the value STORED IN THE SESSION (constant-time),
  // never against a cookie — so an attacker who can set a cookie cannot forge this.
  if (!csrfHeader || !constantTimeEqual(csrfHeader, s.csrf)) return { ok: false, status: 403, error: 'csrf' };
  sessions.delete(token);
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
 * Resolve the current principal from a request's Cookie header. In anon mode the synthetic principal is
 * returned (login is moot on an isolated LAN). Otherwise: token → session (unexpired) → LIVE account by
 * username (so a revoked/removed account resolves to null even with a valid cookie).
 */
export function currentPrincipal(cookieHeader: string | undefined): Principal | null {
  if (ANON_MODE) return ANON_PRINCIPAL;
  const token = parseCookie(cookieHeader);
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expiresAt <= Date.now()) {
    sessions.delete(token);
    updateSessionGauge();
    return null;
  }
  const acc = accounts.get(s.username);
  if (!acc) {
    sessions.delete(token); // account removed → revoke
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
