#!/usr/bin/env bun
/**
 * bundle-guard.ts — assert that nothing which must not ship is present in the production bundle.
 *
 * WHY THIS EXISTS (Phase 5). `ReviewView` carries a DEV-only crash switch so the e2e gate can prove
 * that a REAL render throw is caught by Review's own error boundary and leaves the coach shell
 * standing. It is guarded by `import.meta.env.DEV`, which Vite statically replaces with `false` in a
 * production build, so the branch is dead-code-eliminated. "Should be eliminated" is a claim about a
 * bundler's behaviour, though — and a bundler is exactly the kind of thing that changes under you at
 * the next major version. This turns the claim into a gate: build, then look.
 *
 * It also re-checks a few standing invariants that are cheap to assert on the BUILT output: no bundled
 * bearer token (ADR-0015 killed it), no build-machine source paths, and no hard-coded roster-shaped
 * name. That last one is narrow and worth being precise about: the client holds names only in memory
 * from `/sessions/:id/roster`, so the only way a name can reach the bundle is if someone types one into
 * source — a demo constant, a default, a fixture imported by a src module. This catches the dev fixture
 * shape (`Player 01`..) that the simulator and the e2e stacks use. It is NOT a general name detector,
 * and it cannot be: no scanner can tell a child's name from any other string.
 *
 *   bun run build && bun run guard:bundle
 *
 * Exits 0 when the bundle is clean, 1 with the offending file + token otherwise.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = new URL('../dist', import.meta.url).pathname;

/** Substrings that must NEVER appear in a shipped asset, each with the reason it is banned. */
const FORBIDDEN: Array<[token: string, why: string]> = [
  ['__crash_review', 'the DEV-only Review crash switch (e2e hook) must be eliminated from production'],
  ['induced review crash', 'the DEV-only crash message must not ship'],
  ['VITE_LIVE_TOKEN', 'the retired bundled bearer token must never come back (ADR-0015)'],
  ['/Users/', 'a build-machine source path leaked into the bundle'],
  // The dev-fixture roster shape. A real bundle joins names at RENDER time from the roster endpoint and
  // never contains one; a literal here means a fixture (or worse, a real child) was typed into source.
  ['Player 0', 'a roster-shaped name literal reached the bundle — names must come from /roster at runtime'],
  ['Player 1', 'a roster-shaped name literal reached the bundle — names must come from /roster at runtime'],
];

if (!existsSync(DIST)) {
  console.error(`❌ no dist/ at ${DIST} — run \`bun run build\` first`);
  process.exit(1);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// Text-ish assets only; a font or image cannot meaningfully contain these tokens and reading them as
// UTF-8 would just produce noise.
const files = walk(DIST).filter((f) => /\.(js|mjs|cjs|css|html|json|map)$/.test(f));
if (files.length === 0) {
  console.error('❌ dist/ contains no JS/CSS/HTML assets — did the build actually run?');
  process.exit(1);
}

const violations: string[] = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const [token, why] of FORBIDDEN) {
    if (text.includes(token)) {
      violations.push(`  ${file.replace(DIST, 'dist')}: contains "${token}" — ${why}`);
    }
  }
}

if (violations.length) {
  console.error(`\n❌ BUNDLE GUARD FAILED — ${violations.length} violation(s):\n${violations.join('\n')}\n`);
  process.exit(1);
}

console.log(
  `✅ bundle guard passed — ${files.length} asset(s) checked, none contain any of: ` +
    FORBIDDEN.map(([t]) => `"${t}"`).join(', '),
);
