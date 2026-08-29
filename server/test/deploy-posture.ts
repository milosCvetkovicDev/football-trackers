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

// ── 7. PHASE 6: the dev stack must stay SIGNAL-DELIVERABLE ───────────────────────────────────────
// Measured before Phase 6: `docker stop ft-server` exited 137 (SIGKILL) in 1.3 s, because the command
// was `sh -c "…"` — sh is pid 1, does not forward SIGTERM, and Bun therefore never ran a line of the
// teardown. Two things fix it and BOTH must stay: `exec` (so bun replaces the shell) and `init: true`
// (so a stop during `bun install` is also delivered). Dropping either silently restores the 137, and
// no runtime test can see it because the suites spawn bare processes, not containers.
check(
  'the dev server command execs bun (so bun, not sh, receives SIGTERM)',
  /command:\s*sh -c "[^"]*\bexec bun run src\/server\.ts"/.test(composeText),
  'docker-compose.yml must run the server via `exec bun run src/server.ts` — without exec, sh stays pid 1 and `docker stop` is a SIGKILL (exit 137)',
);
check(
  'the dev server sets init: true (signals are delivered during the install window too)',
  /\binit:\s*true\b/.test(composeText),
  'docker-compose.yml must set `init: true` on the server service',
);
check(
  'the dev server installs from the lockfile (--frozen-lockfile)',
  /bun install --frozen-lockfile/.test(composeText),
  'the dev stack must install exactly what bun.lock says, not resolve something newer at container start',
);
check(
  'the dev server has a healthcheck on /health',
  /healthcheck:/.test(composeText) && /healthcheck\.ts/.test(composeText),
  'docker-compose.yml must healthcheck the server via `bun run /app/healthcheck.ts` (this image has no curl/wget/nc)',
);
for (const svc of ['mosquitto', 'server']) {
  check(
    `the ${svc} service caps its log size`,
    (composeText.match(/max-size/g) ?? []).length >= 2,
    'both services need `logging: driver: json-file, options: {max-size, max-file}` — the default json-file driver is unbounded and fills the disk the store lives on',
  );
}

// ── 8. PHASE 6: the PRODUCTION stack (audit I-1) ─────────────────────────────────────────────────
// The audit's finding was "no production artifact" — so these checks are about the artifact existing
// AND not quietly inheriting the dev stack's deliberate compromises (anon mode, a LAN-published port).
const PROD = join(REPO, 'deploy', 'production', 'compose.yml');
check('deploy/production/compose.yml exists (audit I-1)', existsSync(PROD), `${PROD} is missing`);
if (existsSync(PROD)) {
  const prod = readFileSync(PROD, 'utf8');
  const prodLines = directives(PROD);
  check(
    'production does NOT enable anonymous live access',
    !/^\s*ALLOW_ANONYMOUS_LIVE:\s*"?true"?/m.test(prod),
    'deploy/production/compose.yml sets ALLOW_ANONYMOUS_LIVE=true — production must authenticate every read of a child position',
  );
  check(
    "production publishes the server on loopback only (it belongs behind the TLS proxy)",
    prodLines.some((l) => /^-\s*"127\.0\.0\.1:\d+:3000"$/.test(l)),
    `no "127.0.0.1:<port>:3000" mapping in ${PROD}`,
  );
  check(
    'production does NOT publish the broker on every interface',
    !prodLines.some((l) => /^-\s*"(0\.0\.0\.0:)?\d+:1883"$/.test(l)),
    `${PROD} publishes 1883 on all interfaces — it must bind the field AP address (\${FIELD_AP_IP})`,
  );
  check(
    'production mounts the SAME authenticated broker config as dev',
    /server\/mosquitto:\/mosquitto\/config/.test(prod),
    `${PROD} must mount server/mosquitto — one broker config, exercised on every bench run`,
  );
  check(
    'production sets init: true + a stop_grace_period (the teardown can actually run)',
    /\binit:\s*true\b/.test(prod) && /stop_grace_period:/.test(prod),
    `${PROD} must set init: true and stop_grace_period on the server service`,
  );
  check(
    'production sets AUTH_COOKIE_SECURE=true',
    /AUTH_COOKIE_SECURE:\s*"?true"?/.test(prod),
    `${PROD} must keep session cookies Secure`,
  );
}

