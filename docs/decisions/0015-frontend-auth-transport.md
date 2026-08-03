# ADR-0015 — Frontend auth transport: cookie-on-upgrade, principal-bound session authz, reject the bundled token

**Status:** Accepted · **Implementation:** shipped 2026-06-15 · **Date:** 2026-06-15

## Context
The coach SPA authenticates to `/live` with a single shared `LIVE_TOKEN` **baked into the JS bundle**
(`VITE_LIVE_TOKEN`, [`client/src/config.ts`](../../client/src/config.ts)) and sent in the **WebSocket URL
query string** ([`client/src/useLiveTelemetry.ts`](../../client/src/useLiveTelemetry.ts)). For a children's-
location feed that is a long-lived bearer secret readable in the bundle and leaked into Caddy/server access
logs, browser history, and `Referer`. [ADR-0008](0008-authentication-access-control.md) already commits to
argon2id login + HTTP-only session cookies but tagged it deferred/Profile-B. Browsers **cannot** set custom
headers on `new WebSocket()` (no `Authorization`), so a cookie auto-attached on the upgrade GET is the only
clean browser-WS auth — but only when the client is **same-origin** with the WS endpoint. The FE panel's
adversarial pass flagged that "the cookie is sent on the upgrade" is a topology *constraint*, not a given, and
that a per-session token still in the bundle would be security theatre. Today `server.ts` `open()` only checks
that a `sessionId` is *present* — it subscribes to whatever session string the client supplies.

## Decision
- **Reject any bundle-baked token.** No secret in `import.meta.env` / the WS query string; stop shipping
  `LIVE_TOKEN` in client JS.
- **AuthN before authz.** Implement the [ADR-0008](0008-authentication-access-control.md) named login
  (argon2id + HTTP-only/Secure/`SameSite=Lax` session cookie; hand-rolled per the minimal-dependency ethos —
  **no** auth SDK/IdP). On the isolated LAN, the single default coach account ADR-0008 specifies.
- **Cookie on the WS upgrade — same-origin required (hard constraint).** The client MUST be served from the
  relay/Caddy origin so the browser auto-attaches the session cookie on the `wss://…/live` upgrade. Recorded
  here as a deployment constraint, not an assumption.
- **Dev parity via a same-origin proxy.** Vite serves `:5173` and **proxies** `/live` (+ the API) to the
  server so dev is same-origin; the current cross-origin `ws://localhost:3000` default is removed. A dev-only
  env token, gated to non-production, is the only fallback if a same-origin dev proxy is not used.
- **Session authz bound to the principal.** Replace the presence-only `sessionId` check in `server.ts`
  `open()` with "is this authenticated principal assigned to this `sessionId`?"; reject `1008` and count
  `ft_ws_rejected{reason="not_authorized_for_session"}`.
- **Origin allow-list stays.** Cookies do not stop CSWSH; keep `server.ts` `originOk()` as the CSWSH defence
  (critical under any `SameSite=None` split-host deploy).
- **Cross-origin escape hatch: a short-lived, single-use WS ticket.** If a split-host deploy is ever required,
  mint a short-lived single-use ticket via an authenticated request and pass it once on the upgrade — never a
  long-lived token in the bundle.

## Implementation (shipped 2026-06-15)
Built in parallel streams against the [frozen contract](../frontend/phase-2-auth-contract.md), which the
4-lens adversarial security pre-mortem hardened before any code was written. What landed:
- **Cookie on the upgrade.** Login mints an HttpOnly/`SameSite=Lax`/`Path=/` session cookie — `__Host-ft_session`
  when Secure, `ft_session` otherwise — that the browser auto-attaches to the same-origin `/live` upgrade GET
  ([`server/src/auth.ts`](../../server/src/auth.ts) `setCookieHeader`/`COOKIE_NAME`).
- **Bundled token killed.** `LIVE_TOKEN` / `VITE_LIVE_TOKEN` and the `?token=` WS query param are gone; no secret
  ships in `import.meta.env` or any URL ([`client/src/config.ts`](../../client/src/config.ts) is now token-free).
- **Principal-bound session authz.** `server.ts` `open()` resolves the cookie → principal → live accounts map and
  rejects (`1008 'forbidden session'`) when the principal is not assigned to the requested session, counting
  `ft_ws_rejected_total{reason="not_authorized_for_session"}`.
- **Vite same-origin proxy.** `vite.config.ts` proxies `/live` (`ws:true`), `/auth`, and `/sessions` to
  `VITE_PROXY_TARGET` with `changeOrigin:false`, so dev is same-origin and the browser Origin reaches the
  server's strict allow-list.
- **CSP `connect-src 'self'`.** Same-origin WS + fetch + HMR; the build-time `__WS_CONNECT_SRC__` placeholder and
  its derived-host plugin are removed.

## Pre-mortem hardening
The adversarial pass folded these must-fixes in (all in [`server/src/auth.ts`](../../server/src/auth.ts) /
[`server/src/server.ts`](../../server/src/server.ts)): **server-side logout revocation** — logout deletes the
token, so a captured cookie cannot be replayed; **strict Origin** — an absent `Origin` is rejected on both
`/auth` and `/live` (the old lenient "no Origin → ok" branch would have let any header-omitting curl bypass the
CSWSH/CSRF layer); **anon scoped to `ANON_SESSIONS`, never wildcard** — the isolated-LAN bypass reads only its
listed sessions; **argon2id login DoS controls** that run-and-reject before any hash — a per-IP token bucket, a
global concurrent-hash cap, a per-username soft-lock, and a 4 KB body cap — plus a **constant-work dummy hash**
on unknown users so there is no enumeration timing oracle; **periodic accounts reload as the revocation path** —
edits/removals take effect within `AUTH_ACCOUNTS_RELOAD_SECONDS`, dropping orphaned sessions and closing the
now-unauthorized principal's open `/live` sockets; and a **CSRF synchronizer token** delivered in the response
body (never a readable cookie) and compared constant-time against the stored value on state-changing routes.

## Consequences
- **+** Kills the headline risk: one leaked bundle secret can no longer read every child's live location across
  all sessions; per-session authz contains blast radius.
- **+** Token out of URLs → no leakage via logs/history/`Referer`.
- **+** Reuses ADR-0008's committed design; no new heavyweight dependency (driver #3).
- **−** Couples the client deploy to the relay origin (documented hard constraint) and adds a Vite dev proxy.
- **−** Requires the server login + session-authz endpoints (cross-cutting; tracked in the FE plan).

## Alternatives considered
- **Per-session token still in the bundle** — rejected: theatre; readable by anyone who loads the app.
- **`Authorization: Bearer` on the WS** — impossible from a browser WebSocket (no custom headers).
- **Token in the query string (status quo)** — rejected: leaks into logs/history/`Referer`.
- **OAuth / external IdP** — already rejected by ADR-0008 (overkill for ~20 users; violates the cost driver).
