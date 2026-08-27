#!/usr/bin/env bun
/**
 * Container healthcheck probe (audit §8 Phase 6: "compose healthcheck on /health").
 *
 *   bun run healthcheck.ts     # exit 0 = healthy, 1 = not
 *
 * WHY A SCRIPT AND NOT `curl -f`. `oven/bun:1.3` ships with neither curl nor wget nor nc (verified —
 * `command -v` finds none of them), so the healthcheck every compose example reaches for would fail
 * with "executable not found" and mark a perfectly healthy container unhealthy, forever. Bun itself is
 * the one HTTP client guaranteed to be in that image, and this is the same trick the reference
 * distroless services use with `node --eval`.
 *
 * WHAT IT PROBES. `/health` on METRICS_PORT — the LOOPBACK-only internal listener, which is exactly
 * right for a healthcheck: it runs inside the container's own network namespace, and the endpoint is
 * deliberately not reachable from anywhere else (it carries per-child presence and version info).
 *
 * `ok` is the whole condition, not the HTTP status alone: it folds in the broker connection, the store
 * probe, and — since Phase 6 — the draining flag, so a container on its way out stops being routed to.
 */

const PORT = Number(process.env.METRICS_PORT ?? 9464);
const TIMEOUT_MS = Number(process.env.HEALTHCHECK_TIMEOUT_MS ?? 2_000);

try {
  const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = (await res.json()) as { ok?: boolean; mqtt?: boolean; db?: boolean; draining?: boolean };
  if (body.ok === true) process.exit(0);
  // Print the reason: `docker inspect` keeps the last few healthcheck outputs, and "unhealthy" with no
  // detail sends an operator to the logs for something the probe already knew.
  console.error(`unhealthy: ${JSON.stringify(body)}`);
  process.exit(1);
} catch (err) {
  console.error(`unhealthy: ${String(err)}`); // not listening, or slower than the timeout
  process.exit(1);
}
