/**
 * Docs-as-tests for the REPOSITORY's entry points (audit §8 Phase 7, §6 "Docs").
 *
 * WHY PROSE GETS A GATE. Every documentation defect the audit found was a sentence that was true
 * when it was written and quietly stopped being true: the README still described the server as
 * NestJS after the Bun/Elysia migration; CLAUDE.md documented a `VITE_WS_URL` that had been
 * deleted; and a whole subproject — `vision/`, ~1,800 lines, its own ADR, its own CI workflow, a
 * verified end-to-end run — was invisible from both entry points, while both presented camera/CV
 * work as an un-started idea. Nobody was careless. Prose has no compiler, so it decays in exactly
 * the places nothing reads it, and a reader who follows a stale README makes a decision on it.
 *
 * The rule is deliberately narrow: a document may not state a PATH, a COMMAND, a COUNT or the
 * EXISTENCE of a thing that this repository can contradict. Everything softer stays prose. That
 * boundary matters — a guard that tried to police judgement would be reverted within a month.
 *
 * This lives beside gitignore-guard.ts and deploy-posture.ts, and runs in the SAME unfiltered
 * `repo-guard` workflow, for the same reason those do: a commit that renames a doc, drops an ADR
 * from the index, or deletes a script the README tells people to run need not touch `server/**`.
 *
 *   bun run test/docs-guard.ts        (or: bun run test:docs-guard)
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..', '..');
const README = join(REPO, 'README.md');
const CLAUDEMD = join(REPO, 'CLAUDE.md');

let checks = 0;
const failures: string[] = [];

function check(label: string, cond: boolean, detail: string) {
  checks++;
  if (cond) console.log(`  ✓ ${label}`);
  else {
    console.log(`  ✗ ${label}`);
    failures.push(`${label}\n      ${detail}`);
  }
}

const read = (p: string) => readFileSync(p, 'utf8');
const readme = read(README);
const claudemd = read(CLAUDEMD);
// server/README.md holds the deep server detail the root README links to; its links resolve
// relative to server/, so it carries its own base directory below.
const serverReadme = read(join(REPO, 'server', 'README.md'));

console.log('\ndocs guard — the repo entry points against the repo\n');

// ── 1. Every relative link in an entry point must resolve ────────────────────────────────────────
// A dead link in the file people are told to start from is the cheapest possible way to lose a
// reader, and the easiest thing in the world to leave behind after a rename.
for (const [name, body, base] of [
  ['README.md', readme, REPO],
  ['CLAUDE.md', claudemd, REPO],
  ['server/README.md', serverReadme, join(REPO, 'server')],
] as const) {
  const links = [...body.matchAll(/\]\((?!https?:|mailto:|#)([^)#]+)(?:#[^)]*)?\)/g)].map((m) => m[1]);
  const dead = [...new Set(links)].filter((rel) => !existsSync(join(base, rel.split(':')[0])));
  check(
    `${name}: every relative link resolves (${links.length} checked)`,
    dead.length === 0,
    `${name} links to files that do not exist: ${dead.join(', ')}`,
  );
}

// ── 2. Every documented `bun run <script>` must exist ────────────────────────────────────────────
// Both entry points are largely command blocks; a script that has been renamed turns the whole
// block into a trap, and the reader blames their own environment first.
// The two projects' script names do not collide in practice, and the documents interleave `cd`s
// freely, so the union is the honest thing to check: a documented name must be SOMEBODY's script.
// `bun run <file>.ts` is Bun running a file directly, not a script — excluded, but its path is
// checked as a link above when it is written as one.
{
  const scripts = new Set<string>();
  for (const dir of ['server', 'client']) {
    const pkg = JSON.parse(read(join(REPO, dir, 'package.json')));
    for (const s of Object.keys(pkg.scripts ?? {})) scripts.add(s);
  }
  const named = new Set<string>();
  for (const body of [readme, claudemd, serverReadme]) {
    for (const m of body.matchAll(/\bbun run ([a-z][\w.:-]*)/g)) named.add(m[1]);
  }
  const unknown = [...named].filter((s) => !scripts.has(s) && !s.endsWith('.ts'));
  check(
    `every documented \`bun run <script>\` exists (${named.size} referenced)`,
    unknown.length === 0,
    `documented but not a script in server/ or client/ package.json: ${unknown.join(', ')}`,
  );
}

// ── 3. The server gate's suite count must match the gate ─────────────────────────────────────────
// CLAUDE.md states the number, and server-ci.yml asserts it. Phase 6 had to bump both by hand from
// 25 to 30 and nothing would have complained if only one had been updated.
const runAll = read(join(REPO, 'server', 'test', 'run-all.ts'));
const suiteBlock = runAll.slice(runAll.indexOf('const SUITES'), runAll.indexOf('const NON_SUITES'));
const suiteCount = [...suiteBlock.matchAll(/^\s*\['[\w.-]+\.ts',/gm)].length;
check(
  `the suite count in run-all.ts is discoverable (found ${suiteCount})`,
  suiteCount > 0,
  'could not parse SUITES out of run-all.ts — this guard needs updating alongside it',
);
const claimed = [...claudemd.matchAll(/all (\d+) suites/g)].map((m) => Number(m[1]));
check(
  `CLAUDE.md's "all N suites" matches run-all.ts (${claimed.join(', ') || 'none'} vs ${suiteCount})`,
  claimed.length > 0 && claimed.every((n) => n === suiteCount),
  `CLAUDE.md claims ${claimed.join('/')} server suites; run-all.ts declares ${suiteCount}`,
);
const ci = read(join(REPO, '.github', 'workflows', 'server-ci.yml'));
const ciClaimed = [...ci.matchAll(/(\d+)\s+suites?/g)].map((m) => Number(m[1]));
check(
  `server-ci.yml's suite count matches run-all.ts (${ciClaimed.join(', ') || 'none'} vs ${suiteCount})`,
  ciClaimed.length === 0 || ciClaimed.every((n) => n === suiteCount),
  `server-ci.yml claims ${ciClaimed.join('/')} suites; run-all.ts declares ${suiteCount}`,
);

// ── 4. Every ADR is reachable from the ADR index ─────────────────────────────────────────────────
// An ADR nobody can find is a decision that gets made again, differently.
const adrDir = join(REPO, 'docs', 'decisions');
const adrs = readdirSync(adrDir).filter((f) => /^\d{4}-.*\.md$/.test(f));
const adrIndex = read(join(adrDir, 'README.md'));
const unlisted = adrs.filter((f) => !adrIndex.includes(f));
check(
  `every ADR is listed in the ADR index (${adrs.length} ADRs)`,
  unlisted.length === 0,
  `docs/decisions/README.md does not link: ${unlisted.join(', ')}`,
);

// ── 5. Every top-level subproject is visible from both entry points ──────────────────────────────
// This is the check that would have caught the audit's actual finding. `vision/` had an ADR, a CI
// workflow, 175 tests and a verified run, and appeared in neither README.md nor CLAUDE.md — while
// both described camera/CV as a research spike nobody had started. A reader could not have known
// the code existed.
for (const sub of ['server', 'client', 'firmware', 'vision', 'deploy']) {
  if (!existsSync(join(REPO, sub))) continue;
  for (const [name, body] of [['README.md', readme], ['CLAUDE.md', claudemd]] as const) {
    check(
      `${name} mentions the ${sub}/ subproject`,
      new RegExp(`\\b${sub}/`).test(body),
      `${name} never names \`${sub}/\` — a whole subproject invisible from the entry point`,
    );
  }
}

// ── 6. Named-technology claims that have already gone stale once ─────────────────────────────────
// The README described a NestJS server for months after the Bun/Elysia migration. These are cheap,
// and each one is a mistake this repository has actually made.
const STALE: Array<[needle: RegExp, why: string]> = [
  [/\bNestJS\b/g, 'the server is Bun + Elysia; NestJS was removed'],
  [/\bVITE_WS_URL\b/g, 'that env var was deleted — the client uses a same-origin /live proxy'],
  [/\bsocket\.io\b/gi, 'fan-out is Bun native WS pub/sub, never socket.io'],
];
/**
 * A retired name may still be MENTIONED — "migrated from NestJS", "not socket.io", "(both removed)"
 * are the sentences that stop a reader wondering. What must not survive is the name used as a
 * PRESENT-TENSE description. So an occurrence only counts when nothing nearby marks it as history
 * or negation. The window is generous because these markers usually sit in the same clause; the
 * cost of the heuristic being loose is a stale mention slipping through, and the cost of it being
 * tight is a guard people delete.
 */
