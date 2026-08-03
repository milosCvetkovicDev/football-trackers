import { defineConfig, devices } from '@playwright/test';
import { SERVER_PORT, HEALTH_PORT, BROKER_PORT, VITE_PORT, SESSION, PLAYERS, BASE_URL } from './e2e/ports';

/**
 * Playwright config — the Phase-2 e2e + frame-budget GATE for the coach live view.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * STATUS (read this first): these specs are written against the *documented*
 * Phase-2 behaviour and the pinned contracts (src/contracts.ts, src/config.ts),
 * NOT the current half-wired App.tsx. The auth / rendering / connection / a11y
 * streams are wiring useAuth + Login + the App gate in parallel, so a GREEN run is
 * expected only once the integrator wires the auth gate + A11yMirror + DPR canvas +
 * ConnectionState UI into App.tsx. Until then these are the acceptance gate, not a
 * passing suite. See e2e/live.spec.ts + e2e/auth.spec.ts headers for the exact UI hooks.
 * ───────────────────────────────────────────────────────────────────────────────
 *
 * SAME-ORIGIN model (ADR-0015): the browser talks ONLY to the Vite origin
 * (http://localhost:5173). Vite's dev proxy (vite.config.ts) forwards /live (ws),
 * /auth, and /sessions to the Bun server with changeOrigin:false, so the server's
 * STRICT Origin allow-list sees the real browser Origin. There is no cross-origin WS
 * and no bundled token any more — the HttpOnly session cookie rides the upgrade.
 *
 * Determinism comes from the SIMULATOR (server/test/simulate.ts), driven hardware-free:
 *   - the "live"/smoke project runs the simulator `--standalone` (spawns its own
 *     mosquitto + the real server on :3000, metrics/health on :9464) streaming N
 *     players. --standalone (non-secure) sets ALLOW_ANONYMOUS_LIVE=true AND
 *     ANON_SESSIONS=<session> so the anon principal is scoped to THIS session and the
 *     client connects with no login (isolated-LAN posture);
 *   - the "frame-budget" project ramps to 50 players the same way (its own stack);
 *   - the auth-gated specs spin up their OWN stack in e2e/fixtures.ts (withAuthStack):
 *     a coach account + an auth-ON server (no anon), reached through a dedicated Vite
 *     proxy — so the login flow + login-form-when-unauthed states are real, not mocked.
 *
 * Two webServers are started for the default projects:
 *   1. the simulator standalone (anonymous) stack — server + broker + virtual fleet, and
 *   2. the Vite dev server, pointed at that stack via VITE_PROXY_TARGET (same-origin proxy)
 *      with VITE_DEFAULT_SESSION so any admin-wildcard picker prefills this session.
 *
 * BROWSERS: Chromium must be installed once before this gate can run:
 *     bunx playwright install chromium
 * (Not committed; CI installs it — see .github/workflows/client-ci.yml.)
 */

// Ports/identity live in e2e/ports.ts — kept in lockstep with simulate.ts defaults so zero extra
// flags are needed, and SHARED with e2e/fixtures.ts rather than mirrored into it (that file used to
// hold a second hardcoded copy). ports.ts also documents the PW_*_PORT overrides, which are what
// let this gate run on a machine where something else already holds :3000.

// Resolve the simulator + server cwd (../server) relative to this config.
const SERVER_DIR = new URL('../server', import.meta.url).pathname;

const baseURL = BASE_URL;

