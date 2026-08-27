#!/usr/bin/env bun
/**
 * session-config.ts — provision the per-session age band that selects youth speed-zone thresholds
 * (Phase 4; ADR-0019, within metric-definitions.md §1/§3). See docs/frontend/phase-4-contract.md §2.2.
 *
 * The server loads + periodically reloads SESSION_CONFIG_FILE (default ./session-config.json), so a
 * set/remove here takes effect within SESSION_CONFIG_RELOAD_SECONDS without a restart. Written mode
 * 0o600 (owner-only) to keep the same at-rest posture as roster.json/auth-accounts.json — defence in
 * depth, even though this file holds NO names or locations: the age band is non-sensitive config.
 *
 *   bun run session-config.ts set u12-sat U12     # upsert one session's band (KEEPS any pitch)
 *   bun run session-config.ts set-pitch u12-sat 44.8128,20.4605 44.8128,20.4619 44.8122,20.4619 44.8122,20.4605
 *                                                 # the pitch's four GPS corners, on-screen order TL TR BR BL
 *   bun run session-config.ts clear-pitch u12-sat # back to the client's built-in corners
 *   bun run session-config.ts remove u12-sat      # delete one session's config
 *   bun run session-config.ts list                # every configured session + its band + whether a pitch is set
 *
 * Exit 0 on success; non-zero with a clear message on error. Mirrors roster-user.ts.
 *
 * UNLIKE roster-user.ts, the age band is NOT a name → it MAY be printed freely on every path
 * (success, list, AND validation errors): there is no value to redact. A bad band is reported with the
 * offending value so the operator sees exactly what was rejected — and the file is left UNTOUCHED
 * (validate before load/write), so a typo can never corrupt an existing config.
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeSecretFile } from './src/secretFile';
import { withFileLock } from './src/fileLock';

type AgeBand = 'U12' | 'U14' | 'U16' | 'U19';
interface LatLon {
  lat: number;
  lon: number;
}
interface SessionConfigEntry {
  ageBand: AgeBand;
  /** Phase 5: the pitch's four GPS corners in on-screen order (TL, TR, BR, BL). Optional. */
  pitch?: { corners: LatLon[] };
}
interface SessionConfigFile {
  sessions: Record<string, SessionConfigEntry>;
}

const FILE = process.env.SESSION_CONFIG_FILE ?? './session-config.json';
const BANDS: readonly AgeBand[] = ['U12', 'U14', 'U16', 'U19']; // must match BANDS in src/sessionConfig.ts
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,64}$/; // must match PLAYER_ID_RE in src/roster.ts (same charset)

const argv = process.argv.slice(2);
const cmd = argv[0];

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function isBand(v: string): v is AgeBand {
  return (BANDS as readonly string[]).includes(v);
}

function load(): SessionConfigFile {
  if (!existsSync(FILE)) return { sessions: {} };
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<SessionConfigFile>;
    // Normalise to a sane shape; a missing/odd `sessions` becomes an empty object rather than a crash.
    const sessions =
      parsed.sessions && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)
        ? (parsed.sessions as Record<string, SessionConfigEntry>)
        : {};
    return { sessions };
  } catch {
    fail(`session-config file is not valid JSON: ${FILE} (fix or delete it before re-running)`);
  }
}

function save(file: SessionConfigFile): void {
  // 0600 via an atomic temp+rename+chmod (src/secretFile.ts). `writeFileSync(..., { mode })`
  // applies the mode only when the file is CREATED, so an existing 0644 file stayed 0644 —
  // the audit's "mode 0o600 is a no-op" finding, verified on both write paths.
  writeSecretFile(FILE, JSON.stringify(file, null, 2) + '\n');
}

