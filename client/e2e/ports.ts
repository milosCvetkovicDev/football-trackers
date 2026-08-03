/**
 * ports.ts — the single source of truth for the happy-path e2e stack's ports.
 *
 * WHY A MODULE RATHER THAN TWO CONSTANTS. playwright.config.ts starts the stack and e2e/fixtures.ts
 * tells the specs where to find it. Those numbers were previously written out in both files and kept
 * "in lockstep" by comment — an invariant nothing enforced, and one that breaks the moment either
 * side becomes configurable. Both now import from here, so an override moves the server and the
 * specs together or not at all.
 *
 * WHY OVERRIDABLE AT ALL. Port 3000 is popular: any other stack already holding it (a work docker
 * compose, another dev server) makes the entire gate unrunnable, and Playwright reports it as
 * "Process from config.webServer was not able to start" — which reads like a broken product rather
 * than a busy socket. The override is the difference between "run the gate on a different port" and
 * "shut down whatever else you were doing".
 *
 *     PW_SERVER_PORT=3300 PW_HEALTH_PORT=9564 PW_BROKER_PORT=1984 PW_VITE_PORT=5373 bun run e2e
 *
 * The dedicated stacks in fixtures.ts (withAnonStack :3210, withAuthStack :3201) keep their own
 * fixed ports — they exist to coexist with this one, and are only reachable from inside a spec.
 *
 * ⚠ TWO THINGS TO KNOW WHEN YOU OVERRIDE A PORT:
 *
 * 1. Moving PW_VITE_PORT also moves the browser's Origin, and the server's /live allow-list is a
 *    separate setting — simulate.ts defaults ALLOWED_ORIGINS to http://localhost:5173. The config
 *    passes it through for you; if you ever start the stack by hand, pass it yourself or every
 *    upgrade is rejected with reason:"origin" and the page renders an empty pitch that looks like
 *    a rendering bug.
 * 2. `reuseExistingServer` is true outside CI, so Playwright ADOPTS whatever is already answering
 *    on these ports — including a stale dev Vite pointed at a different upstream. If a run fails
 *    oddly right after another run, kill the strays first:
 *        pkill -f vite; pkill -f simulate.ts; pkill -f 'mosquitto -c /tmp/ft-'
 */

/**
 * Strict parse. A typo'd value throws at config load instead of becoming NaN — which `Bun.serve`
 * and Vite both coerce to "pick an arbitrary free port", producing a stack that starts happily on a
 * port no spec will ever connect to. Failing loudly here is the whole point.
 */
function port(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${name}="${raw}" is not a valid TCP port (expected an integer 1-65535)`);
  }
  return n;
}

/** The public server: /live, /auth, /sessions. Proxied to by Vite (same-origin model, ADR-0015). */
export const SERVER_PORT = port('PW_SERVER_PORT', 3000);
/** Loopback-only /health + /metrics. Playwright waits on /health as the stack's readiness gate. */
export const HEALTH_PORT = port('PW_HEALTH_PORT', 9464);
/** The mosquitto the simulator spawns for this stack. */
export const BROKER_PORT = port('PW_BROKER_PORT', 1884);
/** The Vite dev origin — the only origin the browser ever talks to. */
export const VITE_PORT = port('PW_VITE_PORT', 5173);

/** Session id: distinct from any dev session so a stray broker can't bleed into the assertions. */
export const SESSION = 'pw';
/** Smoke/live fleet size (the frame-budget gate ramps to 50 in its own stack). */
export const PLAYERS = 12;

export const BASE_URL = `http://localhost:${VITE_PORT}`;
