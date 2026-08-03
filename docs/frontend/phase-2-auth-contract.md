# Phase 2 — auth & security core: frozen contract

**Status:** Frozen (build coordination) · **Date:** 2026-06-15 · Implements
[ADR-0015](../decisions/0015-frontend-auth-transport.md) (frontend auth transport) +
[ADR-0008](../decisions/0008-authentication-access-control.md) (auth & access control).
**Hardened by a 4-lens adversarial security pre-mortem (2026-06-15)** — every "must-fix" below is folded in.

Single source of truth the parallel build streams code against. **Threat model #1: this gates the live
location of minors, and Profile B is internet-exposed.** Security first, then performance, then cost.

## Invariants (must hold)
- **No child names anywhere** — never in the SPA bundle, the telemetry DB, replay-export rows, logs, or any
  Prometheus label. Coach *usernames* are adult-operator identities → logged for audit (ADR-0008), but NEVER
  in a metric label. `/auth/me` and `/sessions` carry ONLY sessionId strings + operator usernames.
- **A token is valid iff it exists in the in-memory store AND is unexpired.** Logout and account-removal both
  remove it. Authz is resolved against the **live** accounts map by username on every upgrade — never a
  login-time snapshot.
- **Do not edit `firmware/src/main.cpp`.** Phase 2 is server + client only. **No heavyweight dep** — argon2id
  is Bun-native (`Bun.password`), tokens via `node:crypto`.
- **Fail closed, and be loud.** Every dangerous posture (anon mode, non-Secure cookies, empty origin
  allow-list on a non-anon deploy, missing/malformed accounts) emits a LOUD boot warning and degrades to
  no-access — never to open-access.

## 1. Account model + load hardening
Accounts live in a JSON file, loaded into memory at boot **and reloaded every `AUTH_ACCOUNTS_RELOAD_SECONDS`
(default 15)** so the provisioning CLI's edits (and revocations) take effect without a restart.

```jsonc
// AUTH_ACCOUNTS_FILE (default ./auth-accounts.json, relative to server cwd). NOT committed.
{ "accounts": [
  { "username": "coach-amy", "hash": "$argon2id$v=19$...", "role": "coach", "sessions": ["u12-sat"] },
  { "username": "club-admin", "hash": "$argon2id$v=19$...", "role": "admin", "sessions": [] }
]}
```
- `role:"coach"` → authorized ONLY for `sessions[]` (exact match). `role:"admin"` → all sessions.
- **Load validation (boot AND every reload), all fail-CLOSED, never crash the process:**
  - Wrap read+parse in try/catch. Missing / empty / malformed-JSON / wrong-shape → **0 accounts loaded** +
    loud warning. Server still starts (so `/health` works).
  - Reject the file if it exceeds **1 MB** (operator-writable; bound it) → 0 accounts + warning.
  - **Duplicate username** → skip the file (0 accounts) + warning (privilege-confusion guard).
  - Each entry's `hash` MUST start with `$argon2id$`; entries that don't are dropped + warned (a bad hash can
    never reach a per-request `verify`). `role` must be `coach|admin`; `sessions` must be `string[]`.
  - On reload: atomically swap the map; then (a) drop auth-sessions whose username vanished, and (b) re-evaluate
    every open `/live` socket and close (`1008`) any whose principal no longer passes §5 authz.

### Provisioning CLI — `server/auth-user.ts` (mirrors `purge-player.ts`)
- `add <username> --role <coach|admin> [--sessions a,b,c]` — password from **stdin** (piped) or hidden TTY
  prompt; `Bun.password.hash(pw,{algorithm:'argon2id'})`; upsert; creates the file if missing. Never echoes/logs pw.
- `remove <username>` · `list` (usernames+roles+sessions, **no hashes**). Honors `AUTH_ACCOUNTS_FILE`.
- The running server picks up `add/remove/sessions` edits within `AUTH_ACCOUNTS_RELOAD_SECONDS` (revocation path).

