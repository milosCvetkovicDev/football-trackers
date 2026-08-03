/**
 * review.spec.ts — Phase-3 review/replay e2e gate (ADR-0017 + ADR-0016 names in the aggregate table).
 *
 * SAME-ORIGIN model (ADR-0015): runs against a DEDICATED AUTH-ON stack (fixtures.ts withAuthStack) —
 * the browser hits the Vite origin and Vite's dev proxy forwards /sessions/:id/history and /events
 * (cookie-auto-attached) to the server.
 *
 * WHY NOT THE SHARED ANONYMOUS STACK, which this spec used to use: Phase 2 (audit §4.1) scoped the
 * anonymous principal to the LIVE PITCH. /history is a bulk export of raw child location and /roster
 * hands out names, so both now answer 403 login_required without a real account — and App.tsx hides
 * the Review toggle entirely for an anonymous principal, because offering a control that can only
 * fail reads as a broken app. Review is therefore a signed-in surface, and this spec logs in.
 *
 * The stack's attach-mode simulator streams + PERSISTS fixes into its own SQLite for the whole run, so
 * the review query still reads real recorded rows for SESSION — no separate fixture seeding needed. It
 * also provisions the same throwaway roster + age band the anonymous standalone writes for itself, so
 * the ADR-0016 name join and the Phase-4 provenance header have real data behind them.
 *
 * ┌─ WHAT THIS DRIVES ──────────────────────────────────────────────────────────────┐
 * │ App.tsx exposes a Live ⇄ Review toggle (role="group" aria-label="View mode") once │
 * │ a session is selected (the fixture coach is assigned exactly one session, so it    │
 * │ auto-selects and the toggle is present after login). Clicking "Review" mounts      │
 * │ <ReviewView>:                                                                      │
 * │   - a per-player AGGREGATE TABLE (rows: [data-testid="aggregate-row"]) whose Player │
 * │     column is the render-only name join (displayName ?? playerId — §1.5); the sim   │
 * │     roster maps "01".."NN" → "Player 01".."Player NN", so a NAME must show.          │
 * │   - an occupancy HEATMAP <canvas role="img"> on the shared pitch geometry (ADR-0017 │
 * │     "one renderer, two modes"); occupancy-only, NO identity.                         │
 * │                                                                                     │
 * │ The default window is "now − 90 min … now"; a freshly-started sim stamps every row  │
 * │ at server-receive time ≈ now, so the default window captures the run. The spec is   │
 * │ resilient: it waits generously for the aggregate fetch (the read shares the one     │
 * │ event loop with ingest), and the window already spans the whole short run.          │
 * └──────────────────────────────────────────────────────────────────────────────┘
 *
 * Browsers: `bunx playwright install chromium` once before running (see playwright.config.ts header).
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { SESSION, withAuthStack, type AuthStack } from './fixtures';

/** The Live ⇄ Review toggle group (App.tsx renders role="group" aria-label="View mode"). */
function viewModeGroup(page: Page): Locator {
  return page.getByRole('group', { name: /view mode/i });
}
/** The "Review" toggle button inside that group. */
function reviewToggle(page: Page): Locator {
  return viewModeGroup(page).getByRole('button', { name: /^review$/i });
}
/** The review shell — a <section aria-label="Match review"> (ReviewView.tsx). */
function reviewSection(page: Page): Locator {
  return page.getByRole('region', { name: /match review/i });
}
/** Per-player aggregate rows (ReviewView.AggregateTable marks each row [data-testid="aggregate-row"]). */
function aggregateRows(page: Page): Locator {
  return page.locator('[data-testid="aggregate-row"]');
}
/** The occupancy heatmap (role="img" canvas with an "Occupancy heatmap…" accessible name). */
function heatmap(page: Page): Locator {
  return page.getByRole('img', { name: /occupancy heatmap/i });
}
/** The Phase-4 age-band provenance note (ReviewView renders role="note" "thresholds: <band>"). */
function provenanceNote(page: Page): Locator {
  return page.getByRole('note', { name: /speed-zone thresholds provenance/i });
}
/** A Phase-4 per-player zone-distance breakdown bar (role="img" "Zone distance breakdown: …"). */
function zoneBreakdown(page: Page): Locator {
  return page.getByRole('img', { name: /zone distance breakdown/i });
}

