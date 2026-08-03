/**
 * Self-contained, hardware-free device-health end-to-end test (Phase 3 — device health on /live;
 * ADR-0016, docs/frontend/phase-3-contract.md §2 + §0 standing invariants).
 *
 * THREAT MODEL / DATA-MINIMISATION: the wearable publishes a FULL DeviceStatus on the .../status topic
 * (battery, RSSI, heap, uptime, pub/stash counters, backlog). The coach needs HEALTH, not device internals,
 * so the server fans out a MINIMISED DeviceHealth on /live — exactly nine fields, with heap/up/pub/stash
 * dropped and NO child name. This test spins the real server.ts, connects a coach WS, publishes one full
 * status frame, and proves end-to-end:
 *   - a { event:'status' } envelope arrives whose data has EXACTLY the nine DeviceHealth fields
 *     (playerId, sessionId, serverTs, battPct, battVolts, rssi, fix, sats, backlogBytes) and NONE of
 *     heap/up/pub/stash, and NO name/displayName (§0.1) — the minimisation + name-strip guarantee.
 *   - serverTs is a fresh server stamp (a number, recent), NOT the device `ts`.
 *   - the device gauges on /metrics updated from the same frame (ft_device_battery_percent etc.).
 *   - ft_ws_status_envelopes_sent_total is present and >= 1 (the fan-out happened and is observed).
 *
 * Simplest authn path: ALLOW_ANONYMOUS_LIVE=true + ANON_SESSIONS=<session> so the coach WS needs no login
 * (the §2.2 room-authz still gates it — an anon principal is scoped ONLY to ANON_SESSIONS, never wildcard);
 * the socket still sends a valid Origin to clear the strict CSWSH gate. Broker is anonymous; the publisher
 * acts as the ingest user (publishing the status frame the server consumes).
 *
 * Ports/files are dedicated (e2e 3101/9465/1883, auth-e2e 3104/9468/1885, roster-e2e 3102/9466/1885,
 * auth-dos 3110/9470). We take PORT=3103/METRICS=9467/broker 1886 per the Phase-3 slice spec.
 *
 *   bun run test/device-health-e2e.ts
 *
 * Exits 0 on success, 1 on any failed assertion; cleans up the child processes + temp files.
 */

import { existsSync, rmSync } from 'node:fs';
import mqtt from 'mqtt';

const PORT = 3103;
const METRICS_PORT = 9467;
const BROKER_PORT = 1886;
const MQTT_URL = `mqtt://127.0.0.1:${BROKER_PORT}`;
const DB_PATH = '/tmp/ft-devhealth-e2e.db';
const CONF_FILE = '/tmp/ft-devhealth-e2e-mosquitto.conf';

const ORIGIN = 'http://localhost:5173';
const SESSION = 'sessHealth';
const PLAYER = '01';
const STATUS_TOPIC = `football-trackers/session/${SESSION}/player/${PLAYER}/status`;

// The exact nine fields the minimised DeviceHealth envelope must carry — and no more.
const DEVICE_HEALTH_FIELDS = [
  'playerId', 'sessionId', 'serverTs', 'battPct', 'battVolts', 'rssi', 'fix', 'sats', 'backlogBytes',
].sort();
// Fields from the full DeviceStatus that must be DROPPED from the fan-out (they stay on /metrics only).
const DROPPED_FIELDS = ['heap', 'up', 'pub', 'stash', 'id', 'pl', 'ts'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

// Fresh DB + broker files each run.
for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, CONF_FILE]) {
  if (existsSync(f)) rmSync(f);
}

const children: { kill: () => void }[] = [];
const stop = () => children.forEach((c) => {
  try { c.kill(); } catch { /* already gone */ }
});

let pub: mqtt.MqttClient | undefined;
let ws: WebSocket | undefined;