## 2. Auth-session store (server, in-memory) — bearer cookie
Distinct from the *match* `sessionId`. Keyed by an opaque token.
- **Only a successful argon2id verify mints an entry** (so the map is bounded by successful logins, never by
  attacker request volume): `token = base64url(randomBytes(32))` (256-bit); store
  `Map<token,{ username, csrf, expiresAt }>`. `csrf = base64url(randomBytes(32))` — a **synchronizer token**,
  NOT a cookie (§4).
- **No role/sessions snapshot** — authz re-resolves from the live accounts map by `username` on every use.
- **Absolute** TTL `AUTH_SESSION_TTL_SECONDS` (default 43200 = 12 h — intentional: covers a match day; knob present).
  No idle timeout. Validity checked on every lookup; **an active sweep** drops expired entries every 60 s.
  **Per-username cap** `AUTH_MAX_SESSIONS_PER_USER` (default 8): on mint, the principal's OWN oldest token is
  evicted first, so one account spamming logins can only evict its own sessions — never force-logout another
  coach/admin. A global `AUTH_MAX_SESSIONS` (1000) stays as a hard backstop (the per-user cap keeps the map
  ≈ users × 8, well under it).
- **Logout deletes the entry. Account-removal (via reload) deletes the user's entries.** Process restart clears all.
- Multi-login is allowed (two tablets = two tokens); each is revoked independently by its own logout/expiry, and
  all of a username's tokens are revoked when the account is removed.

## 3. HTTP API (PUBLIC port, alongside `/live`)
JSON only. **Every POST: `Content-Type: application/json`, body ≤ 4 KB (else 413, before parse), and a
present + allow-listed `Origin` (strict — `originOkStrict`, §5). A missing Origin on a POST is REJECTED.**

| Route | Method | Auth | Request | Success | Failure |
|---|---|---|---|---|---|
| `/auth/login` | POST | none | `{username (≤64), password (≤256)}` | `200 {username, role, sessions, csrf}` + `Set-Cookie` (§4) | `401 {error:"invalid_credentials"}` (identical body+timing unknown-user vs bad-pw); `413` oversized; `415` wrong content-type; `429 {error:"throttled"}`; `503 {error:"busy"}` |
| `/auth/logout` | POST | cookie + CSRF | header `X-CSRF-Token` | `204` + cookie cleared (Max-Age=0) + **token deleted server-side** | `401` no/invalid session; `403 {error:"csrf"}` |
| `/auth/me` | GET | cookie (optional) | — | `200 {authenticated:true, username, role, sessions, csrf, wildcard, anonymous?}` | `401 {authenticated:false}` |
| `/sessions` | GET | cookie | — | `200 {sessions:string[], wildcard:boolean}` (coach→assigned; admin→`wildcard:true`) | `401` |

### Login DoS / brute-force / enumeration controls (ALL run-and-reject BEFORE any `Bun.password` call)
1. **Per-IP token bucket** (IP = first `X-Forwarded-For` hop else socket IP): `AUTH_LOGIN_BURST` (default 5)
   per `AUTH_LOGIN_WINDOW_S` (default 30) → `429 throttled`.
2. **Per-username soft-lock — DETECT, don't deny**: 10 failures within 15 min flags the username; further
   *failures* then return `429` (throttle signal) instead of `401`, and a WARN audit log fires — but the lock
   does NOT short-circuit before the verify, so a real operator typing the CORRECT password is never refused
   (success clears it). A username-keyed hard lock would let an attacker force-lock a guessable coach out
   mid-match (a targeted-DoS on a safety feed); brute-force is bounded instead by argon2id + the per-IP bucket
   + the inflight cap.
3. **Global concurrent-hash cap** `MAX_INFLIGHT_LOGINS` (default 4) → `503 busy` (bounds peak argon2id RAM).
4. **Constant work**: unknown username still runs one `verify` against a boot-precomputed argon2id **dummy
   hash** (result discarded) → no unknown-vs-bad-pw timing oracle.
- Metric `ft_auth_logins_total{result="success|failure|throttled"}`. WARN log on failure carries `{username}`
  (operator audit; never a metric label).

