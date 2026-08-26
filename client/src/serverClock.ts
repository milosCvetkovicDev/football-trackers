/**
 * serverClock.ts — the client's estimate of the SERVER's clock (Phase 5; audit C-1).
 *
 * THE PROBLEM. A match-day LAN has no NTP: the coach's tablet and the server agree only by luck.
 * Every freshness decision in this client — STALE_MS, DROP_MS, device-health staleness, the default
 * review window — compares `Date.now()` on the TABLET against a `serverTs` stamped by the SERVER, so
 * the skew between the two clocks is added to (or subtracted from) every age the coach is shown:
 *
 *   tablet 10 s FAST  → every fix instantly reads as >10 s old → a healthy 10 Hz feed draws an EMPTY
 *                       PITCH, which looks exactly like "the trackers are dead".
 *   tablet SLOW       → fixes never age out → a tracker that died five minutes ago still shows a live
 *                       dot, defeating the one honesty rule ADR-0018 exists to enforce.
 *
 * THE ESTIMATE. For every frame, `clientNow - serverTs` = skew + transit delay, and transit delay is
 * always >= 0. So the smallest difference observed is the closest sample to the true skew, and a
 * running MINIMUM converges on it from above. This is the same trick NTP uses on its round trips, and
 * it is why an average would be wrong here: one slow frame (or a Phase-4 backlog replay carrying a
 * GPS time from hours ago) would drag an average far from the truth, while a minimum simply ignores it.
 *
 * WHAT MAY FEED IT — and what must not. Only timestamps that are stamped when the server sees them:
 * the `hello` envelope (the server's clock, sent once as the socket opens) and `.../status` frames
 * (arrival-stamped, explicitly never backlogged). TELEMETRY IS EXCLUDED. Since Phase 4 a replayed
 * backlog fix carries its own GPS time as `serverTs` (`Math.min(gts, arrival)`, up to 6 h behind), so
 * a page loading while a tracker drains its backlog would see only old timestamps, infer an offset of
 * HOURS, and then render those stale fixes — and every later one — as live dots. That is the
 * dangerous direction: it makes a dead tracker look alive, which is exactly what ADR-0018 exists to
 * prevent. A running minimum tolerates the occasional late sample; it cannot save you when every
 * sample in the window is late, which is why the source list matters more than the estimator.
 *
 * Given that source list, no frame can carry a timestamp in the server's future, so the minimum can
 * never be dragged BELOW the true skew either.
 *
 * WHY A SLIDING WINDOW. An all-time minimum is a latch: once a tablet's clock is corrected (an
 * operator fixing the date, an RTC catching up after a cold boot), a permanent minimum would keep
 * applying the OLD offset forever. Two buckets rolled every SKEW_WINDOW_MS give a cheap sliding
 * minimum — the estimate is the smaller of "this window" and "the previous window", so a real clock
 * change is fully absorbed within two windows and a single outlier still cannot pull it low.
 *
 * Module-level state on purpose: there is exactly one server and one page, and the estimate is a
 * property of the pair. `resetServerClock()` exists for tests and teardown.
 */

/** How often the running minimum is re-baselined. One minute: long enough to collect thousands of
 *  10 Hz samples, short enough that a corrected tablet clock is followed within ~2 minutes. */
export const SKEW_WINDOW_MS = 60_000;

let curMin = Number.POSITIVE_INFINITY; // min(clientNow - serverTs) in the current window
let prevMin = Number.POSITIVE_INFINITY; // ...and in the one before it
let windowStart = 0;
let samples = 0;

/**
 * Feed one server-stamped timestamp. Callers must pass ONLY a `hello` or `.../status` timestamp —
 * see the source rule above; telemetry is excluded by design, not by accident.
 * Non-finite or non-positive timestamps are ignored rather than allowed to corrupt the estimate.
 */
export function noteServerTime(serverTs: number, clientNow: number = Date.now()): void {
  if (!Number.isFinite(serverTs) || serverTs <= 0) return;
  if (!Number.isFinite(clientNow)) return;

  if (samples === 0) {
    windowStart = clientNow;
  } else if (clientNow - windowStart >= SKEW_WINDOW_MS) {
    // Roll the buckets: this window becomes "previous", and a fresh minimum starts collecting.
    prevMin = curMin;
    curMin = Number.POSITIVE_INFINITY;
    windowStart = clientNow;
  }
  const delta = clientNow - serverTs;
  if (delta < curMin) curMin = delta;
  samples++;
}

/**
 * Best estimate of (tablet clock − server clock) in ms. Positive means the tablet is AHEAD.
 * 0 before the first sample — i.e. the uncorrected client clock, never worse than today's behaviour.
 */
export function serverSkewMs(): number {
  const m = Math.min(curMin, prevMin);
  return Number.isFinite(m) ? m : 0;
}

/** The current time on the SERVER's clock, as best we can tell. Use this wherever an age is computed
 *  against a `serverTs`. */
export function serverNow(clientNow: number = Date.now()): number {
  return clientNow - serverSkewMs();
}

/** How many timestamps have fed the estimate (0 ⇒ the correction is inert). */
export function serverClockSamples(): number {
  return samples;
}

/** Drop the estimate entirely (tests; and any future "different server" case). */
export function resetServerClock(): void {
  curMin = Number.POSITIVE_INFINITY;
  prevMin = Number.POSITIVE_INFINITY;
  windowStart = 0;
  samples = 0;
}
