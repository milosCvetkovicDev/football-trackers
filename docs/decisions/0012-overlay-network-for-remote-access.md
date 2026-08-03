# ADR-0012 — Overlay network (WireGuard/Tailscale) for Profile B remote access

**Status:** Accepted (design) · **Implementation:** not yet built · **Date:** 2026-06-14 · **Amends:** [ADR-0006](0006-local-core-cloud-relay.md)

## Context
[ADR-0006](0006-local-core-cloud-relay.md) kept the pipeline local and added a bespoke cloud **relay**
(field binary `MODE=relay` + a club mTLS CA + Caddy + fail2ban) for remote access. The
[architecture board review (2026-06-14)](../architecture/reviews/2026-06-14-architecture-board-review.md)
challenged that: the relay's entire custom surface exists to achieve three things — field/devices never face
the internet, exactly one authenticated path in, TLS in transit — that an off-the-shelf overlay network
delivers with near-zero owned code and far lower operate-burden. The hardening experts' own findings (mTLS
lifecycle, relay observability, SPOF, deploy drift) are mostly *operational liabilities of the bespoke relay*.
The owner chose overlay-first.

## Decision
Profile B's **first** (and likely only) remote-access increment is an **overlay network** — Tailscale, or
self-hosted **WireGuard/Headscale** for the fully-owned option — joining the field box and the remote coach's
device. The coach reaches the **existing** `/live` (and the future review UI) on the field box over the
tailnet, behind the **same WS auth** ([ADR-0008](0008-authentication-access-control.md)). The field box keeps
no inbound port (the overlay does NAT traversal outbound). The bespoke relay ([ADR-0006](0006-local-core-cloud-relay.md))
is **deferred** — built only if a concrete need appears: *a non-technical coach who cannot install an overlay
client needs a plain browser URL.*

## Consequences
- **+** Same security spine (outbound-only, one authenticated path, WireGuard-grade transport, identity ACLs)
  with essentially no code to own and nothing to harden — no mTLS CA, Caddy, or fail2ban to operate.
- **+** Moots the relay's biggest unbuilt liabilities (cert lifecycle, relay observability, deploy drift) until/unless the trigger fires.
- **−** A dependency on the overlay. Tailscale's coordination plane is third-party (free tier) though the data path is E2E-encrypted P2P with no telemetry through it; **Headscale/self-hosted WireGuard** is the fully-owned alternative ([NFR-OWN-1](../requirements/non-functional-requirements.md)) at a little more setup. Owner picks.
- **−** Remote view stays best-effort (NFR-RT-2); on-site is unaffected.

## Alternatives considered
- **Bespoke `MODE=relay` + Caddy + mTLS CA (ADR-0006)** — deferred, not deleted; the right tool only for the no-client-install browser-URL case.
- **Full stack on a public VPS** — rejected in [ADR-0006](0006-local-core-cloud-relay.md) (puts the broker/devices on the internet).
