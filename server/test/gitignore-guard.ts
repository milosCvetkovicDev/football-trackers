/**
 * gitignore-guard.ts — the Phase-1 SAFETY-NET gate: prove no personal data or secret can enter git.
 *
 * WHY THIS IS A TEST AND NOT A README LINE. This project tracks CHILDREN. `roster.json` is the only
 * place their real names live at rest, `auth-accounts.json` holds the coaches' password hashes, and
 * `ft.passwd` holds the credential every wearable authenticates with. Git history is APPEND-ONLY:
 * a `git add .` that sweeps one of those in is not undone by `git rm` — the blob stays reachable in
 * every commit that followed. There is no "fix it next commit". The window for catching this is
 * BEFORE the add, which is what this file is.
 *
 * It asserts in BOTH directions, because a .gitignore fails in two opposite ways:
 *   1. TOO NARROW — a sensitive path is committable.        (the leak)
 *   2. TOO BROAD  — a required path is silently dropped.    (the quiet loss)
 * Direction 2 is not hypothetical here: `vision/.gitignore` shipped with `models/` + a
 * `!models/MANIFEST.json` re-include that could never fire, because git does not descend into an
 * excluded DIRECTORY to evaluate negations. The manifest was invisible to git and nothing noticed.
 *
 * The static lists below are the *known* surface. The sweep in step 3 is the part that catches what
 * the lists forgot: it asks git itself what `git add .` would stage right now, and fails on anything
 * matching a sensitive shape — so a roster.json in a directory nobody anticipated still trips it.
 *
 *   bun run test/gitignore-guard.ts   — exits 0 on success, 1 on any failed assertion.
 */

import { resolve } from 'node:path';

