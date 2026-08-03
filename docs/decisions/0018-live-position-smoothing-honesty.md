# ADR-0018 — Live position smoothing & the interpolation honesty rule

**Status:** Accepted · **Implementation:** shipped 2026-06-15 — [`client/src/render/interpolate.ts`](../../client/src/render/interpolate.ts) (pure, unit-tested honesty rule) + [`PitchCanvas.tsx`](../../client/src/PitchCanvas.tsx); verified by `interpolate.test.ts` and the simulator-driven Playwright gate · **Date:** 2026-06-15

## Context
Player dots are drawn at the latest fix's exact `lat/lon` ([`client/src/PitchCanvas.tsx`](../../client/src/PitchCanvas.tsx)),
so at 10 Hz they teleport, and the wire's `spd`/`hdg` go unused. Smoothing makes the view calmer and more
glanceable on a sunlight tablet — but the rendered position is **a child's real location**, so smoothing must
not fabricate positions a coach acts on. The FE panel's adversarial pass **failed** the absolute claim
"two-fix interpolation never misrepresents position": bounded interpolation still draws a constant-velocity
glide a child did not follow, and the fatal case is **gaps** — the firmware backlog-replay / rate-burst paths
(mirrored in `simulate.ts`) make two *accepted* fixes seconds apart in true position but milliseconds apart in
arrival, so naive interpolation would draw a smooth glide across the pitch that never happened.

## Decision
- **Bounded interpolation only** between two consecutive received fixes whose `serverTs` gap is below
  **~200 ms**; render a damped lerp between them.
- **Snap, don't glide, across gaps.** If the gap exceeds the threshold (dropout / backlog / burst), **snap** to
  the latest fix — never draw a smooth path across a gap.
- **Never extrapolate.** Do not project past the latest fix using `spd`/`hdg`; once `now` passes the newest
  fix, hold at the last real position. `spd`/`hdg` drive the **heading-arrow / speed cue visuals only**, not
  position.
- **Clamp to plausible youth speed (~8 m/s)** so a bad fix can't fling a smoothed dot across the pitch.
- **Stale = explicit, not drifting.** Past `STALE_MS`, freeze at the last **known** position and restyle to an
  explicit "last known" state (hollow ring + age), never a drifting dot; keep the existing stale-fade/drop.
- **Display-only, not ground truth.** The smoothed path is presentation; review/replay UIs must not imply
  measured accuracy from it.
- **Respect `prefers-reduced-motion`** — fall back to snap (no interpolation) when set.
- **Verify via record/replay** that the smoothed track never diverges materially from the raw fixes
  (`server/test/simulate.ts --record/--replay` → deterministic comparison).

## Consequences
- **+** Calm, glanceable motion without inventing positions — safe for a children's-location feed.
- **+** Gaps and dead devices read honestly (snap / frozen "last known"), not as smooth motion.
- **−** ~100–200 ms display latency (holds the newest fix briefly) and per-player two-fix buffering.
- **−** Slightly more render logic than snap-only.

## Alternatives considered
- **Raw snap-only (status quo)** — rejected: jittery/teleporting; poor glance on the target tablet.
- **Free-running dead-reckoning on `spd`/`hdg`** — rejected: fabricates positions a coach would act on.
- **Unbounded interpolation across any two fixes** — rejected: draws glides across dropout gaps that never
  happened (the exact failure the adversarial pass caught).
