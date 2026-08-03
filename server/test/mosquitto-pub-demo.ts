/**
 * Verifies the README's literal hardware-free test against the Bun/Elysia stack:
 * a real `mosquitto_pub` publish is observed arriving on a /live WS client.
 *
 *   bun run test/mosquitto-pub-demo.ts
 */

import { existsSync, rmSync } from 'node:fs';

const PORT = 3102;
const METRICS_PORT = 9466;
const MQTT_URL = 'mqtt://127.0.0.1:1883';
const DB_PATH = '/tmp/ft-demo.db';
const TOPIC = 'football-trackers/session/test/player/01/telemetry';
const PAYLOAD =
  '{"id":"trk-01","pl":"01","ts":1,"lat":44.8125,"lon":20.4612,"spd":3.2,"hdg":90,"fix":3,"sats":11,"pdop":1.2}';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const children: { kill: () => void }[] = [];
const stop = () => children.forEach((c) => { try { c.kill(); } catch {} });

for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) if (existsSync(f)) rmSync(f);

try {
  const conf = '/tmp/ft-demo-mosquitto.conf';
  await Bun.write(conf, 'listener 1883 127.0.0.1\nallow_anonymous true\n');
  children.push(Bun.spawn([Bun.which('mosquitto') ?? 'mosquitto', '-c', conf], { stdout: 'ignore', stderr: 'ignore' }));
  children.push(Bun.spawn(['bun', 'run', 'src/server.ts'], {
    cwd: `${import.meta.dir}/..`,
    // Phase 2 isolated-LAN demo path: ALLOW_ANONYMOUS_LIVE skips login, but the anon principal is now
    // SCOPED to ANON_SESSIONS (never wildcard), and the Origin allow-list is STRICT (an absent Origin is
    // rejected) — so allow-list the demo origin and ANON_SESSIONS must include the session we read.
    env: {
      ...process.env,
      PORT: String(PORT),
      METRICS_PORT: String(METRICS_PORT),
      MQTT_URL,
      DB_PATH,
      ALLOW_ANONYMOUS_LIVE: 'true',
      ANON_SESSIONS: 'test',
      ALLOWED_ORIGINS: 'http://localhost:5173',
    },
    stdout: 'ignore', stderr: 'ignore',
  }));

  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const b = (await (await fetch(`http://127.0.0.1:${METRICS_PORT}/health`)).json()) as { mqtt: boolean };
      if (b.mqtt) { ready = true; break; }
    } catch {}
    await sleep(100);
  }
  if (!ready) throw new Error('server not ready');

  // Non-browser WS client: send an allow-listed Origin so the strict CSWSH check admits it (a browser
  // would send this automatically; Bun's WebSocket lets us set it). The session cookie is N/A in anon mode.
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/live?sessionId=test`, {
    headers: { Origin: 'http://localhost:5173' },
  } as unknown as string[]);
  let got: string | undefined;
  ws.onmessage = (ev) => { if (typeof ev.data === 'string') got = ev.data; };
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); setTimeout(() => rej(new Error('ws timeout')), 5000); });
  await sleep(300);

  const cmd = ['mosquitto_pub', '-t', TOPIC, '-m', PAYLOAD];
  console.log('$ ' + cmd.map((a) => (a.includes(' ') || a.includes('{') ? `'${a}'` : a)).join(' '));
  const pub = Bun.spawn(cmd, { stdout: 'inherit', stderr: 'inherit' });
  await pub.exited;

  for (let i = 0; i < 50 && !got; i++) await sleep(100);
  if (!got) throw new Error('WS client never received the published telemetry');

  console.log('WS /live?sessionId=test received:');
  console.log(JSON.stringify(JSON.parse(got), null, 2));
  ws.close();
  stop();
  console.log('\n✅ mosquitto_pub -> WS verified');
  process.exit(0);
} catch (err) {
  console.error('❌', (err as Error).message);
  stop();
  process.exit(1);
}
