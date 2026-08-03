# Architecture Design Brief

A self-contained **prompt** for designing the target architecture of **football-trackers**. Feed it to
an architect (human or AI, e.g. `/pm:arch-create`). It encodes the ground truth, the drivers, the
constraints, and exactly what to produce — so the output is the *right* architecture, not a generic one.

> Drivers locked with the project owner: **security first, real-time performance second, cost-effectiveness
> third** — under a **dual deployment profile** at **single-session scale**. See [§2](#2-the-three-drivers-in-priority-order)
> and [§3](#3-deployment-profiles-the-defining-constraint).

---

## 0. Role & objective

You are the **lead software and security architect** for a DIY real-time GPS tracking system for **youth
("omladinski") football**. Players are **minors** — this fact dominates the security design.

Design the **target architecture** that satisfies the drivers and constraints below, and produce the
deliverables in [§9](#9-required-deliverables). Do **not** rewrite the system from scratch: the current
implementation works and is verified ([§7](#7-invariants--do-not-break-these)). Design the *evolution* to
the target, calling out MVP vs later.

Justify every load-bearing choice against the three drivers. Show tradeoffs, not just conclusions. Where you
make an assumption, state it. Where a decision is the owner's to make, flag it ([§10](#10-open-questions-to-resolve-or-flag)).

---

## 1. System context (ground truth — do not re-derive)

A complete, verified pipeline already exists. Read these rather than reinventing them:
[`README.md`](../../README.md), [`CLAUDE.md`](../../CLAUDE.md),
[system-architecture.md](system-architecture.md), [observability.md](observability.md),
[non-functional-requirements.md](../requirements/non-functional-requirements.md),
[metric-definitions.md](../requirements/metric-definitions.md).

**The pipeline, one line:** ESP32 + u-blox GNSS wearable streams fixes at **10 Hz** over WiFi → **Mosquitto
MQTT** → **Bun + Elysia** ingest (server-stamps, validates, enriches, persists to **bun:sqlite**, fans out)
→ **React** coach live view over a plain **WebSocket**.

**The bindings that must be respected** (changing either side changes both):
- **Topic:** `football-trackers/session/{sessionId}/player/{playerId}/telemetry` (+ `.../status` health).
- **Packet:** terse JSON `{id, pl, ts, lat, lon, spd, hdg, fix, sats, pdop}`.
- **Two timestamps:** device `ts` (`millis()`) is **ordering only, non-authoritative**; the server stamps
  `serverTs = Date.now()` at ingest — that is the source of truth.

Already built and verified without hardware: firmware (10 Hz + LittleFS backlog + `.../status`), the
Bun/Elysia ingest + WS fan-out + SQLite persist, full observability (Prometheus `/metrics`, JSON logs,
device self-telemetry, SLOs/alerts/runbook), and the React live view (4-corner homography).

---

## 2. The three drivers (in priority order)

1. **Security — "we don't want to get hacked."** Highest priority. For youth football this is not abstract:
   the system handles **real-time location of children**. A leak is a safeguarding incident, not just a data
   breach. All four threat dimensions in [§4](#4-security-requirements-all-four-dimensions) are in scope.
2. **Performance — multi-player real-time.** 10–20 players at 10 Hz, **end-to-end glass-to-glass < 1 s**
   ([NFR-RT-1]). Security controls (TLS, auth) must **not** blow this budget.
3. **Cost-effectiveness.** €0 for local; **€5–20/mo** ceiling for the cloud profile. No per-seat SaaS; stay
   aligned with the "fully owned" ethos ([NFR-OWN-1]) wherever it doesn't fight security or performance.

When two drivers conflict, prefer them in this order — and **say so explicitly** at the decision point.

---

## 3. Deployment profiles (the defining constraint)

The **same codebase** must run in **two profiles**, switched by configuration — **not** a fork:

| | **Profile A — Field-local LAN** | **Profile B — Cloud, single club** |
|---|---|---|
| **Use** | Development + match day on the touchline | Remote access for one club (coach off-site, review later) |
| **Network** | Isolated LAN, **no internet exposure** | Internet-exposed |
| **Host** | Laptop / mini-PC the owner already has | Cheap VPS (~€5–20/mo) **or** modest managed cloud |
| **Cost** | **€0** | €5–20/mo target |
| **Trust boundary** | Physical — everyone on the LAN is trusted-ish | Hostile — anyone on the internet can probe |
| **Must work offline** | **Yes** (no internet on a pitch is normal) | N/A |

**Hard requirement:** Profile A must keep working with **zero internet dependency** (no cloud auth service,
no external TLS CA reachability assumptions at runtime, no SaaS callout in the hot path). The architecture is
**one system with a security/topology switch**, where Profile B *adds* an internet-facing edge (TLS,
reverse proxy, auth, hardening) in front of the same core. Design that seam explicitly: what is shared, what
Profile B layers on, and how a single config flag selects the posture.

---

## 4. Security requirements (all four dimensions)

Treat every item as a requirement to be **mapped to a concrete mitigation and an enforcement point** in the
deliverable threat model. Right-size to the scale ([§5](#5-scale-envelope--design-to-this)) — favour simple,
boring, owned controls over heavyweight infrastructure.

### 4a. Children's location privacy (the #1 risk)
- **Live location of a minor must never be world-readable.** No anonymous WebSocket, no public MQTT, no
  unauthenticated `/metrics` exposure of positions.
- **Lawful basis & consent** (GDPR; UK/EU/Serbia youth context): record parental/guardian consent per player;
  design for it even if the UI comes later.
- **Data minimisation:** collect only what the metrics need; pseudonymise player identity (opaque `playerId`,
  no child names in the wire contract or DB).
- **Retention & erasure:** a defined retention period for raw fixes + an **automatic purge** job, and a
  **right-to-erasure** path (delete one player's history). Retention is also a cost and risk lever.
- **Encryption:** in transit (TLS, Profile B) **and at rest** (DB file / backups) for location data.
- **Audit:** access logging — who viewed which session, when.

### 4b. Authentication & access control
- Define the **principals** (coach? club admin? parent viewing only their own child? — see
  [§10](#10-open-questions-to-resolve-or-flag)) and a **role model**.
- AuthN mechanism appropriate to a hobby/club scale (password + session, magic link, or device token — argue
  the tradeoff; avoid standing up a heavyweight IdP for 10–20 users).
- AuthZ scoped to **session/club**: a coach sees only their session's live view and history.
- No anonymous WS subscribe; no anonymous MQTT. Secrets management for both profiles (where keys live, how
  they're rotated, how Profile A avoids hardcoded shared secrets).

### 4c. Device & MQTT integrity
- **Per-device credentials** (not one shared secret across all 10–20 wearables).
- **Mosquitto ACLs**: each device may publish **only** to its own `.../player/{playerId}/...` topic →
  prevents a compromised/forged device from spoofing another player.
- **Reject spoofed identity:** the server already recovers `session/player` from the *topic*; ensure a device
  cannot publish another player's `playerId`. Reconcile packet `id/pl` vs topic-derived identity.
- **TLS for MQTT** on Profile B (and/or mTLS) — weigh firmware complexity (ESP32 TLS heap/CPU cost at 10 Hz)
  against the threat; this is a real tradeoff to analyse, not a default.
- Rate-limit / sanity-bound per device (a device firehosing or sending absurd coordinates must not harm
  ingest). Note QoS0 publish-before-subscribe semantics already handled by the readiness gate.
- Firmware secret provisioning: how each device gets its credential without baking one secret into a shared
  image.

### 4d. Internet-facing hardening (Profile B)
- **TLS everywhere** at the edge (Let's Encrypt = €0); a reverse proxy terminating TLS in front of the Bun
  server and the broker.
- **Minimal exposed surface:** only the ports that must be public; everything else firewalled.
- **WebSocket origin checks**, security headers, request **rate limiting**, basic DDoS/abuse resistance
  (fail2ban-class), and intrusion basics.
- **Supply chain:** pinned `bun.lockb` / dependency review; the firmware and server build provenance.
- **Encrypted, off-host backups** of the DB (a backup is location data too).
- `/metrics` and `/health` must not leak sensitive data or be open to the internet.

---

## 5. Scale envelope — design to THIS

- **1 session, 10–20 players, 10 Hz** → ~**100–200 msg/s** sustained, a **handful** of coach viewers.
- bun:sqlite (WAL, one prepared insert/packet) is **sufficient** today; keep the [`db.ts`](../../server/src/db.ts)
  seam so TimescaleDB can replace it later **without** touching ingest — but **do not** introduce it now.

**Explicitly do NOT build** (anti-scope — flag if you're tempted):
- No multi-tenant / multi-club infrastructure, no per-tenant isolation layer.
- No horizontal scale, no Kafka/NATS, no Kubernetes, no service mesh, no load balancer farm.
- No microservices split — the in-process ingest+WS design is correct at this scale.
- No managed message bus, no cloud-native data lake.

Over-engineering here is a **failure**, not thoroughness. If a control implies one of the above, find the
right-sized alternative or justify the exception against the drivers.

---

## 6. Performance requirements

- **Glass-to-glass < 1 s** ([NFR-RT-1]); the in-process ingest p99 is already < 50 ms (observability SLOs).
- Quantify a **latency budget table**: fix age + WiFi + broker + TLS handshake/overhead + ingest + WS → < 1 s,
  showing where Profile B's TLS/auth spend their slice and proving they fit.
- **Back-pressure:** define behaviour if a slow/absent consumer or a burst threatens the event loop (drop
  vs buffer vs disconnect) — at 10 Hz × 20 this is small, but state the policy.
- Connection limits and resource ceilings appropriate to a single laptop/VPS.

---

## 7. Invariants — do NOT break these

- **One pipeline, one wire contract** (topic + packet shape) across firmware → broker → server.
- **Two-timestamp design** (device `ts` non-authoritative; `serverTs` authoritative).
- **bun:sqlite now, TimescaleDB-swappable later** via the `db.ts` seam.
- **Native Bun WS pub/sub** for fan-out — **not** socket.io; the client uses a plain `WebSocket`.
- **Self-hosted observability** (Prometheus `/metrics`, JSON logs, device `.../status`) — already in place;
  the architecture must keep it working in both profiles.
- **Field resilience:** LittleFS backlog + replay on reconnect ([NFR-RES-1]) — a dropout loses nothing.
- Stack: **Bun + Elysia** server, **ESP32/Arduino** firmware, **React + Vite** client. Private project; **no**
  coupling to any work platform.

---

## 8. Cost requirements

- **Profile A: €0** — runs on hardware the owner already has.
- **Profile B: €5–20/mo** — cheap VPS or modest managed; **TLS via Let's Encrypt = €0**.
- Quantify the **data-growth cost**: bytes/packet × 100–200 msg/s × session length → DB size/session and
  /month; bandwidth for fan-out; whether retention policy ([§4a](#4a-childrens-location-privacy-the-1-risk))
  keeps storage flat. Show that the design lands inside the ceiling. No per-seat/per-player SaaS.

---

## 9. Required deliverables

Produce a `system-architecture.md` revision (and ADRs) containing:

1. **Context + container diagrams** for **both** profiles (what differs, what's shared).
2. **The A↔B seam**: the config switch, what Profile B layers on (edge/TLS/auth/hardening), how A stays
   internet-free.
3. **Threat model** (STRIDE or equivalent) covering all four dimensions in [§4](#4-security-requirements-all-four-dimensions),
   each threat → mitigation → **enforcement point** → which profile.
4. **Data model + retention/purge + erasure design**, and the **encryption-at-rest** approach.
5. **AuthN/AuthZ design**: principals, roles, login flow, where each check is enforced, secrets handling.
6. **MQTT security design**: per-device credentials, topic ACLs, TLS/mTLS decision with the firmware-cost
   tradeoff spelled out.
7. **Profile B network topology**: reverse proxy, TLS, firewall, open ports, backup path, data residency.
8. **Performance budget table** + back-pressure policy ([§6](#6-performance-requirements)).
9. **Cost model table** for Profile B ([§8](#8-cost-requirements)).
10. **ADRs** for each load-bearing decision (auth mechanism; MQTT TLS vs plaintext+LAN; retention period;
    SQLite→Timescale trigger; reverse-proxy choice). Follow the existing
    [decision log](../decisions/README.md) format.
11. **Evolution plan**: current code → target, **MVP vs later**, no big-bang rewrite. What ships first to make
    Profile B safe to expose.
12. **Anti-scope section**: what is deliberately NOT built ([§5](#5-scale-envelope--design-to-this)) and why.

---

## 10. Open questions to resolve or flag

The architect should resolve these from context where possible, or surface them for the owner:

- **Principals:** coaches only, or do **parents** view (e.g. only their own child)? Parent access materially
  enlarges the privacy/authz model.
- **Retention period** for minors' raw location: per-session-only, N days, or a season? Drives purge, cost,
  and GDPR posture.
- **Data residency** for Profile B (EU region for GDPR)? Which VPS/region.
- **MQTT TLS on-device:** is the ESP32 TLS cost (heap/CPU at 10 Hz, battery) acceptable, or is Profile B's
  broker reachable only via a trusted tunnel/VPN with plaintext MQTT behind it?
- **Identity provisioning:** how devices and coaches receive credentials at this scale without a heavyweight
  system.

---

## 11. Method & quality bar

- **Right-size to [§5](#5-scale-envelope--design-to-this).** Boring, owned, simple beats clever and scalable here.
- **Verify with numbers:** latency slices, DB growth, VPS cost — compute them, don't hand-wave.
- **Map every security requirement** to a concrete mitigation and an enforcement point; no unaddressed items.
- **Make tradeoffs explicit** at each decision, tied to the driver priority in [§2](#2-the-three-drivers-in-priority-order).
- **Preserve the invariants** in [§7](#7-invariants--do-not-break-these); if a requirement forces breaking one,
  raise it as an open question rather than silently breaking it.

<!-- NFR refs: NFR-RT-1 (real-time <1s), NFR-OWN-1 (fully owned), NFR-RES-1 (field resilience) — see
     ../requirements/non-functional-requirements.md -->
