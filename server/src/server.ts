/**
 * Entry point. Elysia serves the live WebSocket fan-out, the auth endpoints, a health check, and a
 * Prometheus /metrics endpoint; the MQTT ingest runs alongside it in the same process (Bun event loop),
 * then publishes into Elysia's native pub/sub rooms.
 *
 *   bun run src/server.ts          # start
 *   bun --watch src/server.ts      # dev (reload on change)
 *
 * Env: PORT (default 3000; public /live + /auth + /sessions), METRICS_PORT (default 9464; loopback
 *      /health + /metrics), PUBLIC_HOST (bind interface — see BIND INTERFACE below), MQTT_URL,
 *      MQTT_USERNAME/MQTT_PASSWORD (broker auth), DB_PATH, LOG_LEVEL,
 *      APP_VERSION, RETENTION_DAYS (see retention.ts / ADR-0010).
 *      Auth (Phase 2 — see docs/frontend/phase-2-auth-contract.md, ADR-0015/0008): AUTH_ACCOUNTS_FILE,
 *      AUTH_SESSION_TTL_SECONDS, AUTH_COOKIE_SECURE, AUTH_ACCOUNTS_RELOAD_SECONDS, ANON_SESSIONS,
 *      MAX_INFLIGHT_LOGINS / AUTH_LOGIN_BURST / AUTH_LOGIN_WINDOW_S (login DoS controls),
 *      ALLOWED_ORIGINS (CSWSH allow-list — STRICT: absent Origin is rejected on /auth + /live),
 *      ALLOW_ANONYMOUS_LIVE (+ ANON_SESSIONS) for an isolated-LAN bypass — LIVE PITCH ONLY, see
 *      sessionGetGate: names and bulk history always require a real login.
 *
 * Observability: structured JSON logs (log.ts), Prometheus metrics (metrics.ts), readiness on /health.
 */

import { Elysia, t } from 'elysia';
import { wsRoom, type Telemetry } from './types';
import { startIngest } from './ingest';
import { metrics, registry, updateRuntimeMetrics, capLabel, seedLabel } from './metrics';
import { envInt, envNumber, envString, envBool, envTimerMs, logResolvedConfig } from './env';
import { dbProbe, closeDb } from './db';
import { startRetention, refreshRetentionGauges } from './retention';
import { refreshBackupGauges } from './backup';
import { log } from './log';
import {
  initAuth,
  attemptLogin,
  logout,
  currentPrincipal,
  authorizedFor,
  sessionsFor,
  principalBody,
  registerLiveSocket,
  setCookieHeader,
  clearCookieHeader,
  validSessionId,
  ANON_MODE,
  ANON_SESSIONS,
  accountSessionIds,
  type Principal,
} from './auth';
import { initRoster, rosterFor, rosterSessionIds } from './roster';
import { initSessionConfig, ageBandFor, thresholdsFor, configuredSessionIds, pitchCornersFor } from './sessionConfig';
import {
  validateHistoryParams,
  readHistory,
  historyGate,
  releaseInflight,
  HistoryParamError,
  type HistoryParams,
} from './history';
import {
  validateEventsParams,
  readEvents,
  eventsGate,
  releaseEventsInflight,
  EventsParamError,
  type EventsParams,
} from './events';
import { newScanBudget, ScanAborted, abortAllScans, type ScanBudget } from './scanLoad';
import { onShutdown, installLifecycleHandlers, isDraining, STEP } from './shutdown';

// FIRST, before any await, any listener and any registered step: a signal that arrives during boot must
// be HANDLED. Bun is pid 1 in the container, and the kernel discards a signal pid 1 has no handler for —
// so without this line a `docker stop` in the first ~150 ms waited out the whole grace period and
// SIGKILLed (measured: exit 137 after 5.1 s). A signal at t+0 now runs whatever steps exist (none) and
// exits 0, which is exactly right for a process that has not opened anything yet.
installLifecycleHandlers();

const PORT = envInt('PORT', 3000, { min: 1, max: 65535 });
const METRICS_PORT = envInt('METRICS_PORT', 9464, { min: 1, max: 65535 });
const VERSION = envString('APP_VERSION', 'dev');

// --- BIND INTERFACE (§4.1) ---------------------------------------------------------------------------
// ANON_MODE means "the live feed needs no login". A feed of children's live positions that needs no login
// must not ALSO be reachable from the LAN, so anon mode defaults the bind to LOOPBACK. This is structural
// on purpose: the Origin allow-list is CSWSH defence and carries no authorization weight (an absent Origin
// — what every non-browser client sends — cannot be authenticated), so it must never be the only thing
// standing between a subnet and a child's position.
//
// PUBLIC_HOST overrides it, and a CONTAINER legitimately needs to: inside its own network namespace
// 0.0.0.0 reaches only the compose network, and the real exposure boundary is the Docker port publish
// (docker-compose.yml pins that to 127.0.0.1). The override is deliberately loud — see the boot warning.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const PUBLIC_HOST = envString('PUBLIC_HOST', ANON_MODE ? '127.0.0.1' : '0.0.0.0');
const MAX_BODY_BYTES = 4096; // /auth POST bodies are tiny; reject anything bigger BEFORE parse/hash.

