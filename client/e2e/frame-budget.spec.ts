/**
 * frame-budget.spec.ts — the 50-player FRAME-BUDGET measurement gate (Phase 1).
 *
 * Two INDEPENDENT assertions, per the plan's adversarial pass
 * (docs/frontend/improvement-plan.md, "crisp AND within-budget verified separately"):
 *
 *   1. WITHIN BUDGET — drive a 50-player live feed, sample REAL frame durations by
 *      instrumenting requestAnimationFrame in-page for a few seconds, and assert p95
 *      frame time is within budget.
 *   2. CRISP — assert the canvas backing store is DPR-scaled: canvas.width ≈ CSS box
 *      width × devicePixelRatio (clamped ≤2 per the plan). DPR is what makes it sharp on
 *      a retina tablet, but it COSTS fill budget (4× the pixels at dpr 2) — which is
 *      exactly why budget and crispness are checked separately, not conflated.
 *
 * ── THRESHOLD & ITS BASIS ────────────────────────────────────────────────────────
 * Budget = p95 frame time ≤ 33 ms.
 *   - The data is only 10 Hz and the plan mandates DECOUPLING render from 60 fps and
 *     CAPPING at ~30 fps (a dirty-flag / ~30 fps cap). 30 fps == 33.3 ms/frame, so a
 *     correctly-capped renderer should sit at ~33 ms between *scheduled* paints, with
 *     the actual work-per-frame far below that. p95 ≤ 33 ms means the loop is keeping
 *     its ~30 fps cadence under the 50-player worst case (the explicit gate target).
 *   - We measure p95 (not mean) so an occasional GC/layout spike doesn't pass a loop
 *     that is actually janky; and we DROP the first ~10 frames (warm-up: first paint,
 *     homography solve, WS ramp-in) so we measure steady state, not startup.
 *   - CI headless Chromium has no real vsync, so rAF can free-run faster than 30 fps;
 *     we therefore assert the budget CEILING (≤33 ms) — a capped, healthy loop stays at
 *     or under it, while a renderer that can't keep up at 50 players blows past it. If
 *     the team later wants to assert the *cap itself* (frames not arriving FASTER than
 *     ~30 fps), that's a separate check noted at the bottom of this file.
 *
 * STATUS: like live.spec.ts, this targets the documented Phase-1 renderer (DPR-crisp,
 * 30-fps-capped, decoupled). It is the integrator's gate, not yet a passing run.
 * Browsers: `bunx playwright install chromium` once before running.
 */
import { test, expect, type Page } from '@playwright/test';
import { withAnonStack, type Stack } from './fixtures';

const LOAD_PLAYERS = 50;
const SAMPLE_MS = 4_000; // sample window (steady state)
const WARMUP_FRAMES = 10; // discard startup frames
const P95_BUDGET_MS = 33; // ~30 fps cap (33.3 ms); see header for the basis
const MAX_DPR_CLAMP = 2; // the plan clamps DPR ≤ 2