function cmdSet(): void {
  const sessionId = argv[1];
  const ageBand = argv[2];
  if (!sessionId || ageBand === undefined) {
    fail(`usage: set <sessionId> <ageBand>  (ageBand one of ${BANDS.join(', ')})`);
  }
  if (!SESSION_ID_RE.test(sessionId)) fail('invalid sessionId (charset [A-Za-z0-9._-], 1-64 chars)');
  // Validate the band BEFORE touching the file, so a bad band can never corrupt an existing config.
  // The band is not a name → echoing the rejected value is safe and helps the operator.
  if (!isBand(ageBand)) fail(`invalid ageBand "${ageBand}" (must be one of ${BANDS.join(', ')})`);

  const file = load();
  const existed = sessionId in file.sessions;
  // MERGE, never replace: a session's measured pitch (Phase 5) must survive a routine band correction.
  // Replacing the whole entry here would silently discard four coordinates somebody walked the pitch to
  // collect — and the loss would only show up as players landing in the wrong box at the next match.
  file.sessions[sessionId] = { ...file.sessions[sessionId], ageBand };
  save(file);
  console.log(
    `✅ ${existed ? 'updated' : 'set'} ${sessionId} → ${ageBand} → ${FILE}` +
      ` (the server reloads it within SESSION_CONFIG_RELOAD_SECONDS)`,
  );
}

function cmdRemove(): void {
  const sessionId = argv[1];
  if (!sessionId) fail('usage: remove <sessionId>');
  const file = load();
  if (!(sessionId in file.sessions)) fail(`no such session config: ${sessionId}`);
  delete file.sessions[sessionId];
  save(file);
  console.log(`✅ removed ${sessionId} → ${FILE} (the server reloads it within SESSION_CONFIG_RELOAD_SECONDS)`);
}

// ---------------------------------------------------------------------------------------------------
// Phase 5 (audit §6 "Client"): the pitch corners.
//
// They used to be a compile-time constant in the client bundle — and the committed value pointed at a
// bench in Belgrade, so every real pitch mapped to the wrong box and fixing it meant editing source and
// rebuilding. Measure the four corners once (stand at each with a device, read lat/lon) and set them here.
//
// The geometry is VALIDATED BEFORE the file is touched, because the client solves a homography from
// these four points: a degenerate quad throws inside that solve and white-screens the coach view. The
// rules MUST match validatePitchCorners in src/sessionConfig.ts (and parsePitchCorners in the client).
// ---------------------------------------------------------------------------------------------------
const PITCH_MIN_SIDE_M = 10;
const PITCH_MAX_SIDE_M = 250;
const MIN_CORNER_SEPARATION_M = 1;
const M_PER_DEG_LAT = 111_320;

/** Parse one "lat,lon" argument. Returns null (rather than throwing) so the caller can name the corner. */
function parseCorner(arg: string): LatLon | null {
  const parts = arg.split(',');
  if (parts.length !== 2) return null;
  const lat = Number(parts[0].trim());
  const lon = Number(parts[1].trim());
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

/** Reject the quads that would break (or silently mis-map) the client's homography. */
function pitchProblem(corners: LatLon[]): string | null {
  const ref = corners[0];
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((ref.lat * Math.PI) / 180);
  const m = corners.map((c) => [(c.lon - ref.lon) * mPerDegLon, (c.lat - ref.lat) * M_PER_DEG_LAT] as const);
  const NAMES = ['TL', 'TR', 'BR', 'BL'];

  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      if (Math.hypot(m[i][0] - m[j][0], m[i][1] - m[j][1]) < MIN_CORNER_SEPARATION_M) {
        return `corners ${NAMES[i]} and ${NAMES[j]} are the same point (they must be at least ${MIN_CORNER_SEPARATION_M} m apart)`;
      }
    }
  }
  for (let i = 0; i < 4; i++) {
    const a = m[i];
    const b = m[(i + 1) % 4];
    const side = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (side < PITCH_MIN_SIDE_M || side > PITCH_MAX_SIDE_M) {
      return `side ${NAMES[i]}→${NAMES[(i + 1) % 4]} is ${side.toFixed(1)} m — outside the plausible ${PITCH_MIN_SIDE_M}-${PITCH_MAX_SIDE_M} m range (check the corner order and that lat/lon are not swapped)`;
    }
  }
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = m[i];
    const [bx, by] = m[(i + 1) % 4];
    const [cx, cy] = m[(i + 2) % 4];
    const z = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(z) < 1) return `corners ${NAMES[i]}, ${NAMES[(i + 1) % 4]} and ${NAMES[(i + 2) % 4]} are in a straight line — the GPS→pitch mapping cannot be solved`;
    const s = z > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return 'the four corners cross over themselves — give them in on-screen order TL, TR, BR, BL (going around the pitch, not diagonally)';
  }
  return null;
}

