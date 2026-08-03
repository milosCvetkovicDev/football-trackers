/**
 * Shared constants + helpers for the Phase-2 e2e gate.
 *
 * SAME-ORIGIN model (ADR-0015): the browser talks ONLY to the Vite origin; Vite's dev proxy
 * (vite.config.ts) forwards /live (ws), /auth, and /sessions to the Bun server with
 * changeOrigin:false, so the server's STRICT Origin allow-list sees the real browser Origin.
 * Each stack therefore launches Vite with `VITE_PROXY_TARGET=http://localhost:<serverPort>`
 * (NOT a cross-origin VITE_WS_URL — that's gone) and tells the server `ALLOWED_ORIGINS=
 * http://localhost:<vitePort>` so the proxied upgrade/POST is admitted.
 *
 * The happy-path stack (anonymous simulator standalone + Vite) is started by
 * playwright.config.ts `webServer`. This module holds:
 *   - the identity/ports the specs assert against (kept in lockstep with the config),
 *   - `withAnonStack(...)`: a SECOND anonymous standalone stack on dedicated ports (the
 *     50-player frame-budget gate uses it so it can't collide with the 12-player happy path), and
 *   - `withAuthStack(...)`: an AUTH-ON stack — a provisioned coach account, a server with login
 *     required (no anon), and an attach-mode simulator streaming the coach's session — so the
 *     real login flow + the login-form-when-unauthed state are driven by a real server, not a mock.
 *
 * Everything is loopback-only; no external network. Browsers must be installed once:
 *     bunx playwright install chromium
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- identity / ports of the happy-path stack ---------------------------------------
// Re-exported from ./ports so the specs and playwright.config.ts read the SAME numbers. These used
// to be a second hardcoded copy "mirroring" the config; the moment the config became overridable
// (PW_SERVER_PORT etc.) that copy would have pointed the specs at a stack that wasn't there.
export { SESSION, SERVER_PORT, HEALTH_PORT, BROKER_PORT, VITE_PORT, PLAYERS, BASE_URL } from './ports';
import { SESSION, PLAYERS } from './ports';

// Resolve sibling dirs relative to this file (client/e2e/).
export const SERVER_DIR = new URL('../../server', import.meta.url).pathname;
export const CLIENT_DIR = new URL('..', import.meta.url).pathname;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForHttp(url: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  return false;
}

async function waitForHealthy(healthPort: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const b = (await (await fetch(`http://127.0.0.1:${healthPort}/health`)).json()) as {
        ok: boolean;
        mqtt: boolean;
      };
      if (b.ok && b.mqtt) return true;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  return false;
}

export interface Stack {
  /** Base URL of the dedicated Vite instance for this stack. */
  baseURL: string;
  /** Tear everything down. */
  stop: () => void;
}

/** An auth-gated stack also exposes the fixture credentials the spec logs in with. */
export interface AuthStack extends Stack {
  creds: { username: string; password: string; session: string };
}

/**
 * Start an ANONYMOUS simulator standalone stack (server + broker + N-player fleet) plus a dedicated
 * Vite, on dedicated ports. Used by the 50-player frame-budget gate so it doesn't collide with the
 * 12-player happy-path stack started in playwright.config.ts.
 *
 * Same-origin: Vite is launched with `VITE_PROXY_TARGET=http://localhost:<serverPort>` and
 * `VITE_DEFAULT_SESSION=<session>` (NOT VITE_WS_URL); the browser hits the Vite origin and the proxy
 * forwards same-origin. simulate.ts --standalone (non-secure) sets ALLOW_ANONYMOUS_LIVE=true AND
 * ANON_SESSIONS=<session> itself (anon is scoped to ANON_SESSIONS now — never wildcard), so passing
 * `--session` is what authorizes the anon principal for this feed. ALLOWED_ORIGINS is still pushed
 * into the sim's server env so the proxied upgrade from this Vite origin is admitted.
 *
 * Requires `mosquitto` + `bun` on PATH. Throws if it doesn't come up; caller should `test.skip`.
 */
