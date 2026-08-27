# ADR-0025 — The box has to be operable: lifecycle, schema, and copies of children's data

**Status:** Implemented (audit Phase 6, 2026-08-27) · **Date:** 2026-08-27 ·
(`server/src/shutdown.ts`, `server/src/migrate.ts`, `server/src/backup.ts`, `server/src/erase.ts`,
`server/src/secretFile.ts`, `server/backup-db.ts`, `server/healthcheck.ts`, `server/Dockerfile`,
`deploy/production/compose.yml`; gated by `server/test/{shutdown-e2e,migrate,backup,scan-cancel,deploy-posture}.ts`.)

## Context

Every phase before this one made the system *correct*. None of them made it **operable**: something a
person can restart, upgrade, back up, and hand over, on a box in a clubhouse cupboard with nobody
watching it.

The 2026-08-03 audit measured what that actually meant, and the numbers were unflattering:

- **`docker stop ft-server` exited 137 (SIGKILL) in 1.3 s.** The compose command was `sh -c "…"`, so
  `sh` was pid 1, does not forward SIGTERM, and Bun never saw it. No WAL checkpoint, no socket close,
  no drain — every restart a small unexplained gap. (Re-measured at the start of this phase: identical.)
- **There were no migrations.** The schema was a pile of `CREATE … IF NOT EXISTS` re-run on every boot,
  plus one hand-rolled "ALTER if the column is missing" probe, and nothing could answer *what schema is
  this box running*.
- **There was no backup tooling at all**, and `purge-player.ts` said so in its own docstring: a
  file-level copy taken before an erasure was "a residual this CLI cannot reach".
- **There were no `uncaughtException` handlers**, and `server.publish()` — the live fan-out — sat
  *outside* ingest's try/catch, so a throw there took the process down.
- **`mode: 0o600` was a no-op** on any file that already existed (POSIX applies the mode only at
  creation; verified — a 0644 roster stayed 0644 through both write paths). Those files hold children's
  names and coaches' password hashes.
- **`server.publish()`'s return value was discarded**, so `ft_ws_messages_sent_total` counted attempts
  and called them sends: a stalling tablet lost frames while the graph climbed at full rate.
- **In-memory sessions logged out every coach on restart** — including the restart an operator performs
  *because something is wrong mid-match*.
- And Phase 5 deferred one item here in writing: an abandoned `/history` or `/events` request kept
  scanning, and kept one of three shared off-loop slots, until it finished.

## Decision

### 1. An ordered teardown, with a deadline, on a process that can actually receive the signal

Two halves, and neither works alone. In-process, `src/shutdown.ts` runs registered steps in an
**explicitly numbered order** — deliberately not the LIFO an `atexit` stack gives you, because the right
order here is not the reverse of boot:

> drain (`/health` → 503) → abort in-flight scans → stop timers → disconnect the broker →
> close the listeners → hand over the auth sessions → checkpoint and close the store

Stop being reachable, stop producing work, stop listening, touch the store last. Every step is wrapped
(one failure never strands the rest) and the whole sequence is capped by `SHUTDOWN_DEADLINE_MS`
(1500 ms), which force-exits — a shutdown that hangs is worse than an abrupt one, because it hands the
kill back to Docker.

In the container, `exec` + `init: true` make Bun the process the signal reaches. **Measured after:
`docker stop` exits 0 in 0.10–0.23 s**, with the WAL checkpointed on the way out.

**The handlers are installed FIRST — before any `await`, any listener, any registered step.** They were
originally the last statement of `server.ts`, which is worse than it sounds: bun is pid 1, and the kernel
*discards* a signal pid 1 has no handler for, so a stop inside that ~150 ms window waited out the whole
grace period and SIGKILLed (measured: exit 137 after 5.1 s — worse than the baseline). Installing first is
safe precisely because the teardown is a list: a signal at t+0 runs the steps that exist, which is none,
and exits 0. For the same reason the step order is a set of NUMBERS rather than "the order you happen to
read the calls in": two modules register now, because `auth.ts` must register its own step at the moment
it consumes the session handover, and an order you cannot check is not an order.

A teardown that hits the deadline exits **75**, not the graceful code. `docker inspect .State.ExitCode` is
this phase's own acceptance signal, and a wedged shutdown that reports 0 claims the store was checkpointed
and the coaches handed over when neither happened.

`uncaughtException` runs the same teardown and exits **1**, so the restart policy fires: after an
uncaught throw the process state is unknown, and a live feed of children's positions served from an
unknown state is worse than one that restarts in a second. The known hole the audit named is fixed *at
the source* instead — the publish path now has its own try/catch — so the handler stays a genuine last
resort rather than load-bearing. `unhandledRejection` does **not** exit (the process is still
consistent) but is counted, because silence is not the same as absence.

