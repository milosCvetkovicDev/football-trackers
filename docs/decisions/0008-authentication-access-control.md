# ADR-0008 — Authentication & access control

**Status:** Accepted · **Implementation:** WS `/live` auth (Origin allow-list + server-authorised session)
**shipped** 2026-06-14; the **named login** (username + argon2id + HttpOnly session cookie), the JSON accounts
file + provisioning CLI ([`server/auth-user.ts`](../../server/auth-user.ts)), and **principal-bound session
authz** on the `/live` upgrade **shipped** 2026-06-15 ([ADR-0015](0015-frontend-auth-transport.md); the shared
bundled token is retired). Per-user audit logging via structured `auth login`/`auth logout` events. Remaining
deferred: TOTP for `admin`, parent access · **Date:** 2026-06-14

## Context
Profile B is internet-exposed and serves the **live location of minors**, so access control is mandatory.
But the user population is tiny — a single club, ~1 admin and a few coaches — so a heavyweight IdP would be
over-engineering ([brief §5](../architecture/architecture-brief.md#5-scale-envelope--design-to-this)).

## Decision
- **Principals:** `admin` (club) and `coach`. **Parents are out of MVP** (per-child views need per-player ACLs
  and stricter consent — deferred).
- **AuthN (humans):** username + **argon2id** password; HTTP-only / Secure / SameSite session cookie; CSRF
  tokens on state-changing routes; optional TOTP for `admin`.
- **AuthN (machine):** field box ↔ relay uses **mTLS** (client cert = club identity), not a human password.
- **AuthZ:** roles `{admin, coach}`, coach scoped to assigned sessions. **Every** relay WS-subscribe and
  history query is authorised **server-side** against the authenticated principal — the client-claimed
  `sessionId` is never trusted. The local (LAN) view uses the same code path with one default coach account.

## Consequences
- **+** No anonymous access anywhere (NFR-SEC-1); cross-session/club reads are blocked server-side (STRIDE-EoP).
- **+** Small, owned, no third-party auth dependency or cost.
- **−** Account/credential lifecycle is manual (admin issues coaches) — fine at this scale.
- **−** Parent access will require revisiting the authz model when added.

## Alternatives considered
- **OAuth / managed IdP (Auth0, Clerk, Keycloak)** — rejected: cost/operational weight for ~20 users; conflicts
  with the "fully owned" ethos.
- **Shared club password only** — rejected for Profile B (no per-user audit, no revocation); acceptable *only*
  for the isolated-LAN local view.