export async function withAnonStack(players: number, opts?: {
  serverPort?: number;
  healthPort?: number;
  brokerPort?: number;
  vitePort?: number;
  session?: string;
}): Promise<Stack> {
  const serverPort = opts?.serverPort ?? 3210;
  const healthPort = opts?.healthPort ?? 9474;
  const brokerPort = opts?.brokerPort ?? 1894;
  const vitePort = opts?.vitePort ?? 5283;
  const session = opts?.session ?? 'pwload';
  const baseURL = `http://localhost:${vitePort}`;
  // 127.0.0.1, NOT localhost: this stack is anonymous, and anon mode binds the IPv4 loopback (§4.1);
  // `localhost` may resolve to ::1 first and the proxy would fail against a server that is up.
  const proxyTarget = `http://127.0.0.1:${serverPort}`;

  const procs: ChildProcess[] = [];

  // simulate.ts --standalone spawns its own mosquitto + the real server with ALLOW_ANONYMOUS_LIVE=true
  // and ANON_SESSIONS=<session>, streaming `players` virtual devices @10 Hz.
  const sim = spawn(
    'bun',
    [
      'run',
      'test/simulate.ts',
      '--standalone',
      '--players',
      String(players),
      '--session',
      session,
      '--port',
      String(serverPort),
      '--metrics-port',
      String(healthPort),
      '--broker-port',
      String(brokerPort),
    ],
    // Tell the standalone server to allow THIS stack's Vite origin (non-default port), else /live is
    // rejected 1008 'forbidden origin'. simulate.ts also derives a per-PORT DB path, so this load
    // stack won't collide with the happy-path stack's SQLite file.
    { cwd: SERVER_DIR, stdio: 'ignore', env: { ...process.env, ALLOWED_ORIGINS: `http://localhost:${vitePort}` } },
  );
  procs.push(sim);

  // Dedicated Vite pointed at this stack via the SAME-ORIGIN proxy (no cross-origin WS URL).
  const vite = spawn('bun', ['run', 'dev', '--', '--port', String(vitePort), '--strictPort'], {
    cwd: CLIENT_DIR,
    stdio: 'ignore',
    env: { ...process.env, VITE_PROXY_TARGET: proxyTarget, VITE_DEFAULT_SESSION: session },
  });
  procs.push(vite);

  const stop = () => {
    for (const p of procs) {
      try {
        p.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
  };

  const ready = (await waitForHealthy(healthPort, 40_000)) && (await waitForHttp(baseURL, 30_000));
  if (!ready) {
    stop();
    throw new Error('anonymous simulator stack did not become ready (is mosquitto installed?)');
  }
  return { baseURL, stop };
}

/**
 * Start an AUTH-ON stack: a provisioned coach account + a server that REQUIRES login (no anon) +
 * an attach-mode simulator streaming the coach's assigned session, behind a dedicated same-origin
 * Vite proxy. Drives the real Phase-2 login flow end to end:
 *   - not logged in  → the app shows <Login> (no anon bypass: ALLOW_ANONYMOUS_LIVE is unset).
 *   - valid login    → cookie set (AUTH_COOKIE_SECURE=false over http://localhost) → /live for the
 *                       coach's session → the streamed fleet appears (phase 'live').
 *
 * Provisioning uses the real CLI (server/auth-user.ts) with the password PIPED on stdin (never an
 * argv leak), writing a throwaway AUTH_ACCOUNTS_FILE the server then loads. The coach is assigned to
 * SESSION, which the attach-mode sim streams — so the happy path reaches a live feed, not an empty one.
 *
 * Requires `mosquitto` + `bun` on PATH (same dependency as server/test/auth-e2e.ts). Throws if the
 * stack doesn't come up; the caller should `test.skip` on that so the gate is honest.
 */
export async function withAuthStack(opts?: {
  serverPort?: number;
  healthPort?: number;
  brokerPort?: number;
  vitePort?: number;
}): Promise<AuthStack> {
  // Dedicated ports, distinct from the happy-path (:3000/:9464/:1884/:5173) and the load stack
  // (:3210/:9474/:1894/:5283), so all stacks can coexist without colliding.
  const serverPort = opts?.serverPort ?? 3201;
  const healthPort = opts?.healthPort ?? 9466;
  const brokerPort = opts?.brokerPort ?? 1885;
  const vitePort = opts?.vitePort ?? 5273;
  const baseURL = `http://localhost:${vitePort}`;
  // 127.0.0.1 for the same reason as withAnonStack — this server binds 0.0.0.0 (anon is off), so either
  // would work, but keeping one form across both stacks removes a difference nobody would think to check.
  const proxyTarget = `http://127.0.0.1:${serverPort}`;

  // Fixture coach: an ADULT operator identity (never a child name), assigned to SESSION.
  const creds = { username: 'coach-pw', password: 'pw-e2e-pass', session: SESSION };

  const procs: ChildProcess[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'ft-pw-auth-'));
  const conf = join(dir, 'mosquitto.conf');
  const dbPath = join(dir, 'auth.db');
  const accountsFile = join(dir, 'auth-accounts.json');
  const rosterFile = join(dir, 'roster.json');
  const sessionConfigFile = join(dir, 'session-config.json');

  // Phase-2 (audit §4.1): /roster, /history and /events now require a REAL login — the anonymous
  // principal gets 403 login_required — so this is the only stack where names render and where a
  // review query can succeed. It therefore has to carry the same throwaway fixtures the anonymous
  // standalone writes for itself (simulate.ts §7): "01".."NN" -> "Player 01".."Player NN" and an age
  // band. Without them a migrated spec would fail on an empty roster and look like an authz bug.
  // These are DEV names for pseudonymous sim ids, never a real child's, and live in a temp dir this
  // stack deletes on stop().
  writeFileSync(
    rosterFile,
    JSON.stringify({
      sessions: {
        [SESSION]: Array.from({ length: PLAYERS }, (_, i) => {
          const playerId = String(i + 1).padStart(2, '0');
          return { playerId, displayName: `Player ${playerId}` };
        }),
      },
    }) + '\n',
  );
  writeFileSync(sessionConfigFile, JSON.stringify({ sessions: { [SESSION]: { ageBand: 'U14' } } }) + '\n');

  // Anonymous broker is fine here — the AUTH being tested is the server's cookie /live gate, not the
  // broker ACL (that's covered by server/test/auth-e2e.ts + the sim's --secure mode).
  writeFileSync(conf, `listener ${brokerPort} 127.0.0.1\nallow_anonymous true\n`);
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(f)) rmSync(f);

  // 1. Provision the coach via the real CLI, password PIPED on stdin (never an argv leak). The CLI
  //    creates the accounts file if missing and argon2id-hashes the password (Bun.password).
  await provisionCoach(accountsFile, creds);

  const broker = spawn('mosquitto', ['-c', conf], { stdio: 'ignore' });
  procs.push(broker);

  // 2. The real server with AUTH ON: accounts file loaded, NON-Secure cookie (we're on
  //    http://localhost), strict Origin pinned to this Vite origin, and NO ALLOW_ANONYMOUS_LIVE —
  //    so a tokenless browser is bounced to the login gate, not silently let through.
  const server = spawn('bun', ['run', 'src/server.ts'], {
    cwd: SERVER_DIR,
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(serverPort),
      METRICS_PORT: String(healthPort),
      MQTT_URL: `mqtt://127.0.0.1:${brokerPort}`,
      DB_PATH: dbPath,
      LOG_LEVEL: 'warn',
      AUTH_ACCOUNTS_FILE: accountsFile,
      AUTH_ROSTER_FILE: rosterFile, // names — a real login is now the only way to see them
      SESSION_CONFIG_FILE: sessionConfigFile, // age band → real youth zone thresholds, not the U14 fallback
      AUTH_COOKIE_SECURE: 'false', // localhost dev/e2e: a Secure cookie wouldn't be stored over http://
      ALLOWED_ORIGINS: baseURL, // allow this Vite origin so the proxied upgrade/POST is admitted
      // NB: NO ALLOW_ANONYMOUS_LIVE — login is required (the whole point of this stack).
      ALLOW_ANONYMOUS_LIVE: '',
    },
  });
  procs.push(server);

  // 3. Attach-mode simulator: stream the coach's session into the broker so a successful login lands
  //    on a LIVE feed (not an empty "waiting for players"). It only publishes MQTT — it needs no
  //    /live auth, so the cookie gate is irrelevant to it.
  const sim = spawn(
    'bun',
    ['run', 'test/simulate.ts', '--players', String(PLAYERS), '--session', creds.session, '--mqtt', `mqtt://127.0.0.1:${brokerPort}`],
    { cwd: SERVER_DIR, stdio: 'ignore', env: { ...process.env } },
  );
  procs.push(sim);

  // 4. Dedicated Vite pointed at the gated server via the same-origin proxy. No token ships in the
  //    bundle (there is none any more); VITE_DEFAULT_SESSION only matters for an admin picker.
  const vite = spawn('bun', ['run', 'dev', '--', '--port', String(vitePort), '--strictPort'], {
    cwd: CLIENT_DIR,
    stdio: 'ignore',
    env: { ...process.env, VITE_PROXY_TARGET: proxyTarget, VITE_DEFAULT_SESSION: creds.session },
  });
  procs.push(vite);

  const stop = () => {
    for (const p of procs) {
      try {
        p.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  const ready = (await waitForHealthy(healthPort, 30_000)) && (await waitForHttp(baseURL, 30_000));
  if (!ready) {
    stop();
    throw new Error('auth stack did not become ready (is mosquitto installed?)');
  }
  return { baseURL, stop, creds };
}

/**
 * Run `auth-user.ts add <username> --role coach --sessions <session>` with the password piped on
 * stdin, against a dedicated AUTH_ACCOUNTS_FILE. Resolves when the CLI exits 0; rejects otherwise so
 * a provisioning failure surfaces as a `test.skip` in the caller rather than a confusing login 401.
 */
function provisionCoach(
  accountsFile: string,
  creds: { username: string; password: string; session: string },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cli = spawn(
      'bun',
      ['run', 'auth-user.ts', 'add', creds.username, '--role', 'coach', '--sessions', creds.session],
      { cwd: SERVER_DIR, stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, AUTH_ACCOUNTS_FILE: accountsFile } },
    );
    cli.on('error', reject);
    cli.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`auth-user.ts add exited ${code} (is bun installed?)`)),
    );
    // Pipe the password as the first stdin line (the CLI reads stdin when not a TTY), then EOF.
    cli.stdin?.end(`${creds.password}\n`);
  });
}