// --- CSWSH / CSRF Origin allow-list (children's live location must never be world-readable) ----------
// ALLOWED_ORIGINS is the browser-Origin allow-list. Phase 2 makes it STRICT for the cookie-authenticated
// surfaces (/auth POST and the /live upgrade): an ABSENT Origin is now REJECTED, not allowed — the old
// lenient "no Origin → ok" branch (for the retired shared-token machine clients) would otherwise let any
// header-omitting curl bypass the CSWSH/CSRF layer. See ADR-0015 + the pre-mortem.
const ALLOWED_ORIGINS = envString('ALLOWED_ORIGINS', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function originOkStrict(origin: string | undefined): boolean {
  return !!origin && ALLOWED_ORIGINS.includes(origin);
}

// LENIENT variant for the GET data endpoints (/roster, /history). A same-origin browser GET via fetch()
// sends NO Origin header (browsers omit it on same-origin GET/HEAD), so the STRICT "absent → reject" rule
// would 403 the real coach UI. Here: absent Origin is allowed (same-origin read), but a PRESENT Origin must
// still be allow-listed — a cross-origin fetch is rejected outright (and is already cookie-less under the
// SameSite=Lax session cookie, so this is defense-in-depth, not the primary control). POST /auth + the WS
// upgrade keep originOkStrict: browsers DO send Origin there, and those paths are state-changing/CSWSH-sensitive.
// (This matches the existing /auth/me + /sessions GETs, which carry no Origin requirement at all.)
function originOkLenient(origin: string | undefined): boolean {
  return !origin || ALLOWED_ORIGINS.includes(origin);
}

// TRUST_PROXY: set to 'true' ONLY when the server sits behind a single trusted reverse proxy (Caddy in
// Profile B) that appends the real client to X-Forwarded-For. The LEFTMOST XFF hop is client-supplied and
// spoofable — trusting it would let an attacker rotate it to dodge the per-IP login rate-limiter — so we
// default to the unspoofable socket peer and only consult XFF (the RIGHTMOST hop, added by the trusted proxy)
// when TRUST_PROXY is explicitly set.
const TRUST_PROXY = envBool('TRUST_PROXY', false);

/** Client IP for the login rate-limiter. Socket peer by default; the rightmost XFF hop iff TRUST_PROXY. */
function clientIp(request: Request, server: { requestIP?: (r: Request) => { address: string } | null } | null): string {
  let sockIp: string | undefined;
  try {
    sockIp = server?.requestIP?.(request)?.address;
  } catch {
    sockIp = undefined;
  }
  if (TRUST_PROXY) {
    const xff = request.headers.get('x-forwarded-for');
    if (xff) {
      const hops = xff.split(',').map((s) => s.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1]; // rightmost = the peer the trusted proxy actually saw
    }
  }
  return sockIp ?? 'unknown';
}

/**
 * Content-type + size guards BEFORE JSON.parse — the login body is untrusted and unauthenticated.
 *
 * @param maxBytes per-endpoint cap. The default suits the /auth bodies; the client beacon passes a much
 *   tighter one, because its whole legitimate body is ~30 bytes and there is no reason to READ more of
 *   an unrecognised payload than the endpoint can possibly use.
 */
async function readJsonBody(
  request: Request,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: number; error: string }> {
  const ct = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!ct.includes('application/json')) return { ok: false, status: 415, error: 'unsupported_media_type' };
  const len = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(len) && len > maxBytes) return { ok: false, status: 413, error: 'too_large' };
  let txt: string;
  try {
    txt = await request.text();
  } catch {
    return { ok: false, status: 400, error: 'bad_body' };
  }
  // Authoritative size check on BYTE length (Content-Length can be absent/forged, and txt.length counts
  // UTF-16 code units — a multibyte body could slip past a code-unit cap).
  if (Buffer.byteLength(txt, 'utf8') > maxBytes) return { ok: false, status: 413, error: 'too_large' };
  try {
    const parsed = JSON.parse(txt);
    if (!parsed || typeof parsed !== 'object') return { ok: false, status: 400, error: 'bad_json' };
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, status: 400, error: 'bad_json' };
  }
}

// --- shared authz gate for the Phase-3 session-scoped GET data endpoints (/roster, /history) -----------
// THE ORDER MATTERS (ADR-0016 §1.2, pre-mortem authz-reuse fix): Origin → currentPrincipal → validSessionId
// → authorizedFor — currentPrincipal BEFORE validSessionId so an UNAUTHENTICATED caller always gets 401
// regardless of the :id shape (no 400-vs-401 oracle for whether a session id is well-formed). Matches the
// existing /auth/me + /sessions GET handlers. `username` rides the reject so the audit log can name the
// principal on a 403 (authed-but-wrong-session) — null where we don't yet have one (origin / 401).
type GateOk = { ok: true; principal: Principal };
type GateReject = { ok: false; status: number; result: string; username: string | null };
/**
 * @param allowAnonymous  opt THIS endpoint out of the anon-scope rule below. Default `false` (deny) so a
 *                        new session-scoped endpoint is closed to the anon principal unless someone
 *                        deliberately decides it carries nothing worth a login.
 */
function sessionGetGate(request: Request, id: string, allowAnonymous = false): GateOk | GateReject {
  const origin = request.headers.get('origin') ?? undefined;
  // Lenient: a same-origin browser GET omits Origin (allowed); a present cross-origin Origin must match.
  if (!originOkLenient(origin)) return { ok: false, status: 403, result: 'forbidden_origin', username: null };
  const p = currentPrincipal(request.headers.get('cookie') ?? undefined);
  if (!p) return { ok: false, status: 401, result: 'unauthorized', username: null };
  // ANON SCOPE (Phase 2 §4.1): ALLOW_ANONYMOUS_LIVE exists so the LIVE PITCH VIEW needs no login on an
  // isolated LAN — which is not a reason to hand out child NAMES (/roster) or a bulk raw location export
  // (/history), nor the review series built from them (/events). Those need a real, named account, so an
  // access to them is always attributable to a person in the audit log. 403, not 401: the anon caller IS
  // authenticated, just not permitted — and a 401 would look like an expired cookie to a client that has
  // none. Runs BEFORE validSessionId, like the 401 above, so the reject leaks no session-id oracle.
  if (p.anonymous && !allowAnonymous) {
    return { ok: false, status: 403, result: 'login_required', username: null };
  }
  if (!validSessionId(id)) return { ok: false, status: 400, result: 'bad_session', username: p.username };
  if (!authorizedFor(p, id)) return { ok: false, status: 403, result: 'forbidden', username: p.username };
  return { ok: true, principal: p };
}

