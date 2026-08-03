# ADR-0006 — Local core + cloud relay (devices never face the internet)

**Status:** Accepted (design) · **Implementation:** not yet built · **Date:** 2026-06-14

> Board review 2026-06-14 recommends **overlay-first** (Tailscale/WireGuard) as the default Profile-B increment, deferring this bespoke relay until a non-technical coach needs a browser URL. See [reviews/2026-06-14](../architecture/reviews/2026-06-14-architecture-board-review.md). Decision pending owner input.

## Context
The same system must run **field-local** (dev + match day, offline) **and** give a single club **remote
access** ([brief §3](../architecture/architecture-brief.md#3-deployment-profiles-the-defining-constraint)).
Security is the #1 driver and the data is the **live location of minors**. A field box typically sits behind
NAT with no public IP, and the wearables are ESP32s on the pitch. The naive "run the whole stack on a VPS and
let devices connect in" exposes the broker to the internet and forces TLS onto every wearable.

## Decision
Keep the **entire ingest pipeline on the field box** (broker + Bun server + SQLite) — that box *is* Profile A
and runs with no internet. Profile B adds a small **relay** on a VPS that the field box connects to
**outbound** (mTLS WSS); the relay authenticates remote coaches and re-fans-out the live stream. The switch is
one flag (`RELAY_ENABLED`): **Profile A is Profile B with the relay off.** Raw 10 Hz stays local; the cloud
holds aggregates only.

## Consequences
- **+** Devices never touch the internet → no ESP32 public-broker TLS, no device online attack surface.
- **+** Field box opens **no inbound internet ports** (outbound-only) → zero inbound attack surface on the field.
- **+** On-site coach keeps the **< 1 s** path over the LAN regardless of internet ([NFR-RT-1]).
- **+** Exactly one internet-exposed component (the relay); least raw data at rest in the cloud.
- **−** Profile B has an extra deployable (the relay) and a field→relay link to operate.
- **−** Remote view inherits internet latency (best-effort < 2 s, NFR-RT-2) — acceptable for off-site viewing.

## Alternatives considered
- **Full stack on a VPS; devices dial in** — rejected: broker on the internet, per-device TLS, and on-site
  traffic would round-trip pitch→cloud→pitch, wrecking the local latency.
- **WireGuard tunnel field↔VPS, plaintext behind it** — viable and noted as an alternative to mTLS WSS; heavier
  to run on a field laptop and no real security gain over an outbound mTLS link for this scale.
