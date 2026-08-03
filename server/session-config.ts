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
 *   bun run session-config.ts set u12-sat U12     # upsert one session's band
 *   bun run session-config.ts remove u12-sat      # delete one session's config
 *   bun run session-config.ts list                # every configured session + its band
 *
 * Exit 0 on success; non-zero with a clear message on error. Mirrors roster-user.ts.
 *
 * UNLIKE roster-user.ts, the age band is NOT a name → it MAY be printed freely on every path
 * (success, list, AND validation errors): there is no value to redact. A bad band is reported with the
 * offending value so the operator sees exactly what was rejected — and the file is left UNTOUCHED
 * (validate before load/write), so a typo can never corrupt an existing config.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

type AgeBand = 'U12' | 'U14' | 'U16' | 'U19';
interface SessionConfigEntry {
  ageBand: AgeBand;
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
  writeFileSync(FILE, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
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
  file.sessions[sessionId] = { ageBand };
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

function cmdList(): void {
  const file = load();
  const sessionIds = Object.keys(file.sessions);
  let total = 0;
  for (const sid of sessionIds) {
    const entry = file.sessions[sid];
    if (!entry || !entry.ageBand) continue;
    console.log(`  - ${sid} → ${entry.ageBand}`); // age band is non-sensitive — print freely
    total += 1;
  }
  if (total === 0) console.log(`(no session configs in ${FILE})`);
}

switch (cmd) {
  case 'set':
    cmdSet();
    break;
  case 'remove':
    cmdRemove();
    break;
  case 'list':
    cmdList();
    break;
  default:
    console.error('usage: bun run session-config.ts <set|remove|list> …');
    console.error(`  set <sessionId> <ageBand>   (ageBand one of ${BANDS.join(', ')})`);
    console.error('  remove <sessionId>');
    console.error('  list');
    process.exit(cmd ? 1 : 0);
}