const HISTORY = /\b(not|no longer|never|removed|deleted|replaced|was|were|used to|earlier|former|previously|migrated|instead of|rather than)\b/i;
for (const [name, body] of [['README.md', readme], ['CLAUDE.md', claudemd]] as const) {
  for (const [needle, why] of STALE) {
    const bare: string[] = [];
    for (const m of body.matchAll(needle)) {
      const i = m.index ?? 0;
      const around = body.slice(Math.max(0, i - 140), i + 140);
      if (!HISTORY.test(around)) bare.push(`…${body.slice(Math.max(0, i - 60), i + 60).replace(/\n/g, ' ')}…`);
    }
    check(
      `${name} uses no retired name in the present tense: ${needle.source}`,
      bare.length === 0,
      `${name}: ${why}\n      ${bare.join('\n      ')}`,
    );
  }
}

// ── 7. The vision subproject's own gate is wired into CI ─────────────────────────────────────────
// vision/README.md once claimed CI that did not exist. It does now; this keeps it that way.
check(
  'vision has a CI workflow',
  existsSync(join(REPO, '.github', 'workflows', 'vision-ci.yml')),
  'vision/ is documented as gated but has no workflow',
);

if (failures.length) {
  console.error(`\n❌ docs-guard: ${failures.length} of ${checks} checks FAILED:\n`);
  for (const f of failures) console.error(`   • ${f}\n`);
  process.exit(1);
}
console.log(`\n✅ docs-guard: ${checks} checks passed — every link resolves, every documented command exists,\n   the suite counts agree, every ADR is indexed, and no subproject is invisible from an entry point.\n`);
