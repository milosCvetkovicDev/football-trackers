---
name: production-readiness-audit
description: Severity-ranked production-readiness audit of firmware/server/client/vision/infra, with a phased hardening roadmap
status: awaiting-approval
created: 2026-08-03T08:34:07Z
updated: 2026-08-03T08:34:07Z
---

# Production-Readiness Audit — football-trackers

**Date:** 2026-08-03 · **Scope:** `firmware/`, `server/`, `client/`, `vision/`, infra & delivery, cross-cutting quality
**Scale assumed:** ~20 devices, ~100 msg/s, one host, one operator. **This system tracks children — privacy outranks everything.**

---

## 1. Executive summary

The engineering quality here is genuinely high. Auth hardening, DoS bounds, privacy-by-design in the
data model, the WS frame validator, the accessibility mirror, and the 23-ADR decision log are all
better than most production systems. **The test suites are not just present, they all pass** (§2).

The gap is not code quality — it is that **the safety net is not connected to anything**. The repo is
not under version control, so no CI has ever run; the well-built `client-ci.yml` is inert. And the
single deployable artifact that exists — the dev Docker stack — publishes children's live positions
and names to the entire LAN.

Three themes are severe enough to state plainly:

1. **Children's names and live positions are readable by any host on the LAN, unauthenticated.**
   Proven live against the running stack (§4.1). A bare `curl` with *no headers at all* returns a
   child's `displayName`; forging one `Origin` header streams live coordinates.
2. **The firmware's outage backlog loses ~99% of what it exists to save.** The blocking reconnect
   starves the 10 Hz GPS loop, so a 4-minute dropout preserves ~16 of ~2,400 fixes (§4.2).
3. **Right-to-erasure is broken five separate ways** (§4.5) — the most carefully-built subsystem in
   the repo is the least functional. Every defect was reproduced by execution, not inferred. In its
  worst form the CLI prints a success receipt while the child's data remains fully recoverable.

Nothing here requires new infrastructure. Every fix is small, local, and in keeping with the
zero-dependency ethos — the largest single change proposed is ~30 lines.

### Severity distribution

| | Count | Meaning |
|---|---|---|
| **P0** | 9 | Child-privacy exposure, silent data loss, or security bypass |
| **P1** | 20 | Match-day failure an operator would actually hit |
| **P2** | 32 | Compounding operational debt |
| **P3** | 2 | Polish |

---

## 2. Baseline — what passes today

Everything that can be executed was executed. **No pre-existing test failures.**

| Gate | Command | Result |
|---|---|---|
| Server typecheck | `bunx tsc -p tsconfig.json --noEmit` | **PASS** (clean) |
| Server suites | all 20 in `server/test/` | **20/20 PASS** |
| Client typecheck | `bun run typecheck` | **PASS** |
| Client lint | `bun run lint` | **PASS** |
| Client unit | `bun test` | **32/32 PASS** |
| Vision | `docker compose run --rm test` | **101/101 PASS** |
| Firmware | `pio run` | **SUCCESS** — RAM 14.9%, Flash **71.9%** (943 KB) |
| Client e2e | `bunx playwright test` | **COULD NOT RUN** — see below |

Two honest caveats:

- **Playwright could not run.** `playwright.config.ts` hardcodes `SERVER_PORT = 3000` with no env
  override, and port 3000 was held by an unrelated local service. The acceptance gate cannot run on
  any machine where anything else uses 3000. *(New finding — P3, §6.)*
- **The six "unreachable" server suites all pass.** `auth-cli`, `auth-dos`, `auth-loader`, `events`,
  `events-e2e`, `scan-load` have no `package.json` script, so nothing but a human who remembers them
  will ever run them. They are healthy; they are simply unwired.

Flash headroom note: at 943 KB the image fits comfortably in a 1.25 MB OTA slot, so the OTA
recommendation (§5, F-4) is feasible with ~28% headroom.

---

## 3. Method

Findings were produced by one pass and **independently verified by a different pass** (maker ≠
checker), with verifiers instructed to *refute* by default and to correct line numbers against the
code as it exists today. 55 claims were adjudicated: **43 confirmed, 12 partially confirmed**.

Verifiers also **rejected** several plausible-sounding claims, which is why the list below is shorter
than the raw survey:

- *"No graceful shutdown means data loss"* — **measured false.** 33 rows persisted, `kill -TERM`,
  reopened read-only: still 33 rows. WAL survives process death. The real cost is a stall and
  abrupt socket drops, not lost telemetry. Ranked P2, not P0.
- *"Per-player metric series are never removed"* — true but a **documented, deliberate** residual
  (`purge-player.ts`, `observability.md`). Not a bug.
- *"The captive-portal password is fixed"* — true but an **accepted ADR-0022 decision**. Not re-litigated.
- *"A naive `git add .` would commit `.venv`, model weights, footage"* — **false.** The existing
  per-directory `.gitignore`s handle all of it correctly.

