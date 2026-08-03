/**
 * Virtual device fleet — drive the whole pipeline with NO hardware.
 *
 * Each simulated player is a real MQTT client publishing the exact wire contract the
 * ESP32 firmware emits (RawTelemetry @10 Hz on .../telemetry, DeviceStatus ~every 5 s on
 * .../status — see server/src/types.ts and firmware/src/main.cpp). Players move believably
 * around the pitch, so the real server + coach view run completely unchanged.
 *
 * Capabilities (compose freely):
 *   1. realistic feed   — N players doing waypoint-following movement at 10 Hz + health
 *   2. turnkey run       — --standalone spawns its own mosquitto + server (like e2e)
 *   3. fault injection   — --faults emits bad fixes / out-of-range / id-mismatch / rate
 *                          bursts / dropout->backlog->replay (and ACL-spoof attempts when --secure)
 *   4. scale / load      — --ramp 10,30,50 ramps players and reports latency + drop rate
 *   5. secured broker    — --secure provisions per-player MQTT accounts + `%u` topic ACLs AND, for the
 *                          new Phase-2 cookie auth, a throwaway coach account (written to a temp
 *                          AUTH_ACCOUNTS_FILE) assigned to the run session — so the fleet load-tests the
 *                          broker-ACL layer AND the named /live auth layer together. (Phase 2 removed the
 *                          bundled shared token; /live is now gated by a login cookie, never a query token.)
 *   6. record / replay   — --record FILE captures the published stream; --replay FILE re-publishes
 *                          it with the original timing (deterministic reproduction of a run)
 *   7. roster names      — --standalone (BOTH secure + anonymous) writes a throwaway AUTH_ROSTER_FILE
 *                          (Phase-3 ADR-0016) mapping each simulated player id ("01".."NN") to a DEV
 *                          display name ("Player 01") and points the spawned server at it — so the coach
 *                          view + Playwright e2e render NAMES, not bare ids. These are DEV fixtures in a
 *                          throwaway temp file, NOT real children: the §0.1 invariant (no real child name
 *                          in any store/log/label/client-persistence) is untouched. The roster is
 *                          out-of-band — it does NOT enter recordings, so --record/--replay stay faithful.
 *
 * Examples:
 *   bun run test/simulate.ts                                   # attach to a broker+server you run
 *   bun run test/simulate.ts --standalone --players 10         # turnkey
 *   bun run test/simulate.ts --standalone --players 8 --faults --duration 30
 *   bun run test/simulate.ts --standalone --secure --players 10 --faults --duration 30   # + auth layer
 *   bun run test/simulate.ts --standalone --ramp 10,30,50 --stage-seconds 15             # load ramp
 *   bun run test/simulate.ts --standalone --faults --duration 20 --record /tmp/run.ndjson
 *   bun run test/simulate.ts --standalone --replay /tmp/run.ndjson                       # exact re-run
 *
 * Coach view (same-origin via the Vite dev proxy — Phase 2 dropped VITE_WS_URL/VITE_LIVE_TOKEN, the
 * browser now talks only to the Vite origin and the proxy forwards /live + /auth + /sessions):
 *   anonymous stack:  cd client && VITE_PROXY_TARGET=http://localhost:<PORT> VITE_DEFAULT_SESSION=<SESSION> bun run dev
 *   --secure stack:   cd client && VITE_PROXY_TARGET=http://localhost:<PORT> bun run dev   (then log in with the printed creds)
 * The standalone stack prints the exact line (incl. the dev login for --secure) when it comes up.
 *
 * Ctrl-C (or --duration) stops cleanly, scrapes /metrics, and prints what the server saw.
 */

export {}; // module scope for top-level await

import { existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import mqtt from 'mqtt';

// ----- CLI ------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const has = (n: string) => argv.includes(`--${n}`);
const val = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const num = (n: string, d: number): number => Number(val(n, String(d)));

const SESSION = val('session', 'test'); // matches the client's default VITE_DEFAULT_SESSION
const STANDALONE = has('standalone');
const SECURE = has('secure'); // per-player MQTT creds + ACLs + a provisioned coach account for the cookie-gated /live
const FAULTS = has('faults');
const DURATION_S = num('duration', 0); // 0 = run until Ctrl-C
const RAMP = val('ramp', '').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
const STAGE_S = num('stage-seconds', 15);
const RATE_HZ = num('rate', 10);
const RECORD_FILE = val('record', ''); // '' = off
const REPLAY_FILE = val('replay', ''); // '' = off
const REPLAY_SPEED = num('replay-speed', 1); // >1 fast-forwards

// Ports (only used in --standalone). Defaults match the project so the React client works
// with zero config; override if you already have something on them.
const PORT = num('port', 3000);
const METRICS_PORT = num('metrics-port', 9464);
const BROKER_PORT = num('broker-port', 1884); // 1884 (not 1883) to dodge a dev broker
const MQTT_URL = val('mqtt', process.env.MQTT_URL ?? `mqtt://127.0.0.1:${STANDALONE ? BROKER_PORT : 1883}`);

const PLAYERS = RAMP.length ? Math.max(...RAMP) : num('players', 10);

// Ephemeral auth material for --secure (a throwaway, loopback-only broker).
const INGEST_PW = 'sim-ingest-pw';
const playerPw = (pl: string) => `sim-${pl}-pw`;

// Phase-2 cookie auth for --secure: provision ONE throwaway coach account (in a temp accounts file)
// assigned to the run session, so the standalone stack exercises the named /live login path. These are
// fixed, well-known DEV credentials — NOT secrets — printed at boot so you can log into the coach view.
// (Coach usernames are adult-operator identities; no child/player name ever appears here.)
const SIM_COACH_USER = 'coach';
const SIM_COACH_PW = 'sim-coach-pw';
const SIM_ACCOUNTS_FILE = '/tmp/ft-sim-accounts.json';

// Phase-3 roster (ADR-0016): a throwaway AUTH_ROSTER_FILE so the coach view + Playwright e2e render NAMES.
// Each simulated player id ("01".."NN") maps to a DEV display name ("Player 01"). These are DEV FIXTURES in
// a throwaway temp file — NOT real children — so the §0.1 invariant (no real child name in any pseudonymous
// store/log/label/client-persistence) is untouched; this mirrors the throwaway coach account above. Written
// in BOTH dev postures (secure + anonymous) because names are useful for verifying the render either way, and
// kept OUT of recordings (it is server-side roster state, not a published packet) so --record/--replay stay faithful.
const SIM_ROSTER_FILE = '/tmp/ft-sim-roster.json';
const simDisplayName = (pl: string) => `Player ${pl}`; // DEV fixture, e.g. "Player 01" — not a real child

// Phase-4 session config (ADR-0019): a throwaway SESSION_CONFIG_FILE giving THIS run's session an age band, so
// the spawned server serves GET /sessions/:id/config with a real band and the coach view + Playwright e2e get
// real youth speed-zone thresholds (not just the client-side U14 fallback). The age band is NOT a name/location
// (non-sensitive config) — but it's still a throwaway dev fixture, written in BOTH postures and cleaned up on
// shutdown. Out-of-band from the published stream, so --record/--replay stay faithful.
const SIM_SESSION_CONFIG_FILE = '/tmp/ft-sim-session-config.json';
const SIM_AGE_BAND = 'U14'; // a representative youth band for the dev/e2e session

// ----- pitch geometry (keep the same rectangle as client/src/config.ts so dots render) ---
const CORNERS = [
  { lat: 44.812806, lon: 20.460535 },
  { lat: 44.812806, lon: 20.461865 },
  { lat: 44.812194, lon: 20.461865 },
  { lat: 44.812194, lon: 20.460535 },
];
const lat0 = (Math.min(...CORNERS.map((c) => c.lat)) + Math.max(...CORNERS.map((c) => c.lat))) / 2;
const lon0 = (Math.min(...CORNERS.map((c) => c.lon)) + Math.max(...CORNERS.map((c) => c.lon))) / 2;
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = 111_320 * Math.cos((lat0 * Math.PI) / 180);
const X_MAX = (Math.max(...CORNERS.map((c) => c.lon)) - lon0) * M_PER_DEG_LON;
const Y_MAX = (Math.max(...CORNERS.map((c) => c.lat)) - lat0) * M_PER_DEG_LAT;
const toLatLon = (x: number, y: number) => ({ lat: lat0 + y / M_PER_DEG_LAT, lon: lon0 + x / M_PER_DEG_LON });
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const rnd = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

// ----- topics & ids (the firmware's exact contract) -------------------------------------
const telTopic = (pl: string) => `football-trackers/session/${SESSION}/player/${pl}/telemetry`;
const statTopic = (pl: string) => `football-trackers/session/${SESSION}/player/${pl}/status`;
const playerId = (i: number) => String(i + 1).padStart(2, '0'); // "01".."NN"

// ----- recording: capture every published packet for deterministic replay ---------------
type Rec = { t: number; topic: string; payload: string };
const recorder: Rec[] | null = RECORD_FILE ? [] : null;
const startedAt = Date.now();
/** Publish + (optionally) record. Used for everything the server should SEE (so replay is faithful). */
function emit(client: mqtt.MqttClient, topic: string, payload: string) {
  client.publish(topic, payload);
  if (recorder) recorder.push({ t: Date.now() - startedAt, topic, payload });
}

// ----- a single virtual player ----------------------------------------------------------
interface Player {
  pl: string; clientId: string; client: mqtt.MqttClient;
  x: number; y: number; tx: number; ty: number; speed: number; hdg: number;
  bootMs: number; pub: number; stash: number; backlogBytes: number;
  offlineUntil: number; stashed: string[]; batt: number;
}

const players: Player[] = [];
const childKills: (() => void)[] = [];
let active = 0; // how many players are currently publishing (for --ramp)

function playerAuth(pl: string): { username?: string; password?: string } {
  if (SECURE) return { username: pl, password: playerPw(pl) }; // username == player id (the `%u` ACL)
  if (process.env.MQTT_USERNAME) return { username: process.env.MQTT_USERNAME, password: process.env.MQTT_PASSWORD };
  return {};
}

function newPlayer(i: number): Player {
  const pl = playerId(i);
  const clientId = `sim-trk-${pl}`;
  const client = mqtt.connect(MQTT_URL, { clientId, ...playerAuth(pl) });
  client.on('error', () => { /* a sim socket hiccup shouldn't crash the fleet */ });
  return {
    pl, clientId, client,
    x: rnd(-X_MAX, X_MAX), y: rnd(-Y_MAX, Y_MAX),
    tx: rnd(-X_MAX, X_MAX), ty: rnd(-Y_MAX, Y_MAX),
    speed: rnd(1.5, 3.5), hdg: rnd(0, 360),
    bootMs: Math.floor(rnd(0, 60_000)),
    pub: 0, stash: 0, backlogBytes: 0, offlineUntil: 0, stashed: [], batt: rnd(3.9, 4.15),
  };
}

/** Advance one 100 ms step of believable movement; returns the telemetry packet. */
function step(p: Player, dt: number) {
  const dx = p.tx - p.x, dy = p.ty - p.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1.0) {
    p.tx = rnd(-X_MAX, X_MAX); p.ty = rnd(-Y_MAX, Y_MAX);
    const r = Math.random();
    p.speed = r < 0.15 ? 0 : r < 0.85 ? rnd(1.5, 3.5) : rnd(5.5, 7.5); // stop / jog / sprint
  }
  const ux = dist > 0 ? dx / dist : 0, uy = dist > 0 ? dy / dist : 0;
  const move = Math.min(p.speed * dt, dist);
  const nx = clamp(p.x + ux * move, -X_MAX, X_MAX), ny = clamp(p.y + uy * move, -Y_MAX, Y_MAX);
  const spd = Math.hypot(nx - p.x, ny - p.y) / dt;
  if (move > 0.05) p.hdg = (Math.atan2(ux, uy) * 180) / Math.PI; // 0 = north, 90 = east
  p.x = nx; p.y = ny;
  const { lat, lon } = toLatLon(p.x, p.y);
  return {
    id: p.clientId, pl: p.pl, ts: p.bootMs + Math.floor(performance.now()),
    lat: Number(lat.toFixed(7)), lon: Number(lon.toFixed(7)),
    spd: Number(spd.toFixed(2)), hdg: Number(((p.hdg + 360) % 360).toFixed(1)),
    fix: 3, sats: Math.round(rnd(9, 12)), pdop: Number(rnd(0.8, 2.0).toFixed(2)),
  };
}