### Anonymous mode (`ALLOW_ANONYMOUS_LIVE=true`)
For a physically isolated LAN only. `/auth/me` → `200 {authenticated:true, anonymous:true, username:null,
role:"coach", sessions: ANON_SESSIONS, csrf:"", wildcard:false}`. **The anon principal is authorized ONLY for
the sessions in `ANON_SESSIONS` (comma list, default empty ⇒ reads nothing) — NEVER wildcard.** Strict Origin
still applies (a no-Origin curl cannot reach it). LOUD boot warning + `ft_anon_mode_active=1`.

**Scope — anon is the LIVE PITCH and nothing else** (added by the 2026-08-03 audit, §4.1):

| Surface | Anon | Why |
|---|---|---|
| `/live`, `/sessions`, `/auth/me` | ✅ | the pitch view and what it needs to find its session |
| `/sessions/:id/config` | ✅ | one age-band enum + its thresholds; no name, no position, no per-child data |
| `/sessions/:id/roster` | ❌ `403 login_required` | child **names** |
| `/sessions/:id/history` | ❌ `403 login_required` | bulk raw child **location** export |
| `/sessions/:id/events` | ❌ `403 login_required` | the review series built from that history |

403, not 401: the anon caller *is* authenticated, just not permitted, and a 401 reads as an expired cookie
to a client that has none. The check runs **before** `validSessionId`, like the 401, so it leaks no
session-id-validity oracle. New session-scoped endpoints are **closed to anon by default** —
`sessionGetGate(request, id, allowAnonymous = false)`; opting one in is a deliberate edit.

**Anon is a FALLBACK, not an override.** `currentPrincipal` resolves the cookie FIRST and only returns the
anon principal when there is no valid session. It used to short-circuit (`if (ANON_MODE) return
ANON_PRINCIPAL`) before parsing the cookie, which made the cookie layer dead code on that stack — and, once
the table above existed, made names unreachable there for *everyone*, while every audit line for a coach's
read said `username: null`. On an anon stack a login is **optional** (it buys names + Review), not the way in.

**Bind (`PUBLIC_HOST`).** Anon mode defaults the listener to `127.0.0.1`. A feed that needs no login must not
also be LAN-reachable; the Origin allow-list is CSWSH defence and carries no authorization weight, since an
absent Origin — what every non-browser client sends — cannot be authenticated. `PUBLIC_HOST` overrides it
(a container needs `0.0.0.0` inside its own namespace, where the real boundary is the Docker port publish),
and that combination logs a loud warning. See `server/test/anon-scope.ts`, which pins both directions.

