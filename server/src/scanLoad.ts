import { envInt } from './env';
/**
 * Shared off-loop-scan admission (PM-1; event-detection-contract §0.4/§1.5).
 *
 * The history (ADR-0017) and events (ADR-0020) endpoints both keyset-page over the stored
 * children's-location trace on the ONE Bun event loop, yielding between pages. Each self-throttles
 * per principal (a rate bucket), but their *inflight* caps were independent — so the true worst case
 * was (history cap + events cap) concurrent scans interleaving synchronous steps between yields,
 * exceeding the "N× interleaved steps" loop-protection bound either cap documents in isolation. That
 * bound is exactly what the live-WS-fan-out SLO (the #1 gate over children's live feed) depends on.
 *
 * So the INFLIGHT cap is a single GLOBAL counter here, capping the COMBINED number of concurrent paged
 * scans (history + events) to OFFLOOP_MAX_INFLIGHT. Per-principal RATE limiting stays per-surface in
 * each module (a per-caller fairness control, not loop protection).
 */

// Default 3 — the value history's cap historically used; covers history + events combined now.
const OFFLOOP_MAX_INFLIGHT = envInt('OFFLOOP_MAX_INFLIGHT', 3, { min: 1 });

let inflight = 0;

/** Take a scan slot. Returns false when the global cap is already reached (caller → 503 'busy'). */
export function acquireScanSlot(): boolean {
  if (inflight >= OFFLOOP_MAX_INFLIGHT) return false;
  inflight += 1;
  return true;
}

/** Release a slot taken by acquireScanSlot(). The caller pairs this in a `finally`. */
export function releaseScanSlot(): void {
  if (inflight > 0) inflight -= 1;
}

/** Test-only: current COMBINED inflight scan count (history + events), so a unit test can assert the cap. */
export function _scanInflight(): number {
  return inflight;
}

export { OFFLOOP_MAX_INFLIGHT };
