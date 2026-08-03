/**
 * auth.spec.ts — Phase-2 named-login flow + the session-authz gate (ADR-0015/0008).
 *
 * Runs against an AUTH-ON stack (e2e/fixtures.ts `withAuthStack`): a provisioned coach account, a
 * server that REQUIRES login (no anonymous bypass), and an attach-mode simulator streaming the
 * coach's assigned session — all behind a dedicated SAME-ORIGIN Vite proxy. So every assertion is
 * driven by the real server (real cookie, real /live authz), not a mock.
 *
 * ┌─ WHAT THE INTEGRATOR MUST WIRE FOR THIS TO GO GREEN ───────────────────────────┐
 * │ App.tsx is mid-integration onto useAuth + Login (the auth gate). These encode    │
 * │ the *documented Phase-2 target* (docs/frontend/phase-2-auth-contract.md §7) and  │
 * │ the pinned src/contracts.ts + the shipped src/Login.tsx / src/useAuth.ts.        │
 * │                                                                                  │
 * │ Expected DOM hooks (stable, role/label-based — no brittle CSS):                  │
 * │  - while anonymous: App renders <Login> — a labelled "Username" + "Password"      │
 * │    input and a "Sign in" submit button. The pitch <canvas> is NOT shown yet.      │
 * │  - a login failure lands in an assertive region (role="alert") as TEXT.           │
 * │  - on success: App swaps to the live shell — a <canvas> + the connection live     │
 * │    region (role="status" / aria-live="polite") from describeConnection().         │
 * └──────────────────────────────────────────────────────────────────────────────┘
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { withAuthStack, type AuthStack } from './fixtures';

/** The login form's username field — matched by its accessible label (Login.tsx), not CSS. */
function usernameField(page: Page): Locator {
  return page.getByLabel(/username/i);
}
/** The password field — accessible label again; never a `input[type=password]` selector. */
function passwordField(page: Page): Locator {
  return page.getByLabel(/password/i);
}
/** The submit button — its accessible name is "Sign in" / "Signing in…" (Login.tsx). */
function submitButton(page: Page): Locator {
  return page.getByRole('button', { name: /sign in/i });
}
/** The connection live region carrying describeConnection()'s label. */
function liveRegion(page: Page): Locator {
  return page.locator('[aria-live="polite"], [role="status"]').first();
}

test.describe('coach auth flow — named login + session authz (auth-on stack)', () => {
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

  test.beforeEach(async ({ page }) => {
    test.skip(!stack, 'auth stack not started');
    await page.goto(stack!.baseURL);
  });

  test('not logged in shows the login form (no live canvas yet)', async ({ page }) => {
    // The app boots, GET /auth/me returns 401 (no cookie), and the gate shows <Login>.
    await expect(usernameField(page)).toBeVisible();
    await expect(passwordField(page)).toBeVisible();
    await expect(submitButton(page)).toBeVisible();
    // The live shell (and its canvas) must NOT be rendered until the coach authenticates.
    await expect(page.locator('canvas')).toHaveCount(0);
  });

  test('bad credentials show an error and stay on the login form', async ({ page }) => {
    await usernameField(page).fill(stack!.creds.username);
    await passwordField(page).fill('the-wrong-password');
    await submitButton(page).click();

    // The server answers 401; useAuth surfaces a non-leaky message into the assertive region.
    const alert = page.getByRole('alert');
    await expect(alert).toContainText(/incorrect|could not sign in|try again/i);

    // Still on the login form — NOT swapped to the live view.
    await expect(usernameField(page)).toBeVisible();
    await expect(passwordField(page)).toBeVisible();
    await expect(page.locator('canvas')).toHaveCount(0);
  });

  test('valid login reaches the live view', async ({ page }) => {
    await usernameField(page).fill(stack!.creds.username);
    await passwordField(page).fill(stack!.creds.password);
    await submitButton(page).click();

    // login → 200 + Set-Cookie (non-Secure over http://localhost) → useAuth confirms via /auth/me →
    // App swaps to the live shell. The coach is assigned to the session the sim streams, so /live is
    // admitted and the feed goes live.
    await expect(page.locator('canvas')).toBeVisible({ timeout: 20_000 });
    await expect(liveRegion(page)).toContainText(/live|connected/i, { timeout: 20_000 });
    // The login form is gone once authed (the form unmounts — no lingering credential inputs).
    await expect(passwordField(page)).toHaveCount(0);
  });

  test('a forbidden session shows the not-authorized state', async ({ page }) => {
    // Drive the app, after login, to a session this coach is NOT assigned to so the /live upgrade is
    // closed 1008 'forbidden session' and the UI reaches the terminal 'forbidden' phase
    // (describeConnection → "not authorized for this session", willRetry=false).
    //
    // HONEST SKIP: the coach gate (contract §7) derives the session from the principal — a coach with
    // one assigned session is AUTO-selected onto it, and the admin-wildcard free-choice picker is not
    // offered to a coach. So the coach UI exposes no path to *choose* a forbidden session, and the
    // client cannot self-drive into the 'forbidden' state. The server-side guarantee (a cookie for an
    // UNASSIGNED session → 1008 'forbidden session' + ft_ws_rejected{reason="not_authorized_for_session"})
    // is covered by server/test/auth-e2e.ts (§8 item f). If a later App revision lets a coach reach a
    // foreign sessionId (e.g. a typed/URL session honored for coaches), assert here:
    //     await login(...); navigate to ?sessionId=<unassigned>;
    //     await expect(liveRegion(page)).toContainText(/not authorized for this session/i);
    //     await expect(page.getByText(/reconnecting/i)).toHaveCount(0);  // terminal, willRetry=false
    test.skip(true, 'coach UI exposes no path to a forbidden session; covered by server/test/auth-e2e.ts (§8 f)');

    await usernameField(page).fill(stack!.creds.username);
    await passwordField(page).fill(stack!.creds.password);
    await submitButton(page).click();
  });
});
