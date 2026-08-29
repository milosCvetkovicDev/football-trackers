# Security policy

This is a personal hobby project, maintained by one person. It is also a project whose
subject is **children's real-time location**, so security reports get taken seriously and
answered — there is just no team or SLA behind that promise.

## Reporting a vulnerability

Please use **[GitHub private vulnerability reporting](../../security/advisories/new)**
(Security → Report a vulnerability on this repo). Don't open a public issue for anything
exploitable — the people running this software are coaching youth teams, not watching a
security feed.

## What counts

Anything that would let someone other than the operating coach:

- read a player's position (live over MQTT/WebSocket, at rest in SQLite, or in a backup),
- link a pseudonymous player id to a real name (`roster.json` and its handling),
- authenticate as a coach or a device, or keep a session that policy says should be dead,
- reach the vision web UI's footage or defeat its footage-provenance gate.

## What the threat model already assumes

Deliberate, documented trade-offs are not vulnerabilities on their own — but a way to
*escape* one of these boundaries absolutely is:

- The **dev stack** (`docker-compose.yml`) allows an anonymous *live view* on loopback by
  design; the production stack ([deploy/production/](deploy/production/)) does not.
  `server/test/deploy-posture.ts` pins both postures.
- **TLS** at the field edge is a known, deliberately open item
  ([ADR-0009](docs/decisions/0009-tls-edge-caddy.md)); the field network is designed as an
  isolated, non-internet-routed AP ([ADR-0013](docs/decisions/0013-field-network-security.md)).
- The wire protocol trusts the **broker boundary**: per-device MQTT credentials + ACLs
  ([ADR-0007](docs/decisions/0007-mqtt-security.md)), server-side validation of every field.

## Keys and secrets

No credentials live in this repository (enforced by `.gitignore` + CI guards). If you find
one anyway — in a file *or in git history* — that is a report, please make it privately.