## 4. Cookie
Name is **`__Host-ft_session`** when `AUTH_COOKIE_SECURE !== 'false'` (default), else `ft_session`.
`HttpOnly; SameSite=Lax; Path=/; Max-Age=<ttl>` + `Secure` when secure. **No `Domain`.** The `__Host-` prefix
(when Secure) blocks subdomain cookie-shadowing/fixation. **No CSRF cookie** — the csrf synchronizer token is
delivered in the `/auth/login` + `/auth/me` JSON body and echoed in `X-CSRF-Token`; the server compares it to
the **stored** `session.csrf` with `timingSafeEqual` (never to a cookie). The client never reads any cookie.
- **`AUTH_COOKIE_SECURE=false` ⇒ LOUD boot warning** ("session cookies are NOT Secure — localhost dev / isolated
  LAN only"). Dev/e2e/sim set it false; **dev must be reached via `http://localhost`** (a secure context) — a
  LAN-IP origin silently drops a Secure cookie. Logout clears the cookie (Max-Age=0).

## 5. `/live` WS authz (`server.ts open()`) — the core change
Remove the `token` query param, `LIVE_TOKEN`, `tokenOk`. `originOkStrict(origin)`: **absent → false**; present
must be in `ALLOWED_ORIGINS`. Check order (first failure wins; same predicate mirrored in `close()`):
1. `originOkStrict(origin)` → else `1008 'forbidden origin'`, `ft_ws_rejected{reason="origin"}`.
2. **Validate `sessionId`**: a single string matching `^[A-Za-z0-9._-]{1,64}$` (reject arrays/empty/oversized)
   → else `1008 'bad session'`, `ft_ws_rejected{reason="no_session"}`. Use this validated value everywhere.
3. Resolve principal: parse `Cookie` → the session-cookie name (§4) → auth-session store (unexpired) → `username`
   → **live accounts map**. Anon mode synthesizes the §3 anon principal. No principal → `1008 'unauthorized'`,
   `ft_ws_rejected{reason="auth"}`.
4. Authorized for `sessionId`? (`role==='admin' || sessions.includes(sessionId)`; anon ⇒ `ANON_SESSIONS.includes`)
   → else `1008 'forbidden session'`, `ft_ws_rejected{reason="not_authorized_for_session"}`.
5. `ws.subscribe(wsRoom(sessionId))`; `ft_ws_clients{session}`++; register the socket under `username` so a
   later accounts-reload can close it on revocation. `close()` decrements with the same admit predicate.

Close `reason` wire strings the client maps (§7): `forbidden origin` · `bad session` · `unauthorized` ·
`forbidden session`.

## 6. Metrics (`server/src/metrics.ts`, `docs/architecture/observability.md`)
- `ft_ws_rejected_total` reasons help → add `not_authorized_for_session`.
- `ft_auth_logins_total{result="success|failure|throttled"}` (counter, **no username label**).
- `ft_auth_sessions_active` (gauge), `ft_anon_mode_active` (gauge 0/1). All low-cardinality; `/metrics` loopback-only.

## 7. Client
### `config.ts` (FROZEN by lead) — remove `WS_BASE`/`VITE_WS_URL`, `LIVE_TOKEN`/`VITE_LIVE_TOKEN`. Add:
- `liveWsUrl(sessionId)` → same-origin `${location.protocol==='https:'?'wss':'ws'}://${location.host}/live?sessionId=…`.
- `apiUrl(path)` → relative same-origin; all fetches use `credentials:'same-origin'`.
- `DEFAULT_SESSION = import.meta.env.VITE_DEFAULT_SESSION ?? 'test'` — prefill for the **admin-wildcard** picker only.
- Keep all render/liveness constants unchanged.

### `contracts.ts` (FROZEN by lead)
- `ConnectionPhase` gains `'forbidden'` (authed but not authorized for this session — terminal).
- `describeConnection` `'forbidden'` case → `{label: conn.detail ?? 'not authorized for this session', tone:'bad'}`.
- Auth types:
  ```ts
  export type Role = 'coach' | 'admin';
  export interface Principal { username: string | null; role: Role; sessions: string[]; wildcard: boolean; anonymous: boolean; csrf: string; }
  export type AuthState = { status:'loading' } | { status:'anonymous' } | { status:'authed'; principal: Principal };
  export interface UseAuth {
    auth: AuthState;
    login(u: string, p: string): Promise<{ ok: true } | { ok: false; error: string }>;
    logout(): Promise<void>;
    refresh(): void;   // re-GET /auth/me; flips to 'anonymous' on 401 (cookie expired/revoked mid-session)
  }
  ```

### `useAuth.ts` (NEW — stream CA)
Implements `UseAuth`. Mount → `GET /auth/me`. **`login`**: `POST /auth/login` (relative, `credentials:'same-origin'`,
`X-CSRF`-N/A), then on 200 **immediately `GET /auth/me` to confirm the cookie stuck**; if that returns 401 →
return `{ok:false, error:'Signed in, but the session cookie was not stored — use https:// or http://localhost (dev: set AUTH_COOKIE_SECURE=false).'}` (the cookie-not-stored diagnostic, NOT a silent login loop). On confirm →
`authed` with the principal (incl. `csrf`). **`logout`**: `POST /auth/logout` with `X-CSRF-Token: principal.csrf`
→ `anonymous`. **`refresh`**: re-`GET /auth/me`; 401 → `anonymous`.

### `Login.tsx` (NEW — stream CA)
Accessible form: labelled username/password, submit, an `aria-live` error region showing the server/diagnostic
message as TEXT (not colour). Outdoor/high-contrast aware. No credential autofill leakage.

### `App.tsx` + `useLiveTelemetry.ts` (stream CL)
- `App`: `useAuth()`. `loading`→spinner; `anonymous`→`<Login/>`; `authed`→ live shell. **Session selection** from
  the principal: `wildcard`(admin)→ text input prefilled `DEFAULT_SESSION`; else exactly one session → auto-select;
  else `<select>`. "Sign out" button (hidden when `principal.anonymous`). On a WS `'unauthorized'` close →
  `auth.refresh()` (bounces to `<Login>` if the cookie truly expired). Wake-lock released on `'forbidden'` too.
- `useLiveTelemetry`: drop token; connect `liveWsUrl(sessionId)` (cookie auto-attached). `CLOSE_DETAIL` gains
  `'bad session'` + `'forbidden session'`; map `'forbidden session'`→ phase `'forbidden'`, `'unauthorized'` stays
  terminal + invokes an `onUnauthorized` callback. Keep capped-backoff network-drop logic.

### CSP / Vite (stream TR)
- `index.html`: `connect-src 'self'` (same-origin WS+fetch+HMR); drop the `__WS_CONNECT_SRC__` placeholder + its
  explainer; note the ADR-0015 same-origin requirement.
- `vite.config.ts`: remove the `ft-csp-connect-src` plugin. `server.proxy` for `/live` (`ws:true`), `/auth`,
  `/sessions` → `VITE_PROXY_TARGET` (default `http://localhost:3000`), `changeOrigin:false` (preserve browser
  Origin so the server's strict allow-list sees `http://localhost:5173`).

## 8. Tests
- **Server — `server/test/auth-e2e.ts` (new):** accounts file (argon2id) + coach assigned to session `A`; server
  auth-on (no anon), `AUTH_COOKIE_SECURE=false`. Assert: (a) no-cookie WS → rejected, nothing received;
  (b) bad login → 401 + `ft_auth_logins_total{result="failure"}`; (c) no-Origin POST /auth/login → rejected;
  (d) good login (with Origin) → `Set-Cookie` HttpOnly + body has `csrf`, no token in body; (e) WS w/ cookie+Origin
  for `A` → fan-out; (f) WS w/ cookie for **unassigned** `B` → `1008 'forbidden session'` +
  `ft_ws_rejected{reason="not_authorized_for_session"}`; (g) logout (with X-CSRF) → 204; **the SAME captured
  cookie replayed on a fresh WS is now rejected** (server-side revocation); (h) `auth-user.ts remove` + reload
  window → that coach's new WS upgrade rejected. Uses Bun `new WebSocket(url,{headers:{cookie,origin}})`.
  `server/test/e2e.ts`: migrate the coach socket off `?token=` to the cookie path (login → cookie+Origin).
- **Client — `client/e2e/auth.spec.ts` (new):** login form when not authed; bad creds → error text; good creds →
  reaches `live`; forbidden session → the `'forbidden'` state. `fixtures.ts`: `withAnonStack` keeps working (anon
  + `ANON_SESSIONS=<session>`, no login, via `VITE_PROXY_TARGET`); replace `withTokenGatedStack` →
  `withAuthStack` (provisions a coach account, auth-on, `AUTH_COOKIE_SECURE=false`, Vite proxy). `live.spec.ts`
  anon path unchanged; old "token-gated→unauthorized" test becomes "no session → login form shown".
  `playwright.config.ts`: webServers use `VITE_PROXY_TARGET` + `ANON_SESSIONS`/`VITE_DEFAULT_SESSION`, drop
  `VITE_WS_URL`/`VITE_SESSION_ID`.
- **simulate.ts (stream SIM):** `--secure` provisions a **default coach account** (writes `AUTH_ACCOUNTS_FILE`
  via `Bun.password`) assigned to the run session, `AUTH_COOKIE_SECURE=false`, prints the dev login creds +
  same-origin `bun run dev`. Anonymous standalone sets `ALLOW_ANONYMOUS_LIVE=true` + `ANON_SESSIONS=<session>`.

## 9. Env var catalogue
- **Added (server):** `AUTH_ACCOUNTS_FILE` (`./auth-accounts.json`), `AUTH_SESSION_TTL_SECONDS` (43200),
  `AUTH_COOKIE_SECURE` (`true`), `AUTH_ACCOUNTS_RELOAD_SECONDS` (15), `AUTH_MAX_SESSIONS` (1000),
  `AUTH_MAX_SESSIONS_PER_USER` (8), `ANON_SESSIONS` (empty), `MAX_INFLIGHT_LOGINS` (4), `AUTH_LOGIN_BURST` (5),
  `AUTH_LOGIN_WINDOW_S` (30),
  `TRUST_PROXY` (`false` — socket-peer rate-limit key; `true` only behind a single trusted Caddy that sets XFF).
  **Added (client):** `VITE_PROXY_TARGET` (`http://localhost:3000`), `VITE_DEFAULT_SESSION` (`test`).
- **Removed:** `LIVE_TOKEN`; `VITE_LIVE_TOKEN`; `VITE_WS_URL`.
- **Changed:** `ALLOWED_ORIGINS` now **strict** (absent Origin rejected on `/auth`+`/live`); empty + non-anon ⇒
  LOUD boot warning (cookie auth without a working allow-list is misconfigured). `ALLOW_ANONYMOUS_LIVE` needs
  `ANON_SESSIONS` to read anything.

## 10. Docs to update (stream DOC)
ADR-0015 (→ shipped + same-origin/CSP + pre-mortem hardening) · ADR-0008 (→ accounts/login shipped) ·
`README.md` (server auth env, login flow, removed token, CLI, same-origin, anon=LAN-only) ·
`observability.md` (new metrics + an auth-DoS/lockout note) · `improvement-plan.md` (Phase 2 → shipped).

## 11. File ownership (parallel build — disjoint sets)
- **Lead (me, FIRST, sequential):** `server/src/auth.ts` (core: accounts+load-hardening, session store, login
  controls, cookie/csrf, principal authz, socket registry), `server/src/server.ts` (routes + WS authz),
  `server/src/metrics.ts`, `server/auth-user.ts` (CLI); FREEZE `client/src/config.ts` + `client/src/contracts.ts`.
- **CA:** `client/src/useAuth.ts`, `client/src/Login.tsx` (new). **CL:** `client/src/App.tsx`, `client/src/useLiveTelemetry.ts`.
- **TR:** `client/vite.config.ts`, `client/index.html`. **TS:** `server/test/auth-e2e.ts` (new), `server/test/e2e.ts`.
- **TC:** `client/e2e/auth.spec.ts` (new), `client/e2e/fixtures.ts`, `client/e2e/live.spec.ts`, `client/playwright.config.ts`.
- **SIM:** `server/test/simulate.ts`. **DOC:** the §10 docs.

## 12. Post-implementation security review (2026-06-15) — outcomes
A 3-lens adversarial review of the *built* code (not just the design) found and FIXED:
- **HIGH — `ft_ws_clients` never decremented + revocation registry leak:** the `/live` admit-record `WeakMap`
  was keyed on the per-callback `ElysiaWS` wrapper (a fresh instance each callback), so `close()` always missed.
  Fixed by keying on the stable `ws.data` (verified identical across open/close). Regression guard added to
  `auth-e2e.ts` (case h): the gauge must drain to 0 after an admitted socket closes.
- **MEDIUM — silent dark feed:** a transient `1008 'unauthorized'` close while the cookie is still valid left
  the live view frozen with no recovery. `refresh()` now resolves whether still-authed; `App` re-arms the socket
  a **bounded** `MAX_REARM` (3) times for the still-authed transient, while the common expiry case still bounces
  straight to `<Login>`.
- **MEDIUM — XFF spoofing of the login rate-limiter:** the limiter trusted the client-controlled leftmost
  `X-Forwarded-For` hop. Now keys on the unspoofable socket peer by default; honors XFF (rightmost hop) only when
  `TRUST_PROXY=true` (single trusted Caddy).
- **LOW (hardening) — body cap on bytes:** `readJsonBody` now caps on `Buffer.byteLength` (UTF-8), not UTF-16
  code units.
- **FALSE POSITIVE — "enumeration via lockout":** `recordFailure` is unconditional on any failed login, so an
  unknown username locks (fast 429) exactly like a real one — no asymmetry. No change.
- **ACCEPTED — onopen-before-onclose(1008) 'live' flash:** a rejected socket is never subscribed, so no data is
  delivered; `onclose` is authoritative. No change (documented in `useLiveTelemetry`).

### Second review round — expert multi-axis (2026-06-15)
A 7-axis review (correctness, security, types, React/a11y, performance, test rigor, maintainability), each
finding adversarially verified: 37 findings → 4 confirmed real bugs (33 refuted/nits), all FIXED:
- **MEDIUM — global session-eviction DoS:** one authenticated coach could mint >`AUTH_MAX_SESSIONS` tokens and
  evict every other coach/admin (force-logout the fleet mid-match). Fixed with the per-username cap above.
- **MEDIUM — targeted-lockout DoS:** the username-keyed hard lock denied even the real coach with the correct
  password. Fixed by the DETECT-don't-deny soft-lock (§3).
- **MEDIUM — multi-session `<select>` desync:** a 2+-session coach started with `session=''` (no `<option>`
  match) → picker looked selected but rendered nothing + a React warning. Fixed: auto-select `sessions[0]`.
- **LOW — misleading `validSessionId` comment:** the "array footgun" it claimed to defend doesn't exist on
  Elysia 1.4.28 (duplicate `sessionId` is last-wins string, not an array). Corrected the comment + pinned the
  coercion in `auth-e2e` (case e2) so an Elysia upgrade can't silently change the authz key.
- Plus cheap correctness/a11y nits (Login autofocus + dropped redundant `aria-live`; stale `ConnectionPhase`
  doc) and new regression tests: open-socket revocation on reload (case i), logout CSRF/cookie negatives (f),
  `ft_ws_clients` drain (h).

### Follow-ups — all SHIPPED (2026-06-15)
The "recommended follow-ups (not blocking)" from the review round above are now all done and verified:
- **Accounts-file fail-closed loader tests** — `server/test/auth-loader.ts` (11 cases): missing/oversized/malformed/
  no-array → 0 accounts; per-entry drops for blank-username / non-argon2id-hash / bad-role; **duplicate username →
  entire file rejected**; sessions normalised to `string[]`. (`loadAccounts` is now exported + path-parameterised
  solely to make this validation directly unit-testable.)
- **DoS-response tests** — `server/test/auth-dos.ts`: `415` unsupported_media_type, `413` too_large, `429` throttled
  (per-IP bucket), `503` busy (inflight cap) — all observed against a live server.
- **CLI `add`/`remove`/`list` tests** — `server/test/auth-cli.ts`: `add` (stdin password) writes mode-`0o600`
  argon2id JSON that verifies + never leaks the plaintext; `list` renders the `[role]` label + `sessions:` line;
  `remove` drops one and keeps the other; remove-nonexistent errors without corrupting the file.
- **Cookie-not-stored client diagnostic test** — `client/e2e/cookie-diagnostic.spec.ts` (in the `auth` Playwright
  project): server accepts the login (real `200`) but the confirming `/auth/me` is forced `401`, and the Login UI
  must show the specific cookie diagnostic — not a generic error and not a false success.
- **DRY principal shape** — `principalBody`'s duplicated inline return type collapsed to `: Principal` (the explicit
  field-whitelist literal is kept as the leak guard).
- **Async accounts reload** — `loadAccounts`/`reload` moved to `node:fs/promises` so the 15 s reload never blocks the
  shared Bun event loop (MQTT ingest + WS fan-out), with a re-entrancy guard so a slow read can't overlap itself.
</content>