function cmdSetPitch(): void {
  const sessionId = argv[1];
  const args = argv.slice(2);
  if (!sessionId || args.length !== 4) {
    fail('usage: set-pitch <sessionId> <TL> <TR> <BR> <BL>   where each corner is "lat,lon"');
  }
  if (!SESSION_ID_RE.test(sessionId)) fail('invalid sessionId (charset [A-Za-z0-9._-], 1-64 chars)');

  const NAMES = ['TL', 'TR', 'BR', 'BL'];
  const corners: LatLon[] = [];
  for (let i = 0; i < 4; i++) {
    const c = parseCorner(args[i]);
    if (!c) fail(`corner ${NAMES[i]} ("${args[i]}") is not a valid "lat,lon" pair (lat -90..90, lon -180..180)`);
    corners.push(c);
  }
  // Validate BEFORE load/write, so a bad quad can never corrupt an existing config.
  const problem = pitchProblem(corners);
  if (problem) fail(`these four corners are not a usable pitch: ${problem}`);

  const file = load();
  if (!(sessionId in file.sessions)) {
    fail(`no such session config: ${sessionId} (set its age band first: set ${sessionId} <ageBand>)`);
  }
  file.sessions[sessionId] = { ...file.sessions[sessionId], pitch: { corners } };
  save(file);
  console.log(
    `✅ pitch set for ${sessionId} (TL,TR,BR,BL) → ${FILE}` +
      ` (the server reloads it within SESSION_CONFIG_RELOAD_SECONDS)`,
  );
}

function cmdClearPitch(): void {
  const sessionId = argv[1];
  if (!sessionId) fail('usage: clear-pitch <sessionId>');
  const file = load();
  const entry = file.sessions[sessionId];
  if (!entry) fail(`no such session config: ${sessionId}`);
  if (!entry.pitch) fail(`${sessionId} has no configured pitch (nothing to clear)`);
  delete entry.pitch;
  save(file);
  console.log(`✅ pitch cleared for ${sessionId} → ${FILE} (the coach view falls back to its built-in corners)`);
}

function cmdList(): void {
  const file = load();
  const sessionIds = Object.keys(file.sessions);
  let total = 0;
  for (const sid of sessionIds) {
    const entry = file.sessions[sid];
    if (!entry || !entry.ageBand) continue;
    // Whether a session has a MEASURED pitch or is still on the client's built-in corners is exactly
    // the question this feature exists to answer — so `list` states it rather than making an operator
    // read the JSON. Corner values are a place, not a person; printing the count is enough here.
    const pitch = entry.pitch?.corners?.length === 4 ? 'pitch: set' : 'pitch: —';
    console.log(`  - ${sid} → ${entry.ageBand}  (${pitch})`); // age band is non-sensitive — print freely
    total += 1;
  }
  if (total === 0) console.log(`(no session configs in ${FILE})`);
}

/** Mutating commands serialise on the shared file lock — see auth-user.ts's note on the same change. */
const mutate = async (fn: () => void | Promise<void>): Promise<void> => {
  await withFileLock(FILE, { what: 'session-config', envHint: 'SESSION_CONFIG_FILE' }, async () => {
    await fn();
  });
};

switch (cmd) {
  case 'set':
    await mutate(cmdSet);
    break;
  case 'set-pitch':
    await mutate(cmdSetPitch);
    break;
  case 'clear-pitch':
    await mutate(cmdClearPitch);
    break;
  case 'remove':
    await mutate(cmdRemove);
    break;
  case 'list':
    cmdList();
    break;
  default:
    console.error('usage: bun run session-config.ts <set|set-pitch|clear-pitch|remove|list> …');
    console.error(`  set <sessionId> <ageBand>   (ageBand one of ${BANDS.join(', ')})`);
    console.error('  set-pitch <sessionId> <TL> <TR> <BR> <BL>   (each corner "lat,lon", on-screen order)');
    console.error('  clear-pitch <sessionId>');
    console.error('  remove <sessionId>');
    console.error('  list');
    process.exit(cmd ? 1 : 0);
}
