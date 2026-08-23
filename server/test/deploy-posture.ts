/**
 * Static guard on the DEPLOYED posture of the local stack (audit §4.1 + §4.6).
 *
 * Both P0s were proven live against the running dev stack, and neither was a code bug — the code was
 * fine. §4.6 was compose mounting the *anonymous* broker config when the authenticated one already
 * existed two directories away; §4.1 was a port published on 0.0.0.0 for a server that requires no
 * login. Nothing in the test suite could see either, because a test that spawns its own server and its
 * own broker never reads docker-compose.yml. This file does.
 *
 * It is deliberately string/regex based rather than a YAML parse: there is no YAML dependency in this
 * project and adding one to read six lines would be worse. Every check therefore prints the line it
 * objected to, so a false positive is diagnosable in one read rather than mysterious.
 *
 * Runs in the gate AND, more importantly, in .github/workflows/repo-guard.yml — which has no path
 * filter, because a commit that re-opens the bind is exactly the commit a `server/**` filter misses.
 *
 *   bun run test/deploy-posture.ts        (or: bun run test:deploy-posture)
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..', '..');
const COMPOSE = join(REPO, 'docker-compose.yml');
const BROKER_CONF = join(REPO, 'server', 'mosquitto', 'mosquitto.conf');

let checks = 0;
const failures: string[] = [];

function check(label: string, cond: boolean, detail: string) {
  checks++;
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    failures.push(`${label}\n      ${detail}`);
  }
}

/** Lines of a file with comments and blanks stripped — a rule in a comment is documentation, not config. */
function directives(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

console.log('\ndeploy posture — docker-compose.yml + the broker config\n');

// ── 1. The server's published port must be pinned to loopback (§4.1) ─────────────────────────────
// The stack runs ALLOW_ANONYMOUS_LIVE=true: no login for the live view. Publishing that on 0.0.0.0
// puts a named child's live position on the subnet, and the bench runbook has the operator DISABLE
// Wi-Fi client isolation so the wearable can reach the broker — so "the LAN" includes guest phones.
const composeLines = directives(COMPOSE);
// Port entries look like `- "127.0.0.1:3007:3000"`. Find the one for the server's container port.
const portEntries = composeLines.filter((l) => /^-\s*"?\d[\d.:]*:\d+"?$/.test(l) || /^-\s*"[\d.]*:?\d+:\d+"$/.test(l));
const serverPortLine = portEntries.find((l) => /:3000"?$/.test(l));
check(
  'the server port is published on 127.0.0.1, not every interface',
  serverPortLine !== undefined && /"127\.0\.0\.1:\d+:3000"/.test(serverPortLine),
  serverPortLine === undefined
    ? `no "<host>:3000" port mapping found in ${COMPOSE}; port entries seen: ${JSON.stringify(portEntries)}`
    : `found: ${serverPortLine} — must be "127.0.0.1:<hostPort>:3000" (anon mode ⇒ no login ⇒ not LAN-reachable)`,
);

// ── 2. The broker must mount the AUTHENTICATED config (§4.6) ─────────────────────────────────────
const composeText = readFileSync(COMPOSE, 'utf8');
check(
  'the broker mounts server/mosquitto (the authenticated config + ACL)',
  /\.\/server\/mosquitto:\/mosquitto\/config/.test(composeText),
  `docker-compose.yml does not mount ./server/mosquitto at /mosquitto/config — the dev broker would not be the authenticated one`,
);
check(
  'the broker does NOT mount a deploy/mosquitto config',
  !/deploy\/mosquitto\/[\w.-]*\.conf/.test(composeText),
  `docker-compose.yml still references a deploy/mosquitto config — that file held allow_anonymous true and was deleted for exactly this reason`,
);

// ── 3. Broker credentials must be REQUIRED, not defaulted ────────────────────────────────────────
// `${MQTT_PASSWORD:?...}` makes compose refuse to start when .env is missing. A plain ${MQTT_PASSWORD}
// would substitute an empty string, the server would connect anonymously, the authenticated broker
// would refuse it, and the symptom would look like a broker fault rather than a skipped setup step.
for (const v of ['MQTT_USERNAME', 'MQTT_PASSWORD']) {
  check(
    `${v} is required by compose (\${${v}:?…}), so a missing .env fails loudly`,
    new RegExp(`\\$\\{${v}:\\?`).test(composeText),
    `docker-compose.yml must use \${${v}:?<message>}; a bare \${${v}} silently becomes empty`,
  );
}

// ── 4. The broker config itself ──────────────────────────────────────────────────────────────────
const brokerDirectives = directives(BROKER_CONF);
check(
  'the broker config sets allow_anonymous false',
  brokerDirectives.includes('allow_anonymous false'),
  `${BROKER_CONF} must contain "allow_anonymous false"; directives found: ${JSON.stringify(brokerDirectives)}`,
);
for (const [key, label] of [['password_file', 'password file'], ['acl_file', 'ACL file']] as const) {
  const line = brokerDirectives.find((l) => l.startsWith(`${key} `));
  check(
    `${label} path is absolute (a cwd-relative path makes mosquitto exit rather than start)`,
    line !== undefined && line.split(/\s+/)[1]?.startsWith('/') === true,
    line === undefined ? `${BROKER_CONF} has no ${key} directive` : `found: ${line}`,
  );
}

// ── 5. No anonymous broker config may exist anywhere in the tree ─────────────────────────────────
// Scoped to *.conf files: the server test suites legitimately WRITE anonymous configs at runtime (they
// are testing the server's own auth, not the broker's), and those live as strings inside .ts files.
// A committed .conf with allow_anonymous true is the artifact that caused §4.6 — one copy-paste from
// being mounted again.
function confFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === '__pycache__') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) confFiles(p, out);
    else if (e.name.endsWith('.conf')) out.push(p);
  }
  return out;
}
const anonConfs = confFiles(REPO).filter((f) => /^\s*allow_anonymous\s+true/m.test(readFileSync(f, 'utf8')));
check(
  'no committed *.conf enables anonymous MQTT',
  anonConfs.length === 0,
  `these config files set allow_anonymous true: ${anonConfs.map((f) => f.replace(REPO + '/', '')).join(', ')}`,
);