Two further passes ignored the claim list entirely and hunted independently — a **child-privacy lens**
(tracing every path by which a child's identity, location or image can leave the intended boundary) and
a **completeness critic** (deliberately looking where the survey had not: the root-level CLIs,
cross-boundary failure semantics, retention/erasure interaction with a live match, resource exhaustion).
Between them they found the entire §4.5 erasure cluster, which the structured survey missed completely —
the strongest argument for not letting the finder be the checker.

Where a claim could be tested against running software, it was. §4 marks these **[PROVEN LIVE]**;
every §4.5 defect was reproduced with the real CLI in a scratch directory. The user's own
`telemetry.db` was never modified — the nine synthetic rows injected during live probing were deleted,
verified 0 remaining.

---

## 4. P0 findings

### 4.1 Children's names and live positions are LAN-readable, unauthenticated **[PROVEN LIVE]**

**Where:** `docker-compose.yml:54-56`, `server/src/server.ts:76-89`, `server/src/auth.ts:411-412`

The dev stack binds `0.0.0.0:3007` with `ALLOW_ANONYMOUS_LIVE=true`. `ANON_MODE` short-circuits
`currentPrincipal` before any cookie check, so the only gate is an Origin comparison — and Origin is
a header the browser enforces, not the server. Two independent bypasses, both demonstrated against
the running stack:

```
curl (no Origin at all)          -> 200  {"displayName":"CANARY-CHILD-NAME"}
curl -H 'Origin: http://evil...' -> 403  {"error":"forbidden_origin"}
WebSocket, forged Origin         -> ACCEPTED, 4 live frames with real lat/lon
WebSocket, no Origin             -> 1008 forbidden origin
```

The gate is **inverted in effect**: `originOkLenient` (`server.ts:87-89`) is `!origin || allowed.includes(origin)`,
so *absent* is treated as *trusted* — and absent is exactly what every non-browser client sends by
default. It blocks the hard attack (a browser) and waves through the easy one (a script). `/sessions`,
`/roster`, `/config`, `/history` and `/auth/me` all answer a bare `curl`; `/auth/me` reports
`"authenticated":true`.

This is not the ADR-0007 plaintext-on-isolated-LAN trade: the bench runbook (`local-bench-runbook.md:122`)
instructs the operator to *disable* Wi-Fi client isolation so the wearable can reach the broker — which
is ADR-0013's escalation trigger #2 verbatim. And `restart: unless-stopped` means this survives reboots.

**Failure:** during an outdoor bench run, any device on the home Wi-Fi — a guest phone, a neighbour
with the PSK, a compromised IoT bulb — scans the subnet and retrieves a named child's full location
history and a live 10 Hz feed. Every request logs as an ordinary read, indistinguishable from the coach's tablet.

**Fix (~12 lines):** bind `127.0.0.1:3007:3000` (the Vite proxy is the only consumer), and make the
invariant structural in `server.ts` — `const PUBLIC_HOST = process.env.PUBLIC_HOST ?? (ANON_MODE ? '127.0.0.1' : '0.0.0.0')`.
Origin checks are CSWSH defence; they must never carry authorization weight.

**Verify:** `test -z "$(lsof -nP -iTCP:3007 -sTCP:LISTEN | grep -v 127.0.0.1)"`

---

### 4.2 The firmware backlog loses ~99% of an outage — the opposite of its purpose

**Where:** `firmware/src/main.cpp:121,126-129,161,568,573`

`wifiEnsure()` busy-waits `delay(150)` + up to 15,000 ms (`while … delay(250)`), and is re-entered from
`mqttEnsure()` on **every** `loop()` pass while down. `gnss.getPVT()` is only reached *after* that block.
Two compounding causes: the 256-byte UART ring saturates in 0.256 s at 10 Hz (1 KB/s), and the SparkFun
driver retains only the newest NAV-PVT — so even with an infinite buffer the loop can stash at most one
fix per pass.

**Measured:** ~15.15 s per attempt, during which the GPS produces ~151 fixes and the code stores **1**.
That is **99.3% loss**. A `.local` broker adds a further 2 s block; a blackholed broker adds up to 15 s more.

This directly contradicts `main.cpp:6-8` ("a dropout on the field never loses the session") and ADR-0003.

**Three defects interlock, and fixing one alone makes things worse:**

1. The blocking reconnect (above) means the backlog rarely fills.
2. The 256 KB cap holds only ~197 s and **drops the newest** fix, not the oldest.
3. **The server's own rate limiter would reject a working replay:** `INGEST_RATE_CAP=15/s` vs an
   unpaced flush of ~1,971 lines in ~1 s → ~97% dropped as `reason="rate"`. Currently *masked*
   because the backlog is always tiny.

**Fix (~25 lines firmware + ~4 server):** convert `wifiEnsure`/`mqttEnsure` to a `millis()` state
machine (no blocking waits); drain with `while (gnss.getPVT())`; `Serial2.setRxBufferSize(1024)`;
pace the flush to ~40 packets/pass; drop-oldest rotation; raise `INGEST_RATE_CAP` to 60 with burst 120
(still 6× nominal, still bounded).

**Verify:** cut the AP for 60 s, then assert the device's `stash` counter advanced ≥550 (today: ~4).

---

### 4.3 The vision web UI accepts children's footage, contradicting ADR-0023's hard gate

**Where:** `vision/webui/runner.py:23,37-40`, `vision/webui/index.html:74-81`

ADR-0023 §2 is unambiguous — *"No youth footage in any phase"* — with the real-youth gate deferred to a
future ADR requiring a DPIA, verified parental consent, and a documented lawful basis. Yet
`ATTEST_KINDS = {"public_adult", "consented_youth"}` and the UI offers *"Dečji — imam saglasnost roditelja"*.

The mechanism is worse than "a checkbox unlocks it": `attest_kind` is a **pure ledger string with zero
downstream effect**. It is recorded and never read again — download, decode, detect, annotate, write and
serve behave identically. No consent evidence, controller, lawful basis or retention date is captured, so
it cannot even discharge GDPR Art. 7(1) demonstrability. `consented_youth` appears in exactly two places
in the repo and is authorised by no ADR; the web UI itself is absent from ADR-0023 entirely.

Combined with §4.4 (no retention) and the unauthenticated `0.0.0.0:8077` bind, this is a live egress
path for face-bearing derivatives that ADR-0023 §14 explicitly places under no-egress rules.

**Fix (~20 lines):** `ATTEST_KINDS = {"public_adult"}`; delete the UI selector; reword the refusal; add a
test asserting the youth path is refused. If youth footage is ever genuinely wanted, it returns through
the §14 ADR — not through `runner.py`.

**Verify:** `! grep -rn 'consented_youth' vision/webui/ vision/README.md`

---

### 4.4 Committing the repo would write children's names into git history permanently

**Where:** no root `.gitignore`; `server/.gitignore` covers only `node_modules/` and `*.db*`

Four sensitive runtime files are unignored by anything in the repo:

| File | Contents |
|---|---|
| **`server/roster.json`** | **plaintext playerId → child's full name** (`roster.ts:5-9`: *"THIS IS THE ONLY PLACE PLAYER NAMES LIVE AT REST"*) |
| `server/auth-accounts.json` | coaches' argon2id hashes + session assignments |
| `server/mosquitto/ft.passwd` | broker password hashes |
| `server/session-config.json` | per-session config |

None exist *yet* — the exposure materialises the moment the operator provisions for the first real
match, which is precisely when `git init` is planned. `git rm` does not remove data from history.
`.claude/settings.local.json` is protected only by the user's machine-global ignore file, not the repo.

**Separately — a subtle bug that silently breaks model integrity [PROVEN LIVE]:** `vision/.gitignore`
excludes `models/` and then tries `!models/MANIFEST.json`. Git **cannot re-include a file whose parent
directory is excluded**, so the SHA-256 weight-integrity manifest — the anchor for `resolve_weight`'s
verification — would not be committed at all. Verified empirically, including the fix:

```
models/  + !models/MANIFEST.json  ->  MANIFEST.json IGNORED   (integrity pin lost)
models/* + !models/MANIFEST.json  ->  MANIFEST.json STAGED, *.pt still ignored
```

**Fix (~10 lines, must land BEFORE `git init`):** root `.gitignore` with `roster.json`,
`auth-accounts.json`, `session-config.json`, `*.passwd`, `.env*`, `.DS_Store`,
`.claude/settings.local.json`; change `models/` → `models/*`; add a ~6-line
`server/test/gitignore-guard.ts` that shells `git check-ignore -q` for each sensitive path.

---

### 4.5 Right-to-erasure is broken five separate ways **[ALL REPRODUCED BY EXECUTION]**

This is the most important cluster in the audit. `purge-player.ts` is thoughtfully built — receipts,
exit codes, `secure_delete`, a documented retry contract — and it is the subsystem I would trust
least. Five independent defects, each verified by running the real CLI against real modules:

| # | Defect | Reproduced result |
|---|---|---|
| **a** | **Erased data stays byte-recoverable in the WAL** | receipt `{"erased":300}` → erased playerId still appears **9,214×** in `t.db-wal` |
| **b** | **Fail-closed loader = fail-OPEN erasure** | duplicate `playerId` → **exit 0**, success receipt, **name still on disk** |
| **c** | **Collateral destruction of other children** | erasing one Saturday player **deleted all 3 Sunday children's names** |
| **d** | **Wrong store in Docker** | deletes the *name* on the host, cannot reach positions in the named volume |
| **e** | **Missing DB = success** | non-existent `DB_PATH` is silently *created*; exit 0, nothing erased |

**(a) The WAL retains everything.** `db.ts:16-26` sets `journal_mode=WAL` + `secure_delete=ON` and
comments that erasure therefore "actually destroy[s] the bytes". But `secure_delete` only zeroes freed
pages *in the page images the deleting connection writes* — which land in the `-wal` sidecar; the
pre-delete images survive in both files. Nothing in shipped code ever checkpoints:
`grep -rn 'wal_checkpoint' server/src server/*.ts` returns **nothing** — the only hits are in
`test/retention.ts`, where the *test* manually checkpoints, compensating for what production never does.

```
main db:  4,096 bytes   → 0 occurrences of the erased child
WAL:  3,827,512 bytes   → 9,214 occurrences of the erased child
```

Because the WAL is never truncated, essentially all data lives there — so the erasure zeroed almost
nothing. Any file-level copy, backup, or recovered disk yields the "erased" child's full trace.

**Fix (~6 lines):** `PRAGMA journal_size_limit = 0` in `db.ts`, and
`PRAGMA wal_checkpoint(TRUNCATE)` after the purge completes.

**(b) The fail-closed loader makes erasure fail open.** `purgeRosterPlayer` (`roster.ts:186`) reads
via `loadRoster()` — the *serving* loader, which correctly returns empty on a malformed file and drops
an entire session on a duplicate `playerId`. Then `roster.ts:192` guards the rewrite with
`if (removed > 0)`, so "found nothing" means "write nothing", while `purge-player.ts` exits 0.
Fail-closed for reads is fail-**open** for erasure. Reproduced verbatim:

```
{"erased":0,"rosterEntriesErased":0,"playerId":"07","scope":"all sessions"}   exit 0
→ roster.json still contains ALEX_M / ALEX_MORGAN
```

**(c) Erasing one child deletes others.** `roster.ts:195-200` rebuilds the whole file from the
*filtered* map, so every entry the loader silently dropped is erased from disk — triggered by
`removed > 0` on a completely unrelated session:

```
before: u12-sat[DEPARTING_CHILD, KEEP_ME_SAT]   u12-sun[SUNDAY_A, SUNDAY_B, SUNDAY_C]
after:  u12-sat[KEEP_ME_SAT]                    u12-sun GONE ENTIRELY
```

Nobody notices until the next Sunday match renders every dot as a bare pseudonymous id — and the
receipt said success.

**Fix for (b)+(c) (~10 lines):** give `purgeRosterPlayer` a *permissive* read-modify-write (the raw
`JSON.parse` round-trip `roster-user.ts:46-59` already uses), preserving every byte it does not
target, and make an unreadable file **throw** so the existing non-zero exit path fires.

**(d) Wrong store under Docker.** The split is exact and unfortunate:

- **Names** → `roster.json` resolves against `/app`, which **is** bind-mounted from the host. The
  documented host-side command **finds and deletes it**.
- **Positions** → `DB_PATH=/data/telemetry.db` in the **named volume `server_data`**, addressable by no
  host path. The command **cannot touch them**.

So the documented command destroys the child's name, leaves 30 days of 10 Hz location data intact,
reports `{erased:0, retry:true}` — and `observability.md` correctly tells the operator that means
"not erased, retry". They retry forever. Meanwhile the data is now *pseudonymous and unattributable*,
because the identifier that linked it to the request has been deleted. A stale `server/telemetry.db`
on the host adds genuine "which DB is authoritative?" ambiguity.

**Fix (~10 lines):** bind-mount `./server/data:/data` so the store is a visible host file; add the
`docker compose exec -T server bun run purge-player.ts …` invocation to the runbook as the only correct
form while the stack is up; delete the stale host DB.

**(e) A missing database counts as success.** `DB_PATH` pointing at a non-existent file causes
bun:sqlite to *create* it, so the CLI erases 0 rows from an empty new database and exits 0 — the exact
outcome of (d), reported as compliance. **Fix (~4 lines):** `existsSync(dbPath)` check with a distinct
exit code, so "wrong file" is never presented as "transient failure".

**Two further erasure-adjacent defects (P1/P2):**

- **The purge freezes the server.** `db.ts:87`'s `DELETE FROM telemetry WHERE player_id = $player` has
  no `LIMIT` and there is **no index on `player_id`** — `EXPLAIN QUERY PLAN` yields `SCAN telemetry`,
  while the retention delete beside it uses a covering index and is carefully batched. With
  `secure_delete` zeroing every freed page, running the documented lost-device wipe *during* a match
  holds the write lock for tens of seconds: dots stop moving while children are actually running.
  **Fix:** add `idx_telemetry_player`, batch with the rowid-subquery pattern already in `db.ts:83-85`.
- **Retention never touches `roster.json`.** The sweep bounds the telemetry table only, so the
  name↔playerId re-identification map outlives every fix it identifies, with no time bound — and
  `ft_oldest_raw_fix_age_seconds`, described as "the data-minimisation SLI proving the retention window
  holds", is blind to it. After a season the SLI reads healthy while the file still names every child
  who ever wore a device. **Fix (~15 lines):** after each sweep, drop roster sessions with no remaining telemetry.

---

### 4.6 The dev broker is anonymous and LAN-published **[PROVEN LIVE]**

**Where:** `deploy/mosquitto/mosquitto.conf:6-7`, `docker-compose.yml:29-30`

`allow_anonymous true` on `0.0.0.0:1883`. Confirmed live: an anonymous publish from the host was
accepted. Any LAN host can `mosquitto_sub -t 'football-trackers/#'` for every child's 10 Hz feed, or
publish forged telemetry — and since `ingest.ts` only checks that body `pl`/`id` agree with the topic, a
consistent forgery is accepted, server-stamped, persisted as authoritative and fanned out to the coach.

The enforcing config **already exists** (`server/mosquitto/mosquitto.conf` + `ft.acl` with the correct
`%u` pattern); compose simply mounts the wrong one. This is not the ADR-0007 trade — that decision was
per-device credentials **plus** ACLs *with* plaintext transport; here the load-bearing inner controls
are absent entirely.

**Fix (~8 lines):** point the dev broker at the same `ft.passwd`/`ft.acl` with absolute container paths.
Bonus: every bench run then exercises the real auth path, eliminating the prod-only-auth-never-tested class of bug.

---

## 5. P1 findings (condensed)

| # | Finding | Where | Fix |
|---|---|---|---|
| S-1 | **Wire-field types unvalidated → metrics injection.** A string `fix` passes `raw.fix < 2` (NaN compare) and is interpolated raw into the exposition. **[PROVEN LIVE]** — injected `ft_injected_metric 999`. A rogue device can forge `ft_anon_mode_active 0`, *silencing the alarm for §4.1*, and duplicate metric names break the **entire scrape** (`up=0`, all alerts dead). | `ingest.ts:137-159`, `metrics.ts:82-98` | ~20 LOC: coerce at boundary; `Number.isFinite` guard on `Gauge.set` |
| S-2 | **Status frame needs no attacker.** Only `s.up` is typechecked; a firmware skew missing `batt` writes literal `undefined` into `/metrics`, killing the whole scrape, and freezes that device's health card silently. | `ingest.ts:224-248` | same coercion |
| S-3 | **Fail-open env parsing.** `Math.max(1, Number('6h'))` is NaN and every downstream compare is false. **Measured:** typo'd `HISTORY_MAX_SPAN_MS` → a **10-year** export of children's raw location accepted, rate limiter 10000/10000. Also kills session TTL (cookie valid forever), argon2id inflight cap, roster rate limit, the shared scan cap. Three knobs fail *hard* (1 ms hot loops). | `history.ts`, `ingest.ts`, `auth.ts`, `server.ts`, `scanLoad.ts`, `retention.ts` | promote `events.ts`'s `envCount` to shared `env.ts`, log resolved config at boot |
| S-4 | **`/health` lies. [PROVEN LIVE]** Broker down → `{"ok":true,"mqtt":true}` while `ft_mqtt_connected 0`. Write-once latch, never reset. No DB probe. | `server.ts:181,526` | ~10 LOC: `onDisconnected` callback |
| S-5 | **Unbounded metric cardinality.** ACL leaves the session segment as bare `+`; `metrics.received.inc()` runs *before* parse, validation and rate-limit. **Measured:** 200 garbage publishes → 201 series. | `ingest.ts:128`, `ft.acl:10-11` | ~14 LOC session cap + bucket sweep |
| S-6 | **No server CI gate.** The only workflow leaves auth, authz, origin, rate-limit, retention and erasure logic completely ungated — inherited as-is at `git init`. | `.github/workflows/` | `server-ci.yml` cloned from client-ci |
| C-1 | **Clock skew breaks freshness.** No NTP on an isolated LAN. Tablet ahead >10 s → healthy feed renders an **empty pitch**; tablet behind → a **dead tracker shows as a live dot forever**, defeating ADR-0018's honesty rule. | 5 `Date.now()` sites | ~25 LOC `serverClock.ts` (running min of `Date.now()-serverTs`) |
| C-2 | **Terminal reconnect give-up.** 8 retries ≈ 37 s expected / 75 s worst case, then dead for the match. No retry button, no `online` listener. Recovery exists only by accident (Review→Live remount) and is undiscoverable. | `useLiveTelemetry.ts:32-36,274-287` | ~20 LOC: `reconnectNow()` + `online` listener + button |
| F-1 | **Backlog replay is not crash-safe.** Deleted only after full success → reboot mid-flush re-sends everything; no sequence number and no unique index → duplicate rows inflate a child's distance/sprint stats. | `main.cpp:234-250`, `db.ts:28-49` | NVS offset cursor + `sq` field + unique index |
| F-2 | **Replayed fixes are temporally wrong.** Device `ts` is never read by anything; replayed rows get `serverTs = now`, so a 90 s outage **collapses into ~1 s** — the child appears to teleport, fabricating a burst of "high-intensity efforts". GPS UTC is already parsed and unused. | `main.cpp:582`, `ingest.ts:186` | publish `gts`; trust it for replay |
| F-3 | **Provisioning accepts topic-unsafe ids.** `set player 07/b` → broker accepts, server's single-level `+` never matches: a **silent black hole with no drop counter**. Over-long ids overflow `buf[256]` → every fix diverted to backlog. | `main.cpp:384,452` | ~14 LOC charset check matching `TOPIC_ID_RE` |
| F-4 | **No watchdog, no reset reason, no version.** A wedged device is dead on a child until power-cycled; brownout loops are invisible. | `main.cpp` | `esp_task_wdt` + reset reason/boot count/version in status |
| F-5 | **Plaintext child location persists on flash.** 256 KB ≈ 1,971 fixes at ~1 cm precision, retained indefinitely if the session ends offline. A **fourth copy** ADR-0010 does not enumerate — `purge-player` provably cannot reach it. | `main.cpp:71-72,249` | age-based purge at boot + `wipe` command |
| F-6 | **`SESSION_ID` compiled in as `"test"`.** Every match accumulates under one session id — and session id is the unit of *access control*. A U10 coach can read U14 children's history. | `main.cpp:36` | NVS key, mirroring ADR-0022's `mqtt_host` |
| V-1 | **Web UI unauthenticated on `0.0.0.0:8077`**, unbounded thread per POST, and `_serve_out` hands back the **raw source clip** the UI never links. | `webui/server.py:105-144` | loopback bind + `Semaphore(1)` + artifact allow-list |
| V-2 | **`run_v1` retains every decoded frame.** 90 min @720p/5fps ≈ **69.5 GiB** — the stated goal is physically impossible. Frames are dead weight; the writer re-decodes anyway. | `pipeline.py:37,41,139` | drop `frame` from the tuple → O(tracks) |
| I-1 | **No production artifact.** No Caddyfile, no prod compose, no unit. The authenticated broker's `password_file ./ft.passwd` is **cwd-relative**, and the conf's own header contradicts its README — verified: mosquitto exits rather than starting. | `deploy/`, `server/mosquitto/` | absolute paths + `deploy/production/compose.yml` |
| Q-1 | **Empty provenance ledger.** `samples.manifest.jsonl` is **0 bytes** while `samples/` holds 3 clips — and the test that guards it passes **vacuously** on an empty file, so the control cannot fail in the one state where it matters. | `vision/` | backfill + coverage assertion |

---

## 6. P2 / P3 (grouped)

**Delivery & quality:** no aggregate `test` script and no `typecheck` script in `server/package.json`
(7 of 22 test files unscripted) · no vision/firmware CI · `vision/README.md` claims CI that does not
exist · lint/format only for client · **`playwright.config.ts` hardcodes port 3000** so the gate cannot
run alongside other local work *(new)* · firmware has zero tests; the wire contract is three
hand-maintained copies reconciled by a comment.

**Server:** `mode: 0o600` on the child-name and credential files is a **no-op whenever the file already
exists** (POSIX applies `mode` only at creation — verified: a 644 file stayed 644 after both write
paths), so the documented at-rest posture silently fails for any roster restored from backup, `scp`ed,
or created by an editor — fix with an explicit `chmod` or a temp-file + rename · **WS fan-out drops are
counted as successful sends**: `server.publish()`'s return is discarded (`server.ts:517`), and Bun
documents `0` = dropped and `-1` = backpressure, so a stalled coach tablet loses frames while
`ft_ws_sent_total` climbs at full rate · no migrations (`PRAGMA user_version`) or backup tooling · no
`uncaughtException`/`unhandledRejection` handlers (Bun's default is exit(1), and `publish()` sits
outside the ingest try/catch) · in-memory sessions log out every coach on restart · no graceful
shutdown (**measured: no data loss**; cost is a 10 s stall and abrupt socket drops) · `sh` as PID 1
(container exits **137/SIGKILL**, measured in 1.2 s — *zero* drain window, not the assumed 10 s).

**Client:** ErrorBoundary only wraps the live canvas — Review white-screens the **whole root**, leaving
no way back except reload · `PITCH_CORNERS` compile-time (and currently pointing at a Belgrade bench
spot, so every real pitch maps to the wrong box) · no fetch deadlines, and the "try again" copy is
misleading because re-pressing Apply is a no-op · no client observability · touch targets ~24-25 px
(WCAG 2.5.5 wants 44) · off-pitch players clipped invisibly while still counted · inbound frames not
checked against the subscribed `sessionId` (defence-in-depth).

**Vision:** `run_v2`/`run_v3` are `...` stubs returning success · no retention/TTL (`out/` = 51 MB
after 3 jobs) · attestation ledger lives **inside the prunable directory** · no subprocess timeouts ·
ffmpeg exit status unchecked · lockfile is placeholder text nothing consumes · model fetch is
trust-on-first-use (the fetcher overwrites the manifest with what it just downloaded).

**Infra:** no healthchecks despite a purpose-built `/health` · no log rotation · no resource limits ·
containers run as root · deps installed from network at container start without `--frozen-lockfile`.

**Docs:** README still says "NestJS" · `CLAUDE.md` documents the removed `VITE_WS_URL` · `vision/` is
invisible from every entry point while README presents Track B as un-started.

---

## 7. Verified strengths — do not re-recommend

Confirmed present and correct; audited only for regressions:

- **Auth:** argon2id + constant-work dummy hash (no enumeration oracle), per-IP buckets, concurrent-hash
  inflight cap, per-username soft-lock, per-user session caps, `__Host-` cookies, constant-time CSRF.
- **AuthZ ordering** is consistent on every session-scoped surface and deliberately avoids a 400/401 oracle.
- **Privacy by design:** names only in `roster.json` (0600), never in DB/logs/metrics; explicit-field
  copying (no spread); `secure_delete`; retention sweep; erasure CLI with receipts; loopback-only `/metrics`.
- **DoS bounds:** per-player buckets, shared off-loop scan slot, span caps, keyset paging that yields the loop.
- **Client:** strict WS frame validation with structural stripping; bounded maps/trails; honest reconnect
  state machine; shared freshness classifier; no client-side storage; strict CSP `default-src 'none'`;
  rAF/ref render discipline with a 50-player frame-budget gate; first-class A11yMirror.
- **Firmware:** NVS secret provisioning (one image, refuses to run un-enrolled); per-device MQTT identity
  with broker ACL `%u`; defensive GPS bring-up.
- **Process:** 23 cross-linked ADRs; the deterministic simulator as shared e2e substrate; vision's
  offline guards, SHA-verified weights and privacy-firewall gitignore.

---

## 8. Roadmap

Each phase closes with **machine-checkable** acceptance criteria. A separate checker verifies before a
phase closes (maker ≠ checker). Out-of-scope discoveries go to a triage list, not into the phase.

### Phase 1 — Foundation: make the safety net real *(everything depends on this)*
1. Root `.gitignore` (`roster.json`, `auth-accounts.json`, `session-config.json`, `*.passwd`, `.env*`,
   `.DS_Store`, `.claude/settings.local.json`); fix `vision/.gitignore` `models/` → `models/*`.
2. `server/test/gitignore-guard.ts`.
3. `git init` + initial commit **only after 1-2 verify clean**.
4. `server/package.json`: add `typecheck` + aggregate `test` (covering all 20 suites).
5. `server-ci.yml`, `vision-ci.yml`, firmware `pio run` job, cloned from `client-ci.yml`'s shape.
6. Make `playwright.config.ts` port env-overridable.

**Accept:** `git check-ignore -q` passes for every sensitive path · `bun run test` exits 0 and runs 20 suites · `pio run` exits 0 · all workflows present.

> **✅ DONE 2026-08-03.** All four acceptance criteria met: the guard's 286 checks pass · `bun run test`
> exits 0 running **21** suites in 19 s (20 as scoped, plus the guard itself) · `pio run` exits 0 ·
> five workflows present, `actionlint` clean. Beyond the letter of the scope: the Playwright gate
> **ran for the first time** (20 passed — it was un-runnable during the audit because :3000 was held),
> and `client/e2e/` is now typechecked, having been outside every static gate.
>
> A five-lens independent checker pass found **seven real defects in this phase's own work**, all
> fixed and re-verified by execution before the commit. The three worth remembering, because each is
> a gate that reported green while not gating:
> - The guard was **path-filtered out of CI for exactly the commits that leak** — adding `docs/roster.json`
>   or a root-level file matched no filter, so nothing ran. It now has its own unfiltered `repo-guard.yml`.
> - `run-all.ts`'s per-suite timeout **could not stop a hung suite**: the e2e suites' mosquitto/server
>   grandchildren inherit the stdout pipe, so awaiting the drain alongside `proc.exited` blocked forever.
> - The guard's sweep was **blind to non-ASCII and uppercase filenames** — git C-quotes
>   `"samples/André.mp4"`, and cameras write `.MP4`. The child with an accented name was the one who
>   would not have been caught.
>
> Deliberately left for later, not silently dropped: `platformio.ini` declares `platform = espressif32`
> unversioned, so firmware CI proves "still compiles", not "compiles identically to the bench image".

### Phase 2 — Close the P0 exposure *(no new deps; ~40 lines total)*
1. Bind `127.0.0.1:3007`; make `ANON_MODE ⇒ loopback` structural in `server.ts`.
2. Dev broker auth parity (mount `ft.passwd`/`ft.acl`, absolute paths).
3. Remove `consented_youth`; add the refusal test.
4. Consider gating `/roster` and `/history` behind real auth even in anon mode — anon exists so the
   *live pitch view* needs no login, which does not require handing out names and bulk history.

**Accept:** `lsof` shows no non-loopback listener on 3007 · anonymous `mosquitto_sub` refused · `! grep -r consented_youth`.

### Phase 2b — Repair erasure *(GDPR-load-bearing; do not defer)*
1. `journal_size_limit = 0` + `wal_checkpoint(TRUNCATE)` after purge.
2. Permissive read-modify-write in `purgeRosterPlayer`; throw on unreadable file.
3. `existsSync(DB_PATH)` guard with a distinct exit code; bind-mount `./server/data:/data`; runbook
   `docker compose exec` line; delete the stale host DB.
4. `idx_telemetry_player` + batched delete.
5. Extend retention to prune orphaned roster sessions.

**Accept:** after purge, `! strings -a $DB $DB-wal | grep -q <playerId>` · duplicate-playerId roster → **non-zero** exit and name removed · erasing one session leaves all others byte-identical · missing `DB_PATH` → distinct non-zero exit · `EXPLAIN QUERY PLAN` shows `SEARCH`, not `SCAN` · erasure e2e passes against the containerized store.

### Phase 3 — Boundary correctness
1. Coerce every wire field in `ingest.ts` (telemetry **and** status); `Number.isFinite` guard on `Gauge.set`.
2. Shared `env.ts` with loud fallback; log resolved config at boot.
3. Truthful `/health` (+ DB probe); session label cap + bucket sweep.

**Accept:** injection test finds no non-numeric value in `/metrics` · typo'd env still enforces caps · `/health` flips to `mqtt:false` within 5 s of broker loss · 500 novel sessions ≤ 33 series.

### Phase 4 — Field resilience (firmware)
Non-blocking connect state machine + jittered backoff · GPS drain loop + larger RX buffer · paced flush
+ NVS offset cursor + `sq` dedupe + drop-oldest · GPS UTC timestamps · player-id validation · watchdog
+ reset reason/version · backlog age purge · runtime `SESSION_ID`. Server side: raise ingest rate cap
**in the same phase** (they must land together).

**Accept:** 60 s AP outage preserves ≥92% of fixes · no duplicate `(player_id, seq)` rows · replayed rows span ~60 s, not ~1 s · invalid ids rejected at enrollment.

### Phase 5 — Coach-view reliability
`serverClock.ts` skew correction · `reconnectNow()` + `online` listener + retry button · root and
Review error boundaries · fetch deadlines · pitch corners via session config · off-pitch indicator ·
44 px touch targets · minimal client beacon.

**Accept:** skew unit test within 100 ms · e2e: kill server → "gave up" → click retry → feed returns · induced Review throw shows the boundary, not a blank page.

### Phase 6 — Operability
Graceful shutdown + exec-form PID 1 · compose healthcheck on `/health` · log rotation · migrations via
`user_version` · `VACUUM INTO` backup with erasure-aware rotation · `deploy/production/compose.yml`
with absolute broker paths · `uncaughtException` handlers.

**Accept:** `docker stop` exits 0 (not 137) in <2 s · healthcheck reports healthy/unhealthy correctly · backup restores to a byte-identical row count · purged player absent from every backup.

### Phase 7 — Vision & docs
Fail-fast stubs · job queue + timeouts + artifact allow-list · streaming pipeline · TTL prune · ledger
out of `out/` · checksum-pinned fetch · consumed lockfile · README/CLAUDE.md drift + `vision/` visibility
· docs-as-tests guard.

**Accept:** `--ball` exits non-zero · second concurrent POST returns 429 · `_iter_world_states` peak < 1/10 naive · docs guard passes.

---

## 9. Recommended sequencing note

Phases 1, 2 and 2b are the ones I would not defer: Phase 1 because every other gate is inert without
it, Phase 2 because the exposure is live *today* on a stack with `restart: unless-stopped`, and Phase 2b
because an erasure mechanism that reports success without erasing is worse than none — it produces a
written audit trail asserting compliance that did not happen. Phases 3-4 carry the most engineering
value per line. Phase 5 onward is comfort and durability.

A note on §4.5: nothing there reflects carelessness. Each defect is a *reasonable decision applied one
context too far* — a fail-closed loader (right for serving) reused on an erasure path, `secure_delete`
trusted without accounting for WAL semantics, a receipt contract that predates the Docker layout. That
is exactly the class of bug that survives review and only surfaces under execution, which is why the
acceptance criteria above are all byte-level assertions rather than "verify erasure works".

**The outdoor-session milestone** (README's own open item) is blocked specifically by Phase 4 — until
the reconnect path is non-blocking, a real match will silently lose most of any out-of-range period,
and the resulting data would be misleading rather than merely incomplete.
