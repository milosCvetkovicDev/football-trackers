/**
 * Focused test for the /live Origin / CSWSH defence (Phase 2: STRICT — ADR-0015 + the pre-mortem).
 *
 * No broker needed — the WS `open` handler enforces origin + auth + session before any MQTT interaction.
 * Phase 2 made the Origin check STRICT for the cookie-authenticated /live surface:
 *   - a forged (non-allow-listed) Origin is rejected (1008 'forbidden origin'),
 *   - an ABSENT Origin is now ALSO rejected (the old "no Origin → admit on token alone" branch is gone —
 *     it let a header-omitting curl bypass CSWSH; the shared token is gone too),
 *   - an allow-listed Origin WITH a valid session cookie is admitted.
 * The Origin check runs BEFORE auth, so it fires regardless of the cookie.
 *
 *   bun run test/ws-origin.ts
 *
 * Exits 0 on success, 1 on any failed assertion.
 */

export {}; // make this a module so top-level await is allowed

import { existsSync, rmSync, writeFileSync } from 'node:fs';

const PORT = 3103;
const METRICS_PORT = 9467;
const GOOD = 'http://good.example';
const EVIL = 'http://evil.example';
const ACC = '/tmp/ft-wsorigin-accounts.json';
const DB = '/tmp/ft-wsorigin.db';
const USER = 'coach-o';
const PW = 'origin-test-pw';
const SESSION = 'test';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

try {
  // Fresh account file + DB. One coach assigned to SESSION; AUTH_COOKIE_SECURE=false so the cookie is 'ft_session'.
  for (const f of [ACC, DB, `${DB}-wal`, `${DB}-shm`]) if (existsSync(f)) rmSync(f);
  const hash = await Bun.password.hash(PW, { algorithm: 'argon2id' });
  writeFileSync(ACC, JSON.stringify({ accounts: [{ username: USER, hash, role: 'coach', sessions: [SESSION] }] }));

  process.env.PORT = String(PORT);
  process.env.METRICS_PORT = String(METRICS_PORT);
  process.env.MQTT_URL = 'mqtt://127.0.0.1:1'; // no broker; the WS path doesn't need it
  process.env.AUTH_ACCOUNTS_FILE = ACC;
  process.env.AUTH_COOKIE_SECURE = 'false';
  process.env.ALLOWED_ORIGINS = GOOD;
  process.env.DB_PATH = DB;
  process.env.LOG_LEVEL = 'error';

  await import('../src/server');

  // wait for the loopback /health to ANSWER. There is deliberately no broker here, so since Phase 3 it
  // answers 503 {ok:false, mqtt:false} — truthfully; "HTTP is up" is what this test needs, not "ready".
  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${METRICS_PORT}/health`);
      const body = (await res.json()) as { mqtt: boolean; db: boolean };
      if (res.status === 503 && body.mqtt === false && body.db === true) {
        up = true;
        break;
      }
    } catch {
      /* not up */
    }
    await sleep(50);
  }
  assert(up, 'server did not start');

  // Log in (with the allow-listed Origin) to obtain a valid session cookie for the admit case.
  const login = await fetch(`http://127.0.0.1:${PORT}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: GOOD },
    body: JSON.stringify({ username: USER, password: PW }),
  });
  assert(login.status === 200, `login should succeed (got ${login.status})`);
  const cookie = (login.headers.get('set-cookie') ?? '').match(/ft_session=[^;]+/)?.[0];
  assert(cookie, 'login should set the ft_session cookie');

  const url = `ws://127.0.0.1:${PORT}/live?sessionId=${SESSION}`;
  // Bun's WebSocket accepts a { headers } option (forge the Origin a browser would send + carry the cookie).
  const mk = (origin?: string) =>
    new WebSocket(url, {
      headers: origin ? { Origin: origin, Cookie: cookie } : { Cookie: cookie },
    } as unknown as string[]);

  const good = mk(GOOD); // allow-listed Origin + cookie -> admitted
  const evil = mk(EVIL); // forged cross-site Origin     -> rejected (before auth)
  const none = mk(); // absent Origin (non-browser)      -> rejected (strict)
  for (const w of [good, evil, none]) w.onerror = () => { /* expected for evil/none */ };
  await sleep(600);

  assert(good.readyState === WebSocket.OPEN, `allow-listed Origin + cookie must be admitted (readyState=${good.readyState})`);
  assert(evil.readyState === WebSocket.CLOSED, `forged Origin must be rejected (readyState=${evil.readyState})`);
  assert(none.readyState === WebSocket.CLOSED, `absent Origin must be rejected — strict (readyState=${none.readyState})`);

  const metricsText = await (await fetch(`http://127.0.0.1:${METRICS_PORT}/metrics`)).text();
  const m = metricsText.match(/ft_ws_rejected_total\{reason="origin"\}\s+(\d+)/);
  assert(m && Number(m[1]) >= 2, 'ft_ws_rejected_total{reason="origin"} should be >= 2 (evil + no-origin)');

  console.log('\n✅ ORIGIN/CSWSH PASSED — forged + absent Origin rejected, allow-listed Origin + cookie admitted');
  good.close();
  evil.close();
  none.close();
  process.exit(0);
} catch (err) {
  console.error('\n❌ ORIGIN TEST FAILED:', (err as Error).message);
  process.exit(1);
}