test.describe('coach review/replay — aggregate table + heatmap (signed-in coach)', () => {
  let stack: AuthStack | undefined;

  test.beforeAll(async () => {
    try {
      // Dedicated ports so this stack can never collide with the shared happy path (3000/9464/1884/5173),
      // the auth stack live.spec.ts uses (3201/9466/1885/5273), or the frame-budget one (3210/9474/1894/5283).
      stack = await withAuthStack({ serverPort: 3202, healthPort: 9476, brokerPort: 1896, vitePort: 5274 });
    } catch (err) {
      // mosquitto/bun not available in this sandbox -> skip honestly rather than false-fail.
      test.skip(true, `auth stack unavailable: ${(err as Error).message}`);
    }
  });

  test.afterAll(() => {
    stack?.stop();
  });

  test.beforeEach(async ({ page }) => {
    test.skip(!stack, 'auth stack not started');
    await page.goto(stack!.baseURL);

    // Review needs a REAL login now (audit §4.1): /history and /roster refuse the anon principal, and
    // the toggle this whole spec drives is hidden without a named account. Log in through the real form.
    await page.getByLabel(/username/i).fill(stack!.creds.username);
    await page.getByLabel(/password/i).fill(stack!.creds.password);
    await page.getByRole('button', { name: /sign in/i }).click();

    // Wait for the live shell to settle (the fixture coach has exactly one session, so it auto-selects
    // and the View-mode toggle is present). The header names the live session — a cheap "app is up" gate.
    await expect(page.getByText(SESSION, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    // Give the simulator a beat to publish + PERSIST some fixes before we read them back (the review
    // query reads the same SQLite the sim is writing). The live region going "live" proves fixes flow.
    const liveRegion = page.locator('[aria-live="polite"], [role="status"]').first();
    await expect(liveRegion).toContainText(/live/i, { timeout: 30_000 });
  });

  test('the Live ⇄ Review toggle is present once a session is selected', async ({ page }) => {
    await expect(viewModeGroup(page)).toBeVisible();
    await expect(reviewToggle(page)).toBeVisible();
    // Live is the default mode (aria-pressed); the canvas live view is showing.
    await expect(page.locator('canvas')).toBeVisible();
  });

  test('clicking Review renders the aggregate table + occupancy heatmap', async ({ page }) => {
    await reviewToggle(page).click();

    // The review shell mounts and the toggle reflects the new mode.
    await expect(reviewSection(page)).toBeVisible();
    await expect(reviewToggle(page)).toHaveAttribute('aria-pressed', 'true');

    // The aggregate query reads the recorded window. It can momentarily show "Loading match summary…"
    // (shared event loop), then settles to either the table or an explicit empty/error panel. The sim
    // has been streaming into this session's DB for the whole run, so we expect populated aggregates —
    // poll generously for at least one player row (the read + JS accumulation takes a beat).
    await expect
      .poll(async () => aggregateRows(page).count(), { timeout: 30_000, intervals: [1_000] })
      .toBeGreaterThanOrEqual(1);

    // The occupancy heatmap canvas renders on the shared pitch geometry (role="img", occupancy-only).
    await expect(heatmap(page)).toBeVisible({ timeout: 30_000 });
  });

  test('a player NAME shows in the aggregate table (ADR-0016 render-only join)', async ({ page }) => {
    await reviewToggle(page).click();
    await expect(reviewSection(page)).toBeVisible();

    // Wait for the aggregate table to populate.
    await expect
      .poll(async () => aggregateRows(page).count(), { timeout: 30_000, intervals: [1_000] })
      .toBeGreaterThanOrEqual(1);

    // The Player column is the render-only name join (displayName ?? playerId — §1.5). The fixture roster
    // maps id "01".."NN" → "Player 01".."Player NN", so a DEV name must show in a row, not a bare id.
    // This is now also the positive half of the Phase-2 rule: the SAME roster is invisible to the anon
    // principal (live.spec.ts asserts the 403), and visible here because this coach signed in.
    await expect(
      aggregateRows(page).filter({ hasText: /Player 0\d/ }).first(),
    ).toBeVisible({ timeout: 30_000 });
  });

  // ── Phase 4 (ADR-0019): the aggregate gains a per-player zone breakdown + dist/min + a band-provenance
  // header. The standalone server now returns the extended aggregate shape, so these render.
  test('Review shows the zone-breakdown bar + dist/min + the ageBand provenance header (§4.2)', async ({
    page,
  }) => {
    await reviewToggle(page).click();
    await expect(reviewSection(page)).toBeVisible();

    // Wait for the aggregate table to populate (shared event loop — poll generously).
    await expect
      .poll(async () => aggregateRows(page).count(), { timeout: 30_000, intervals: [1_000] })
      .toBeGreaterThanOrEqual(1);

    // Provenance header: "thresholds: <band>" — the band comes from the server aggregate's `ageBand`
    // (top-level provenance, §4.1), or "default" if a pre-Phase-4 server omits it. Either way the note
    // renders with the "thresholds:" label, and the HSR/sprint m/s cuts from the resolved thresholds.
    await expect(provenanceNote(page)).toBeVisible({ timeout: 30_000 });
    await expect(provenanceNote(page)).toContainText(/thresholds:/i);
    await expect(provenanceNote(page)).toContainText(/HSR ≥ [\d.]+ m\/s/);

    // Each player row carries a 5-segment zone-distance breakdown bar (ZONE_COLOR widths = % of distance),
    // exposed to AT as role="img" "Zone distance breakdown: walk … m, jog … m, …". At least one renders
    // (the sim has been streaming gated, moving fixes, so the server's zoneDistanceM is non-empty).
    await expect(zoneBreakdown(page).first()).toBeVisible({ timeout: 30_000 });

    // A dist/min value shows in the Dist/min column (idx 5: Player|Distance|Avg|Max|Zones|Dist/min|…). It
    // is a number once the server supplies distancePerMin for a player who moved over the recorded window.
    await expect
      .poll(
        async () => {
          const cells = aggregateRows(page).first().locator('td');
          const texts = await cells.allInnerTexts();
          const distPerMin = (texts[5] ?? '').trim(); // Dist/min (m) column
          return /^\d[\d,]*$/.test(distPerMin);
        },
        { timeout: 30_000, intervals: [1_000] },
      )
      .toBe(true);
  });

  // ── Track A (ADR-0020): the review surface gains a tactical-events panel — a team-shape series +
  // movement-derived phase events. The panel is honestly labelled (heuristic, not ground truth) and shows the
  // proposed/unvalidated detector params as provenance. The sim has been streaming into this session, so the
  // events read settles to a populated (series-bearing) panel over the default window.
  test('Review shows the tactical-events panel with honesty labelling + provenance (ADR-0020)', async ({
    page,
  }) => {
    await reviewToggle(page).click();
    await expect(reviewSection(page)).toBeVisible();

    // Wait for the aggregate to populate first — that proves recorded fixes exist in the window, so the
    // events read (same window) will have a non-empty team-shape series and render its <section>.
    await expect
      .poll(async () => aggregateRows(page).count(), { timeout: 30_000, intervals: [1_000] })
      .toBeGreaterThanOrEqual(1);

    // The events panel is a <section aria-label="Tactical events"> (only mounted once the read settles to ok).
    const events = page.getByRole('region', { name: /tactical events/i });
    await expect(events).toBeVisible({ timeout: 30_000 });

    // Honesty (§0.5): the panel states these are movement-derived heuristics, NOT confirmed ball events…
    await expect(events).toContainText(/movement-derived heuristics/i);
    // …and shows the proposed/unvalidated structural detector params as provenance (PM-S6).
    await expect(events).toContainText(/proposed thresholds/i);

    // PB-N4: the events panel is team-AGGREGATE — unlike the aggregate table (which shows the render-only name
    // join), it must render NO player identifier/name. Assert no "Player 0X" dev name appears in it.
    await expect(events).not.toContainText(/Player \d/);

    // PM-S5 / PB-2: the events payload carries the team CENTROID over time — child-derived location. It must
    // live in memory only and NEVER persist (matching the server no-store) so it can't survive logout. Scrape
    // EVERY localStorage + sessionStorage value (the live.spec roster-name pattern) and assert no events-payload
    // key leaked into it — a future localStorage.setItem(eventsResult) would put these keys in storage.
    const persisted = await page.evaluate(() => {
      const dump = (s: Storage) => {
        const out: Record<string, string> = {};
        for (let i = 0; i < s.length; i++) {
          const k = s.key(i);
          if (k !== null) out[k] = s.getItem(k) ?? '';
        }
        return out;
      };
      return JSON.stringify({ l: dump(localStorage), s: dump(sessionStorage) });
    });
    for (const key of ['centroid', 'stretchM', 'surfaceAreaM2', 'hsrFraction', 'high_tempo']) {
      expect(persisted).not.toContain(key);
    }
  });

  test('switching back to Live from Review restores the live canvas', async ({ page }) => {
    await reviewToggle(page).click();
    await expect(reviewSection(page)).toBeVisible();

    // The Review surface uses canvases too (heatmap/replay), but switching back to Live must restore the
    // live shell. The Live toggle re-mounts <LiveView> and its pitch canvas + a11y mirror.
    const liveToggle = viewModeGroup(page).getByRole('button', { name: /^live$/i });
    await liveToggle.click();
    await expect(liveToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('canvas')).toBeVisible();
    // The match-review section is gone once we're back on Live.
    await expect(reviewSection(page)).toHaveCount(0);
  });
});