// ----- fault injection ------------------------------------------------------------------
let faultSalvoFired = false;
const faultLog: Record<string, number> = {};
const logFault = (kind: string) => { faultLog[kind] = (faultLog[kind] ?? 0) + 1; };

/** One deterministic packet of each abuse type so a short run is guaranteed to show drops. */
function fireFaultSalvo(p: Player) {
  const base = step(p, 0.1);
  emit(p.client, telTopic(p.pl), JSON.stringify({ ...base, fix: 1 })); logFault('no_fix');
  emit(p.client, telTopic(p.pl), JSON.stringify({ ...base, lat: 999 })); logFault('out_of_range');
  emit(p.client, telTopic(p.pl), JSON.stringify({ ...base, pl: '99' })); logFault('id_mismatch'); // body != topic
  for (let i = 0; i < 40; i++) emit(p.client, telTopic(p.pl), JSON.stringify(base)); // rate burst
  logFault('rate_burst');
}

/** Probabilistic, per-tick faults. Returns true if it consumed the normal publish for this tick. */
function maybeFault(p: Player, now: number): boolean {
  // ongoing dropout: buffer instead of publishing (mirrors the firmware's LittleFS backlog)
  if (now < p.offlineUntil) {
    const pkt = JSON.stringify(step(p, 1 / RATE_HZ));
    p.stashed.push(pkt); p.stash++;
    p.backlogBytes = p.stashed.reduce((s, l) => s + l.length + 1, 0);
    return true;
  }
  // dropout just ended: replay the backlog rapidly, then resume (exercises ordering + rate cap)
  if (p.stashed.length) {
    logFault('backlog_replay');
    for (const line of p.stashed) emit(p.client, telTopic(p.pl), line);
    p.stashed = []; p.backlogBytes = 0;
  }
  const r = Math.random();
  if (r < 0.004) { emit(p.client, telTopic(p.pl), JSON.stringify({ ...step(p, 1 / RATE_HZ), fix: 1 })); logFault('no_fix'); return true; }
  if (r < 0.007) { emit(p.client, telTopic(p.pl), JSON.stringify({ ...step(p, 1 / RATE_HZ), lat: 999 })); logFault('out_of_range'); return true; }
  if (r < 0.010) { emit(p.client, telTopic(p.pl), JSON.stringify({ ...step(p, 1 / RATE_HZ), pl: '99' })); logFault('id_mismatch'); return true; }
  if (r < 0.0108) { for (let i = 0; i < 40; i++) emit(p.client, telTopic(p.pl), JSON.stringify(step(p, 1 / RATE_HZ))); logFault('rate_burst'); return true; }
  if (r < 0.0114) { p.offlineUntil = now + rnd(3000, 8000); logFault('dropout'); return true; } // offline 3-8 s
  // secured-broker only: try to publish to ANOTHER player's topic — the broker ACL must deny it.
  // NB: direct publish (not emit) — it never reaches the server, so it must not enter a recording.
  if (SECURE && r < 0.0120) { p.client.publish(telTopic('99'), JSON.stringify(step(p, 1 / RATE_HZ))); logFault('acl_spoof_attempt'); return true; }
  return false;
}

