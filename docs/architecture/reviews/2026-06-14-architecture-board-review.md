# Architecture Board Review — 2026-06-14

**Subject:** [target-architecture.md](../target-architecture.md) + [ADR-0006–0011](../../decisions/README.md) (and the [architecture-brief.md](../architecture-brief.md) they realise).
**Method:** six independent senior experts reviewed in parallel, **against the docs and the running code**; a chair adjudicated conflicts using the project's driver priority (**security > performance > cost**) at the fixed small scale.
**Board verdict: APPROVE WITH CHANGES** (unanimous — all six experts independently).

## Panel
Security architect & threat-modeller · Privacy/GDPR & child-safeguarding · Real-time & distributed systems · Embedded/IoT firmware (ESP32) · Cloud/SRE/cost & operations · Pragmatist staff engineer (YAGNI).

## Verdict rationale
The **spine is correct and must not be reopened**: local-core + outbound-only relay, raw 10 Hz stays on the LAN, aggregates-only in the cloud, devices never touch the internet, one internet-exposed component, single `RELAY_ENABLED` flag. It is **not** a plain "approve" because of one finding every expert reached independently: **the threat model is documentation-only and the running code contradicts its central claims** — today a child's live cm-accurate position is readable by anyone who can reach the port on the field LAN. It is **not** "needs-rework" because no spine redesign is required — the gap is a bounded build checklist plus a few doc-honesty fixes, cheap now and expensive after a quiet failure.

## Affirmed — do not reopen
- The spine (above) — the right answer for the #1 driver at this scale.
- Pseudonymous `playerId` + separate roster (matches the code) — *defence-in-depth, not anonymisation*.
- 30-day retention / aggregates-only-in-cloud (ADR-0010).
- Right-sizing: argon2+session over an IdP; bun:sqlite over Timescale (ADR-0011); plaintext-MQTT-on-isolated-LAN over ESP32 TLS (ADR-0007); the explicit anti-scope.
- Latency/observability honesty; the cost ceiling **holds** — the SRE re-checked the egress (~45 KB/s per remote coach) and confirmed **~€6–22/mo**.

## Top risks (ranked)
| # | Severity | Risk | Raised by |
|---|---|---|---|
| 1 | **critical** | Design-vs-code gap: enforcement controls don't exist, so children's live location is readable by anyone on the field LAN **today** (`/live` no auth, defaults `sessionId=test`; firmware MQTT no creds; no ACL) | Security, Privacy, Pragmatist, Real-time, SRE |
| 2 | **critical** | No lawful basis / verifiable parental consent and no DPIA before tracking real children (consent mis-placed in Phase 3) | Privacy |
| 3 | high | Replayed LittleFS backlog gets a fresh `serverTs` and is rendered as a **live** position (stale child shown at full opacity after any WiFi blip) — violates NFR-RES-1 | Real-time |
| 4 | high | Relay (the only internet-exposed component) has **no observability, no restore-tested recovery, unacknowledged SPOF**; audit_log lives only on the VPS | SRE, Real-time |
| 5 | high | mTLS/secret **lifecycle**: provisioning but no rotation/revocation/expiry monitoring; lost-wearable leaks the shared WiFi PSK + its MQTT cred | SRE, Security, Firmware |
| 6 | high | Erasure/retention/minimisation gaps: `purge-player` misses backups, audit_log, Prometheus series; purge/FDE are fire-and-forget; `/metrics` on the public listener leaks per-child presence | Privacy, SRE, Security |
| 7 | medium | Relay-forwarder shares the on-site event loop (can regress the <1s path); one "drop-stale" policy wrongly covers the completeness-critical review path | Real-time |
| 8 | medium | No firmware OTA/patch path; no coach off-boarding / anti-stalking control (departing coach access undefined) | Firmware, Privacy |

## Adjudicated conflicts
1. **Bespoke relay vs an overlay network (Tailscale/WireGuard)** → decided **for overlay-first**, decisively. The custom Profile-B surface (relay-forwarder + `MODE=relay` + a club mTLS CA to mint/rotate + Caddy + fail2ban + ufw) exists to achieve three things an overlay delivers with near-zero owned code and far lower operate-burden: field/devices never face the internet, exactly one authenticated path in, TLS in transit. **Ruling:** make the *first* Profile-B increment "field box + remote coach on a tailnet, coach reaches the existing `/live` behind the same login"; keep the bespoke relay documented as a deferred upgrade triggered **only** by "a non-technical coach who can't install an overlay client needs a plain browser URL." This moots several other findings (relay observability, cert lifecycle, deploy-drift) unless that trigger fires. *Gated on an owner decision.*
2. **More controls vs YAGNI** → **split by control**: **CUT** TOTP from MVP; **scope down** CSRF to real state-changing forms (the receive-only live view is covered by SameSite + Origin check); **KEEP** the audit log but reframed as a **safeguarding/anti-stalking** accountability control (not SaaS ceremony); **AFFIRM** Origin/CSWSH check + server-authorised `sessionId` + replay/skew bounds + per-account brute-force lockout for any human-facing path — YAGNI does not reach these because the asset is children's location.
3. **ADR ceremony vs stale docs** → **agreement, not conflict**: keep the ADRs (each is load-bearing) but add a STATUS line, add a blunt "current state vs target" banner, fix factual drift (`bun.lock` not `bun.lockb`; re-label "already"/"reuses existing" as "to be added"), and collapse the parallel NFR-SEC scheme into the existing NFR table.
4. **Escalate plaintext-MQTT / sqlite / parents-out?** → **hold the line**, with a condition: the calls are correctly right-sized and must **not** be escalated absent their named triggers — but the plaintext-MQTT trade is **contingent** on the match-day AP being genuinely dedicated/isolated **and** on the must-fix auth controls shipping, so the LAN boundary is defence-in-depth, not the sole defence.