export default defineConfig({
  testDir: './e2e',
  // The frame-budget sampler runs for several seconds; give specs room but keep CI bounded.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false, // a single shared sim stack + dev server; don't race them
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL,
    trace: 'on-first-retry',
    // Deterministic viewport AND device-pixel-ratio so the "crisp" (DPR) assertion in
    // frame-budget.spec.ts has a known dpr to check the canvas backing store against.
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2, // emulate a retina tablet — the primary target device
  },

  projects: [
    {
      name: 'live',
      testMatch: /live\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], deviceScaleFactor: 2 },
    },
    {
      // Phase 3 (ADR-0017): review/replay. Reuses the SAME shared anonymous standalone webServers as
      // 'live' (below) — the sim has been streaming + PERSISTING fixes into SESSION's SQLite for the
      // whole run, so the /history aggregate query reads real recorded rows (no extra fixture seeding).
      name: 'review',
      testMatch: /review\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], deviceScaleFactor: 2 },
    },
    {
      // auth.spec.ts + cookie-diagnostic.spec.ts both spin their OWN auth-ON stack via fixtures.ts
      // (withAuthStack), so they share the 'auth' project (which does not anon-bypass the login gate).
      name: 'auth',
      testMatch: /(auth|cookie-diagnostic)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], deviceScaleFactor: 2 },
    },
    {
      name: 'frame-budget',
      testMatch: /frame-budget\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], deviceScaleFactor: 2 },
    },
  ],

  // Bring up the deterministic ANONYMOUS stack, then Vite. Playwright waits for each URL to answer.
  // (The auth-gated specs in auth.spec.ts / live.spec.ts spin up their own dedicated stacks in
  // fixtures.ts — they do NOT use these shared webServers, so they can't anon-bypass the login gate.)
  webServer: [
    {
      // The real server + broker + a virtual fleet, hardware-free. --standalone (non-secure) sets
      // ALLOW_ANONYMOUS_LIVE=true AND ANON_SESSIONS=<session> so the anon principal is authorized for
      // exactly this session (anon is scoped to ANON_SESSIONS now — never wildcard) and the client
      // connects without a login. The 50-player frame-budget spec ramps inside its own stack.
      command: `bun run test/simulate.ts --standalone --players ${PLAYERS} --session ${SESSION} --port ${SERVER_PORT} --metrics-port ${HEALTH_PORT} --broker-port ${BROKER_PORT}`,
      cwd: SERVER_DIR,
      env: {
        // Tell the standalone server which Vite origin to admit on the /live upgrade. simulate.ts
        // defaults this to http://localhost:5173, so overriding PW_VITE_PORT without also setting
        // this leaves the server rejecting every upgrade as `reason:"origin"` — the page loads, the
        // canvas renders, and only the feed is missing, which looks like a rendering bug rather
        // than an allow-list mismatch. (fixtures.ts does the same for its dedicated stacks.)
        ALLOWED_ORIGINS: `http://localhost:${VITE_PORT}`,
      },
      // /health flips ok+mqtt:true once the broker subscription is live (the QoS0
      // publish-before-subscribe readiness gate the e2e test relies on too).
      url: `http://127.0.0.1:${HEALTH_PORT}/health`,
      timeout: 30_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // --strictPort: Vite's default is to silently increment past a busy port, which would leave the
      // dev server on :5174 while every spec still targets :5173. Fail loudly instead. (The dedicated
      // stacks in fixtures.ts already do this; the happy path did not.)
      command: `bun run dev -- --port ${VITE_PORT} --strictPort`,
      url: baseURL,
      env: {
        // Same-origin model: the browser hits the Vite origin and Vite's dev proxy forwards /live +
        // /auth + /sessions to the server. VITE_PROXY_TARGET is the proxy upstream (NOT a client var —
        // the app never sees it). No VITE_WS_URL / VITE_SESSION_ID / VITE_LIVE_TOKEN any more.
        // 127.0.0.1, NOT localhost: the standalone stack runs in anon mode, and anon mode now defaults
        // the server's bind to the IPv4 loopback (audit §4.1). `localhost` can resolve to ::1 first, and
        // the proxy would then fail to connect to a server that is demonstrably up — which surfaces as a
        // blank feed rather than a connection error.
        VITE_PROXY_TARGET: `http://127.0.0.1:${SERVER_PORT}`,
        // Prefill for the admin-wildcard session picker only; coaches/anon get their sessions from
        // the principal / ANON_SESSIONS. Kept aligned with the session the standalone stack streams.
        VITE_DEFAULT_SESSION: SESSION,
      },
      timeout: 30_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