### 2. The schema is a ladder, and a store from the future stops the boot

`PRAGMA user_version`, an append-only list of migrations, each applied in its own transaction together
with the version bump. Migration 1 is exactly the schema as it stood at the end of Phase 5, written
idempotently, because every store in the field is at version 0 with all of it already present.

The server also refuses a store that is not OURS. `sqliteFileProblem()` answers "is this SQLite", which
is the right question for the erasure CLI and the wrong one here: pointed at an unrelated database, the
boot created `telemetry` inside it, converted it to WAL, and overwrote its `user_version` — the byte other
migration tools key on — while serving an empty pitch behind a green `/health`. The check runs before any
pragma that writes, because `PRAGMA journal_mode = WAL` rewrites the header, and a boot that is about to
declare it does not understand a store should not have converted it first.

A store whose `user_version` **exceeds** the ladder makes the server refuse to start. That is a
rollback or the wrong `DB_PATH`, and writing through a schema the binary does not understand is how a
column silently stops being populated on a store nobody reads for weeks. `ft_db_schema_version` makes
the resulting version answerable from `/metrics`, so a box that failed to migrate is not
indistinguishable from one that did.

### 3. A backup is children's location, so it inherits every rule the live store has

`VACUUM INTO` — not `cp`, which in WAL mode is a torn snapshot that opens perfectly and is quietly
short. The copy is **verified row-for-row before it counts as a backup**, and deleted if it is short:
an unverified backup is a belief, and the failure being guarded against produces a file that looks fine.

Two consequences follow from "a backup is the same data", and both are the point of this ADR:

- **Rotation is bounded twice** — by `BACKUP_KEEP` *and* by `RETENTION_DAYS`. [ADR-0010](0010-location-data-retention.md)
  bounds how long a fix may exist; a copy is a fix. `BACKUP_KEEP=7` on a monthly schedule would
  otherwise hold seven months of children's positions, six of them past the window the live store is
  held to.
- **Erasure reaches copies.** `purge-player.ts` now runs the *same* erasure statements against every
  backup and re-counts each file to prove it. That is why the DELETEs moved into `src/erase.ts`: an
  erasure path that exists twice is an erasure path that will one day be fixed once. A backup that
  cannot be erased is exit 4 with the offending file named — never a silent success on a compliance
  claim.

Rotation only ever deletes files matching the name pattern the tool itself writes. An operator's
`telemetry-before-the-cup-final.db` is not ours to delete.

Rotation is **not** contingent on the backup succeeding, and the erasure receipt **names the directory
it searched**. Both were the same mistake in two places: an operation that quietly does nothing looks
exactly like an operation that had nothing to do. A nightly cron failing on an unreachable store expired
no copies at all (rotation ran nowhere else), and a purge with a mistyped `BACKUP_DIR` reported exit 0 over
copies it never opened — `§4.5(e)` re-opened on a new surface. So: rotation runs regardless,
`--rotate-only` exists, `ft_backup_oldest_age_seconds` makes the state visible without running anything,
and the receipt carries `backupDir` + `backupsFound` exactly as it already carried `rosterFound`.

Backups are a **CLI plus a documented cron**, not a timer inside the server: `VACUUM INTO` reads the
whole store and writes a full copy, and doing that at an arbitrary moment on a Pi with one SD card is
I/O contention with the live 10 Hz ingest — a self-inflicted gap in the data the backup exists to protect.

### 4. Cancellation is cooperative, at the yield points that already exist

Every paged scan already `await`s between pages to keep the live fan-out responsive. Those are exactly
the safe places to give up, so the check lives *inside* the yield helper — a new paged loop cannot
forget it the way a separate `if (aborted) break` can. Three reasons stop a scan: the client vanished
(`request.signal`), the wall-clock budget ran out (`SCAN_BUDGET_MS`, 25 s), or the server is shutting down
— and that last one is AWAITED, because marking a budget is not aborting a scan: a scan notices at its next
page boundary, so returning immediately meant the process exited first and the coach got a socket reset
instead of the 503 the design promised. An aborted scan is also audited like any other read (principal and
rows actually scanned): on the most sensitive read in the system, the requests that touch the most of a
child's trace and return nothing must not be the only ones with nobody's name against them.

The shared slot cap gained a **per-principal share** (2 of 4). A per-principal rate bucket is not a
fairness control for a shared resource: a caller well inside its own budget held every slot continuously
and denied another coach 39 of 40 reads. Two, not one, because a coach's own Review page legitimately runs
two scans at once. The client's own scan deadline is 30 s, deliberately **longer**, so the server gives up first and
answers an honest, retryable 503 instead of the client timing out against a scan that is still running.

