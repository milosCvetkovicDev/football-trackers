/**
 * cookie-diagnostic.spec.ts — the "login accepted but the cookie didn't stick" gate (ADR-0015/0008).
 *
 * This is the one failure mode useAuth.login is built to catch that NEITHER a bad-password (401 on
 * POST /auth/login) NOR a happy login exercises: the server ACCEPTS the credentials
 * (POST /auth/login → 200 + principal) but the session cookie is NOT subsequently presented, so the
 * confirming GET /auth/me → 401. In the real world this is a non-Secure cookie silently dropped by
 * the browser over a LAN-IP origin (anything that isn't https:// or http://localhost). useAuth.login
 * must NOT optimistically trust the 200 — it must resolve `{ ok:false, error:<cookie diagnostic> }`
 * so the operator sees the SPECIFIC, actionable "cookie wasn't stored" message, never a generic error
 * and never a false "you're in".
 *
 * Runs against the SAME auth-on stack as auth.spec.ts (e2e/fixtures.ts `withAuthStack`): a real
 * provisioned coach + a server that REQUIRES login. The credentials really are valid (so POST
 * /auth/login really returns 200 + principal — not a mock), and we ONLY intercept the confirming
 * GET /auth/me, forcing it to 401 with page.route. That isolates exactly the cookie-not-stored branch
 * while keeping every other moving part real. We do NOT modify fixtures.ts or auth.spec.ts.
 *
 * Expected DOM hooks (same as auth.spec.ts — stable, role/label-based, no brittle CSS):
 *  - while anonymous: <Login> with labelled "Username"/"Password" + a "Sign in" button; no <canvas>.
 *  - a login failure lands in a role="alert" region as TEXT.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { withAuthStack, type AuthStack } from './fixtures';

/** The login form's username field — matched by its accessible label (Login.tsx), not CSS. */
function usernameField(page: Page): Locator {
  return page.getByLabel(/username/i);
}
/** The password field — accessible label again; never an `input[type=password]` selector. */
function passwordField(page: Page): Locator {
  return page.getByLabel(/password/i);
}
/** The submit button — its accessible name is "Sign in" / "Signing in…" (Login.tsx). */
function submitButton(page: Page): Locator {
  return page.getByRole('button', { name: /sign in/i });
}

/**
 * The EXACT diagnostic useAuth.login resolves with when POST /auth/login succeeds but the confirming
 * GET /auth/me is not authenticated (the cookie-not-stored guard, useAuth.ts). Quoted verbatim — the
 * single space-join of the two source string literals — so this gate fails loudly if that user-facing
 * copy ever drifts. The "—" is a U+2014 em dash, matching the source.
 */
const COOKIE_DIAGNOSTIC =
  'Signed in, but the session cookie was not stored — open this app over https:// or ' +
  'http://localhost (in dev, set AUTH_COOKIE_SECURE=false).';

test.describe('login accepted but cookie not stored → specific diagnostic (auth-on stack)', () => {
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

    // Force EVERY GET /auth/me to 401 — both the mount probe and (the one we care about) the post-login
    // confirmation. This is the browser-dropped-cookie case: POST /auth/login still hits the real server
    // and returns 200 + principal, but no session cookie is ever presented on /auth/me. POST /auth/login
    // is deliberately NOT routed, so the server genuinely validates the fixture credentials.
    await page.route('**/auth/me', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ authenticated: false }),
        });
      }
      return route.continue();
    });

    await page.goto(stack!.baseURL);
  });

  test('shows the cookie-not-stored diagnostic, not a generic error and not a false success', async ({
    page,
  }) => {
    // Mount probe (/auth/me → 401) lands us on the login gate.
    await expect(usernameField(page)).toBeVisible();
    await expect(passwordField(page)).toBeVisible();

    // Submit the REAL, VALID fixture credentials → POST /auth/login → 200 + principal (server accepts).
    await usernameField(page).fill(stack!.creds.username);
    await passwordField(page).fill(stack!.creds.password);
    await submitButton(page).click();

    // The confirming GET /auth/me is forced 401 → useAuth.login must resolve { ok:false } and Login
    // must render the EXACT actionable diagnostic into the assertive region — verbatim copy.
    const alert = page.getByRole('alert');
    await expect(alert).toHaveText(COOKIE_DIAGNOSTIC);

    // It must be the SPECIFIC cookie message — never the generic catch-all login error. (loginErrorFor's
    // default; useAuth.ts.) Asserting its absence guards against a regression that swallows the 200→401
    // branch into the generic path.
    await expect(alert).not.toContainText(/could not sign in\. please try again\./i);

    // And NOT a false success: we stay on the login form and no live shell / canvas is mounted, because
    // the principal was never confirmed (probeMe left auth 'anonymous').
    await expect(usernameField(page)).toBeVisible();
    await expect(passwordField(page)).toBeVisible();
    await expect(page.locator('canvas')).toHaveCount(0);
  });
});
