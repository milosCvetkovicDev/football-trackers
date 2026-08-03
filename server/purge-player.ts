#!/usr/bin/env bun
/**
 * Right-to-erasure / lost-device wipe (ADR-0010).
 *
 * Deletes a player's raw fixes from the field-box telemetry DB. Operates directly on
 * DB_PATH with no network surface — the running server's /live and /metrics listeners
 * gain no mutation endpoint from this. WAL + busy_timeout (db.ts) let it run while the
 * server is live, and PRAGMA secure_delete (db.ts) zeroes the freed pages so the bytes
 * are actually destroyed, not just unlinked.
 *
 *   bun run purge-player.ts <playerId> [sessionId]
 *
 *   bun run purge-player.ts 07            # erase player 07 across every session
 *   bun run purge-player.ts 07 morning-5s # erase player 07 from one session only
 *
 * Exits 0 on success (prints a JSON receipt), 2 on a usage error, 3 if the DB was busy
 * or the delete failed (the wipe did NOT happen — retry; never assume erased on error).
 *
 * NOTE: per ADR-0010 full erasure also removes the player's aggregates, roster entry,
 * and the cloud aggregate copy. The roster entry IS erased here now (Phase 3; ADR-0016 §1.4)
 * — see rosterEntriesErased in the receipt. Aggregates + the cloud aggregate copy are not
 * built yet; when they land, extend this CLI to purge them in the same call. Two known
 * residuals this CLI cannot reach from a separate process: (a) per-player Prometheus series in the
 * RUNNING server's in-memory registry (ft_player_last_seen_timestamp_seconds{player=…}
 * etc.) persist until the server restarts — those series are pseudonymous and exposed
 * only on the loopback /metrics port; restart the server to clear them; and (b) any
 * file-level backup of telemetry.db taken before this wipe. See the erasure runbook in
 * docs/architecture/observability.md.
 */

const [playerId, sessionId] = process.argv.slice(2);

if (!playerId) {
  console.error('usage: bun run purge-player.ts <playerId> [sessionId]');
  process.exit(2);
}

try {
  // Import inside the guard so even a failure to OPEN the DB (bad path, SQLITE_CANTOPEN)
  // yields a clear non-zero receipt rather than a bare stack trace — db.ts opens on import.
  const { purgePlayer } = await import('./src/db');
  const erased = purgePlayer(playerId, sessionId);
  // Erase the roster entry in the SAME try (ADR-0016 §1.4): a roster-write failure must surface as the
  // existing exit-3 error receipt, never a silent partial erasure (raw fixes gone but the name lingers).
  // 0 entries removed (player not in the roster) still exits 0 — the erasure goal is met regardless,
  // matching purgePlayer's 0-rows semantics.
  const { purgeRosterPlayer } = await import('./src/roster');
  const rosterEntriesErased = await purgeRosterPlayer(playerId, sessionId);
  console.log(
    JSON.stringify({
      erased,
      rosterEntriesErased,
      playerId,
      scope: sessionId ? { sessionId } : 'all sessions',
    }),
  );
  process.exit(0);
} catch (err) {
  // Make a compliance failure unmistakable: a non-zero JSON receipt + exit 3, never a
  // bare stack trace an operator might mistake for a transient glitch.
  console.error(JSON.stringify({ erased: 0, rosterEntriesErased: 0, playerId, error: String(err), retry: true }));
  process.exit(3);
}
