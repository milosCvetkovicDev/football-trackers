# Target Architecture — Secure, Dual-Profile

The security-and-deployment design that realises the [architecture brief](architecture-brief.md). It does
**not** replace the logical [system-architecture.md](system-architecture.md) (data flow + layers); it layers
**security, the dual deployment profile, and the evolution plan** on top of that pipeline.

> ⚠️ **Implementation status (2026-06-14): partially built.** The **Minimum Safe Increment** has **shipped and is e2e-verified** —
> WS `/live` auth (token + Origin/CSWSH check + server-authorised session, no more `test` default), per-device MQTT credentials +
> topic ACLs ([`server/mosquitto/`](../../server/mosquitto/)), and the `id_mismatch` reject. **Still to-be-built** (treat as design,
> not present): the remote path (overlay-first, [ADR-0012](../decisions/0012-overlay-network-for-remote-access.md)), retention/purge,
> roster/consent, OS FDE, and the remaining controls below. Build order: the evolution plan (§11). Reviewed by the
> [architecture board (2026-06-14)](reviews/2026-06-14-architecture-board-review.md); field network decided in
> [ADR-0013](../decisions/0013-field-network-security.md). **Hard gate:** do not track real children until the field AP is
> isolated ([ADR-0013](../decisions/0013-field-network-security.md)) and the firmware `WIFI_PASS` placeholder is removed
> (done — secrets now in NVS, [ADR-0014](../decisions/0014-firmware-secret-provisioning.md); flash encryption is the remaining gate item).

**Drivers, in priority order:** ① security (don't get hacked — children's live location is the asset) →
② real-time performance (<1 s on-site) → ③ cost (€0 local, €5–20/mo cloud). Decisions below are justified
against this order; where two conflict, the higher-priority driver wins and the trade is stated.

