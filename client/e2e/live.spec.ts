/**
 * live.spec.ts — Phase-2 smoke + accessibility + the unauthed-shows-login gate, EXTENDED for Phase 3
 * (ADR-0016 names + ADR-0017 device-health-on-/live + the never-persist-names invariant, §0.1).
 *
 * SAME-ORIGIN model (ADR-0015): the smoke/a11y tests run against the shared ANONYMOUS standalone
 * stack started in playwright.config.ts — the browser hits the Vite origin and Vite's dev proxy
 * forwards /live (cookie-auto-attached) to the server, whose anon principal is scoped to this
 * session via ANON_SESSIONS. No token, no cross-origin WS. The tests below need no code change for
 * that — the proxy is transparent to the page.
 *
 * ┌─ PHASE 3 (this file's additions) ──────────────────────────────────────────────┐
 * │ The standalone stack now ALWAYS provisions a throwaway roster (simulate.ts §7):  │
 * │ each sim player id "01".."NN" maps to a DEV display name "Player 01".."Player NN" │
 * │ in a temp AUTH_ROSTER_FILE the spawned server reads — so the live view renders    │
 * │ NAMES, not bare ids (these are dev fixtures, NOT real children — §0.1 untouched). │
 * │ The new cases assert: (a) the A11yMirror shows a name not the id; (b) the         │
 * │ device-health columns POPULATE (battery/signal cells leave "—") once a status     │
 * │ frame arrives (the sim publishes .../status ~every 5 s); (c) AFTER names render,   │
 * │ neither localStorage nor sessionStorage holds any roster-name value — making the   │
 * │ "names are never persisted" invariant observable, not just declared.              │
 * └──────────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ WHAT THE INTEGRATOR MUST WIRE FOR THIS TO GO GREEN ───────────────────────────┐
 * │ App.tsx is mid-integration (auth gate + A11yMirror + DPR canvas). These          │
 * │ assertions encode the *documented Phase-2 target* (phase-2-auth-contract.md §7,  │
 * │ improvement-plan.md) and the pinned contracts (src/contracts.ts).                │
 * │                                                                                  │
 * │ Expected DOM hooks (stable, role/text-based — no brittle CSS):                   │
 * │  - a <canvas> (the pitch render).                                                │
 * │  - an "Accessible DOM mirror": an element with role="img" and an accessible      │
 * │    name (aria-label) describing the live pitch — the canvas-equivalent for AT.   │
 * │  - an ARIA live region (role="status" / aria-live="polite") carrying the         │
 * │    connection label from contracts.ts describeConnection().                      │
 * │  - inside the mirror, one row per active player. Rows are matched by an           │
 * │    accessible row role (role="row") whose text contains the playerId; the spec    │
 * │    falls back to a [data-testid="player-row"] hook if the team prefers that.      │
 * │                                                                                  │
 * │ The connection labels are NOT free text — they come from describeConnection() in │
 * │ src/contracts.ts: live -> "live · N players".                                    │
 * └──────────────────────────────────────────────────────────────────────────────┘
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { SESSION, PLAYERS, withAuthStack, type AuthStack } from './fixtures';

/**
 * Locate the player rows in the accessible mirror, tolerant of the two reasonable
 * implementations the integrator might pick: ARIA grid rows, or explicit testids.
 */
function playerRows(page: Page): Locator {
  return page.locator('[data-testid="player-row"], [role="row"]');
}

/** Find the accessible mirror (role=img). The plan mandates exactly this for the canvas-equiv. */
function a11yMirror(page: Page): Locator {
  return page.getByRole('img');
}