/**
 * One shape for "the scan stopped early" on both off-loop surfaces (Phase 6).
 *
 * `client_gone` is not an error and must not be logged as one — it is the NORMAL outcome of a coach
 * closing the tab mid-review, and before this phase it was invisible *and* kept its shared inflight
 * slot to the very end. The status code is academic (nobody is listening), but a 499 would be a
 * non-standard code on a surface whose other answers are all standard; 503 with the same `busy`-family
 * semantics is honest and, crucially, `no-store` already applies.
 *
 * `budget` and `shutdown` DO reach a client: 503 tells the coach view to show its retry affordance
 * rather than a permanent failure, which is the truthful reading of both.
 */
function scanAbortResponse(
  surface: 'history' | 'events',
  err: ScanAborted,
  set: { status?: number | string },
  sessionId: string,
  username: string | null,
  scan: ScanBudget | undefined,
): { error: string } {
  metrics.scanAborted.inc({ surface, reason: err.reason });
  (surface === 'history' ? metrics.historyRequests : metrics.eventsRequests).inc({ result: 'aborted' });
  // THE AUDIT TRAIL MUST NOT HAVE A HOLE WHERE THE BIGGEST READS ARE. Both the `history read` audit line
  // and ft_history_rows_scanned_total sit AFTER the paged loop, so an aborted scan recorded no volume and
  // no principal — on the most sensitive read in the system, the requests that touched the most of a
  // child's trace and returned nothing were the only ones with nobody's name against them. The rows are
  // counted here instead, from the budget, and the principal is logged like every other read.
  const scannedRows = scan?.rowsScanned ?? 0;
  if (scannedRows > 0) {
    (surface === 'history' ? metrics.historyRowsScanned : metrics.eventsRowsScanned).inc(
      surface === 'history' ? { mode: 'aborted' } : {},
      scannedRows,
    );
  }
  const fields = { surface, session: sessionId, username, scannedRows, reason: err.reason };
  if (err.reason === 'client_gone') log.info('scan abandoned by client', fields);
  else log.warn('scan aborted', fields);
  set.status = 503;
  return { error: err.reason === 'client_gone' ? 'client_gone' : 'scan_aborted' };
}

