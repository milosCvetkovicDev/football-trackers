/**
 * serverClock.test.ts — Phase 5 unit gate for the clock-skew estimator (audit C-1).
 *
 * THE FAILURE THIS PREVENTS. There is no NTP on an isolated match-day LAN, so the coach's tablet
 * clock and the server clock disagree by whatever each drifted to. Every freshness decision in the
 * client (`now - serverTs` vs STALE_MS/DROP_MS) is a comparison between the TABLET's clock and a
 * SERVER-stamped timestamp, so a skewed tablet renders one of two lies:
 *   - tablet AHEAD  > DROP_MS → every fix looks older than 10 s → a healthy feed draws an EMPTY pitch;
 *   - tablet BEHIND         → fixes never age out → a DEAD tracker keeps a live dot forever, which is
 *                             precisely the honesty rule ADR-0018 exists to enforce.
 *
 * The estimator is a running MINIMUM of (clientNow - serverTs) over the observed stream: transit
 * latency is always >= 0, so the smallest observed difference is the closest sample to the true
 * offset. The audit's acceptance criterion is pinned below: the corrected clock must land within
 * 100 ms of the true server time under realistic jitter.
 */
import { test, expect, beforeEach } from 'bun:test';
import {
  noteServerTime,
  serverNow,
  serverSkewMs,
  serverClockSamples,
  resetServerClock,
  SKEW_WINDOW_MS,
} from './serverClock';

beforeEach(() => resetServerClock());

test('with no samples the client clock is used unchanged (never worse than today)', () => {
  expect(serverClockSamples()).toBe(0);
  expect(serverSkewMs()).toBe(0);
  expect(serverNow(1_700_000_000_000)).toBe(1_700_000_000_000);
});

test('ACCEPTANCE: a 45 s-ahead tablet is corrected to within 100 ms of true server time', () => {
  // Truth: the server is at T; the tablet reads T + 45 s. Each frame reaches the browser after a
  // small, always-positive transit delay (LAN + proxy + WS + JS), which is what the running min peels off.
  const SKEW = 45_000;
  const trueServerAt = (i: number) => 1_700_000_000_000 + i * 100; // 10 Hz stream
  const latency = [37, 12, 55, 8, 80, 21, 3, 64, 19, 42, 6, 71, 15, 28, 9]; // ms, deterministic "jitter"

  for (let i = 0; i < latency.length; i++) {
    const serverTs = trueServerAt(i);
    const clientNow = serverTs + latency[i] + SKEW; // tablet clock at the moment the frame lands
    noteServerTime(serverTs, clientNow);
  }
  const clientNow = trueServerAt(latency.length) + SKEW;
  expect(Math.abs(serverNow(clientNow) - trueServerAt(latency.length))).toBeLessThanOrEqual(100);
  // ...and the skew it reports is the real one, again within the same 100 ms budget.
  expect(Math.abs(serverSkewMs() - SKEW)).toBeLessThanOrEqual(100);
});

test('a tablet running BEHIND the server is corrected the same way (negative skew)', () => {
  const SKEW = -30_000; // tablet 30 s slow — the "dead tracker stays live forever" case
  const base = 1_700_000_000_000;
  for (let i = 0; i < 12; i++) noteServerTime(base + i * 100, base + i * 100 + 10 + SKEW);
  expect(Math.abs(serverSkewMs() - SKEW)).toBeLessThanOrEqual(100);
  // A fix stamped 12 s ago must READ as ~12 s old, not as "from the future".
  const clientNow = base + 12_000 + SKEW;
  const age = serverNow(clientNow) - base;
  expect(age).toBeGreaterThanOrEqual(11_900);
  expect(age).toBeLessThanOrEqual(12_100);
});

test('a single late sample among honest ones is ignored (that is what the minimum buys)', () => {
  const base = 1_700_000_000_000;
  noteServerTime(base, base + 20); // one honest arrival-stamped sample: skew ~20 ms
  const before = serverSkewMs();
  // A hours-old timestamp makes (clientNow - serverTs) enormous. A running MIN discards it — an
  // average would drag the whole view hours out of date. NB this is only half the protection: see the
  // source-rule tests at the bottom for the case a minimum CANNOT survive.
  noteServerTime(base - 5 * 3_600_000, base + 30);
  expect(serverSkewMs()).toBe(before);
});