// ----- tick loops -----------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let telTimer: ReturnType<typeof setInterval> | undefined;
let statTimer: ReturnType<typeof setInterval> | undefined;

function telemetryTick() {
  const now = Date.now();
  if (FAULTS && !faultSalvoFired && now - startedAt > 2000 && players[0]) { fireFaultSalvo(players[0]); faultSalvoFired = true; }
  for (let i = 0; i < active; i++) {
    const p = players[i];
    if (FAULTS && maybeFault(p, now)) continue;
    emit(p.client, telTopic(p.pl), JSON.stringify(step(p, 1 / RATE_HZ)));
    p.pub++;
  }
}

const batteryPct = (v: number) => Math.round(clamp(((v - 3.3) / (4.2 - 3.3)) * 100, 0, 100));

function statusTick() {
  const upS = Math.floor((Date.now() - startedAt) / 1000);
  for (let i = 0; i < active; i++) {
    const p = players[i];
    p.batt = Math.max(3.3, p.batt - 0.0005); // gentle drain
    const status = {
      id: p.clientId, pl: p.pl, ts: p.bootMs + Math.floor(performance.now()),
      up: upS, heap: Math.round(rnd(195_000, 215_000)), rssi: Math.round(rnd(-75, -58)),
      batt: Number(p.batt.toFixed(2)), pct: batteryPct(p.batt), fix: 3, sats: Math.round(rnd(9, 12)),
      pub: p.pub, stash: p.stash, backlog: p.backlogBytes,
    };
    emit(p.client, statTopic(p.pl), JSON.stringify(status));
  }
}