// Per-principal token bucket for the name-bearing /roster reads (bulk-export bound; ADR-0016 §1.2). Mirrors
// auth.ts's ipBuckets. Keyed on the principal (username, or 'anon') so one coach can never starve another.
// The map is naturally bounded by the (tiny) account count + the single 'anon' key, so it needs no sweep.
const ROSTER_RATE_BURST = envNumber('ROSTER_RATE_BURST', 20, { min: 1 });
const ROSTER_RATE_PER_MIN = envNumber('ROSTER_RATE_PER_MIN', 30, { min: 1 });
const rosterBuckets = new Map<string, { tokens: number; last: number }>();
function rosterRateOk(key: string): boolean {
  const now = Date.now();
  let b = rosterBuckets.get(key);
  if (!b) {
    b = { tokens: ROSTER_RATE_BURST, last: now };
    rosterBuckets.set(key, b);
  }
  b.tokens = Math.min(ROSTER_RATE_BURST, b.tokens + ((now - b.last) / 60_000) * ROSTER_RATE_PER_MIN);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// Client beacon (Phase 5): the closed vocabulary the POST body's `kind` must belong to. MUST match
// BEACON_KINDS in client/src/beacon.ts — a value outside this list is refused with a 400 and never
// reaches the exposition, so the metric's cardinality is fixed at four by construction (audit S-5).
const BEACON_KINDS: readonly string[] = ['ws_gave_up', 'ws_manual_retry', 'render_error', 'fetch_timeout'];
/** The legitimate body is `{"kind":"ws_manual_retry"}` — ~30 bytes. Read no more than this. */
const BEACON_MAX_BODY_BYTES = 256;

// Per-principal token bucket for the beacon. Defaults are a MATCH-scale budget: the client throttles
// each kind to one report per 30 s, so a legitimate tablet spends a handful per hour and only a broken
// or hostile one ever reaches this limit.
//
// UNLIKE rosterBuckets this map IS SWEPT (checker finding). The roster's map is bounded by the account
// count because /roster requires a named login; the beacon deliberately allows the ANONYMOUS principal
// (a coach on the isolated-LAN bypass must be able to report that the live pitch broke), and the anon
// key is the client IP — so every distinct source IP would otherwise add a permanent entry. Sweeping
// buckets that have been idle long enough to have FULLY refilled is equivalent to recreating them, and
// bounds the map to the clients actually reporting. Same rule and shape as ingest.ts's sweep.
const BEACON_RATE_BURST = envNumber('BEACON_RATE_BURST', 20, { min: 1 });
const BEACON_RATE_PER_MIN = envNumber('BEACON_RATE_PER_MIN', 10, { min: 1 });
const beaconBuckets = new Map<string, { tokens: number; last: number }>();
// Never sweep a bucket before it would have refilled completely, or an operator who lowered the cap
// would be handing back a full burst on every sweep. Overridable the same way ingest.ts's sweep is —
// which is also what lets the e2e prove the sweep actually runs without a 60 s test.
const BEACON_BUCKET_IDLE_MS = Math.max(
  envTimerMs('BEACON_BUCKET_IDLE_MS', 60_000, { min: 1_000 }),
  Math.ceil((BEACON_RATE_BURST / BEACON_RATE_PER_MIN) * 60_000),
);
setInterval(() => {
  const cutoff = Date.now() - BEACON_BUCKET_IDLE_MS;
  for (const [k, b] of beaconBuckets) if (b.last < cutoff) beaconBuckets.delete(k);
}, BEACON_BUCKET_IDLE_MS).unref?.();

setInterval(() => metrics.beaconBuckets.set({}, beaconBuckets.size), 5_000).unref?.();
function beaconRateOk(key: string): boolean {
  const now = Date.now();
  let b = beaconBuckets.get(key);
  if (!b) {
    b = { tokens: BEACON_RATE_BURST, last: now };
    beaconBuckets.set(key, b);
  }
  b.tokens = Math.min(BEACON_RATE_BURST, b.tokens + ((now - b.last) / 60_000) * BEACON_RATE_PER_MIN);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// Audit S-4: /health used to latch `mqtt:true` once and never reset — broker down, /health still green while
// ft_mqtt_connected read 0. Now it follows the client's connect/close events, and it probes the DB too.
let mqttReady = false;
const startedAt = Date.now();
// The probe (db.ts dbProbe) touches the telemetry table AND folds in the last insert outcome — a plain
// SELECT 1 runs entirely in SQLite's VM and stayed green with the table dropped (checker finding). Honest
// limit: an idle server with an intact file reads true; what it catches is a dropped/corrupt table, a closed
// handle, and a store failing its writes (full disk, unlinked file).

// One admit-record per accepted /live socket. Set ONLY when a socket passes every check, so close() can
// (a) decrement ft_ws_clients exactly once and only for admitted sockets, and (b) unregister it from the
// revocation registry. Rejected sockets get no record, so their close() is a no-op (no gauge drift).
//
// KEY ON ws.data, NOT ws: Elysia constructs a FRESH ElysiaWS wrapper for each callback, so the `ws` object
// in close() is a different instance than the one in open() (a WeakMap keyed on it would always miss, leaking
// the gauge + registry). `ws.data` is the stable per-connection data object — identical across open/close.
interface Admit {
  sessionId: string;
  unregister?: () => void;
}
const admitted = new WeakMap<object, Admit>();

export function createApp() {
  return (
    new Elysia()
      // --- auth: named login → HttpOnly cookie; principal-bound; kills the bundled token (ADR-0015) ---
      .post('/auth/login', async ({ request, set, server }) => {
        const origin = request.headers.get('origin') ?? undefined;
        if (!originOkStrict(origin)) {
          set.status = 403;
          return { error: 'forbidden_origin' };
        }
        const parsed = await readJsonBody(request);
        if (!parsed.ok) {
          set.status = parsed.status;
          return { error: parsed.error };
        }
        const r = await attemptLogin(parsed.body.username, parsed.body.password, clientIp(request, server));
        if (!r.ok || !r.principal || !r.token) {
          set.status = r.status;
          return { error: r.error ?? 'invalid_credentials' };
        }
        set.headers['set-cookie'] = setCookieHeader(r.token);
        return principalBody(r.principal);
      })
      .post('/auth/logout', ({ request, set }) => {
        const origin = request.headers.get('origin') ?? undefined;
        if (!originOkStrict(origin)) {
          set.status = 403;
          return { error: 'forbidden_origin' };
        }
        const r = logout(request.headers.get('cookie') ?? undefined, request.headers.get('x-csrf-token') ?? undefined);
        if (!r.ok) {
          set.status = r.status;
          return r.error ? { error: r.error } : { error: 'unauthorized' };
        }
        set.headers['set-cookie'] = clearCookieHeader();
        set.status = 204;
        return '';
      })
      .get('/auth/me', ({ request, set }) => {
        const p = currentPrincipal(request.headers.get('cookie') ?? undefined);
        if (!p) {
          set.status = 401;
          return { authenticated: false };
        }
        return { authenticated: true, ...principalBody(p) };
      })
      .get('/sessions', ({ request, set }) => {
        const p = currentPrincipal(request.headers.get('cookie') ?? undefined);
        if (!p) {
          set.status = 401;
          return { authenticated: false };
        }
        return sessionsFor(p);
      })
      // --- roster: playerId → displayName for ONE session (ADR-0016). Identified data; gated by auth+origin+
      // session-scope+rate-limit+no-store; names NEVER logged (counts only) and NEVER cached beyond client memory.
      .get('/sessions/:id/roster', ({ request, set, params, server }) => {
        set.headers['cache-control'] = 'no-store'; // names must not survive in the browser disk cache past logout
        const g = sessionGetGate(request, params.id);
        if (!g.ok) {
          metrics.rosterRequests.inc({ result: g.result });
          log.warn('roster rejected', { reason: g.result, session: params.id, username: g.username });
          set.status = g.status;
          return g.status === 401 ? { authenticated: false } : { error: g.result };
        }
        // Per-principal bucket; the shared anon principal (username null) keys by IP so one LAN tablet
        // can't drain the bucket for the others (anon mode is the multi-tablet isolated-LAN posture).
        const key = g.principal.username ?? clientIp(request, server);
        if (!rosterRateOk(key)) {
          metrics.rosterRequests.inc({ result: 'rate_limited' });
          log.warn('roster rejected', { reason: 'rate_limited', session: params.id, username: g.principal.username });
          set.status = 429;
          return { error: 'rate_limited' };
        }
        const roster = rosterFor(params.id);
        metrics.rosterRequests.inc({ result: 'ok' });
        // Audit the read: who, which session, HOW MANY names — never a displayName value (§0.1).
        log.info('roster read', { username: g.principal.username, session: params.id, playerCount: roster.length });
        return { sessionId: params.id, roster };
      })
      // --- session config: the age band → youth speed-zone thresholds (Phase 4, ADR-0019). The band is NOT a
      // name/location, so no rate-limit / no-store is needed; it is still session-scoped + authed for uniformity
      // and so live zone colour matches what the server uses for the review breakdown. ----
      // allowAnonymous: THE ONE session-scoped read the anon principal keeps. It carries a single enum (the
      // age band) and its thresholds — no name, no position, nothing per-child — and the LIVE pitch needs it
      // to colour speed zones, which is exactly what anon mode is for. Denying it would leave the anon live
      // view silently mis-colouring speeds against the U14 client-side fallback.
      .get('/sessions/:id/config', ({ request, set, params }) => {
        const g = sessionGetGate(request, params.id, true);
        if (!g.ok) {
          metrics.configRequests.inc({ result: g.result });
          log.warn('config rejected', { reason: g.result, session: params.id, username: g.username });
          set.status = g.status;
          return g.status === 401 ? { authenticated: false } : { error: g.result };
        }
        const ageBand = ageBandFor(params.id); // configured band or the U14 default (zones always resolve)
        metrics.configRequests.inc({ result: 'ok' });
        // Phase 5 (audit §6 "Client"): the pitch's four GPS corners ride along when this session has a
        // measured one — that is what replaces the compile-time PITCH_CORNERS in the client bundle. The
        // key is OMITTED (not null) when there is none, so the client simply keeps its built-in corners.
        // A corner is a PLACE, not a person: no name, no child position, so no `no-store` is needed here.
        const corners = pitchCornersFor(params.id);
        return corners
          ? { sessionId: params.id, ageBand, thresholds: thresholdsFor(ageBand), pitch: { corners } }
          : { sessionId: params.id, ageBand, thresholds: thresholdsFor(ageBand) };
      })
      // --- client beacon (Phase 5, audit §6 "Client": no client observability). The ONE write the coach
      // view makes. Everything else this server measures stops at its own process boundary: a tablet that
      // exhausts its reconnect budget, a review view that crashes into its error boundary, or a read that
      // hits its deadline are all invisible here — /metrics stays green while the touchline sees nothing.
      //
      // MINIMISED BY CONSTRUCTION: the body is EXACTLY {kind} from a closed four-value vocabulary, so
      // there is no free text to carry a child's name and no unbounded metric label (audit S-5). Session
      // scope comes from the URL, so this reuses the SAME sessionGetGate as /roster and /config rather
      // than inventing a second authz path. allowAnonymous: the anon principal owns the live pitch, so it
      // must be able to report that the live pitch broke. STRICT Origin: this is a POST, and browsers
      // always send Origin on POST, so an absent one means a non-browser caller.
      .post('/sessions/:id/client-beacon', async ({ request, set, params, server }) => {
        const origin = request.headers.get('origin') ?? undefined;
        if (!originOkStrict(origin)) {
          metrics.beaconRequests.inc({ result: 'forbidden_origin' });
          set.status = 403;
          return { error: 'forbidden_origin' };
        }
        const g = sessionGetGate(request, params.id, true);
        if (!g.ok) {
          metrics.beaconRequests.inc({ result: g.result });
          set.status = g.status;
          return g.status === 401 ? { authenticated: false } : { error: g.result };
        }
        // Per-principal bucket (anon keys by IP, like /roster) so one wedged tablet in a reconnect loop
        // cannot flood the server it is already failing to reach.
        const key = g.principal.username ?? clientIp(request, server);
        if (!beaconRateOk(key)) {
          metrics.beaconRequests.inc({ result: 'rate_limited' });
          set.status = 429;
          return { error: 'rate_limited' };
        }
        const parsed = await readJsonBody(request, BEACON_MAX_BODY_BYTES);
        if (!parsed.ok) {
          metrics.beaconRequests.inc({ result: parsed.error });
          set.status = parsed.status;
          return { error: parsed.error };
        }
        // Closed vocabulary AND no extra keys: an unknown kind, a non-string kind, or anything smuggled
        // alongside is a 400. The rejected value is NEVER echoed back or logged — it is attacker-supplied
        // text on a system whose one hard invariant is that no child's name is ever written down.
        const keys = Object.keys(parsed.body);
        const kind = parsed.body.kind;
        if (keys.length !== 1 || keys[0] !== 'kind' || typeof kind !== 'string' || !BEACON_KINDS.includes(kind)) {
          metrics.beaconRequests.inc({ result: 'bad_kind' });
          set.status = 400;
          return { error: 'bad_kind' };
        }
        metrics.clientEvents.inc({ kind });
        metrics.beaconRequests.inc({ result: 'ok' });
        // Audited by KIND + principal only — no session label on the metric, no body echo in the log.
        log.info('client beacon', { kind, username: g.principal.username, session: params.id });
        set.status = 204;
        return null;
      })
      // --- history: review/replay source (ADR-0017). Off-the-live-loop paged read; per-principal rate limit +
      // concurrent-scan inflight cap (DoS bounds on a raw children's-location export); audit log; no-store.
      .get('/sessions/:id/history', async ({ request, set, params, query, server }) => {
        set.headers['cache-control'] = 'no-store';
        const g = sessionGetGate(request, params.id);
        if (!g.ok) {
          metrics.historyRequests.inc({ result: g.result });
          log.warn('history rejected', { reason: g.result, session: params.id, username: g.username });
          set.status = g.status;
          return g.status === 401 ? { authenticated: false } : { error: g.result };
        }
        // Per-principal gate; anon (username null) keys by IP so one LAN tablet can't starve the others.
        // ONE key for the gate and the release: the per-principal slot share (Phase 6) only balances if
        // the slot is given back under the identity it was taken by.
        const principalKey = g.principal.username ?? clientIp(request, server);
        const gate = historyGate(principalKey); // rate-limit BEFORE the inflight slot
        if (!gate.ok) {
          metrics.historyRequests.inc({ result: gate.result });
          log.warn('history rejected', { reason: gate.result, session: params.id, username: g.principal.username });
          set.status = gate.result === 'busy' ? 503 : 429;
          return { error: gate.result };
        }
        let scan: ScanBudget | undefined;
        try {
          let p: HistoryParams;
          try {
            p = validateHistoryParams({
              sessionId: params.id,
              from: query.from,
              to: query.to,
              mode: query.mode,
              player: query.player,
              cursor_ts: query.cursor_ts,
              cursor_rowid: query.cursor_rowid,
              limit: query.limit,
            });
          } catch (e) {
            // OPAQUE 400: the reason is for the server log only — NEVER echo a query value (a misconfigured
            // client could pass a name as ?player=, and reflecting it would leak it).
            const reason = e instanceof HistoryParamError ? e.reason : 'bad_params';
            metrics.historyRequests.inc({ result: 'bad_params' });
            log.warn('history rejected', { reason, session: params.id, username: g.principal.username });
            set.status = 400;
            return { error: 'bad_params' };
          }
          scan = newScanBudget(request.signal); // Phase 6: a vanished client, or 25 s, stops the scan
          const result = await readHistory(p, scan); // paged + yields between chunks — off the live loop
          metrics.historyRequests.inc({ result: 'ok' });
          // Audit: scannedRows is the bulk-export volume signal; playerId is pseudonymous (OK per §0.1).
          log.info('history read', {
            username: g.principal.username,
            session: params.id,
            mode: p.mode,
            from: p.from,
            to: p.to,
            scannedRows: result.scannedRows,
            ...(p.mode === 'raw' ? { playerId: p.player } : {}),
          });
          return result;
        } catch (err) {
          if (err instanceof ScanAborted) return scanAbortResponse('history', err, set, params.id, g.principal.username, scan);
          metrics.historyRequests.inc({ result: 'internal' });
          log.error('history failed', { session: params.id, err: String(err) }); // never the raw player value
          set.status = 500;
          return { error: 'internal' };
        } finally {
          scan?.release();
          releaseInflight(principalKey); // always free the slot we took on gate.ok
        }
      })
      // --- tactical events: review-only movement-derived phases (ADR-0020). Same off-loop posture as /history
      // (sessionGetGate + per-principal rate + the SHARED inflight slot + audit + no-store + opaque errors).
      // Team-AGGREGATE result — no playerId/name ever. Detection is heuristic, never ground truth (§0.5).
      .get('/sessions/:id/events', async ({ request, set, params, query, server }) => {
        set.headers['cache-control'] = 'no-store';
        const g = sessionGetGate(request, params.id);
        if (!g.ok) {
          metrics.eventsRequests.inc({ result: g.result });
          log.warn('events rejected', { reason: g.result, session: params.id, username: g.username });
          set.status = g.status;
          return g.status === 401 ? { authenticated: false } : { error: g.result };
        }
        const principalKey = g.principal.username ?? clientIp(request, server);
        const gate = eventsGate(principalKey); // rate-limit BEFORE the inflight slot
        if (!gate.ok) {
          metrics.eventsRequests.inc({ result: gate.result });
          log.warn('events rejected', { reason: gate.result, session: params.id, username: g.principal.username });
          set.status = gate.result === 'busy' ? 503 : 429;
          return { error: gate.result };
        }
        let scan: ScanBudget | undefined;
        try {
          let p: EventsParams;
          try {
            p = validateEventsParams({ sessionId: params.id, from: query.from, to: query.to });
          } catch (e) {
            const reason = e instanceof EventsParamError ? e.reason : 'bad_params';
            metrics.eventsRequests.inc({ result: 'bad_params' });
            log.warn('events rejected', { reason, session: params.id, username: g.principal.username });
            set.status = 400;
            return { error: 'bad_params' };
          }
          scan = newScanBudget(request.signal); // Phase 6: same cancellation contract as /history
          const result = await readEvents(p, scan); // paged + yields between chunks — off the live loop
          metrics.eventsRequests.inc({ result: 'ok' });
          // PM-N3: audit {username, session, from, to, scannedRows} ONLY — no player dimension on this surface.
          log.info('events read', {
            username: g.principal.username,
            session: params.id,
            from: p.from,
            to: p.to,
            scannedRows: result.scannedRows,
          });
          return result;
        } catch (err) {
          if (err instanceof ScanAborted) return scanAbortResponse('events', err, set, params.id, g.principal.username, scan);
          metrics.eventsRequests.inc({ result: 'internal' });
          log.error('events failed', { session: params.id, err: String(err) }); // never a raw query value
          set.status = 500;
          return { error: 'internal' };
        } finally {
          scan?.release();
          releaseEventsInflight(principalKey); // always free the shared slot we took on gate.ok
        }
      })
      // --- live fan-out: cookie auto-attached on the same-origin upgrade; principal-bound session authz ---
      .ws('/live', {
        // A coach tablet connects to /live?sessionId=<id>; the session cookie rides the upgrade.
        query: t.Object({
          sessionId: t.Optional(t.String()),
        }),
        open(ws) {
          const headers = (ws.data as { headers?: Record<string, string> }).headers ?? {};
          const origin = headers.origin;
          const { sessionId } = ws.data.query;

          // 1. CSWSH: a browser always sends Origin; require it allow-listed (absent → reject, strict).
          if (!originOkStrict(origin)) {
            metrics.wsRejected.inc({ reason: 'origin' });
            log.warn('ws rejected', { reason: 'origin', origin });
            return ws.close(1008, 'forbidden origin');
          }
          // 2. sessionId must be a well-formed string (bounded charset + length). A duplicate ?sessionId=a&b
          //    coerces to the last value under Elysia 1.4.28 (not an array) and is used identically for authz
          //    and the room key, so there is no desync — see validSessionId in auth.ts.
          if (!validSessionId(sessionId)) {
            metrics.wsRejected.inc({ reason: 'no_session' });
            return ws.close(1008, 'bad session');
          }
          // 3. AuthN: resolve the principal from the cookie (or the anon principal on an isolated LAN).
          const principal = currentPrincipal(headers.cookie);
          if (!principal) {
            metrics.wsRejected.inc({ reason: 'auth' });
            log.warn('ws rejected', { reason: 'auth' });
            return ws.close(1008, 'unauthorized');
          }
          // 4. AuthZ: is THIS principal assigned to THIS session? (never trust sessionId presence alone)
          if (!authorizedFor(principal, sessionId)) {
            metrics.wsRejected.inc({ reason: 'not_authorized_for_session' });
            log.warn('ws rejected', { reason: 'not_authorized_for_session', session: sessionId, username: principal.username });
            return ws.close(1008, 'forbidden session');
          }

          ws.subscribe(wsRoom(sessionId));
          const admit: Admit = { sessionId };
          // Register non-anon sockets so an accounts reload (revocation) can close this feed immediately.
          if (!principal.anonymous && principal.username) {
            admit.unregister = registerLiveSocket(principal.username, sessionId, () => {
              try {
                ws.close(1008, 'forbidden session');
              } catch {
                /* already gone */
              }
            });
          }
          admitted.set(ws.data as object, admit);
          metrics.wsClients.inc({ session: capLabel('session', sessionId) });
          log.info('ws open', { session: sessionId, username: principal.username });

          // Phase 5 (audit C-1): hand the client the SERVER's clock, once, immediately on connect.
          //
          // A match-day LAN has no NTP, so the coach's tablet and this server agree only by luck, and
          // every freshness decision in the client compares its own `Date.now()` against a timestamp
          // stamped here. The client estimates the offset from what it receives — and telemetry is NOT
          // a safe source for that: since Phase 4 a replayed backlog fix carries its GPS time
          // (`Math.min(gts, arrival)`, up to 6 h behind), so a page that loads while a tracker is
          // draining a backlog would infer an offset of HOURS and then render stale fixes as live dots
          // — the exact dishonesty ADR-0018 forbids. This frame, and the `.../status` envelope (also
          // arrival-stamped, never backlogged), are the only clock sources the client trusts.
          //
          // Carries no child data at all: a clock reading and the session the socket is already on.
          // An older client ignores an unknown `event` (parseLiveFrame returns null), so this is a
          // backward-compatible addition to the wire.
          try {
            ws.send(JSON.stringify({ event: 'hello', data: { sessionId, serverTs: Date.now() } }));
          } catch {
            /* a socket that died between admit and here closes on its own; nothing to recover */
          }
        },
        close(ws) {
          // Decrement/unregister ONLY for sockets we actually admitted (they have an Admit record), so the
          // ft_ws_clients gauge cannot drift on rejected connections. Keyed on the stable ws.data (see above).
          const a = admitted.get(ws.data as object);
          if (!a) return;
          admitted.delete(ws.data as object);
          a.unregister?.();
          metrics.wsClients.dec({ session: capLabel('session', a.sessionId) });
          log.info('ws close', { session: a.sessionId });
        },
        // The coach UI is receive-only; inbound frames are ignored.
        message() {},
      })
  );
}

// /metrics and /health carry per-child presence + version info, so they bind to LOOPBACK on a separate
// port — never the public/relay interface. Prometheus scrapes them locally; Caddy must not proxy them.
function createInternalApp() {
  return new Elysia()
    .get('/health', ({ set }) => {
      const mqtt = mqttReady;
      const dbUp = dbProbe();
      // Phase 6: a draining process is NOT healthy. Once SIGTERM has landed the listeners are about to
      // go, and a health check that keeps answering 200 for the last second of the process's life is
      // the reason orchestrators route requests into a closing socket. `draining` is reported as its
      // own field so an operator reading the body can tell "shutting down" from "broken".
      const draining = isDraining();
      const ok = mqtt && dbUp && !draining;
      // 503 when not ok: Playwright's webServer wait (200–403 = available) and the compose healthcheck
      // then both mean what they say. Every consumer in this repo parses the body regardless.
      set.status = ok ? 200 : 503;
      return {
        ok,
        mqtt,
        db: dbUp,
        draining,
        version: VERSION,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      };
    })
    .get('/metrics', ({ set }) => {
      updateRuntimeMetrics();
      refreshRetentionGauges(); // keep oldest-fix age current between hourly sweeps
      refreshBackupGauges(); // and the same question for the COPIES — see ft_backup_oldest_age_seconds
      set.headers['content-type'] = 'text/plain; version=0.0.4; charset=utf-8';
      return registry.render();
    });
}

// Auth must be initialised (accounts loaded, dummy hash precomputed, timers started) before we serve.
await initAuth();
// Roster (player names) — load + start the periodic reload BEFORE serving so /sessions/:id/roster has data.
await initRoster();
// Session config (Phase 4) — the per-session age band; load + start its reload before serving.
await initSessionConfig();

const app = createApp().listen({ port: PORT, hostname: PUBLIC_HOST });
const server = app.server;
if (!server) throw new Error('Elysia server failed to start');

const internalApp = createInternalApp().listen({ port: METRICS_PORT, hostname: '127.0.0.1' });

metrics.buildInfo.set({ version: VERSION, runtime: `bun-${Bun.version}` }, 1);

// Make the access-control posture loud — never let a children's-location feed be quietly mis-secured.
// The bind is the one control that cannot be recovered from downstream: once the socket is on a LAN
// interface with anon mode on, every request is already unauthenticated by design.
if (ANON_MODE && !LOOPBACK_HOSTS.has(PUBLIC_HOST)) {
  log.warn(
    `ALLOW_ANONYMOUS_LIVE=true AND the listener is bound to ${PUBLIC_HOST} (not loopback) — the live feed of children's positions is reachable without any login by anything that can route to this port. This is correct ONLY when something else confines it (a container whose published port is pinned to 127.0.0.1, or a trusted reverse proxy). If you did not deliberately arrange that, unset PUBLIC_HOST.`,
  );
}
if (!ANON_MODE && ALLOWED_ORIGINS.length === 0) {
  log.warn(
    'ALLOWED_ORIGINS is empty and anonymous mode is off — cookie-authenticated /live and /auth will reject ALL browser clients (a present Origin is required). Set ALLOWED_ORIGINS to your app origin (prod: https://relay.example; dev: http://localhost:5173).',
  );
}

/**
 * Publish one envelope into a session room and COUNT WHAT ACTUALLY HAPPENED (audit §6 "Server").
 *
 * Bun's `server.publish()` returns bytes sent, `0` when the message was dropped (no subscriber, or the
 * socket went away) and `-1` under backpressure. That return was discarded, so `ft_ws_messages_sent_total`
 * counted attempts and called them sends: a coach tablet stalling behind a slow link lost frames while
 * the "sent" rate climbed at full speed, and the one metric an operator would check could not say no.
 *
 * It is also the try/catch the audit named. `publish()` sat OUTSIDE ingest's error handling, so a throw
 * here reached the process-level handler and took the server down. Ingest must never be able to kill the
 * process by fanning out — the fan-out is best-effort by construction, and a failed publish is a counted
 * drop, not a fatal.
 */
const publishToRoom = (
  session: string,
  payload: string,
  sent: { inc: (l: Record<string, string>) => void },
): void => {
  const label = capLabel('session', session);
  try {
    const n = server.publish(wsRoom(session), payload);
    if (n === -1) metrics.wsDropped.inc({ session: label, reason: 'backpressure' });
    else if (n === 0) metrics.wsDropped.inc({ session: label, reason: 'dropped' });
    else sent.inc({ session: label });
  } catch (err) {
    metrics.wsDropped.inc({ session: label, reason: 'error' });
    log.warn('ws publish failed', { session: label, err: String(err) }); // never the payload — it carries positions
  }
};

const mqttClient = startIngest({
  publish: (session: string, telemetry: Telemetry) => {
    publishToRoom(session, JSON.stringify({ event: 'telemetry', data: telemetry }), metrics.wsSent);
  },
  // Phase 3: the minimised device-health envelope rides the SAME session room, so only sockets already
  // authorised for that session (the /live open() gate) ever receive it. No name on the wire.
  publishStatus: (session: string, h) => {
    publishToRoom(session, JSON.stringify({ event: 'status', data: h }), metrics.wsStatusSent);
  },
  onSubscribed: () => {
    mqttReady = true;
  },
  onDisconnected: () => {
    mqttReady = false;
  },
});

// Seed the metric label slots with every session the CONFIGURATION names (checker finding): admission into
// the capped label set is otherwise first-come, and a device flooding junk session ids before kick-off could
// take the slots — configured sessions must never end up as `_other`. (roster/session-config/accounts load
// just above; ANON_SESSIONS is the bench.)
for (const sid of ANON_SESSIONS) seedLabel('session', sid);
for (const sid of rosterSessionIds()) seedLabel('session', sid);
for (const sid of configuredSessionIds()) seedLabel('session', sid);
for (const sid of accountSessionIds()) seedLabel('session', sid);

// Present-at-0 for the client-beacon kinds (Phase 5), like the retention counter: a series that only
// appears the first time it happens has no baseline, so `increase(...[15m]) > 0` cannot fire on the
// very occurrence that matters most — a coach's view going dark mid-match.
for (const kind of BEACON_KINDS) metrics.clientEvents.inc({ kind }, 0);
// Same rule, same reason, for the Phase 6 counters whose documented alert is "any increase": a series
// that springs into existence at 1 gives increase(...[15m]) ~ 0, so the alert cannot fire on the very
// first occurrence — and for an unhandled rejection that may be the ONLY occurrence.
for (const kind of ['uncaught_exception', 'unhandled_rejection']) metrics.processFatal.inc({ kind }, 0);
for (const surface of ['history', 'events']) {
  for (const reason of ['client_gone', 'budget', 'shutdown']) metrics.scanAborted.inc({ surface, reason }, 0);
}

// Bound the raw-fix store in time (children's location must not linger). See ADR-0010.
const retentionTimer = startRetention();

// ── Phase 6: the graceful teardown, declared ONCE, in the order it runs. ─────────────────────────
// Registration order IS execution order (shutdown.ts) — deliberately not a LIFO stack, because the
// right order here is not the reverse of boot. Stop being reachable, stop producing work, stop
// listening, then touch the store last, when nothing else can be writing to it.
//
// Every step is individually wrapped by the runner and the whole sequence is capped at
// SHUTDOWN_DEADLINE_MS, so a step that wedges cannot turn `docker stop` back into a SIGKILL.
onShutdown('abort-scans', STEP.SCANS, async () => {
  // AWAITED, because marking a budget is not aborting a scan: a scan only notices at its next page
  // boundary, which is a yield away. The first version returned immediately, process.exit() fired ~1 ms
  // later, and the coach mid-review got a socket reset while `reason="shutdown"` stayed a permanently
  // zero metric (measured: 3 marked, 0 aborted). The drain returns as soon as the last one lets go.
  const { marked, drained } = await abortAllScans();
  if (marked > 0) log.info('shutdown: aborted off-loop scans', { scans: marked, drained });
});
onShutdown('stop-timers', STEP.TIMERS, () => {
  clearInterval(retentionTimer); // the sweep takes the write lock; it must not start during teardown
});
onShutdown('mqtt', STEP.MQTT, async () => {
  // Polite DISCONNECT, but never wait on it: QoS0 means there is nothing in flight worth preserving,
  // and the broker being unreachable is one of the reasons an operator restarts in the first place.
  await Promise.race([
    new Promise<void>((resolve) => mqttClient.end(false, {}, () => resolve())),
    Bun.sleep(250),
  ]);
});
onShutdown('listeners', STEP.LISTENERS, () => {
  // `true` = close active connections, which is what closes the /live sockets. The coach view treats a
  // close as a reconnect trigger (Phase 5), so the tablets come back on their own once we are up again.
  server.stop(true);
  internalApp.server?.stop(true);
});
// STEP.SESSIONS is registered by initAuth() itself, at the moment it consumes the handover file — a
// window this block could not cover, because it runs after the awaits above.
onShutdown('db', STEP.STORE, () => {
  closeDb(); // PASSIVE checkpoint + close; never TRUNCATE here (see closeDb's note on the budget)
});

// Audit S-3: print the whole resolved configuration once, where an operator looks — and shout about any env
// value that was rejected in favour of a default (a typo'd cap is otherwise invisible until it matters).
logResolvedConfig();

log.info('http listening', {
  host: PUBLIC_HOST, // logged so "which interface is this on" is answerable from the log alone
  port: PORT,
  metricsPort: METRICS_PORT,
  version: VERSION,
  anonMode: ANON_MODE,
  public: ['/live', '/auth/login', '/auth/logout', '/auth/me', '/sessions'],
  internalLoopback: ['/health', '/metrics'],
});