test('the estimate follows a real clock change within two windows (it is not a permanent latch)', () => {
  const base = 1_700_000_000_000;
  for (let i = 0; i < 5; i++) noteServerTime(base + i * 100, base + i * 100 + 15);
  expect(Math.abs(serverSkewMs() - 15)).toBeLessThanOrEqual(100);

  // The tablet's clock is stepped forward 60 s (an operator fixing the date, or an RTC catching up).
  // Two window rolls must retire the stale minimum — a plain all-time min would stay wrong forever.
  const STEP = 60_000;
  let t = base + 10_000;
  for (let w = 0; w < 2; w++) {
    for (let i = 0; i < 5; i++) {
      const serverTs = t + i * 100;
      noteServerTime(serverTs, serverTs + 15 + STEP);
    }
    t += SKEW_WINDOW_MS + 1_000;
    noteServerTime(t, t + 15 + STEP); // a sample that lands in the NEXT window, rolling the buckets
  }
  expect(Math.abs(serverSkewMs() - STEP - 15)).toBeLessThanOrEqual(100);
});

test('junk timestamps are ignored rather than corrupting the clock', () => {
  const base = 1_700_000_000_000;
  noteServerTime(base, base + 25);
  const good = serverSkewMs();
  noteServerTime(Number.NaN, base + 30);
  noteServerTime(Number.POSITIVE_INFINITY, base + 30);
  noteServerTime(0, base + 30);
  noteServerTime(-1, base + 30);
  noteServerTime(base + 40, Number.NaN);
  expect(serverSkewMs()).toBe(good);
  expect(serverClockSamples()).toBe(1);
});

test('resetServerClock clears the estimate (session teardown / tests)', () => {
  noteServerTime(1_700_000_000_000, 1_700_000_005_000);
  expect(serverSkewMs()).not.toBe(0);
  resetServerClock();
  expect(serverSkewMs()).toBe(0);
  expect(serverClockSamples()).toBe(0);
});

// --- Phase 5 checker: the SOURCE rule is the load-bearing part -------------------------------------
// The estimator was originally fed by every accepted /live frame, including telemetry. A checker lens
// showed why that is unsafe: a replayed Phase-4 backlog fix carries its GPS time as `serverTs`, so a
// page that loads while a tracker drains its backlog sees ONLY old timestamps — no smaller sample
// exists for the minimum to prefer — and infers an offset of hours. The view then renders stale fixes
// as live dots: a dead tracker that looks alive, the exact dishonesty ADR-0018 forbids.
//
// The fix is the source list (hello + status only, both arrival-stamped), enforced at the call site in
// useLiveTelemetry. This test pins the CONSEQUENCE the source list prevents, so that if telemetry is
// ever wired back in, the behaviour it would cause is documented here as the reason not to.

test('a window of ONLY late samples moves the estimate — which is why telemetry may not feed it', () => {
  const base = 1_700_000_000_000;
  const REPLAY_LAG_MS = 20 * 60_000; // a 20-minute outage being drained
  // Every sample carries an event time 20 min behind arrival (what a backlog drain looks like).
  for (let i = 0; i < 20; i++) {
    const arrival = base + i * 33;
    noteServerTime(arrival - REPLAY_LAG_MS, arrival + 15);
  }
  // The estimate is ~the replay lag, NOT the ~15 ms true skew: a minimum cannot rescue a window whose
  // samples are all late. Hence the rule that only arrival-stamped frames are allowed to feed it.
  expect(serverSkewMs()).toBeGreaterThan(REPLAY_LAG_MS - 1_000);
  // ...and the visible consequence: a fix stamped "now" would read as 20 minutes in the FUTURE, so it
  // could never age out of DROP_MS — a dot that stays live forever.
  const ageOfAFreshFix = serverNow(base + 1_000) - (base + 1_000);
  expect(ageOfAFreshFix).toBeLessThan(-REPLAY_LAG_MS + 1_000);
});

test('one honest arrival-stamped sample in the window is enough to hold the estimate', () => {
  const base = 1_700_000_000_000;
  // A status frame (arrival-stamped) lands among a burst of replayed telemetry-shaped samples.
  noteServerTime(base, base + 12); // the honest one
  for (let i = 0; i < 50; i++) noteServerTime(base - 20 * 60_000 + i, base + 20 + i);
  expect(serverSkewMs()).toBe(12);
});