test.describe('coach live view — smoke + a11y (anonymous simulator stack)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('app shell loads with the page title and a pitch canvas', async ({ page }) => {
    await expect(page).toHaveTitle(/football-trackers/i);
    await expect(page.locator('canvas')).toBeVisible();
    // The header names the live session; the anon stack streams (and is scoped to) SESSION.
    await expect(page.getByText(SESSION, { exact: false })).toBeVisible();
  });

  test('accessible mirror is present: role=img + ARIA live region (a11y gate)', async ({
    page,
  }) => {
    // role="img" canvas-equivalent with an accessible name.
    const mirror = a11yMirror(page);
    await expect(mirror).toBeVisible();
    await expect(mirror).toHaveAccessibleName(/.+/); // non-empty aria-label

    // A polite live region announces connection status by TEXT (not colour alone).
    const liveRegion = page.locator('[aria-live="polite"], [role="status"]').first();
    await expect(liveRegion).toBeAttached();
  });

  test('under the live feed, the mirror shows a row per active player', async ({ page }) => {
    // The sim streams PLAYERS players @10 Hz; the live region should report "live · N players"
    // (describeConnection -> phase 'live', activePlayers > 0). Give the WS + first fixes a moment.
    const liveRegion = page.locator('[aria-live="polite"], [role="status"]').first();
    await expect(liveRegion).toContainText(/live/i, { timeout: 20_000 });

    // One row per active player. Players ramp in as their first fix arrives; assert we reach
    // a healthy majority of the fleet (some may be momentarily stale at any instant).
    await expect
      .poll(async () => playerRows(page).count(), { timeout: 20_000, intervals: [500] })
      .toBeGreaterThanOrEqual(Math.ceil(PLAYERS * 0.5));

    // Rows are keyed by playerId — the sim ids are "01".."NN". At least player "01" is present.
    await expect(playerRows(page).filter({ hasText: /\b0?1\b/ }).first()).toBeVisible();
  });

  // ── Phase 3 (ADR-0016): the standalone stack now provisions a roster, so the mirror renders NAMES.
  test('the mirror shows player NAMES (ADR-0016), not bare ids', async ({ page }) => {
    // Wait for the feed to go live and at least one row to appear (the name join is render-only:
    // displayName ?? playerId — A11yMirror.tsx — so a populated roster turns "01" into "Player 01").
    const liveRegion = page.locator('[aria-live="polite"], [role="status"]').first();
    await expect(liveRegion).toContainText(/live/i, { timeout: 20_000 });
    await expect
      .poll(async () => playerRows(page).count(), { timeout: 20_000, intervals: [500] })
      .toBeGreaterThanOrEqual(1);

    // The sim maps id "01".."NN" → "Player 01".."Player NN" (simulate.ts §7). At least one dev name
    // must show in the mirror — proving the roster fetch + render-only join landed (NOT just the id).
    await expect(page.getByText(/Player 0\d/).first()).toBeVisible({ timeout: 20_000 });
  });

  // ── Phase 3 (§2): the second /live envelope ({event:'status'}) populates the device-health columns.
  test('device-health columns POPULATE after status frames arrive (§2)', async ({ page }) => {
    const liveRegion = page.locator('[aria-live="polite"], [role="status"]').first();
    await expect(liveRegion).toContainText(/live/i, { timeout: 20_000 });
    await expect
      .poll(async () => playerRows(page).count(), { timeout: 20_000, intervals: [500] })
      .toBeGreaterThanOrEqual(1);

    // The mirror's first data row carries Battery/Signal/GPS/Device cells. They start as "—" and must
    // POPULATE once a {event:'status'} frame arrives for that player (the sim publishes .../status
    // ~every 5 s; the health columns stay "—" forever if parseLiveFrame silently drops status frames).
    // Assert the row has at least one cell whose text is no longer the "—" placeholder — i.e. real
    // battery / signal / GPS / device-health data. Poll generously: a status frame is ~5 s cadence.
    const firstRow = playerRows(page).first();
    await expect
      .poll(
        async () => {
          // Cells per A11yMirror.tsx: Player | Status | Speed | LastFix | Battery | Signal | GPS | Device.
          // Battery (idx 4), Signal (idx 5), GPS (idx 6), Device (idx 7) are the health cells.
          const cells = firstRow.locator('td');
          const texts = await cells.allInnerTexts();
          // health cells are indices 4..7; count how many are NOT the em-dash placeholder.
          const health = texts.slice(4, 8).map((t) => t.trim());
          return health.filter((t) => t.length > 0 && t !== '—').length;
        },
        { timeout: 30_000, intervals: [1_000] },
      )
      .toBeGreaterThanOrEqual(1);

    // Be concrete about WHICH columns filled: the GPS cell reports "3D · N sats" once a status frame
    // lands (the sim sends fix:3, sats 9..12 — A11yMirror.gpsText), and Battery shows a "%"/"V" value.
    await expect(firstRow.getByText(/3D · \d+ sats/).first()).toBeVisible({ timeout: 30_000 });
  });

  // ── Phase 4 (ADR-0019): the mirror gains a Zone WORD + a live Distance value per tracked player.
  test('the mirror shows a speed-zone WORD + a live Distance for a tracked player (§3.4)', async ({
    page,
  }) => {
    const liveRegion = page.locator('[aria-live="polite"], [role="status"]').first();
    await expect(liveRegion).toContainText(/live/i, { timeout: 20_000 });
    await expect
      .poll(async () => playerRows(page).count(), { timeout: 20_000, intervals: [500] })
      .toBeGreaterThanOrEqual(1);

    // The Zone column carries a WORD (walk/jog/run/HSR/sprint) — colour is a redundant extra (a11y). The
    // session-config endpoint resolves the band (the standalone stack provisions one), but even without it
    // the client falls back to U14 DEFAULT_THRESHOLDS, so a zone word ALWAYS renders for a moving player.
    await expect(
      page.getByText(/\b(walk|jog|run|HSR|sprint)\b/).first(),
    ).toBeVisible({ timeout: 20_000 });

    // The Distance (m) cell is the per-player LIVE running accumulator (§3.3). It starts "—" and POPULATES
    // once the player has moved enough accepted fixes (the sim streams believable movement at 10 Hz). The
    // appended Phase-4 cells are Zone (idx 8) | Distance (idx 9) | Dist/min (idx 10) — Battery..Device stay
    // at 4..7 so the Phase-3 health-column test is unaffected. Assert the Distance cell shows a number.
    const firstRow = playerRows(page).first();
    await expect
      .poll(
        async () => {
          const cells = firstRow.locator('td');
          const texts = await cells.allInnerTexts();
          const distanceCell = (texts[9] ?? '').trim(); // Distance (m) column
          // A populated distance is a number with optional thousands separators (e.g. "1,234"); "—" / "" not.
          return /^\d[\d,]*$/.test(distanceCell);
        },
        { timeout: 30_000, intervals: [1_000] },
      )
      .toBe(true);
  });

  // ── Phase 3 (§0.1): names render, but are NEVER persisted (localStorage/sessionStorage scrape).
  test('rendered names are NEVER persisted to local/session storage (§0.1)', async ({ page }) => {
    const liveRegion = page.locator('[aria-live="polite"], [role="status"]').first();
    await expect(liveRegion).toContainText(/live/i, { timeout: 20_000 });

    // First PROVE a name actually rendered — otherwise the scrape below would pass vacuously (no name
    // could leak if no name was ever resolved). The roster fetch + render-only join must have happened.
    await expect(page.getByText(/Player 0\d/).first()).toBeVisible({ timeout: 20_000 });

    // Now scrape EVERY localStorage + sessionStorage value the page holds and assert no roster-name
    // value is in any of it. useRoster keeps the map in memory (useState) ONLY — §1.5/ADR-0016 — so a
    // "Player 0…" substring anywhere in client persistence is a leak of a child-name surface.
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
    // The dev fixture names all share the "Player 0" prefix (Player 01..09) and "Player 1" (10..12);
    // the canonical leak probe in the contract is the "Player 0" substring — assert it's absent. Also
    // assert the broader "Player " prefix is absent so a two-digit name (Player 10+) can't slip through.
    expect(persisted).not.toContain('Player 0');
    expect(persisted).not.toContain('Player 1');
  });
});