try {
  // --- 1. anonymous broker (the publisher acts as the ingest user; authn under test is the /live fan-out) -
  await Bun.write(
    CONF_FILE,
    `listener ${BROKER_PORT} 127.0.0.1\n` +
    'allow_anonymous true\n',
  );
  const mosquittoBin = Bun.which('mosquitto') ?? 'mosquitto';
  const broker = Bun.spawn([mosquittoBin, '-c', CONF_FILE], { stdout: 'ignore', stderr: 'ignore' });
  children.push(broker);

  // --- 2. server (the real artifact) — anonymous /live for SESSION only, strict Origin still enforced ---
  const server = Bun.spawn(['bun', 'run', 'src/server.ts'], {
    cwd: `${import.meta.dir}/..`,
    env: {
      ...process.env,
      PORT: String(PORT), METRICS_PORT: String(METRICS_PORT), MQTT_URL, DB_PATH,
      AUTH_COOKIE_SECURE: 'false',
      ALLOWED_ORIGINS: ORIGIN,
      // The simplest coach-auth path: anon /live scoped to exactly this session (never wildcard). The WS
      // still must send an allow-listed Origin to clear the strict CSWSH gate.
      ALLOW_ANONYMOUS_LIVE: 'true',
      ANON_SESSIONS: SESSION,
      // No broker creds — anonymous broker.
      MQTT_USERNAME: undefined as unknown as string,
      MQTT_PASSWORD: undefined as unknown as string,
      LIVE_TOKEN: undefined as unknown as string,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  children.push(server);

  // --- 3. wait until server is up AND subscribed (proves the .../status subscription is live) ----------
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${METRICS_PORT}/health`);
      const body = (await res.json()) as { ok: boolean; mqtt: boolean };
      if (body.ok && body.mqtt) { ready = true; break; }
    } catch { /* not up yet */ }
    await sleep(100);
  }
  assert(ready, 'server did not become ready (HTTP up + MQTT subscribed) in 10s');

  // --- 4. the status publisher (acts as the ingest user; anonymous broker) -----------------------------
  pub = mqtt.connect(MQTT_URL);
  await new Promise<void>((res, rej) => {
    pub!.on('connect', () => res());
    pub!.on('error', rej);
    setTimeout(() => rej(new Error('publisher MQTT connect timeout')), 8000);
  });

  // --- 5. coach WS to /live?sessionId=SESSION (anon mode → no cookie needed; Origin still required) -----
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/live?sessionId=${SESSION}`, {
    headers: { origin: ORIGIN },
  } as unknown as string[]);
  const received: any[] = [];
  ws.onmessage = (ev) => { if (typeof ev.data === 'string') received.push(JSON.parse(ev.data)); };
  await new Promise<void>((res, rej) => {
    ws!.onopen = () => res();
    ws!.onerror = () => rej(new Error('coach WS connection error (anon /live should admit it)'));
    setTimeout(() => rej(new Error('WS open timeout')), 5000);
  });
  await sleep(300); // let the server-side open() subscribe to the room before we publish

  // --- 6. publish ONE full firmware-shape DeviceStatus on the status topic -----------------------------
  // The full shape (types.ts DeviceStatus): id, pl, ts, up, heap, rssi, batt, pct, fix, sats, pub, stash, backlog.
  const beforePublish = Date.now();
  const fullStatus = {
    id: 'trk-01', pl: PLAYER, ts: 123456,
    up: 3600, heap: 145000, rssi: -67, batt: 3.92, pct: 78,
    fix: 3, sats: 11, pub: 5000, stash: 12, backlog: 2048,
  };
  pub.publish(STATUS_TOPIC, JSON.stringify(fullStatus), { qos: 0 });

  // --- 7. assert a { event:'status' } envelope arrives with EXACTLY the nine minimised fields ----------
  let statusEnv: any | undefined;
  for (let i = 0; i < 50 && !statusEnv; i++) {
    await sleep(100);
    statusEnv = received.find((m) => m && m.event === 'status');
  }
  assert(statusEnv !== undefined, `expected a { event:'status' } envelope on /live, got ${JSON.stringify(received)}`);
  const h = statusEnv.data;
  assert(h && typeof h === 'object', 'status envelope data must be an object');

  // EXACTLY the nine DeviceHealth keys — no more, no fewer (structural minimisation guarantee).
  const gotKeys = Object.keys(h).sort();
  assert(JSON.stringify(gotKeys) === JSON.stringify(DEVICE_HEALTH_FIELDS),
    `DeviceHealth must carry EXACTLY ${JSON.stringify(DEVICE_HEALTH_FIELDS)}, got ${JSON.stringify(gotKeys)}`);
  // Belt: none of the dropped device-internals / wire-shape fields nor any name leaked through.
  for (const f of DROPPED_FIELDS) {
    assert(!(f in h), `minimised DeviceHealth must NOT contain dropped field "${f}", got ${JSON.stringify(gotKeys)}`);
  }
  assert(!('name' in h) && !('displayName' in h),
    `DeviceHealth must NEVER carry a name/displayName (§0.1), got keys ${JSON.stringify(gotKeys)}`);

  // Identity + minimised values carried faithfully from the full status frame.
  assert(h.playerId === PLAYER, `health playerId should be "${PLAYER}", got ${h.playerId}`);
  assert(h.sessionId === SESSION, `health sessionId should be "${SESSION}", got ${h.sessionId}`);
  assert(h.battPct === 78, `health battPct should be 78, got ${h.battPct}`);
  assert(h.battVolts === 3.92, `health battVolts should be 3.92, got ${h.battVolts}`);
  assert(h.rssi === -67, `health rssi should be -67, got ${h.rssi}`);
  assert(h.fix === 3, `health fix should be 3, got ${h.fix}`);
  assert(h.sats === 11, `health sats should be 11, got ${h.sats}`);
  assert(h.backlogBytes === 2048, `health backlogBytes should be 2048, got ${h.backlogBytes}`);

  // serverTs is a FRESH server stamp — a number, recent (>= when we published), NOT the device ts (123456).
  assert(typeof h.serverTs === 'number' && Number.isFinite(h.serverTs), `health serverTs must be a finite number, got ${h.serverTs}`);
  assert(h.serverTs !== fullStatus.ts, 'health serverTs must be the SERVER stamp, not the device ts');
  assert(h.serverTs >= beforePublish - 1000 && h.serverTs <= Date.now() + 1000,
    `health serverTs should be a fresh server stamp near now, got ${h.serverTs}`);

  // --- 8. /metrics: the device gauges updated from the same frame, and the fan-out counter is present --
  const metricsText = await (await fetch(`http://127.0.0.1:${METRICS_PORT}/metrics`)).text();
  const num = (re: RegExp): number | undefined => {
    const m = metricsText.match(re);
    return m ? Number(m[1]) : undefined;
  };
  assert(num(new RegExp(`ft_device_battery_percent\\{[^}]*player="${PLAYER}"[^}]*\\}\\s+(-?[\\d.]+)`)) === 78,
    'metrics: ft_device_battery_percent{player="01"} should be 78');
  assert(num(new RegExp(`ft_device_battery_volts\\{[^}]*player="${PLAYER}"[^}]*\\}\\s+([\\d.]+)`)) === 3.92,
    'metrics: ft_device_battery_volts{player="01"} should be 3.92');
  assert(num(new RegExp(`ft_device_wifi_rssi_dbm\\{[^}]*player="${PLAYER}"[^}]*\\}\\s+(-?[\\d.]+)`)) === -67,
    'metrics: ft_device_wifi_rssi_dbm{player="01"} should be -67');
  assert(num(new RegExp(`ft_device_backlog_bytes\\{[^}]*player="${PLAYER}"[^}]*\\}\\s+([\\d.]+)`)) === 2048,
    'metrics: ft_device_backlog_bytes{player="01"} should be 2048');
  // The device internals that are DROPPED from the fan-out still live on /metrics (they were not removed,
  // only kept off the wire) — proving the split is "minimise the envelope", not "stop collecting".
  assert(num(new RegExp(`ft_device_free_heap_bytes\\{[^}]*player="${PLAYER}"[^}]*\\}\\s+([\\d.]+)`)) === 145000,
    'metrics: ft_device_free_heap_bytes{player="01"} should be 145000 (internals stay on /metrics)');
  // The fan-out counter: present and >= 1 for this session.
  assert((num(/ft_ws_status_envelopes_sent_total\{[^}]*\}\s+(\d+)/) ?? 0) >= 1,
    'metrics: ft_ws_status_envelopes_sent_total should be present and >= 1');
  assert(metricsText.includes('ft_ws_status_envelopes_sent_total'),
    'metrics: ft_ws_status_envelopes_sent_total metric must be exposed');

  console.log('\n✅ DEVICE-HEALTH E2E PASSED — status frame → { event:\'status\' } on /live with EXACTLY the 9 minimised fields (no heap/up/pub/stash, no name), fresh serverTs, device gauges updated, ft_ws_status_envelopes_sent_total >= 1');
  pub.end();
  ws.close();
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, CONF_FILE]) {
    if (existsSync(f)) rmSync(f);
  }
  stop();
  process.exit(0);
} catch (err) {
  console.error('\n❌ DEVICE-HEALTH E2E FAILED:', (err as Error).message);
  try { pub?.end(); } catch { /* noop */ }
  try { ws?.close(); } catch { /* noop */ }
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, CONF_FILE]) {
    try { if (existsSync(f)) rmSync(f); } catch { /* noop */ }
  }
  stop();
  process.exit(1);
}
