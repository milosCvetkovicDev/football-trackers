import { envInt, envTimerMs } from './env';
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

// Default 4, raised from 3 in Phase 6 — see OFFLOOP_MAX_PER_PRINCIPAL below for why. The bound exists to
// keep the worst-case interleaving that the live-WS-fan-out SLO depends on; the checker measured a
// maximum event-loop block of ~4-7 ms with the cap saturated, against a ~33 ms frame budget, so the
// margin absorbs one more comfortably (events-e2e re-proves the SLO at the new value).
const OFFLOOP_MAX_INFLIGHT = envInt('OFFLOOP_MAX_INFLIGHT', 4, { min: 1 });

/**
 * And a PER-PRINCIPAL share of it (Phase 6 checker finding).
 *
 * The global cap is loop protection, not fairness — and the per-principal RATE bucket does not supply
 * fairness either, because a caller well inside its own rate budget can keep all three slots occupied
 * continuously once a single scan takes a few seconds. Measured: one authenticated principal on three
 * sockets, pacing at 200 ms and using ~18 of its 60/min budget, denied another coach 39 of 40 small
 * reads over 40 s. One stolen 12 h cookie takes the review surface offline for the whole club.
 * (history.ts's own comment claimed a principal "can never starve another"; that was true of the bucket
 * and false of the surface.)
 *
 * 2, not 1, because ONE coach's Review page legitimately runs two scans at once — the aggregate read and
 * the tactical-events read fire together on mount, so a cap of 1 would deadlock a coach against itself.
 * The global cap went 3 -> 4 in the same change so that 2 is genuinely a SHARE: one principal holds at
 * most half, and a second coach can always open Review. A principal can no longer take the surface to
 * zero for everyone else, which is the property the rate bucket was wrongly credited with.
 */
const OFFLOOP_MAX_PER_PRINCIPAL = envInt('OFFLOOP_MAX_PER_PRINCIPAL', 2, { min: 1 });

let inflight = 0;
/** Slots held per principal (a coach username, or an IP for the anonymous principal). */
const perPrincipal = new Map<string, number>();

/**
 * Take a scan slot for `principalKey`. False when the global cap OR this principal's share is already
 * reached (caller → 503 'busy'). The key is the same one the rate bucket uses.
 */
export function acquireScanSlot(principalKey: string): boolean {
  if (inflight >= OFFLOOP_MAX_INFLIGHT) return false;
  const mine = perPrincipal.get(principalKey) ?? 0;
  if (mine >= OFFLOOP_MAX_PER_PRINCIPAL) return false;
  inflight += 1;
  perPrincipal.set(principalKey, mine + 1);
  return true;
}

/** Release a slot taken by acquireScanSlot(). The caller pairs this in a `finally`. */
export function releaseScanSlot(principalKey: string): void {
  if (inflight > 0) inflight -= 1;
  const mine = perPrincipal.get(principalKey) ?? 0;
  // Deleted at zero rather than left at 0: this map is keyed by IP for the anonymous principal, so an
  // entry per distinct source address that is never removed is the same unbounded-map shape the beacon
  // limiter had to be swept for.
  if (mine <= 1) perPrincipal.delete(principalKey);
  else perPrincipal.set(principalKey, mine - 1);
}

/** Test-only: how many slots a principal currently holds (0 when it holds none). */
export function _principalSlots(principalKey: string): number {
  return perPrincipal.get(principalKey) ?? 0;
}

