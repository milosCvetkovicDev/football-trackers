# deploy/production/

The field-box stack: an authenticated broker plus the ingest/fan-out server, built from a fixed image,
with nothing published on `0.0.0.0` and no anonymous access to anything.

This exists because the audit's I-1 finding was "no production artifact" — no prod compose, no unit, and
a broker config whose `password_file ./ft.passwd` was cwd-relative (mosquitto exits rather than starts
when it cannot find it; the paths are absolute now). The dev stack at
[`../../docker-compose.yml`](../../docker-compose.yml) is deliberately **not** this: it runs the live
view with **no login** on an isolated LAN, installs dependencies at container start, and bind-mounts the
source. Excellent on a bench, wrong on a box left alone with a team's children on it.

## What differs from the dev stack, and why

| | dev | production |
|---|---|---|
| Live view | `ALLOW_ANONYMOUS_LIVE=true` — no login | **authenticated**; every read is attributable to a named coach |
| Server | `oven/bun` + source mount + `bun install` at start | built image, non-root (uid 1000), deps from the lockfile |
| Server port | `127.0.0.1:3007` | `127.0.0.1:3000`, behind a TLS proxy |
| Broker port | `1883` on the LAN (the wearables need it) | `${FIELD_AP_IP}:1883` — the AP interface only |
| Cookies | `Secure=false` (http://localhost) | `Secure=true` |
| Limits / logs | none | memory+cpu limits, `json-file` capped at 3 × 10 MB |

Both stacks mount the **same** broker config (`../../server/mosquitto/`), so the authenticated path is
exercised on every bench run rather than existing only in production, untested.

## First run

```sh
cd deploy/production
cp .env.example .env && $EDITOR .env && chmod 600 .env

# The directories the bind mounts point at must exist and be writable by uid 1000 (the image is non-root):
sudo mkdir -p /srv/ft/data /srv/ft/config && sudo chown -R 1000:1000 /srv/ft && sudo chmod 700 /srv/ft/config

docker compose -f compose.yml up -d --build
docker compose -f compose.yml ps          # server should reach (healthy) within ~30 s
```

Provision at least one coach before anyone tries to log in — no accounts means every login fails, and
the server says so at boot:

```sh
docker compose -f compose.yml exec -T server bun run auth-user.ts add coach1 --role coach --sessions <sessionId>
docker compose -f compose.yml exec -T server bun run roster-user.ts set <sessionId> <playerId> "<display name>"
docker compose -f compose.yml exec -T server bun run session-config.ts set <sessionId> U12
```

## Backups

`VACUUM INTO`, verified row-for-row, written 0600 into a 0700 directory beside the store:

```sh
docker compose -f compose.yml exec -T server bun run backup-db.ts
```

The JSON receipt on stdout is the record: source path, copy path, row counts, and how many old copies
were rotated away. `--list` shows what is on disk **and which copies are past `RETENTION_DAYS`**; `--no-rotate` keeps
everything; `--rotate-only` expires old copies without taking a new one — useful when the cron has been
failing, because rotation is the only thing that enforces retention on copies. It now runs even when the
backup itself fails, so a night with an unreachable store still expires what is due.

**Rotation is bounded twice**, and the second bound is the one that matters: `BACKUP_KEEP` (default 7)
*and* `RETENTION_DAYS` (default 30). A backup is a complete copy of children's location, so it inherits
the live store's retention window — `BACKUP_KEEP=7` on a box backed up monthly would otherwise hold
seven months of it, six of them past the window ADR-0010 holds the live store to.

Run it **between sessions**, not mid-match: `VACUUM INTO` reads the whole store and writes a full copy,
which on a Pi with one SD card is I/O contention with the live 10 Hz ingest. A crontab line:

```cron
# 02:15 nightly — well away from any session
15 2 * * * cd /srv/ft/deploy/production && docker compose -f compose.yml exec -T server bun run backup-db.ts >> /var/log/ft-backup.log 2>&1
```

`ft_backup_oldest_age_seconds` on `/metrics` answers "are my copies inside the window" without running
anything; alert when it exceeds `RETENTION_DAYS`.

Restoring is a file copy, because a backup **is** a store: stop the stack, put the chosen file at
`DATA_DIR/telemetry.db`, remove any stale `-wal`/`-shm` beside it, start the stack. The server migrates
it forward on boot if it is older than the running build (and refuses to start if it is *newer* — see
below).

## Erasure reaches the backups

`purge-player.ts` erases the player from the live store **and from every backup in `BACKUP_DIR`**, then
re-counts each file to prove it:

```sh
docker compose -f compose.yml exec -T server bun run purge-player.ts <playerId> [sessionId]
```

Exit 0 with a JSON receipt is the compliance record; exit 4 means residue remains **somewhere named in
the receipt** (a locked or unwritable backup) — fix that file and re-run, it is idempotent. Copies this
command cannot see — one you made by hand elsewhere, an SD-card image — are still yours to handle.

## Schema

The store carries `PRAGMA user_version`; the server migrates it forward on boot and publishes the result
as `ft_db_schema_version`. A store **newer** than the running build makes the server **refuse to start**
— that is a rollback or the wrong `DATA_DIR`, and writing through a schema the binary does not
understand is how a column silently stops being populated. Roll forward, or point at the right store.

## Shutdown and restarts

`docker stop` is graceful: the server drains (`/health` reports `draining` and 503), aborts in-flight
review scans, disconnects from the broker, closes the live sockets, hands the logged-in coaches over,
checkpoints the WAL and exits **0** — measured at ~0.1–0.2 s. Coaches stay logged in across the restart
(the handover file is 0600 and holds `sha256(token)`, never a usable token, and is consumed on read).
A **crash** still logs everyone out; that is the honest limit, and `ft_auth_sessions_restored_total`
reads 0 when it happens.

## The coach view is a separate artifact — build it and let the proxy serve it

This stack is the **backend only**: the broker and the API/WebSocket server. It serves no HTML, and
`GET /` is a 404 by design — the server's job is `/live`, `/auth`, `/sessions` and the loopback
`/health` + `/metrics`, and adding static hosting would put the bundle behind the same process that must
not be distracted from a 10 Hz fan-out.

So the coach view is built once and served by whatever terminates TLS in front of this box:

```sh
cd client
VITE_PROXY_TARGET=http://127.0.0.1:3000 bun run build   # -> client/dist
```

Point the reverse proxy at `client/dist` for `/`, and proxy `/live`, `/auth` and `/sessions` through to
`127.0.0.1:3000` — same-origin, which is what the strict CSP (`connect-src 'self'`) and the Origin
allow-list both assume. `ALLOWED_ORIGINS` in `.env` must be exactly the origin the browser sees.

Without that step you get a healthy backend that no coach can open. It is called out here because
following this README to the end used to leave you exactly there.

## The one piece that is not here: TLS

There is no Caddyfile, and that is a decision rather than an omission. A field box has no public DNS and
no ACME reachability, so terminating TLS means choosing an internal CA or a self-signed certificate and
getting it trusted on the coaches' tablets — a decision to make with the person who owns those tablets,
not a config file to guess at. Until it is made:

- run the coaches' tablets on the same physically isolated LAN as the box (Profile A, [ADR-0008](../../docs/decisions/0008-authentication-access-control.md));
- keep the server on `127.0.0.1` and reach it through an SSH tunnel or a local proxy on the box;
- `AUTH_COOKIE_SECURE=true` stays set — over plain HTTP the browser will simply not store the cookie,
  which is the failure you want (a loud one) rather than a session cookie crossing the LAN in the clear.

`/metrics` and `/health` are loopback-only inside the container by design (they carry per-child presence
and version info). Scrape them **on the box**; never proxy them.