// ── 9. PHASE 6: the production IMAGE must be non-root and carry no personal data ─────────────────
const DOCKERFILE = join(REPO, 'server', 'Dockerfile');
const DOCKERIGNORE = join(REPO, 'server', '.dockerignore');
check('server/Dockerfile exists', existsSync(DOCKERFILE), `${DOCKERFILE} is missing`);
if (existsSync(DOCKERFILE)) {
  const df = readFileSync(DOCKERFILE, 'utf8');
  // The LAST USER wins, so a lookahead over "any USER line" passes on a Dockerfile that ends `USER root`
  // — a checker pass appended exactly that and this file still printed "37 checks passed ... non-root".
  const lastUser = [...df.matchAll(/^USER\s+(\S+)/gm)].map((m) => m[1]).pop();
  check(
    'the image runs as a non-root user (the LAST USER instruction wins)',
    lastUser !== undefined && lastUser !== 'root' && lastUser !== '0',
    `${DOCKERFILE}'s effective USER is ${lastUser ?? '(none — defaults to root)'}`,
  );
  check('the image installs from the lockfile', /--frozen-lockfile/.test(df), `${DOCKERFILE} must use bun install --frozen-lockfile`);
  check(
    'the image uses an exec-form CMD (so SIGTERM reaches bun)',
    /^CMD\s*\[/m.test(df),
    `${DOCKERFILE} must use the JSON/exec form of CMD — a shell form re-creates the exit-137 bug`,
  );
  check('the image pins its base tags (no :latest)', !/^FROM\s+\S+:latest/m.test(df), `${DOCKERFILE} must not use a :latest base image`);
  check(
    'the image never COPYs the whole context',
    !/^COPY\s+\.\s+\.?/m.test(df),
    `${DOCKERFILE} uses \`COPY . .\` — that would bake roster.json / auth-accounts.json / the store into a layer`,
  );
}
check('server/.dockerignore exists', existsSync(DOCKERIGNORE), `${DOCKERIGNORE} is missing`);
if (existsSync(DOCKERIGNORE)) {
  const di = directives(DOCKERIGNORE);
  // These four are the reason the file exists: names, password hashes, the raw store, broker creds.
  for (const must of ['roster.json', 'auth-accounts.json', 'data', 'mosquitto/ft.passwd']) {
    check(
      `.dockerignore excludes ${must}`,
      di.includes(must),
      `${DOCKERIGNORE} must list ${must} — an image layer survives every later deletion and travels with the image`,
    );
  }
}

// ── 9. The vision images inherit the same posture (the gpu target used to run as ROOT) ──────────
// vision/ is the subproject that feeds attacker-influenced input (an arbitrary YouTube download)
// through yt-dlp + ffmpeg + torch — and until this section existed, nothing guarded its Dockerfile
// at all: the `gpu` target ran as root while the server image was held to non-root. Vision images
// DO `COPY . .` by design (the runtime services bind-mount the source over it anyway), so the
// context is bounded by .dockerignore instead — which makes .dockerignore load-bearing and pinned
// here the same way server/.dockerignore is above.
const VISION_DF = join(REPO, 'vision', 'Dockerfile');
const VISION_DI = join(REPO, 'vision', '.dockerignore');
const VISION_COMPOSE = join(REPO, 'vision', 'docker-compose.yml');
check('vision/Dockerfile exists', existsSync(VISION_DF), `${VISION_DF} is missing`);
if (existsSync(VISION_DF)) {
  const vdf = readFileSync(VISION_DF, 'utf8');
  check('vision images pin their base tags (no :latest)', !/^FROM\s+\S+:latest/m.test(vdf), `${VISION_DF} must not use a :latest base image`);
  // Every build stage must drop root. Split the file into stages on FROM and require USER app in
  // each — a stage-scoped check, because `USER` in one stage says nothing about the next.
  const stages = vdf.split(/^FROM\s+/m).slice(1);
  for (const stage of stages) {
    const name = (stage.match(/AS\s+(\S+)/)?.[1] ?? stage.split(/\s/)[0]).trim();
    check(
      `vision Dockerfile stage '${name}' runs as a non-root USER`,
      /^USER\s+app\s*$/m.test(stage),
      `the '${name}' stage of ${VISION_DF} has no \`USER app\` — it runs yt-dlp/ffmpeg/torch over downloaded input as root`,
    );
  }
}
check('vision/.dockerignore exists', existsSync(VISION_DI), `${VISION_DI} is missing — vision images COPY the whole context, so this file is the only thing keeping footage/weights out of layers`);
if (existsSync(VISION_DI)) {
  const vdi = directives(VISION_DI);
  // Footage, weights, artifacts, the attestation ledger, git history: none may enter an image layer.
  for (const must of ['models/', 'samples/', 'out/', 'var/', '*.mp4', '*.pt', '.git/']) {
    check(
      `vision/.dockerignore excludes ${must}`,
      vdi.includes(must),
      `${VISION_DI} must list ${must} — vision images COPY the whole context, and a layer survives every later deletion`,
    );
  }
}
check('vision/docker-compose.yml exists', existsSync(VISION_COMPOSE), `${VISION_COMPOSE} is missing`);
if (existsSync(VISION_COMPOSE)) {
  // The web UI has no authentication and serves derived footage; every published port must be
  // loopback-pinned (same §4.1 argument as the server port above, with fewer excuses).
  const vPorts = directives(VISION_COMPOSE).filter((l) => /^-\s*"?[\d.]*:?\d+:\d+"?$/.test(l));
  check(
    'every vision published port is pinned to 127.0.0.1',
    vPorts.length > 0 && vPorts.every((l) => /"127\.0\.0\.1:\d+:\d+"/.test(l)),
    `vision/docker-compose.yml publishes a port on every interface: ${vPorts.filter((l) => !/127\.0\.0\.1/.test(l)).join(' | ') || '(no port entries found — the check pattern may need updating)'}`,
  );
}

if (failures.length) {
  console.error(`\n❌ deploy-posture: ${failures.length} of ${checks} checks FAILED:\n`);
  for (const f of failures) console.error(`   • ${f}\n`);
  process.exit(1);
}
console.log(`\n✅ deploy-posture: ${checks} checks passed — the dev stack is loopback-published, signal-deliverable and its broker is authenticated;\n   the production stack authenticates every read, publishes nothing on 0.0.0.0, and its image is non-root with no personal data in it.\n`);
