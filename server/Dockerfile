# Production image for the ingest / fan-out / persistence server (audit I-1, §8 Phase 6).
#
# The DEV stack (../docker-compose.yml) deliberately does not use this: it bind-mounts the source and
# runs `bun install` at container start so an edit is live without a rebuild. That is the right trade
# on a bench and the wrong one in a field box, where the image should be a fixed, inspectable artefact
# with its dependencies already resolved.
#
#   docker build -t football-trackers-server:local server/
#
# Build context is server/ — everything the runtime needs is in there, and a repo-root context would
# drag the vision/ tree, the client and the firmware into the daemon for nothing. See .dockerignore for
# what is kept OUT, which on this project is a security control and not merely a size optimisation:
# roster.json (children's names), auth-accounts.json (password hashes), data/ (raw location) and
# mosquitto/ft.passwd (broker credentials) must never be baked into an image that gets copied around.

# ---- deps: resolve dependencies from the lockfile, once -------------------------------------------
# Pinned to the same 1.3 the dev stack runs (no :latest, per the repo's docker guardrails).
FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
# --frozen-lockfile is the `npm ci` of this toolchain: install EXACTLY the lockfile, fail if it and
# package.json disagree. `bun install` alone would silently resolve something newer at build time, so
# two builds of the same commit could ship different dependency trees.
RUN bun install --frozen-lockfile --production

# ---- runtime -------------------------------------------------------------------------------------
FROM oven/bun:1.3 AS runtime
WORKDIR /app

# The store's directory, for the case where /data is NOT bind-mounted (a named volume, or no volume at
# all — Docker seeds a named volume from the image, so this ownership is what it inherits).
#
# It does NOT help the bind-mount case, and saying otherwise here was wrong: a bind mount takes the HOST
# directory's ownership and this layer is invisible to it. That is the trap the production README calls
# out — Docker creates a missing bind-mount directory owned by ROOT while the image runs as uid 1000 —
# and the fix for it lives on the host (`chown -R 1000:1000`), not here. db.ts now says so by name when
# it cannot open the store, because a raw SQLITE_CANTOPEN under `restart: unless-stopped` is a crash loop
# with no diagnostic.
RUN mkdir -p /data/backups && chown -R bun:bun /data && chmod 700 /data/backups

COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json ./
COPY --chown=bun:bun src ./src
# The operator CLIs ship WITH the image on purpose: erasure and backups are things you have to be able
# to run on the box, in the container, against the container's own DB_PATH — `docker compose exec server
# bun run purge-player.ts <id>` is the documented right-to-erasure path (ADR-0010).
COPY --chown=bun:bun purge-player.ts roster-user.ts auth-user.ts session-config.ts backup-db.ts healthcheck.ts ./

# Non-root. The bun image provides uid 1000; nothing here needs privilege, and the one thing this
# process holds — children's live location — is the reason to spend the two lines.
USER bun

ENV NODE_ENV=production \
    DB_PATH=/data/telemetry.db \
    BACKUP_DIR=/data/backups \
    PORT=3000 \
    METRICS_PORT=9464

EXPOSE 3000

# No curl/wget/nc in this image (verified), so the probe is Bun itself — same script the dev stack uses.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "run", "/app/healthcheck.ts"]

# EXEC form: bun is the process the container's init forwards SIGTERM to, which is what makes the
# graceful teardown in src/shutdown.ts run at all. A shell form here re-creates the exit-137 bug.
CMD ["bun", "run", "src/server.ts"]