### 5. Session tokens are stored as verifiers, which is what makes surviving a restart safe

The session map is re-keyed by `sha256(token)`. The raw bearer token now exists in the process only for
the microseconds between minting it and writing the `Set-Cookie` header, and what a graceful shutdown
writes to disk is a **verifier**: possession of the file grants nothing without a sha256 preimage. It
is 0600, written atomically, and **consumed on read** — a restart hands the sessions over exactly once,
and a stale file can never resurrect a session days later. A session whose account was removed while the
process was down is dropped, not restored.

And the restore applies the CURRENT policy rather than the persisted one: the lifetime is clamped to
today's TTL, the per-user and global caps apply, a duplicate key is dropped, and the key must have the
shape `saveSessions` writes. That matters because a restart is precisely how an operator APPLIES a policy
change — "shorten sessions and restart" is the response to a lost coach tablet — and trusting the file
would exempt the very sessions being tightened against. It also bounds what a hand-written file can ask
for: someone who can WRITE this file can already edit `auth-accounts.json`, so it is not an escalation,
but a forged handover is a *better* backdoor because it deletes itself and leaves no artefact. Being
consumed is unconditional too: if the file cannot be removed, nothing is restored, because restoring from
a file that survives means replaying sessions that were explicitly signed out.

The honest limit, stated rather than hidden: this covers a *graceful* exit only. A crash still logs
everyone out, and `ft_auth_sessions_restored_total` reads 0 in exactly that case.

### 6. Owner-only means atomic temp + rename + chmod

`writeFileSync(path, text, { mode: 0o600 })` applies the mode only when the file is **created**. Every
write over an existing file — one restored from a backup, `scp`ed, or made by an editor — silently kept
whatever permissions it had. `src/secretFile.ts` is now the single writer for all of them, and the
rename also removes the truncated-file failure mode: both the roster and accounts loaders fail closed
on a malformed file, so a crash mid-write could have taken out every name or every login.

The telemetry store itself is tightened to 0600 on open for the same reason (observed 0644 inside the
production image) — best-effort, because a mount that cannot chmod should warn, not refuse to boot.

## Consequences

**Good.** `docker stop` is 0 in ~0.1 s with the store checkpointed. A restart no longer logs the
coaches out. The schema is knowable and rolls forward safely. Backups exist, verify themselves, expire
on the same clock as the live data, and are reachable by the erasure CLI. An abandoned review read
releases its shared slot at the next page boundary instead of holding it to the end. `sent` means
*delivered*. There is a production artifact — non-root image, no personal data in any layer, nothing on
`0.0.0.0`, no anonymous access — and `test/deploy-posture.ts` fails the build if any of that regresses.

**Costs, accepted.** A hash per authenticated request (~1 µs on a 256-bit token; negligible against
argon2id at login). A `bun run` process every 15 s for the healthcheck, because this image has no curl,
wget or nc. One more file on disk between a graceful stop and the next boot. And the ladder is
append-only forever — a shipped migration can never be edited, only superseded.

**Not done, and named as such.** TLS termination for a field box. There is no Caddyfile because "add a
Caddyfile" is really "choose an internal CA and get it trusted on the coaches' tablets" — a decision,
not a config file, and the wrong thing to guess at in a repo. Until it is made the production stack
keeps the server on loopback behind whatever the operator puts in front of it, and
[deploy/production/README.md](../../deploy/production/README.md) says so in those words.

## Alternatives considered

- **Persist sessions as raw tokens.** Rejected: a file of live bearer tokens is a key, not a verifier.
  Hashing costs a microsecond and downgrades the file from "credential store" to "list of hashes".
- **Swallow `uncaughtException` and keep serving.** Tempting mid-match, rejected: it is exactly the
  "continue in an unknown state" that produces the bugs nobody can reproduce. Fixing the one known
  source (the publish path) and exiting on the rest is the honest split.
- **A backup timer inside the server.** Rejected on I/O grounds (see §3); it would stall the live
  ingest it is meant to protect.
- **`cp` the store, or `sqlite3 .backup`.** Rejected: the first is torn in WAL mode; the second is an
  external dependency this project deliberately does not have (`VACUUM INTO` is one statement).
- **Delete every backup on an erasure.** Simpler than purging each one, and rejected: it destroys the
  backup story to satisfy a request that a targeted delete satisfies exactly.
- **A `nc`/`curl` healthcheck.** Not available in `oven/bun:1.3` (verified). Adding a package to the
  image for a liveness probe is a worse trade than a 40 ms `bun run`.
