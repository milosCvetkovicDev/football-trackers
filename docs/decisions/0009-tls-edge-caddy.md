# ADR-0009 — Caddy as the TLS-terminating edge (Profile B)

**Status:** Accepted (design) · **Implementation:** not yet built · **Date:** 2026-06-14

## Context
Profile B needs a public HTTPS/WSS endpoint with TLS, security headers, and rate limiting in front of the
relay. Cost ceiling is €5–20/mo and the ethos is self-hosted/owned, so a paid WAF/managed-TLS service is out.

## Decision
Put **Caddy** in front of the relay on the VPS. Caddy provides **automatic HTTPS** via Let's Encrypt (€0,
auto-renew), HSTS/CSP/security headers, WebSocket reverse-proxying, and auth-endpoint rate limiting. The relay
binds to localhost; **only :443 is public** (SSH key-only and IP-restricted; firewall default-deny inbound).

## Consequences
- **+** TLS at €0 with auto-renewal — no cert ops, no recurring TLS cost.
- **+** Minimal, well-trodden config; security headers and rate limits in one place.
- **+** Smallest public surface (single port), aligning with NFR-SEC-7.
- **−** One more process to run/update on the VPS (cheap at this scale).

## Alternatives considered
- **Nginx + certbot** — rejected: more moving parts (manual cert renewal cron, more verbose config) for no
  benefit here.
- **Cloud load balancer / managed WAF** — rejected: recurring cost and vendor coupling beyond the ceiling and
  the owned ethos.
- **Bun/Elysia terminating TLS directly** — rejected: loses the hardened edge (rate-limit, headers, cert
  automation) and puts cert handling in the app.