function git(args: string[], cwd?: string): { code: number; out: string } {
  const p = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return { code: p.exitCode, out: new TextDecoder().decode(p.stdout) };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

// The guard runs from server/; every path below is relative to the REPO ROOT.
const REPO = resolve(import.meta.dir, '../..');

/**
 * Paths that must be ignored. They do NOT have to exist — `git check-ignore` matches patterns, not
 * files, which is the whole point: the rule is proven before the file is ever created. Each entry is
 * a real path the code or docs can produce, not a hypothetical.
 */
const MUST_IGNORE: Array<[path: string, why: string]> = [
  ['server/roster.json', "children's real names (AUTH_ROSTER_FILE — roster-user.ts)"],
  ['roster.json', 'same file if the server is run from the repo root'],
  ['server/data/roster.json', 'same file under the containerised store (Phase 2b bind mount)'],
  ['server/auth-accounts.json', 'argon2id coach password hashes (AUTH_ACCOUNTS_FILE — auth-user.ts)'],
  ['server/session-config.json', 'per-session config incl. age band (session-config.ts)'],
  ['server/mosquitto/ft.passwd', 'mosquitto credential DB — every wearable authenticates with it'],
  ['server/telemetry.db', "children's positions at rest"],
  ['server/telemetry.db-wal', 'WAL sidecar — holds pre-checkpoint page images of the same rows'],
  ['server/telemetry.db-shm', 'shared-memory index for the WAL'],
  ['.env', 'ROBOFLOW_API_KEY and any MQTT/AUTH override'],
  ['vision/.env', 'docker compose sources it for ROBOFLOW_API_KEY'],
  ['.claude/settings.local.json', 'machine-local permissions, may name local paths'],
  ['.DS_Store', 'Finder metadata (leaks directory names)'],
  ['server/.DS_Store', 'the same, one level down'],
  ['vision/models/players.pt', 'model weights — 137 MB, and ADR-0023 keeps them out of VCS'],
  ['vision/samples/clip.mp4', 'raw footage of children — the ADR-0023 §3 privacy firewall'],
  ['vision/out/clip/annotated.mp4', 'derived footage of children'],
  ['node_modules/x', 'dependency tree'],
  ['server/node_modules/x', 'dependency tree'],
  ['firmware/.pio/build/x.o', 'PlatformIO build tree'],
  ['vision/.venv/bin/python', 'python virtualenv'],
];

/**
 * The inverse assertions. Every entry is a file the repo genuinely needs in version control, and
 * each one sits close enough to a broad rule that a careless widening would swallow it. This is the
 * list that would have caught the `models/` bug on the day it was written.
 */
const MUST_TRACK: Array<[path: string, why: string]> = [
  ['vision/models/MANIFEST.json', 'the weight manifest — checksums, no weights; the `models/` bug hid exactly this'],
  ['server/mosquitto/ft.acl', 'topic ACL: pseudonymous player ids, no secret — must stay reviewable in the diff'],
  ['server/mosquitto/mosquitto.conf', 'broker config — no credentials in it'],
  ['.claude/launch.json', 'shared dev-server config (settings.local.json is the machine-local one)'],
  ['.github/workflows/client-ci.yml', 'CI is inert if the workflow files are not committed'],
  ['vision/samples.manifest.jsonl', 'sample provenance — no footage'],
  ['server/src/db.ts', 'proves the `*.db` data rule did not widen into `*db*` and eat the source file'],
  ['docs/audit/2026-08-03-production-readiness.md', 'docs must survive the `out/`-style rules'],
  ['client/src/App.tsx', 'the app itself'],
  ['firmware/src/main.cpp', 'the firmware itself'],
];

/** Shapes that must never be committable, wherever they appear. Drives the step-3 sweep. */
const SENSITIVE_SHAPES: Array<[re: RegExp, what: string]> = [
  [/(^|\/)roster\.json$/, 'child-name roster'],
  [/(^|\/)auth-accounts\.json$/, 'password hashes'],
  [/(^|\/)session-config\.json$/, 'session config'],
  [/\.passwd$/, 'broker credential DB'],
  [/(^|\/)\.env(\..+)?$/, 'environment secrets'],
  [/(^|\/)settings\.local\.json$/, 'machine-local editor settings'],
  [/\.(db|db-wal|db-shm|sqlite|sqlite3)$/, 'telemetry store'],
  [/\.(pt|engine|onnx|weights)$/, 'model weights'],
  [/\.(mp4|mov|360|mkv|avi)$/, 'raw or derived footage of children'],
  [/(^|\/)\.DS_Store$/, 'Finder metadata'],
  [/(^|\/)id_(rsa|ed25519)$/, 'private key'],
  [/\.(pem|key|p12|pfx)$/, 'private key or certificate'],
];
/** Deliberate exceptions to the shapes above — each must be justified, not merely convenient. */
const SHAPE_ALLOW: RegExp[] = [
  /(^|\/)\.env\.example$/, // a template with placeholder values, no real secret
];

let checks = 0;

try {
  // ── 0. There must be a repo to check. A guard that silently no-ops is worse than no guard. ──────
  const top = git(['rev-parse', '--show-toplevel'], REPO);
  assert(
    top.code === 0,
    `not a git repository at ${REPO} — this guard cannot verify anything, and a green run here would be a lie. ` +
      `Run \`git init\` first (see docs/audit/2026-08-03-production-readiness.md §8 Phase 1).`,
  );
  assert(
    resolve(top.out.trim()) === REPO,
    `expected the repo root to be ${REPO}, got ${top.out.trim()} — the guard is checking the wrong tree`,
  );

  // ── 1. Sensitive paths ARE ignored (the leak direction). ────────────────────────────────────────
  for (const [path, why] of MUST_IGNORE) {
    const r = git(['check-ignore', '-q', '--no-index', path], REPO);
    assert(r.code === 0, `LEAK: "${path}" is NOT gitignored — ${why}. Add a rule to .gitignore before committing.`);
    checks++;
  }

  // ── 2. Required paths are NOT ignored (the quiet-loss direction). ───────────────────────────────
  for (const [path, why] of MUST_TRACK) {
    const r = git(['check-ignore', '-q', '--no-index', path], REPO);
    const m = git(['check-ignore', '-v', '--no-index', path], REPO);
    assert(
      r.code !== 0,
      `OVER-BROAD: "${path}" IS gitignored but must be tracked — ${why}.\n  matched by: ${m.out.trim() || '(unknown)'}`,
    );
    checks++;
  }

  // ── 3. The sweep: nothing sensitive is committable RIGHT NOW. ───────────────────────────────────
  // Two sets together cover everything that can end up in a commit:
  //   a) untracked-and-not-ignored — exactly what `git add .` would newly stage;
  //   b) already tracked — .gitignore does NOT protect a tracked file, so a rule added after the
  //      fact is cosmetic. This is the check that notices the barn door is already open.
  const staged = git(['ls-files', '--others', '--exclude-standard'], REPO).out.split('\n').filter(Boolean);
  const tracked = git(['ls-files'], REPO).out.split('\n').filter(Boolean);

  for (const [label, files] of [
    ['would be staged by `git add .`', staged],
    ['ALREADY TRACKED (gitignore does not retroactively protect these — use `git rm --cached`)', tracked],
  ] as const) {
    for (const f of files) {
      if (SHAPE_ALLOW.some((re) => re.test(f))) continue;
      const hit = SENSITIVE_SHAPES.find(([re]) => re.test(f));
      assert(!hit, `LEAK: "${f}" ${label} and looks like ${hit?.[1]}. Ignore it (or justify it in SHAPE_ALLOW).`);
    }
  }
  checks += staged.length + tracked.length;

  // ── 4. The negation actually fires. `!models/MANIFEST.json` under `models/` parsed fine and did
  //      nothing; only asking git to list the file proves the re-include works. ────────────────────
  const manifestTracked = git(['ls-files', '--others', '--exclude-standard', '--', 'vision/models/MANIFEST.json'], REPO);
  const manifestKnown = git(['ls-files', '--', 'vision/models/MANIFEST.json'], REPO);
  assert(
    manifestTracked.out.trim() !== '' || manifestKnown.out.trim() !== '',
    'vision/models/MANIFEST.json is neither tracked nor stageable — the `!models/MANIFEST.json` negation is dead ' +
      'again (the parent directory is excluded, so git never descends to evaluate it). Use `models/*`, not `models/`.',
  );
  checks++;

  console.log(
    `✅ gitignore-guard: ${checks} checks passed — ${MUST_IGNORE.length} sensitive paths ignored, ` +
      `${MUST_TRACK.length} required paths tracked, ${staged.length} stageable + ${tracked.length} tracked files swept clean.`,
  );
  process.exit(0);
} catch (err) {
  console.error(`\n❌ gitignore-guard FAILED\n${err instanceof Error ? err.message : String(err)}\n`);
  console.error('Nothing has been committed by this test. Fix .gitignore, then re-run before any `git add`.');
  process.exit(1);
}