interface FrameStats {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

/** Instrument rAF in-page and collect inter-frame deltas over `ms`, then summarise. */
async function sampleFrameStats(page: Page, ms: number, warmup: number): Promise<FrameStats> {
  return page.evaluate(
    ([durationMs, warmupFrames]) =>
      new Promise<FrameStats>((resolve) => {
        const deltas: number[] = [];
        let last = performance.now();
        const start = last;
        function tick(now: number) {
          deltas.push(now - last);
          last = now;
          if (now - start < durationMs) {
            requestAnimationFrame(tick);
          } else {
            const steady = deltas.slice(warmupFrames).sort((a, b) => a - b);
            const at = (q: number) =>
              steady.length ? steady[Math.min(steady.length - 1, Math.floor(q * steady.length))] : 0;
            resolve({
              count: steady.length,
              p50: at(0.5),
              p95: at(0.95),
              max: steady.length ? steady[steady.length - 1] : 0,
            });
          }
        }
        requestAnimationFrame(tick);
      }),
    [ms, warmup] as const,
  );
}

test.describe('50-player frame-budget gate', () => {
  // This spec runs LONG (stack boot + 4 s sample). Give it headroom.
  test.setTimeout(120_000);

  let stack: Stack | undefined;

  test.beforeAll(async () => {
    try {
      stack = await withAnonStack(LOAD_PLAYERS);
    } catch (err) {
      test.skip(true, `50-player stack unavailable: ${(err as Error).message}`);
    }
  });

  test.afterAll(() => {
    stack?.stop();
  });

  test('p95 frame time stays within the ~30 fps budget under 50 players', async ({ page }) => {
    test.skip(!stack, '50-player stack not started');
    await page.goto(stack!.baseURL);

    // Wait until the feed is actually live and players have ramped in, so we measure the
    // real 50-player load — not an idle canvas before the first fixes arrive.
    const liveRegion = page.locator('[aria-live="polite"], [role="status"]').first();
    await expect(liveRegion).toContainText(/live/i, { timeout: 30_000 });
    await expect
      .poll(async () => page.locator('[data-testid="player-row"], [role="row"]').count(), {
        timeout: 30_000,
        intervals: [500],
      })
      .toBeGreaterThanOrEqual(Math.ceil(LOAD_PLAYERS * 0.5));

    const stats = await sampleFrameStats(page, SAMPLE_MS, WARMUP_FRAMES);
    console.log(
      `[frame-budget] 50 players: frames=${stats.count} p50=${stats.p50.toFixed(1)}ms ` +
        `p95=${stats.p95.toFixed(1)}ms max=${stats.max.toFixed(1)}ms (budget p95<=${P95_BUDGET_MS}ms)`,
    );

    expect(stats.count, 'too few frames sampled — render loop may be stalled').toBeGreaterThan(20);
    expect(stats.p95, `p95 frame time exceeded the ~30 fps budget (${P95_BUDGET_MS} ms)`).toBeLessThanOrEqual(
      P95_BUDGET_MS,
    );
  });

  test('canvas backing store is DPR-scaled (crisp), independent of the budget check', async ({
    page,
  }) => {
    test.skip(!stack, '50-player stack not started');
    await page.goto(stack!.baseURL);
    await expect(page.locator('canvas')).toBeVisible();

    // RETRY THE ASSERTIONS, not just a precondition before them.
    //
    // This test failed on CI (main, 2026-08-28) reading `backing=300x150` — the HTML canvas default —
    // against `css=1100x550`, i.e. it measured a canvas whose backing store had not been sized yet.
    // Two things make a single measurement unsafe here, and the first fix (waiting for "no longer
    // 300x150", then measuring) still flaked 2 runs in 5 because it only addressed the second:
    //
    //   1. The live canvas REMOUNTS. Since Phase 5 the pitch quad comes from
    //      GET /sessions/:id/config, so the component first renders at a default aspect and is
    //      replaced when the session's real corners arrive — a brand-new <canvas> at the HTML
    //      default. Any wait-then-measure can straddle that swap. The observed CSS heights differ
    //      between runs (550 before, 712 after) for exactly this reason.
    //   2. `document.querySelector('canvas')` is ambiguous — the app has three (the live pitch and
    //      two in Review) — so "the first canvas" is not a stable identity across a re-render.
    //
    // `toPass` re-runs the measurement AND the assertions together, so a swap mid-check is simply
    // retried, and a genuine violation still fails with the real numbers in the message.
    await expect(async () => {
      const probe = await page.evaluate(() => {
        const c = document.querySelector('canvas') as HTMLCanvasElement | null;
        if (!c) return null;
        const rect = c.getBoundingClientRect();
        return {
          dpr: window.devicePixelRatio,
          cssW: rect.width,
          cssH: rect.height,
          backingW: c.width,
          backingH: c.height,
        };
      });

      expect(probe, 'no canvas found').not.toBeNull();
      const { dpr, cssW, cssH, backingW, backingH } = probe!;
      expect(cssW, 'canvas has no laid-out width yet').toBeGreaterThan(0);

      // The plan clamps DPR <= 2; the effective scale the canvas should use.
      const effDpr = Math.min(dpr, MAX_DPR_CLAMP);

      // Sanity: a retina-emulated context must actually report dpr>1, else this asserts nothing.
      expect(dpr, 'test context is not retina — set deviceScaleFactor:2').toBeGreaterThan(1);

      // Backing store ~= CSS box x effective DPR (allow +/-1 device px for rounding). The OLD
      // canvas set width/height to fixed 900x620 ignoring the CSS box & dpr — that FAILS here,
      // which is the point: this gate forces the DPR-crisp rewrite.
      expect(
        Math.abs(backingW - cssW * effDpr),
        `canvas.width (${backingW}) should be CSS width (${cssW.toFixed(1)}) x effDPR (${effDpr})`,
      ).toBeLessThanOrEqual(2);
      expect(
        Math.abs(backingH - cssH * effDpr),
        `canvas.height (${backingH}) should be CSS height (${cssH.toFixed(1)}) x effDPR (${effDpr})`,
      ).toBeLessThanOrEqual(2);

      console.log(
        `[crisp] dpr=${dpr} (eff=${effDpr}) css=${cssW.toFixed(0)}x${cssH.toFixed(0)} ` +
          `backing=${backingW}x${backingH} expected~${Math.round(cssW * effDpr)}x${Math.round(cssH * effDpr)}`,
      );
    }).toPass({ timeout: 20_000, intervals: [100, 250, 500, 1_000] });
  });
});

/*
 * OPTIONAL future assertion — verify the 30-fps CAP itself (not just the ceiling).
 * On hardware with real vsync you can also assert frames don't arrive much FASTER than
 * the cap (e.g. p50 >= ~28 ms), proving render is decoupled from 60 fps. Omitted from the
 * gate because headless CI Chromium has no vsync and free-runs rAF, which would make a
 * lower-bound flaky. Run it locally on the target tablet if you want to confirm the cap.
 */
