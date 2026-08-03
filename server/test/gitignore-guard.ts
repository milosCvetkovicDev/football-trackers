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

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Every git call is made with the repo's OWN rules and nothing else:
 *   core.excludesFile=/dev/null  — a rule in the developer's ~/.config/git/ignore would otherwise
 *     make check-ignore report "ignored" for a path this repo does not actually protect. The guard
 *     would go green on their machine and the file would land from anyone else's.
 *   core.quotePath=false — by default git C-quotes any path with a non-ASCII byte, so a clip named
 *     after a child with an accent comes back as "samples/Andr\303\251.mp4" (with the quotes), and
 *     every `\.mp4$` shape test misses it. That is the exact filename this repo must never leak.
 * `.git/info/exclude` is checked separately below — it is per-clone and equally invisible to review.
 */
function git(args: string[], cwd?: string): { code: number; out: string } {
  const p = Bun.spawnSync(['git', '-c', 'core.excludesFile=/dev/null', '-c', 'core.quotePath=false', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: p.exitCode, out: new TextDecoder().decode(p.stdout) };
}

/** Split a `-z` (NUL-separated) git listing. Belt to core.quotePath=false's braces. */
function gitZ(args: string[], cwd?: string): string[] {
  return git([...args, '-z'], cwd).out.split('\0').filter(Boolean);
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
  // --- the variants: how this actually leaks in practice, not how it leaks in theory ------------
  ['server/roster.json.bak', 'a copy taken before an edit holds the same twenty names'],
  ['server/roster-2026-08.json', 'a dated copy, ditto'],
  ['docs/roster.json', 'the same file somewhere nobody was guarding'],
  ['server/mosquitto/passwd', "mosquitto's own docs name it this as often as ft.passwd"],
  ['server/mosquitto/pwfile', 'ditto'],
  ['server/.claude/settings.local.json', 'a NESTED .claude/, which the root-anchored rule missed'],
  ['id_ed25519', 'private key'],
  ['deploy/tls/server.key', 'private key — the TLS edge (ADR-0009) will arrive without a habit here'],
  ['deploy/tls/server.pem', 'private key or bundle'],
  ['backup/telemetry.db.gz', 'a compressed backup holds exactly the same child positions'],
  ['backup/telemetry.sql', 'a SQL dump, ditto'],
  // Footage and weights ANYWHERE, not just under vision/. Capitalised because GoPro and iPhone
  // write .MP4/.MOV by default and Linux treats those as different files.
  ['docs/clip.mp4', 'a clip parked outside vision/ is the same children with none of the protection'],
  ['docs/CLIP.MP4', 'the capitalised form a camera actually produces'],
  ['GX010042.MOV', 'a GoPro file dropped at the repo root'],
  ['models/players.pt', 'weights outside vision/'],
  ['server/.roster.json.swp', "a vim swapfile contains the edited file's full plaintext"],
  ['.idea/workspace.xml', 'IDE state (can embed paths and tokens)'],
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

/**
 * Shapes that must never be committable, wherever they appear. Drives the step-3 sweep.
 *
 * ALL CASE-INSENSITIVE. macOS is case-insensitive so `ROSTER.JSON` and `roster.json` are the same
 * file here — but CI and the Docker deploy are Linux, where they are two different files and only
 * the lowercase one is ignored. Cameras make this concrete rather than theoretical: GoPro and iPhone
 * both write `.MP4`/`.MOV` in capitals by default, so the uppercase form is the LIKELY one for
 * exactly the footage this repo must never carry.
 */
const SENSITIVE_SHAPES: Array<[re: RegExp, what: string]> = [
  // Roster/account/config: match variants too. A human protecting data before an edit produces
  // `roster.json.bak`, `roster-2026.json`, `roster copy.json` — none of which the exact basename
  // rule catches, and all of which hold the same twenty children's names.
  [/(^|\/)[^/]*roster[^/]*\.json(\.\w+)?$/i, 'child-name roster (or a copy of one)'],
  [/(^|\/)[^/]*auth-accounts[^/]*\.json(\.\w+)?$/i, 'password hashes (or a copy)'],
  [/(^|\/)[^/]*session-config[^/]*\.json(\.\w+)?$/i, 'session config (or a copy)'],
  // Broker credentials: *.passwd is the repo's convention, but mosquitto's own docs use bare
  // `passwd`/`pwfile`/`passwords` just as often.
  [/\.passwd$/i, 'broker credential DB'],
  [/(^|\/)(passwd|pwfile|passwords|htpasswd)$/i, 'credential file (mosquitto/apache naming)'],
  [/(^|\/)\.env(\..+)?$/i, 'environment secrets'],
  [/(^|\/)settings\.local\.json$/i, 'machine-local editor settings'],
  [/\.(db|db-wal|db-shm|sqlite|sqlite3)$/i, 'telemetry store'],
  [/\.(db|sqlite3?)\.(gz|bz2|xz|zst|bak)$/i, 'compressed or backed-up telemetry store'],
  [/\.(sql|dump)$/i, 'database dump'],
  [/\.(pt|pth|engine|onnx|safetensors|weights)$/i, 'model weights'],
  [/\.(mp4|mov|360|mkv|avi|webm|ogv|m4v|mts|insv)$/i, 'raw or derived footage of children'],
  [/(^|\/)\.DS_Store$/i, 'Finder metadata'],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i, 'private key'],
  // .crt/.cer are deliberately absent — those are public certificates, and a shape that cries wolf
  // on a legitimately-committed CA bundle is a shape people start ignoring.
  [/\.(pem|key|p12|pfx|jks|keystore)$/i, 'private key or keystore'],
  [/\.(swp|swo|swn)$/i, 'editor swapfile (contains the full plaintext of the file being edited)'],
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
    // "Not ignored" is not the same as "present". Without this, deleting one of these files leaves
    // the guard reporting "10 required paths tracked" — a sentence that would then be false.
    assert(existsSync(resolve(REPO, path)), `MISSING: "${path}" is required but does not exist — ${why}`);
    checks += 2;
  }

  // ── 3. The sweep: nothing sensitive is committable RIGHT NOW. ───────────────────────────────────
  // Two sets together cover everything that can end up in a commit:
  //   a) untracked-and-not-ignored — exactly what `git add .` would newly stage;
  //   b) already tracked — .gitignore does NOT protect a tracked file, so a rule added after the
  //      fact is cosmetic. This is the check that notices the barn door is already open.
  // `-z` (NUL-separated): the only listing format git never quotes or escapes. A path containing a
  // newline or a non-ASCII byte is otherwise mangled before any shape test sees it.
  const staged = gitZ(['ls-files', '--others', '--exclude-standard'], REPO);
  const tracked = gitZ(['ls-files'], REPO);

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

  // ── 3b. The protection must live in the REPO, not in this clone or this machine. ────────────────
  // check-ignore is already run with core.excludesFile=/dev/null, but .git/info/exclude is
  // per-clone: rules there are invisible to review, absent for every other developer and absent in
  // CI. If it has any content, the green above may be resting on it.
  const infoExclude = resolve(REPO, '.git/info/exclude');
  if (existsSync(infoExclude)) {
    const meaningful = (await Bun.file(infoExclude).text())
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    assert(
      meaningful.length === 0,
      `.git/info/exclude has ${meaningful.length} active rule(s): ${meaningful.join(', ')}\n` +
        `  These are local to YOUR clone — not reviewable, not present for anyone else, not present in CI.\n` +
        `  Move anything load-bearing into the tracked .gitignore.`,
    );
  }
  checks++;

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