## Prioritized actions

**Must-fix before Profile B (and before real children on any non-isolated network):**
1. **Minimum Safe Increment** — auth on the `/live` subscribe (shared bearer token min; **server-authorised `sessionId`**, never trust the query param; remove the `test` default) + **Origin allow-list** on the WS upgrade (closes CSWSH); per-device MQTT username/password (or client cert) + a mosquitto `acl_file`/`password_file` with `allow_anonymous false` + per-device publish-only scoping; the **`id_mismatch` reject** in `ingest.ts` (~5 lines).
2. **Lawful basis + signed parental consent** (paper/PDF is sufficient; no code) + a short 2–3 page **DPIA** referencing the STRIDE table; provisioning **refuses** a `playerId` with no recorded consent.
3. Remove the committed `WIFI_PASS="changeme"`; move WiFi PSK + per-device MQTT creds into **ESP32 NVS**; handle MQTT auth-failure (state 4/5) distinctly.
4. Fix the **replayed-backlog-shown-as-live** bug (tag replayed packets `bk:1` and skip them in the live view, or back-date an approximate capture time).
5. **Doc-honesty** — STATUS lines + "current state vs target" banner; fix `bun.lock`; re-label overstated enforcement claims. *(Applied 2026-06-14 — see below.)*
6. **Re-sequence Profile B overlay-first** *(pending owner decision)*.

**Should-fix:**
- *(if the bespoke relay is built)* relay `/metrics` scraped over the outbound link; full mTLS cert lifecycle (CA key off the relay; monitored `cert_not_after`; one-command re-issue; fingerprint allow-list for revocation); idempotent VPS rebuild script + monthly restore-check; ship the audit_log back to the field box; pinned compose + wire-contract version check.
- Self-reporting safeguarding controls (`oldest_raw_fix_age_days`, `fde_enabled`, fail2ban/unattended-upgrades); ingest lat/lon/speed bounds + per-(session,player) rate cap; bind `/metrics`+`/health` to `127.0.0.1` on a separate port (+ a test).
- Complete the erasure design (every store holding `playerId`, incl. backups/audit_log/Prometheus) + the cross-host purge protocol; coach off-boarding + named local login when real children are tracked.
- Non-blocking bounded forwarder + **split back-pressure** (live = drop-stale; aggregate/review = at-least-once idempotent); add jitter to the client's 1 s WS retry.

**Nice-to-have:**
- Add the missing STRIDE rows (relay compromise; lost wearable; unpatchable firmware; CSWSH; replay/fixation/brute-force); pin firmware library versions; re-ground ADR-0007's TLS justification on the relay design (not heap cost); document a USB-only patch path; collapse NFR-SEC codes into the NFR table.
- Resolve jurisdiction & controller/processor roles + a minimal breach-response runbook.

## Owner decisions the board needs
1. **Is the match-day AP genuinely dedicated and isolated (client isolation on)?** Decides whether broker TLS-PSK is "optional upgrade" or "required".
2. **Will a remote coach realistically refuse to install a Tailscale/WireGuard client?** If not, the bespoke relay + Caddy + mTLS-CA isn't built — overlay-first is the board's default.
3. **Is Profile B actually going to be deployed, or speculative?** If speculative, keep Phase 2 paper-only and spend everything on making Profile A safe.
4. **Who is the data controller (club vs you), and are the children Serbian/in Serbia?** Determines the regulator (Poverenik vs an EU DPA), a possible unmanaged Serbia→EU transfer, and who owes parents the transparency notice. The household exemption does not apply to non-family minors.
5. **Commit to DPIA + parental consent as hard gates** before first real-child capture? And what purpose needs **30 days of raw** fixes (vs aggregates)?
6. **Firmware ops stance:** USB-only re-flash vs LAN-restricted signed OTA; ESP32 flash encryption once creds live in NVS; the lost-wearable playbook (rotate shared AP PSK + revoke that device's MQTT cred).

---
*This record summarises the chair's synthesis of six independent expert reviews. The full per-expert findings are in the board workflow transcript. Doc-honesty corrections from must-fix #5 were applied to [target-architecture.md](../target-architecture.md) and ADR-0006–0011 on 2026-06-14.*