// ── 5b. The telemetry store must be a host-visible BIND mount, not a named volume (§4.5 d) ───────
// With `server_data:/data` the documented host-side `purge-player.ts` invocation deleted the child's NAME
// from the bind-mounted roster.json and could not reach the positions at all — they lived in a volume no
// host path addresses — then reported {erased:0, retry:true} forever. A bind mount makes the store a file
// the operator can see, back up, and erase from the host; the runbook's `docker compose exec` form works
// either way, but the wrong form must not be able to destroy the identifier while leaving the trace.
const dataMounts = composeLines.filter((l) => /:\/data"?$/.test(l));
check(
  'the server mounts ./server/data at /data (bind mount — the store is a host-visible file)',
  dataMounts.some((l) => /^-\s*"?\.\/server\/data:\/data"?$/.test(l)),
  `no "- ./server/data:/data" volume entry in ${COMPOSE}; /data entries seen: ${JSON.stringify(dataMounts)}`,
);
check(
  'DB_PATH points inside /data (the mount and the env are two halves of one invariant)',
  composeLines.some((l) => /^DB_PATH:\s*\/data\/\S+/.test(l)),
  `no "DB_PATH: /data/<file>" directive in the server service — a store outside /data is unreachable from the host and lost on container recreate`,
);
check(
  'no named volume holds the telemetry store',
  !dataMounts.some((l) => /^-\s*"?[A-Za-z_][\w-]*:\/data"?$/.test(l)),
  `a named volume is still mounted at /data (${JSON.stringify(dataMounts)}) — positions would again be unreachable from the host`,
);

// ── 6. The provisioning script the whole stack now depends on must exist and be executable ───────
const provision = join(REPO, 'server', 'mosquitto', 'dev-provision.sh');
check(
  'server/mosquitto/dev-provision.sh exists (compose is unusable without the accounts it creates)',
  existsSync(provision),
  `${provision} is missing, but docker-compose.yml requires the .env and ft.passwd it writes`,
);

if (failures.length) {
  console.error(`\n❌ deploy-posture: ${failures.length} of ${checks} checks FAILED:\n`);
  for (const f of failures) console.error(`   • ${f}\n`);
  process.exit(1);
}
console.log(`\n✅ deploy-posture: ${checks} checks passed — the dev stack is loopback-published and its broker is authenticated.\n`);