test.describe('explicit failure state — auth-on server, no session/login', () => {
  // Phase 2 replaces the old token-gated "1008 unauthorized in the UI" check. The user-facing
  // "you must log in" state is now the LOGIN FORM, not an in-canvas unauthorized banner — App gates
  // on auth BEFORE it opens /live, so an unauthenticated coach never gets a socket to be rejected on.
  // (The server-side 1008 'unauthorized' WS path itself is covered by server/test/auth-e2e.ts.)
  let stack: AuthStack | undefined;

  test.beforeAll(async () => {
    try {
      stack = await withAuthStack();
    } catch (err) {
      // mosquitto/bun not available in this sandbox -> skip honestly rather than false-fail.
      test.skip(true, `auth stack unavailable: ${(err as Error).message}`);
    }
  });

  test.afterAll(() => {
    stack?.stop();
  });

  test('with no session/login the app shows the login form, not a silent spinner', async ({
    page,
  }) => {
    test.skip(!stack, 'auth stack not started');
    await page.goto(stack!.baseURL);

    // GET /auth/me → 401 (no cookie); the gate must show <Login> — a real, actionable form — and must
    // NOT sit on "connecting…/reconnecting…" forever (the old silent infinite reconnect bug).
    await expect(page.getByLabel(/username/i)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel(/password/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();

    // Negative assertions: the app is NOT stuck on a connection spinner, and there is no live canvas
    // (no /live socket is opened until the coach authenticates).
    await expect(page.getByText(/reconnecting/i)).toHaveCount(0);
    await expect(page.getByText(/^connecting/i)).toHaveCount(0);
    await expect(page.locator('canvas')).toHaveCount(0);
  });
});
