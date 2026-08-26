/**
 * reliability.spec.ts — the Phase-5 coach-view reliability gate (audit C-1, C-2, and the §6
 * "Client" group: error boundaries, touch targets).
 *
 * These are the failures a coach meets on a touchline, not in a browser on a desk:
 *
 *   C-1  NO NTP ON A MATCH-DAY LAN. Every freshness decision compares the TABLET's clock against a
 *        SERVER-stamped timestamp. A tablet ten seconds fast renders an EMPTY PITCH over a perfectly
 *        healthy feed; a tablet slow keeps a dead tracker's dot alive forever. Proven here by moving
 *        the browser's clock 30 s before the app loads and demanding the pitch still populate.
 *
 *   C-2  A TERMINAL RECONNECT GIVE-UP. Eight capped retries and then nothing, for the rest of the
 *        match, with no button and no `online` listener — recovery existed only by accident (toggle
 *        to Review and back). Proven here the only honest way: kill the real server, watch the view
 *        give up IN TEXT, restart it, press the button, and require the feed to come back.
 *
 *   §6   REVIEW CRASHES THE WHOLE ROOT. The ErrorBoundary wrapped only the live canvas, so a throw
 *        inside Review white-screened everything with no way back but a reload. Proven by inducing a
 *        real render throw (a DEV-only switch, dead-code-eliminated from production builds — see the
 *        `client-ci` bundle guard) and demanding the shell survive with a way back to Live.
 *
 *   §6   TOUCH TARGETS ~24 px. WCAG 2.5.5 asks for 44. A coach taps these with gloves, in the rain,
 *        on a bouncing tablet.
 *
 * This spec runs its OWN stack on dedicated ports (3203/9477/1897/5275), because it kills and restarts
 * the server and must not touch the shared happy-path stack other specs are using. The stack is
 * anon-capable with a coach account provisioned: the live pitch survives a server restart (auth
 * sessions are in-memory, a known Phase-6 item, so a cookie-authed page would come back to a login
 * form and the reconnect test would be measuring session loss instead of reconnection), while the
 * Review test signs in for real, because Phase 2 scoped the anonymous principal to the live pitch.
 */
import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { withRestartableStack, type RestartableAuthStack } from './fixtures';

const PORTS = { serverPort: 3203, healthPort: 9477, brokerPort: 1897, vitePort: 5275 };

let stack: RestartableAuthStack | undefined;

test.beforeAll(async () => {
  try {
    stack = await withRestartableStack(PORTS);
  } catch (err) {
    test.skip(true, `reliability stack unavailable: ${(err as Error).message}`);
  }
});

test.afterAll(async () => {
  await stack?.stop();
});

/** Wait for the anonymous live feed (this stack's live pitch needs no login — see fixtures.ts). */
async function waitLive(page: Page): Promise<void> {
  const liveRegion = page.locator('[aria-live="polite"], [role="status"]').first();
  await expect(liveRegion).toContainText(/live/i, { timeout: 30_000 });
}

/**
 * Sign in through the real form. Only the Review test needs this: Phase 2 scoped the anonymous
 * principal to the live pitch, so the Review toggle is not even offered without a named account.
 */