// ----- /metrics report ------------------------------------------------------------------
async function scrapeReport(label: string) {
  let text = '';
  try { text = await (await fetch(`http://127.0.0.1:${METRICS_PORT}/metrics`)).text(); }
  catch { console.log(`\n[report:${label}] /metrics unreachable on :${METRICS_PORT} (attach mode? set --metrics-port)`); return; }
  const sum = (re: RegExp): number => [...text.matchAll(re)].reduce((a, m) => a + Number(m[1]), 0);
  const received = sum(/^ft_telemetry_received_total\{[^}]*\}\s+(\d+)/gm);
  const published = sum(/^ft_telemetry_published_total\{[^}]*\}\s+(\d+)/gm);
  const drops: Record<string, number> = {};
  for (const m of text.matchAll(/^ft_telemetry_dropped_total\{reason="([^"]+)"\}\s+(\d+)/gm)) drops[m[1]] = Number(m[2]);
  const count = sum(/^ft_ingest_duration_seconds_count\s+(\d+)/gm);
  let p99 = 'n/a';
  if (count > 0) {
    const buckets = [...text.matchAll(/^ft_ingest_duration_seconds_bucket\{le="([^"]+)"\}\s+(\d+)/gm)]
      .map((m) => ({ le: m[1], n: Number(m[2]) })).filter((b) => b.le !== '+Inf');
    const hit = buckets.find((b) => b.n >= 0.99 * count);
    p99 = hit ? `≤ ${(Number(hit.le) * 1000).toFixed(1)} ms` : '> top bucket';
  }
  const rss = sum(/^ft_process_resident_memory_bytes\s+(\d+)/gm);
  const age = sum(/^ft_oldest_raw_fix_age_seconds\s+([\d.]+)/gm);
  console.log(`\n[report:${label}]`);
  console.log(`  received=${received}  published=${published}  drops=${JSON.stringify(drops)}`);
  console.log(`  ingest p99 ${p99}   RSS=${(rss / 1e6).toFixed(0)} MB   oldest_raw_fix_age=${age.toFixed(1)}s`);
  if (FAULTS) console.log(`  faults injected by sim: ${JSON.stringify(faultLog)}`);
  if (SECURE) {
    const spoofReached = /ft_telemetry_received_total\{[^}]*player="99"[^}]*\}/.test(text);
    console.log(`  AUTH: per-player creds + ACL active; player-99 spoof reached server? ${spoofReached ? 'YES — ACL FAIL!' : 'no (broker ACL blocked it)'}`);
  }
}

