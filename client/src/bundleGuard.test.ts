/**
 * bundleGuard.test.ts — proves the bundle guard can FAIL (Phase 5 checker finding).
 *
 * `scripts/bundle-guard.ts` is the only gate that inspects the artefact we actually ship: it asserts
 * the DEV-only Review crash switch was dead-code-eliminated, that the retired bundled bearer token has
 * not come back, that no build-machine path leaked, and that no roster-shaped name literal is present.
 * A guard whose failure path is never exercised is the vacuity trap the audit's own Q-1 finding is
 * about (a provenance test that passed on an empty file). So: run the scanner over a synthetic dist
 * containing each forbidden token, and require a violation for every one.
 *
 * It lives in src/ so `bun test src` picks it up — the scanner itself is imported from scripts/.
 */
import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanDist, FORBIDDEN } from '../scripts/bundle-guard';

const dirs: string[] = [];
function fixtureDist(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ft-bundle-guard-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}
afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

test('a clean bundle passes', () => {
  const dir = fixtureDist({
    'index.html': '<!doctype html><div id="root"></div>',
    'assets/index-abc.js': 'const a=1;export{a};',
  });
  const { files, violations } = scanDist(dir);
  expect(files.length).toBe(2);
  expect(violations).toEqual([]);
});

test('EVERY forbidden token is actually detected', () => {
  // The load-bearing assertion: a typo in the token list, or a scanner that stopped reading files,
  // would leave the guard green forever. One synthetic asset per token, checked individually.
  expect(FORBIDDEN.length).toBeGreaterThanOrEqual(4);
  for (const [token] of FORBIDDEN) {
    const dir = fixtureDist({ 'assets/index-abc.js': `console.log("${token}");` });
    const { violations } = scanDist(dir);
    expect(violations.length, `token "${token}" was not detected`).toBe(1);
    expect(violations[0]).toContain(token);
  }
});

test('the scan reaches nested directories and skips binary-ish assets', () => {
  const dir = fixtureDist({
    'assets/nested/deep/chunk-xyz.js': 'const x = "__crash_review";',
    'assets/logo.png': '__crash_review', // not a text asset: must NOT be read/flagged
  });
  const { files, violations } = scanDist(dir);
  expect(files.length).toBe(1); // the .png is not scanned
  expect(violations.length).toBe(1);
  expect(violations[0]).toContain('chunk-xyz.js');
});

test('an empty dist reports no files — the caller treats that as a failed build', () => {
  const { files, violations } = scanDist(fixtureDist({}));
  expect(files).toEqual([]);
  expect(violations).toEqual([]);
});