> **Decisions taken** (owner can override — these resolve the brief's [open questions](architecture-brief.md#10-open-questions-to-resolve-or-flag)):
> | # | Question | Decision (default) |
> |---|---|---|
> | 1 | Principals | **Coach + club admin.** Parent access is **out of MVP** (enlarges authz + consent model). |
> | 2 | Retention of raw minor location | **30 days local, then auto-purge to aggregates** (configurable). |
> | 3 | Data residency (Profile B) | **EU-region VPS** (GDPR). |
> | 4 | MQTT transport security | **Plaintext on an isolated field LAN; broker never internet-facing** (relay design). Device TLS not required. |
> | 5 | Credential provisioning | **Per-device MQTT credential + WiFi PSK in NVS via serial enrollment ([ADR-0014](../decisions/0014-firmware-secret-provisioning.md)); coach accounts issued by admin.** |

---

## 1. The defining decision: local core + cloud relay

The pipeline that produces the live view **always runs on the field box** (broker + Bun server + SQLite).
That box *is* Profile A and runs with **zero internet dependency**. Profile B does **not** move the pipeline
to the cloud — it adds a small **relay** on a VPS that the field box connects to **outbound**, and which
authenticates remote coaches and re-fans-out the live stream. See [ADR-0006](../decisions/0006-local-core-cloud-relay.md).

Why this is the right spine, against all three drivers:

- **Security ①** — Devices never touch the internet (they only reach the *local* broker on an isolated LAN),
  so there is **no ESP32-to-public-broker TLS** to get wrong and no device attack surface online. The field
  box opens **no inbound internet ports** (the relay link is outbound-only), so the field side has **zero
  inbound attack surface**. Exactly **one** component is internet-exposed — the relay — and it is small and
  hardenable.
- **Performance ②** — The on-site coach is served by the **local** server over the LAN, so the **< 1 s**
  budget ([NFR-RT-1]) is met regardless of internet. The internet hop is only on the *remote* path, which is
  explicitly a softer target.
- **Cost ③** — One tiny VPS, aggregates only in the cloud (raw stays local) → smallest instance, least
  data-at-rest to protect and pay for.

It also makes the A↔B switch trivial: **Profile A is Profile B with the relay turned off.**

---

## 2. Context diagrams (both profiles)

**Profile A — field-local (development + match day, offline):**
```
                isolated field LAN — NO internet
  ┌──────────────┐   WiFi / MQTT    ┌─────────────────────────────────┐   LAN WSS   ┌──────────────┐
  │ 10–20        │ ───(plaintext,──▶│  FIELD BOX (laptop / mini-PC)    │ ──(<1 s)──▶ │ on-site coach │
  │ wearables    │   per-device     │  mosquitto + Bun/Elysia + SQLite │             │ tablet (LAN)  │
  │ (ESP32+GNSS) │   creds + ACL)   │  + Prometheus/Grafana (localhost)│             └──────────────┘
  └──────────────┘                  └─────────────────────────────────┘
                                       no inbound ports · raw data local
```

**Profile B — adds the cloud relay (remote access for one club):**
```
  isolated field LAN                    internet (TLS only)                 
  ┌──────────┐  MQTT   ┌───────────┐   outbound mTLS WSS   ┌───────────────────────────┐  WSS/HTTPS  ┌────────────┐
  │ wearables│ ───────▶│ FIELD BOX │ ════════════════════▶│ VPS (EU): Caddy(TLS:443)  │ ◀──────────│ remote     │
  └──────────┘         │ (as above)│   (field dials OUT;   │   → relay (auth + authz   │  login +   │ coach      │
                       └─────┬─────┘    no inbound holes)  │     + rooms + audit)      │  authz     └────────────┘
                             │ also serves on-site         │   → aggregate DB (no raw) │
                             ▼ coach on LAN (<1 s)         └───────────────────────────┘
                       on-site coach                         only :443 public · raw never leaves the field
```

---

## 3. Container view & the A↔B seam

```
 FIELD BOX (same binary in A and B) ───────────────────────────────┐
 │  firmware → [mosquitto]  (per-device creds + topic ACL)          │
 │                 │ plaintext on isolated LAN                       │
 │                 ▼                                                 │
 │            ingest.ts  ─ validate · identity-reconcile · enrich ── │──▶ db.ts (bun:sqlite, raw, FDE volume)
 │                 │                                                 │
 │                 ├──▶ local WS  /live   (on-site coach, <1 s)      │
 │                 ├──▶ metrics.ts /metrics (localhost only)         │
 │                 └──▶ relay-forwarder  ── if RELAY_ENABLED ───────┐│ outbound mTLS WSS
 └──────────────────────────────────────────────────────────────── ││
                                                                    ▼▼
 VPS / RELAY (same codebase, MODE=relay) ──────────────────────────────────┐
 │  Caddy (auto-HTTPS, :443, rate-limit, security headers)                  │
 │     → relay: authN (argon2+session) · authZ (club/session) · rooms       │
 │              · audit log · live re-fan-out · post-session review UI      │
 │     → aggregate DB (per-player/session summaries; NO raw 10 Hz)          │
 └──────────────────────────────────────────────────────────────────────────┘
```

**The seam is one flag.** `RELAY_ENABLED` (with `RELAY_URL` + `RELAY_CLIENT_CERT`):

- **unset → Profile A:** the relay-forwarder never starts; no outbound connection; nothing internet-facing.
  Pure local, offline.
- **set → Profile B:** the same field binary additionally forwards `{event:telemetry}` envelopes outbound to
  the relay. Ingest, local WS, persistence, and metrics are **byte-for-byte identical**. The relay is the
  *same codebase* run with `MODE=relay` — no fork, shared WS-envelope and auth libraries.

---

## 4. Threat model (STRIDE)

Each threat → mitigation → **enforcement point** → profile. Right-sized to 10–20 players / one club
([scale envelope](architecture-brief.md#5-scale-envelope--design-to-this)); no control implies multi-tenant
or cluster infrastructure.

> **Status caveat:** the *Enforced at* column is the **target** enforcement point. The Minimum Safe Increment has shipped (WS
> auth, per-device MQTT creds/ACL, `id_mismatch` reject — e2e-verified); **still not implemented:** DoS sanity-bounds, the remote
> path, retention/erasure, and the audit log. Read those rows as design intent, not current posture (see the banner above).

| STRIDE | Threat | Mitigation | Enforced at | Profile |
|---|---|---|---|---|
| **S**poofing | Forged device publishes **another player's** telemetry | Per-device broker credential + topic ACL (`player/{own}/#` only); server trusts **topic-derived** identity, rejects packet/topic `id` mismatch (`dropped{reason="id_mismatch"}`) | mosquitto ACL + `ingest.ts` | A+B |
| **S** | Attacker impersonates a coach | Password (argon2id) + signed HTTP-only session cookie; no anonymous WS | relay authN | B |
| **S** | Rogue field box connects to relay | **mTLS client cert** provisioned per club | relay TLS | B |
| **T**ampering | MITM on telemetry over the internet | TLS (WSS) on every internet hop; persistent conns (handshake amortised) | Caddy / relay | B |
| **T** | Tamper data at rest | OS full-disk encryption on the field box; encrypted off-host backups; SQLite WAL integrity | field box / VPS | A+B |
| **R**epudiation | "Who viewed this child's location?" | Append-only **audit log** of auth + session-view events | relay | B |
| **I**nfo disclosure | **Children's live location world-readable** (the #1 risk) | No anonymous WS/MQTT anywhere; `/metrics`+`/health` bound to localhost / behind edge; relay requires auth | everywhere | A+B |
| **I** | Eavesdropping in transit | TLS on all internet hops; plaintext only on the isolated field LAN | Caddy / relay | B |
| **I** | DB / backup leak reveals **named** child locations | **Pseudonymous `playerId`** on wire + in DB; name↔id roster kept separate & access-controlled; raw stays local; cloud holds aggregates only; encryption at rest; retention purge | wire contract + db + roster | A+B |
| **D**oS | Device firehose / absurd coordinates | Range/sanity bounds + per-device rate cap (drop + count); `message_size_limit`, `max_inflight` | `ingest.ts` + mosquitto | A+B |
| **D** | Internet flood on the relay | Rate-limit auth endpoints, connection caps, fail2ban; only :443 exposed | Caddy + firewall | B |
| **E**oP | Coach reads **another** session/club | Server-side authZ on **every** WS subscribe and history query — never trust client-claimed session | relay authZ | B |
| **E** | Compromised dependency | Pinned `bun.lock`, minimal deps (zero-dep metrics already), review on bump | build | A+B |

---

## 5. Data model, retention, erasure, encryption

**Identity is pseudonymous by construction.** The wire contract and `telemetry` table carry only an opaque
`playerId` (e.g. `p07`). The `playerId → child name + parental consent` mapping lives in a **separate,
access-controlled roster** (local, encrypted) — so a telemetry-DB leak is *not* a named-child location leak
(data minimisation, [§4a](architecture-brief.md#4a-childrens-location-privacy-the-1-risk)).

| Store | Lives | Contents | Protection |
|---|---|---|---|
| `telemetry` (raw 10 Hz) | **field box only** | pseudonymous fixes | FDE volume; **30-day retention → auto-purge** |
| `session_aggregate` | field box + relay | per-player/session summaries ([metric-definitions](../requirements/metric-definitions.md)) | FDE / TLS; long-lived |
| `roster` | field box only | `playerId → name`, consent record, erasure flag | separate encrypted file, access-controlled |
| `audit_log` | relay | who viewed which session, when | append-only |

- **Retention & purge:** a scheduled job deletes raw fixes older than `RETENTION_DAYS` (default 30), leaving
  aggregates. Bounds storage *and* breach blast-radius. See [ADR-0010](../decisions/0010-location-data-retention.md).
  *Shipped 2026-06-14* — hourly batched sweep in [`server/src/retention.ts`](../../server/src/retention.ts),
  self-reporting via `ft_oldest_raw_fix_age_seconds` + sweep liveness/failure metrics.
- **Right to erasure:** a `purge-player <playerId>` operation removes raw + aggregates + roster + the cloud
  aggregate copy for that player. *Shipped 2026-06-14 (raw only):*
  [`server/purge-player.ts`](../../server/purge-player.ts) erases the raw `telemetry` rows with `secure_delete`
  byte-zeroing; aggregates/roster/cloud copies don't exist yet, so the CLI is extended when they do.
- **Encryption at rest:** OS full-disk encryption (FileVault/LUKS) on the field box and VPS — the pragmatic,
  €0, owned control. `bun:sqlite` has no native page encryption; **SQLCipher** is noted as a future option if
  FDE is insufficient. Backups are `age`/gpg-encrypted before leaving the host.
- **Encryption in transit:** TLS on every internet hop; plaintext MQTT only on the isolated field LAN.

---

## 6. AuthN / AuthZ

- **Principals:** `admin` (club), `coach`. **Parents are out of MVP** — per-child parent views need per-player
  ACLs and stricter consent; flagged for a later phase.
- **AuthN (humans):** username + **argon2id** password, HTTP-only/Secure/SameSite session cookie, CSRF tokens
  on state-changing routes. A full OAuth/IdP for ~20 users is over-engineering
  ([§5](architecture-brief.md#5-scale-envelope--design-to-this)); optional TOTP for `admin`. See
  [ADR-0008](../decisions/0008-authentication-access-control.md).
- **AuthN (machine):** field box ↔ relay is **mTLS** (client cert = club identity), not a human password.
- **AuthZ:** roles `{admin, coach}`; a coach is scoped to assigned sessions. **Every** relay WS-subscribe and
  every history/aggregate query is checked **server-side** against the authenticated principal — the client's
  claimed `sessionId` is never trusted. On the isolated-LAN local view, the same auth path applies with a
  single default coach account (a fully-open local view is acceptable *only* on a physically controlled LAN —
  stated, not assumed).
- **Secrets:** relay holds password hashes + the mTLS CA; field box holds its client cert + per-device MQTT
  creds; firmware carries only its **own** device credential, in **NVS**
  ([ADR-0014](../decisions/0014-firmware-secret-provisioning.md)). All via env/secret files (server side) or
  NVS (firmware) — never committed.

---

## 7. MQTT security

- **Per-device credentials** (username/password or client cert) — **no shared secret** across wearables;
  provisioned into **NVS** via a serial enrollment console, not baked into source
  ([ADR-0014](../decisions/0014-firmware-secret-provisioning.md)); the MQTT username **is** the `PLAYER_ID`.
- **Topic ACLs (mosquitto):** device `p07` may publish **only** to `football-trackers/session/+/player/p07/#`
  and subscribe only to its own `/cmd`. A forged/compromised device therefore **cannot** spoof another player.
- **Server identity reconciliation** *(to build):* `ingest.ts` recovers `session`/`player` from the *topic*
  today, but does **not** yet compare them to the packet body. Make the topic authoritative and **reject**
  packets whose body `pl`/`id` disagree (new counted drop reason `id_mismatch`).
- **Transport:** plaintext on the isolated field LAN is acceptable (LAN trust boundary; devices can't reach
  the internet); the broker is **never** internet-facing. Broker TLS (server cert or PSK) is an *optional*
  add-on only if the field LAN is shared/untrusted. This is the decision that **avoids ESP32 TLS cost** —
  see [ADR-0007](../decisions/0007-mqtt-security.md).
- **Abuse bounds:** `ingest.ts` drops out-of-range lat/lon and absurd speeds and caps per-device rate; broker
  sets `message_size_limit` and `max_inflight_messages`.

---

## 8. Profile B network topology

```
 internet ──▶ :443 (HTTPS/WSS)  ──▶ Caddy ──▶ relay (localhost)
              :22  (SSH, key-only, IP-allowlist/VPN)
              everything else: default-deny (ufw/nftables)
 field box ──▶ outbound mTLS WSS to wss://relay.<club>/ingest   (no inbound port on field side)
 coach     ──▶ https://relay.<club> → login → WSS /live
```

- **VPS:** single small EU instance (~1 vCPU / 1–2 GB), GDPR data residency.
- **Edge:** **Caddy** — automatic HTTPS via Let's Encrypt (€0), HSTS/CSP/security headers, auth-endpoint rate
  limiting, WS origin checks. See [ADR-0009](../decisions/0009-tls-edge-caddy.md).
- **Exposure:** **only :443 public**; SSH key-only and IP-restricted; firewall default-deny inbound.
- **`/metrics` & `/health`:** localhost-bound (Prometheus scrapes locally); never serve positions on a public
  endpoint.
- **Backups:** nightly `age`-encrypted aggregate dump off-host; field-box raw DB backed up encrypted locally.
- **Hardening:** fail2ban on SSH + Caddy; minimal package surface; unattended security updates.

---

## 9. Performance budget

**On-site live path (Profile A — the < 1 s SLO, [NFR-RT-1]):**

| Hop | Typical |
|---|---|
| GNSS fix age (10 Hz, autoPVT) | 50–100 ms |
| WiFi device → AP → broker | 5–20 ms |
| mosquitto (QoS0) | < 5 ms |
| ingest (validate+enrich+persist+publish; measured p99 < 50 ms) | 5–50 ms |
| local WS fan-out → canvas render | 5–20 ms |
| **Total on-site** | **~70–195 ms ≪ 1 s** (TLS/auth not on this LAN path) |

**Remote path (Profile B — best-effort, proposed target < 2 s):** local pipeline (~100 ms) + field→relay
outbound WSS (internet RTT ~20–100 ms) + relay fan-out + coach internet RTT (~20–100 ms) → typically
**~300–700 ms**. **TLS does not blow the budget**: connections are persistent, so the handshake is one-time
and per-message cost is just symmetric crypto.

**Back-pressure:** 200 msg/s is trivial. Policy = **latest-wins, fire-and-forget** (QoS0 / [NFR-RES-2] — a
dropped 10 Hz frame is invisible): per-client outbound queue is bounded; if a remote socket saturates, drop
its stale frames (never block the event loop or other clients) and disconnect if it stays saturated. The
relay applies the same drop policy.

---

## 10. Cost model (Profile B)

| Item | Cost |
|---|---|
| VPS (small EU instance) | €5–20/mo |
| TLS (Let's Encrypt) | €0 |
| Domain | ~€1/mo (~€10/yr) |
| Encrypted backups / object storage (aggregates) | €0–2/mo |
| **Total** | **~€6–22/mo — inside the ceiling** |

**Data growth:** packet ≈ 120 B. Raw = up to 200 msg/s × 5400 s ≈ **~70–200 MB per 90-min session**, **local
only**; 30-day retention at a few sessions/week stays ~1–2 GB on the field box. The cloud stores **aggregates
only** — a few KB/player/session → MBs per season → fits the smallest VPS disk. No per-seat/per-player cost.

---

## 11. Evolution plan (MVP vs later — no big-bang)

Ordered so each phase makes the *next* exposure safe:

- **Phase 0 — done:** local pipeline + observability (verified, no hardware).
- **Phase 1 — local hardening (safe Profile A):** ✅ per-device MQTT creds + topic ACLs, ✅ server `id_mismatch`
  reconcile, ✅ WS `/live` auth (token + Origin + server-authorised session) — all shipped & e2e-verified
  2026-06-14; pseudonymous `playerId` confirmed. ✅ firmware secrets (WiFi PSK + per-device MQTT creds) moved
  to NVS via a serial enrollment console ([ADR-0014](../decisions/0014-firmware-secret-provisioning.md)) — the
  `WIFI_PASS` placeholder is gone (firmware pending hardware flash). **Still to do:** dedicated isolated AP
  ([ADR-0013](../decisions/0013-field-network-security.md)), OS FDE on the field box, retention/purge job,
  named local coach login.
- **Phase 2 — remote access, overlay-first ([ADR-0012](../decisions/0012-overlay-network-for-remote-access.md)):**
  field box + remote coach on a WireGuard/Tailscale tailnet; coach reaches the existing `/live` (+ future review)
  behind the same WS auth. The bespoke `MODE=relay` + Caddy + mTLS path is **deferred** (built only if a
  no-client-install browser URL is needed; then it needs relay observability, cert lifecycle, audit log, encrypted backups).
- **Phase 3 — privacy/ops polish:** consent records + `purge-player` erasure tooling; aggregate-only cloud
  persistence; auth-anomaly alerts; optional SQLCipher / broker TLS if the LAN is untrusted.
- **Later — only if triggered:** TimescaleDB swap via the `db.ts` seam ([ADR-0011](../decisions/0011-persistence-engine-threshold.md));
  trigger = sustained throughput or session/club count beyond the current envelope (none of which exists now).

---

## 12. Anti-scope (deliberately NOT built)

Per the [scale envelope](architecture-brief.md#5-scale-envelope--design-to-this) — building any of these here
would be a failure, not thoroughness:

- No multi-tenant / multi-club infrastructure, no tenant isolation layer.
- No horizontal scale, Kafka/NATS, Kubernetes, service mesh, or load-balancer farm.
- No microservices split (in-process ingest+WS is correct at this scale).
- No managed message bus / cloud-native data lake.
- No heavyweight IdP/OAuth for ~20 users; no per-seat SaaS.
- No **parent-facing** access in MVP (deferred — enlarges authz + consent).
- No **device-to-internet TLS** (the relay design removes the need); no custom CA beyond a simple club mTLS pair.

---

## Proposed NFR additions

These security NFRs are introduced by this design and should be folded into
[non-functional-requirements.md](../requirements/non-functional-requirements.md):

| ID | Requirement | Target |
|---|---|---|
| NFR-SEC-1 | No anonymous access to location data | enforced at broker, local WS, and relay |
| NFR-SEC-2 | Per-device identity + topic ACL; reject spoofed `playerId` | mosquitto ACL + `ingest.ts` |
| NFR-SEC-3 | TLS on every internet hop | Caddy + mTLS field↔relay |
| NFR-SEC-4 | Encryption at rest for location data | OS FDE (SQLCipher later) |
| NFR-SEC-5 | Retention limit + right-to-erasure for minors' data | 30-day purge + `purge-player` |
| NFR-SEC-6 | Audit log of location-data access | relay append-only log |
| NFR-SEC-7 | Field box exposes no inbound internet port | outbound-only relay link |
| NFR-RT-2 | Remote (off-site) live view | best-effort < 2 s (softer than NFR-RT-1) |

---

*References: [architecture brief](architecture-brief.md) · [system-architecture.md](system-architecture.md) ·
[observability.md](observability.md) · [ADR-0006–0014](../decisions/README.md). NFR codes per
[non-functional-requirements.md](../requirements/non-functional-requirements.md).*