// ----- standalone infra: spawn mosquitto + server (turnkey) -----------------------------
async function startStandaloneStack(secure: boolean) {
  const CONF = '/tmp/ft-sim-mosquitto.conf';
  const PW_FILE = '/tmp/ft-sim-passwd';
  const ACL_FILE = '/tmp/ft-sim-acl';
  for (const f of [CONF, PW_FILE, ACL_FILE, SIM_ACCOUNTS_FILE, SIM_ROSTER_FILE, SIM_SESSION_CONFIG_FILE]) if (existsSync(f)) rmSync(f);

  let conf = `listener ${BROKER_PORT} 127.0.0.1\n`;
  if (secure) {
    // provision an 'ingest' (read-all) account + one per player (username == player id).
    const passwdBin = Bun.which('mosquitto_passwd') ?? 'mosquitto_passwd';
    const accounts: [string, string, boolean][] = [['ingest', INGEST_PW, true]];
    for (let i = 0; i < PLAYERS; i++) accounts.push([playerId(i), playerPw(playerId(i)), false]);
    for (const [user, pw, create] of accounts) {
      const args = create ? ['-b', '-c', PW_FILE, user, pw] : ['-b', PW_FILE, user, pw];
      const code = await Bun.spawn([passwdBin, ...args], { stdout: 'ignore', stderr: 'ignore' }).exited;
      if (code !== 0) throw new Error(`mosquitto_passwd failed for "${user}" (exit ${code}) — is mosquitto installed?`);
    }
    await Bun.write(
      ACL_FILE,
      'user ingest\n' +
      'topic read football-trackers/#\n\n' +
      'pattern write football-trackers/session/+/player/%u/telemetry\n' +
      'pattern write football-trackers/session/+/player/%u/status\n',
    );
    conf += `allow_anonymous false\npassword_file ${PW_FILE}\nacl_file ${ACL_FILE}\nmessage_size_limit 1024\n`;

  } else {
    conf += 'allow_anonymous true\n';
  }

  // Phase-2 cookie auth: a throwaway AUTH_ACCOUNTS_FILE with one coach assigned to this run's session.
  // Hashing in-process via Bun.password (argon2id) — same shape auth-user.ts writes, so the server loads
  // it unchanged — is simpler than shelling out to the CLI (no piped-stdin dance).
  //
  // Written in BOTH postures now. It used to be secure-only, which made the anonymous stack a place
  // where logging in was impossible — fine while anon could read everything, wrong since anon was scoped
  // to the live pitch (audit §4.1): signing in is how you get names and Review there, and the anon stack
  // is the ONLY place the sign-in ⇄ sign-out transition happens without unmounting the shell (the exact
  // path where a stale roster kept a child's name on screen for a principal no longer entitled to it).
  const hash = await Bun.password.hash(SIM_COACH_PW, { algorithm: 'argon2id' });
  await Bun.write(
    SIM_ACCOUNTS_FILE,
    JSON.stringify({ accounts: [{ username: SIM_COACH_USER, hash, role: 'coach', sessions: [SESSION] }] }, null, 2) + '\n',
  );
  await Bun.write(CONF, conf);

  // Phase-3 roster (ADR-0016): write a throwaway roster.json for THIS run's session in BOTH postures (secure
  // + anonymous) — names help verify the coach-view / e2e render regardless of dev posture. The shape mirrors
  // server/src/roster.ts exactly: { sessions: { "<sessionId>": [ { playerId, displayName } ] } }. The values
  // are DEV fixtures ("Player 01"), NOT real children, so §0.1 stays intact. The server is pointed at it via
  // AUTH_ROSTER_FILE below; the file is out-of-band from the published stream so --record/--replay are faithful.
  const rosterEntries = Array.from({ length: PLAYERS }, (_, i) => {
    const pl = playerId(i);
    return { playerId: pl, displayName: simDisplayName(pl) };
  });
  await Bun.write(
    SIM_ROSTER_FILE,
    JSON.stringify({ sessions: { [SESSION]: rosterEntries } }, null, 2) + '\n',
  );

  // Phase-4 session config (ADR-0019): write a throwaway SESSION_CONFIG_FILE giving THIS run's session an age
  // band so the spawned server serves real youth zone thresholds via GET /sessions/:id/config (the coach view
  // + Playwright e2e then render real zones instead of the client-side U14 fallback). Shape mirrors
  // server/src/sessionConfig.ts exactly: { sessions: { "<sessionId>": { ageBand } } }. Written in BOTH dev
  // postures; the server is pointed at it via SESSION_CONFIG_FILE below; out-of-band from the published stream.
  await Bun.write(
    SIM_SESSION_CONFIG_FILE,
    JSON.stringify({ sessions: { [SESSION]: { ageBand: SIM_AGE_BAND } } }, null, 2) + '\n',
  );

  const broker = Bun.spawn([Bun.which('mosquitto') ?? 'mosquitto', '-c', CONF], { stdout: 'ignore', stderr: 'ignore' });
  childKills.push(() => broker.kill());

  // Per-PORT DB path (env-overridable): concurrent --standalone instances (e.g. two e2e stacks)
  // must NOT share one SQLite file, or one instance's fresh-run reset unlinks the other's open DB
  // and every insert trips "disk I/O error". Cleared up-front — before the server opens it, not
  // after (deleting a live DB is what caused the storm).
  const DB_FILE = process.env.DB_PATH ?? `/tmp/ft-sim-${PORT}.db`;
  for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) if (existsSync(f)) rmSync(f);

  const env: Record<string, string> = {
    ...process.env,
    PORT: String(PORT), METRICS_PORT: String(METRICS_PORT),
    MQTT_URL: `mqtt://127.0.0.1:${BROKER_PORT}`, DB_PATH: DB_FILE, LOG_LEVEL: 'warn',
    // Phase-3 (ADR-0016): point the spawned server at the throwaway roster written above so the coach view +
    // e2e render DEV names ("Player 01"). Applies to both postures; ids-only still works if this is removed.
    AUTH_ROSTER_FILE: SIM_ROSTER_FILE,
    // Phase-4 (ADR-0019): point the spawned server at the throwaway session-config written above so the coach
    // view + e2e get real youth speed-zone thresholds for SESSION (not just the client-side U14 fallback).
    SESSION_CONFIG_FILE: SIM_SESSION_CONFIG_FILE,
  };
  // Env-overridable so a caller serving the client on a non-default port (e.g. the load-test
  // fixture on :5283) can allow its own origin; the default suits `bun run dev` on :5173.
  const allowedOrigins = process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173';
  // Both dev postures keep cookies non-Secure (the stack is reached over http://localhost via the Vite
  // proxy, where a Secure cookie would be silently dropped) — the server emits the loud boot warning.
  env.AUTH_COOKIE_SECURE = 'false';
  env.ALLOWED_ORIGINS = allowedOrigins;
  // Named cookie auth in BOTH postures: secure REQUIRES a login to reach /live; anon makes it OPTIONAL
  // (the pitch is open, but names + Review need an account since audit §4.1). currentPrincipal resolves
  // the cookie first and only falls back to the anon principal, so both work off the same account file.
  env.AUTH_ACCOUNTS_FILE = SIM_ACCOUNTS_FILE;
  if (secure) {
    env.MQTT_USERNAME = 'ingest'; env.MQTT_PASSWORD = INGEST_PW;
  } else {
    // dev-only posture so the React client connects with no login (physically-isolated-LAN bypass). Anon is
    // now SCOPED to ANON_SESSIONS — without it the client subscribes but reads nothing — so pin it to SESSION.
    env.ALLOW_ANONYMOUS_LIVE = 'true'; env.ANON_SESSIONS = SESSION;
  }
  const server = Bun.spawn(['bun', 'run', 'src/server.ts'], { cwd: `${import.meta.dir}/..`, env, stdout: 'inherit', stderr: 'inherit' });
  childKills.push(() => server.kill());

  for (let i = 0; i < 100; i++) {
    try {
      const b = (await (await fetch(`http://127.0.0.1:${METRICS_PORT}/health`)).json()) as { ok: boolean; mqtt: boolean };
      if (b.ok && b.mqtt) return;
    } catch { /* not up */ }
    await sleep(100);
  }
  throw new Error('standalone server did not become ready in 10 s');
}