/** Test-only: current COMBINED inflight scan count (history + events), so a unit test can assert the cap. */
export function _scanInflight(): number {
  return inflight;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Cancellation (Phase 6; the item Phase 5 deferred here in writing).
//
// THE HOLE. A slot was held until the scan FINISHED, and nothing could make a scan finish early. The
// server never looked at `request.signal`, so a coach who closed the tab, navigated away, or whose
// 30 s client-side fetch deadline fired left a scan running to completion over a children's-location
// trace — burning one of OFFLOOP_MAX_INFLIGHT (3) slots for a result nobody would ever read. Three of
// those and every subsequent review read answers 503 `busy` for as long as the scans take. There was
// no wall-clock bound of any kind either: the only limits were the span cap and the page size, so a
// dense enough window scanned for as long as it scanned.
//
// THE SHAPE OF THE FIX. Cooperative, at the yield points that already exist. Every paged loop in
// history.ts / events.ts already `await`s between pages to keep the live fan-out responsive; those are
// exactly the safe places to give up, and checking there adds no new interleaving and no new state.
// A budget is checked, not polled: no timers, nothing to leak if a caller forgets.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export type ScanAbortReason = 'client_gone' | 'budget' | 'shutdown';

/** Thrown from a scan's yield point. The route maps it to a result; it is never surfaced to the client raw. */
export class ScanAborted extends Error {
  constructor(readonly reason: ScanAbortReason) {
    super(`scan aborted: ${reason}`);
    this.name = 'ScanAborted';
  }
}

/**
 * Wall-clock ceiling for ONE off-loop scan. 25 s by design: the coach view's own scan deadline is 30 s
 * (client/src/fetchDeadline.ts), so the server gives up FIRST and answers honestly, instead of the
 * client timing out against a scan that keeps running and keeps its slot — which is the exact failure
 * Phase 5 could only reduce the frequency of.
 */
// The floor is 100 ms rather than 1 s only so a test can set a budget BELOW the machine it runs on can
// complete a scan in — the CI runner is fast enough that a 1 s floor made the budget case unreachable
// there while passing locally. It is still a nonsense-rejecting floor (0, negative and non-numeric all
// fall back loudly via envTimerMs); a deliberate 100 ms is a choice, not a typo.
const SCAN_BUDGET_MS = envTimerMs('SCAN_BUDGET_MS', 25_000, { min: 100 });

const liveScans = new Set<ScanBudget>();

export class ScanBudget {
  readonly deadlineAt: number;
  /**
   * Rows read so far. An aborted scan used to record NOTHING — `ft_history_rows_scanned_total` and the
   * `history read` audit line both sit after the paged loop, so the requests that read the most of a
   * children's-location trace and return nothing were the ones with no volume and no principal in the
   * audit trail. The scan reports its progress here so the abort path can log what it actually read.
   */
  rowsScanned = 0;
  private cancelled: ScanAbortReason | null = null;

  constructor(private readonly signal?: AbortSignal) {
    this.deadlineAt = Date.now() + SCAN_BUDGET_MS;
    liveScans.add(this);
  }

  /** Throw if this scan should stop. Called at the paged loops' existing yield points. */
  check(): void {
    if (this.cancelled) throw new ScanAborted(this.cancelled);
    // `request.signal` aborts when the client disconnects — the whole point of the exercise.
    if (this.signal?.aborted) throw new ScanAborted('client_gone');
    if (Date.now() > this.deadlineAt) throw new ScanAborted('budget');
  }

  /** Called by the paged loops after each page, so an abort can still be audited for volume. */
  noteRows(n: number): void {
    this.rowsScanned += n;
  }

  /** Marked by abortAllScans() at shutdown; the scan stops at its next yield. */
  cancel(reason: ScanAbortReason): void {
    this.cancelled ??= reason;
  }

  /** Paired with construction in the route's `finally`, alongside releaseScanSlot(). */
  release(): void {
    liveScans.delete(this);
  }
}

/** Start a budget for one scan. Pass the request's AbortSignal so a vanished client stops the work. */
export function newScanBudget(signal?: AbortSignal): ScanBudget {
  return new ScanBudget(signal);
}

/**
 * Shutdown step: tell every in-flight scan to stop, and WAIT BRIEFLY for it to happen.
 *
 * The wait is the whole point, and the first version of this did not have it: marking the budgets and
 * returning immediately meant `process.exit()` fired about a millisecond later, before any scan reached
 * the `check()` that would observe the mark — so `reason:'shutdown'` was a permanently-zero metric and a
 * coach mid-review got a socket reset instead of the honest 503 the design promised (measured: 3 marked,
 * 0 aborted). A scan aborts at its next page boundary, which is a yield away, so a couple of hundred
 * milliseconds is generous; the drain returns as soon as the last one lets go.
 */
export async function abortAllScans(drainMs = 250): Promise<{ marked: number; drained: boolean }> {
  const marked = liveScans.size;
  if (marked === 0) return { marked: 0, drained: true };
  for (const b of liveScans) b.cancel('shutdown');
  const deadline = Date.now() + drainMs;
  while (liveScans.size > 0 && Date.now() < deadline) {
    // A real macrotask turn: the paged loops yield with setTimeout(0), so nothing shorter gives them one.
    await new Promise((r) => setTimeout(r, 5));
  }
  return { marked, drained: liveScans.size === 0 };
}

/** Test-only: how many scans currently hold a budget (a leak here is a leak of the Set above). */
export function _liveScanBudgets(): number {
  return liveScans.size;
}

export { OFFLOOP_MAX_INFLIGHT, OFFLOOP_MAX_PER_PRINCIPAL, SCAN_BUDGET_MS };