async function signIn(page: Page): Promise<void> {
  await page.getByRole('button', { name: /sign in for names/i }).click();
  await page.getByLabel(/username/i).fill(stack!.creds.username);
  await page.getByLabel(/password/i).fill(stack!.creds.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await waitLive(page);
}

const playerRows = (page: Page) => page.locator('[data-testid="player-row"]');

test.describe('C-1 — a skewed tablet clock must not fake an empty pitch', () => {
  test('a tablet running 30 s FAST still renders the live players', async ({ page }) => {
    test.skip(!stack, 'reliability stack not started');
    // Move the browser's wall clock forward BEFORE any app code runs. Without skew correction every
    // server-stamped fix immediately reads as >10 s old (DROP_MS), the store empties every frame, and
    // the coach sees "connected · waiting for players" over a fleet that is streaming at 10 Hz.
    await page.addInitScript(() => {
      const OFFSET_MS = 30_000;
      const realNow = Date.now.bind(Date);
      Date.now = () => realNow() + OFFSET_MS;
    });
    await page.goto(stack!.baseURL);
    await waitLive(page);

    // The pitch populates: rows exist at all...
    await expect
      .poll(async () => playerRows(page).count(), { timeout: 30_000, intervals: [500] })
      .toBeGreaterThanOrEqual(1);
    // ...and the live region reports players, not the "waiting" state a skewed clock manufactures.
    const liveRegion = page.locator('[aria-live="polite"], [role="status"]').first();
    await expect(liveRegion).toContainText(/live · \d+ player/i, { timeout: 30_000 });

    // The load-bearing number: "Last fix (s)" (cell 3) must read as a FRESH fix — around a tenth of a
    // second — not as ~30. This is what distinguishes "the correction worked" from "the rows happen to
    // still be there"; an uncorrected clock reports the whole offset as the fix's age.
    await expect
      .poll(
        async () => {
          const texts = await playerRows(page).first().locator('td').allInnerTexts();
          return Number.parseFloat((texts[3] ?? '999').trim());
        },
        { timeout: 30_000, intervals: [1_000] },
      )
      .toBeLessThan(5);
  });
});

test.describe('C-2 — a terminal reconnect give-up must be recoverable from the UI', () => {
  test('server dies → "gave up" in text → Reconnect now → the feed returns', async ({ page }) => {
    test.skip(!stack, 'reliability stack not started');
    await page.goto(stack!.baseURL);
    await waitLive(page);
    await expect
      .poll(async () => playerRows(page).count(), { timeout: 30_000, intervals: [500] })
      .toBeGreaterThanOrEqual(1);

    // Kill the real server: the socket drops (1006) and the capped-backoff retries all fail. The
    // stack is started with a SMALL retry budget (VITE_MAX_RECONNECT_ATTEMPTS) so the terminal state
    // is reached in seconds instead of the 37-75 s the field default takes.
    await stack!.stopServer();

    // The give-up must be TEXT on the page — the audit's complaint is that the old terminal state was
    // indistinguishable from a quiet feed.
    await expect(page.getByText(/gave up/i).first()).toBeVisible({ timeout: 40_000 });

    // ...and it must come with a control. Before Phase 5 there was none: the view was dead for the match.
    const retry = page.getByRole('button', { name: /reconnect now/i });
    await expect(retry).toBeVisible();

    // Pressing it while the server is still down is honest about failing again, and does NOT wedge.
    await retry.click();
    await expect(page.getByText(/reconnecting|connecting|disconnected|gave up/i).first()).toBeVisible({
      timeout: 20_000,
    });

    // Bring the server back and press it again: the feed must return — the acceptance criterion.
    await stack!.startServer();
    await expect
      .poll(
        async () => {
          if (await retry.isVisible().catch(() => false)) await retry.click().catch(() => {});
          const region = page.locator('[aria-live="polite"], [role="status"]').first();
          return ((await region.textContent()) ?? '').toLowerCase();
        },
        { timeout: 60_000, intervals: [2_000] },
      )
      .toContain('live');
    await expect
      .poll(async () => playerRows(page).count(), { timeout: 40_000, intervals: [1_000] })
      .toBeGreaterThanOrEqual(1);
  });
});

test.describe('C-2 (checker) — a SILENT stall must be detected, not shown as "live"', () => {
  test('a server that stops answering without closing the socket flips the view out of live', async ({
    page,
  }) => {
    test.skip(!stack, 'reliability stack not started');
    // THE CASE THIS COVERS. The most common way a pitch-side feed dies produces no close event at all:
    // the tablet walks behind the clubhouse, or an AP/NAT drops the flow, and the browser keeps a socket
    // in readyState OPEN forever. Before the watchdog, `conn.phase` stayed 'live', the pitch emptied as
    // every dot aged past DROP_MS, the banner read "connected · waiting for players" — and BOTH Phase-5
    // recovery paths were explicit no-ops in that state. The coach was left with a view that looked
    // connected and was not, which is the exact failure C-2 was supposed to remove.
    //
    // SIGSTOP reproduces it faithfully: the process stops answering while the kernel keeps the socket
    // open, so no FIN or RST ever reaches the browser.
    await page.goto(stack!.baseURL);
    await waitLive(page);
    await expect
      .poll(async () => playerRows(page).count(), { timeout: 30_000, intervals: [500] })
      .toBeGreaterThanOrEqual(1);

    const pids = execSync(`lsof -ti tcp:${PORTS.serverPort} -sTCP:LISTEN || true`)
      .toString()
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    expect(pids.length, 'expected to find the stack server listening').toBeGreaterThan(0);

    execSync(`kill -STOP ${pids.join(' ')}`);
    try {
      // Within a bounded time the view must STOP claiming to be live and offer the way out. The
      // watchdog fires after LIVE_STALL_MS (15 s) of silence on a socket that had been carrying data.
      await expect(page.getByRole('button', { name: /reconnect now/i })).toBeVisible({ timeout: 40_000 });
      // ...and the banner must no longer read as a healthy connection.
      const region = page.locator('[aria-live="polite"], [role="status"]').first();
      await expect(region).not.toContainText(/live · \d+ player/i);
    } finally {
      execSync(`kill -CONT ${pids.join(' ')}`);
    }

    // Once the server answers again the feed comes back on its own (or on one press).
    const retry = page.getByRole('button', { name: /reconnect now/i });
    await expect
      .poll(
        async () => {
          if (await retry.isVisible().catch(() => false)) await retry.click().catch(() => {});
          const region = page.locator('[aria-live="polite"], [role="status"]').first();
          return ((await region.textContent()) ?? '').toLowerCase();
        },
        { timeout: 60_000, intervals: [2_000] },
      )
      .toContain('live');
  });
});

test.describe('§6 — a Review crash must not white-screen the coach view', () => {
  test('an induced Review throw renders the boundary, and Live is still reachable', async ({ page }) => {
    test.skip(!stack, 'reliability stack not started');
    // The DEV-only crash switch: it exists solely so this failure can be exercised for real rather
    // than mocked. `client-ci` asserts the token is absent from a production build.
    await page.goto(`${stack!.baseURL}/?__crash_review=1`);
    await signIn(page);

    await page.getByRole('button', { name: /^review$/i }).click();

    // The boundary shows an alert with actionable text...
    const alert = page.getByRole('alert').first();
    await expect(alert).toBeVisible({ timeout: 20_000 });
    await expect(alert).toContainText(/review/i);

    // ...the SHELL SURVIVES — this is the whole difference from the pre-Phase-5 behaviour, where the
    // root boundary caught the throw and replaced the entire page.
    await expect(page.getByRole('heading', { name: /football-trackers/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^live$/i })).toBeVisible();

    // ...and going back to Live actually works (a dead-end alert would be no better than a reload).
    await page.getByRole('button', { name: /^live$/i }).click();
    await expect(page.locator('canvas')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});

test.describe('§6 — the pitch config is untrusted, and its failure must not be a false claim', () => {
  test('a player OUTSIDE the pitch is drawn and named, not silently clipped', async ({ page }) => {
    test.skip(!stack, 'reliability stack not started');
    // Since the simulator publishes its own corners, the happy path no longer exercises the off-pitch
    // branch at all — a checker completeness note. Strip the pitch out of the config response and the
    // client falls back to its built-in corners, 7 km away, so every simulated player IS off-pitch.
    // That is both the off-pitch render path AND the "server serves a pitch the client won't use" path.
    await page.route('**/sessions/*/config', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      delete body.pitch;
      await route.fulfill({ response: res, json: body });
    });
    await page.goto(stack!.baseURL);
    await waitLive(page);

    // The players are still TRACKED (the HUD counts them)...
    await expect
      .poll(async () => playerRows(page).count(), { timeout: 30_000, intervals: [500] })
      .toBeGreaterThanOrEqual(1);
    // ...and every one of them SAYS it is off the pitch, in words. Before Phase 5 they were clipped
    // into invisibility while the HUD kept counting them — "11 players" over a pitch showing none.
    await expect
      .poll(
        async () => {
          const texts = await playerRows(page).first().locator('td').allInnerTexts();
          return texts[1] ?? '';
        },
        { timeout: 30_000, intervals: [1_000] },
      )
      .toMatch(/off pitch/i);
    // The footer must also stop claiming the outline is measured.
    await expect(page.getByText(/No measured pitch for this session yet/i)).toBeVisible();
  });

  test('a FAILED config read says so — it never claims the pitch is unmeasured', async ({ page }) => {
    test.skip(!stack, 'reliability stack not started');
    // One blip used to strand the coach on the placeholder pitch and U14 zones for the whole match,
    // with the footer asserting — as fact — that no pitch was configured. Fail every read until the
    // retry budget is spent, then require the honest wording.
    //
    // A FLAG, not a call count: React 19 StrictMode double-invokes the effect in dev, so the number of
    // requests is not something a test should encode.
    let failing = true;
    await page.route('**/sessions/*/config', async (route) => {
      if (failing) return route.abort('failed');
      return route.fallback();
    });
    await page.goto(stack!.baseURL);
    await waitLive(page);

    await expect(page.getByText(/Couldn’t load this session’s setup/i)).toBeVisible({ timeout: 40_000 });
    // The wording that would be a lie: we cannot claim the pitch is unmeasured when we never asked.
    await expect(page.getByText(/No measured pitch for this session yet/i)).toHaveCount(0);

    // ...and once the network is back, the browser's `online` event triggers a fresh read that lands
    // the real corners — so the coach is not stranded for the rest of the match.
    failing = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByText(/this session’s measured corners/i)).toBeVisible({ timeout: 30_000 });
  });
});

test.describe('§6 — touch targets are usable with gloves on a wet tablet', () => {
  test('every control on the live view is at least 44x44 CSS px (WCAG 2.5.5)', async ({ page }) => {
    test.skip(!stack, 'reliability stack not started');
    await page.goto(stack!.baseURL);
    await waitLive(page);

    const controls = page.locator('button:visible, select:visible, input:visible');
    const n = await controls.count();
    expect(n).toBeGreaterThan(0); // not vacuous: there ARE controls on this page
    const tooSmall: string[] = [];
    for (let i = 0; i < n; i++) {
      const c = controls.nth(i);
      const box = await c.boundingBox();
      const label = ((await c.textContent()) ?? (await c.getAttribute('aria-label')) ?? `#${i}`).trim();
      if (!box) continue;
      if (box.width < 44 || box.height < 44) {
        tooSmall.push(`"${label}" ${Math.round(box.width)}x${Math.round(box.height)}`);
      }
    }
    expect(tooSmall, `controls below the 44x44 minimum: ${tooSmall.join(', ')}`).toEqual([]);
  });
});