// ----- shutdown -------------------------------------------------------------------------
function shutdown(code = 0) {
  if (telTimer) clearInterval(telTimer);
  if (statTimer) clearInterval(statTimer);
  if (recorder && RECORD_FILE) {
    writeFileSync(RECORD_FILE, recorder.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(`[sim] recorded ${recorder.length} packets -> ${RECORD_FILE}`);
  }
  for (const p of players) { try { p.client.end(true); } catch { /* noop */ } }
  for (const kill of childKills) { try { kill(); } catch { /* noop */ } }
  // Remove the throwaway roster (Phase-3, ADR-0016) so a dev-fixture name file never lingers on disk after a
  // run; the next --standalone also clears it up-front. Best-effort — never let cleanup block shutdown/exit.
  try { if (existsSync(SIM_ROSTER_FILE)) rmSync(SIM_ROSTER_FILE); } catch { /* noop */ }
  // Remove the throwaway session config (Phase-4, ADR-0019) too — same best-effort cleanup as the roster.
  try { if (existsSync(SIM_SESSION_CONFIG_FILE)) rmSync(SIM_SESSION_CONFIG_FILE); } catch { /* noop */ }
  setTimeout(() => process.exit(code), 200);
}

// ----- replay: re-publish a recorded stream with the original timing --------------------
async function runReplay() {
  if (!existsSync(REPLAY_FILE)) throw new Error(`replay file not found: ${REPLAY_FILE}`);
  const recs = readFileSync(REPLAY_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Rec);
  if (!recs.length) throw new Error(`replay file is empty: ${REPLAY_FILE}`);
  // Replay goes through ONE client, so it needs a broker that accepts writes to every player
  // topic — i.e. an anonymous broker. --standalone here always spawns the anonymous stack.
  if (STANDALONE) {
    console.log(`[sim] replay: spawning anonymous stack (broker :${BROKER_PORT}, server :${PORT})`);
    await startStandaloneStack(false);
  }
  const client = mqtt.connect(MQTT_URL, process.env.MQTT_USERNAME ? { username: process.env.MQTT_USERNAME, password: process.env.MQTT_PASSWORD } : {});
  await new Promise<void>((res) => { client.connected ? res() : client.once('connect', () => res()); setTimeout(res, 4000); });
  childKills.push(() => client.end(true));

  const span = recs[recs.length - 1].t;
  console.log(`[sim] replaying ${recs.length} packets over ${(span / 1000).toFixed(1)}s${REPLAY_SPEED !== 1 ? ` at ${REPLAY_SPEED}x` : ''}…`);
  const t0 = Date.now();
  for (const rec of recs) {
    const wait = rec.t / REPLAY_SPEED - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
    client.publish(rec.topic, rec.payload);
  }
  await sleep(500); // let the server drain + persist
  await scrapeReport('replay');
  shutdown(0);
}

// ----- orchestration --------------------------------------------------------------------
try {
  process.on('SIGINT', () => { console.log('\n[sim] stopping…'); scrapeReport('final').then(() => shutdown(0)); });
  // Playwright e2e fixtures stop the sim with SIGTERM (not SIGINT). Without this, the process dies
  // WITHOUT running shutdown(), orphaning the child mosquitto + server — which then squat their
  // ports and answer /health with a dead (non-publishing) backend, poisoning the next run.
  process.on('SIGTERM', () => { console.log('\n[sim] terminated'); shutdown(0); });

  if (REPLAY_FILE) {
    await runReplay();
  } else {
    if (STANDALONE) {
      console.log(`[sim] standalone${SECURE ? ' (secured)' : ''}: spawning mosquitto :${BROKER_PORT} + server :${PORT} (metrics :${METRICS_PORT})`);
      await startStandaloneStack(SECURE);
      // Coach view is now SAME-ORIGIN: the browser talks only to the Vite dev origin and Vite proxies
      // /live + /auth + /sessions to VITE_PROXY_TARGET (no VITE_WS_URL, no token — Phase 2).
      if (SECURE) {
        console.log(`[sim] stack ready. Open the coach view:  cd client && VITE_PROXY_TARGET=http://localhost:${PORT} bun run dev`);
        console.log(`[sim]   then log in as  ${SIM_COACH_USER} / ${SIM_COACH_PW}  (dev coach, assigned session="${SESSION}"; cookie-gated /live + per-player MQTT ACLs)`);
      } else {
        console.log(`[sim] stack ready. Open the coach view:  cd client && VITE_PROXY_TARGET=http://localhost:${PORT} VITE_DEFAULT_SESSION=${SESSION} bun run dev`);
        console.log(`[sim]   session="${SESSION}" (dev posture: /live anonymous/no-login on the isolated stack, scoped to ANON_SESSIONS="${SESSION}")`);
      }
      console.log(`[sim]   roster (ADR-0016): ${PLAYERS} DEV names ("Player 01"..) -> ${SIM_ROSTER_FILE} (dev fixtures, not real children); dots/mirror render names`);
      console.log(`[sim]   session config (ADR-0019): session="${SESSION}" ageBand=${SIM_AGE_BAND} -> ${SIM_SESSION_CONFIG_FILE}; GET /sessions/:id/config serves real youth zone thresholds`);
    } else if (SECURE) {
      console.log('[sim] --secure without --standalone: players will auth as <playerId>/sim-<playerId>-pw; your broker must have those accounts + the `%u` ACL.');
    }

    for (let i = 0; i < PLAYERS; i++) players.push(newPlayer(i));
    await Promise.all(players.map((p) => new Promise<void>((res) => {
      if (p.client.connected) return res();
      p.client.once('connect', () => res());
      setTimeout(res, 4000);
    })));

    telTimer = setInterval(telemetryTick, Math.round(1000 / RATE_HZ));
    statTimer = setInterval(statusTick, 5000);

    if (RAMP.length) {
      console.log(`[sim] load ramp: ${RAMP.join(' -> ')} players, ${STAGE_S}s per stage, ${RATE_HZ} Hz each`);
      for (const stage of RAMP) {
        active = Math.min(stage, PLAYERS);
        console.log(`[sim] stage: ${active} active players…`);
        await sleep(STAGE_S * 1000);
        await scrapeReport(`${active}p`);
      }
      shutdown(0);
    } else {
      active = PLAYERS;
      console.log(`[sim] streaming: ${active} players @ ${RATE_HZ} Hz${FAULTS ? ' + faults' : ''}${SECURE ? ' (secured)' : ''}, session="${SESSION}"${DURATION_S ? `, for ${DURATION_S}s` : ' (Ctrl-C to stop)'}${RECORD_FILE ? `, recording -> ${RECORD_FILE}` : ''}`);
      if (DURATION_S > 0) { await sleep(DURATION_S * 1000); await scrapeReport('final'); shutdown(0); }
    }
  }
} catch (err) {
  console.error('[sim] failed:', (err as Error).message);
  shutdown(1);
}
