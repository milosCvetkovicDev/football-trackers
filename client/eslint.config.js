// ESLint flat config — coach live view (React 19 + TypeScript).
//
// Scope: lints client/src (the SPA) and client/e2e (the Playwright specs). Kept
// deliberately lean — recommended JS + non-type-aware typescript-eslint + the two
// classic, stable react-hooks rules (rules-of-hooks + exhaustive-deps). These catch
// the one class of bug that actually bites this app: the useRef-Map + rAF render
// loop and the WS effect in useLiveTelemetry depend on correct hook usage/deps.
// No stylistic/formatting rules — that's a separate concern and would add churn
// without catching real bugs.
//
// NOTE: we do NOT use eslint-plugin-react-hooks v7's `recommended` preset. That
// preset turns on the full React-Compiler ruleset (`refs`, `set-state-in-effect`,
// `purity`, …) which flags this codebase's *deliberate, documented* patterns — e.g.
// mirroring props into refs during render so the rAF loop reads the latest value
// without restarting (PitchCanvas.tsx), and the matchMedia subscribe-on-mount effect
// in useReducedMotion.ts. Those are correct here, so we enable only the two
// long-stable rules everyone relies on rather than fight the architecture.
//
// Why non-type-aware (recommended, not recommendedTypeChecked): type errors are
// already caught by `bun run typecheck` (tsc --noEmit) in CI, so a second
// type-aware pass here would be redundant, slower, and require a tsconfig project
// service. Lint stays fast and focused on lint-only concerns.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  // Never lint build output or deps.
  { ignores: ['dist/**', 'node_modules/**', 'playwright-report/**', 'test-results/**'] },

  // Base JS + TS recommended rules for all source.
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Project-wide: allow the conventional underscore-prefix to mark an intentionally
  // unused binding (e.g. dropping a key via rest-destructuring in the unit tests:
  // `const { serverTs: _serverTs, ...rest } = VALID`).
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  // React + browser source: hooks rules + browser globals.
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // The codebase intentionally narrows untrusted WS frames via `as`-casts in
      // ws/validate.ts after runtime guards; flag stray `any` but don't fail the
      // deliberate, commented assertions.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // Unit tests (bun:test) carry scaffolding helpers that aren't always all used in a
  // given run (e.g. a `dLon` builder kept alongside `dLat`). Don't fail the gate on
  // dead test-only locals — they're owned by the rendering/contracts streams, and
  // `bun test` is the real check on that code.
  {
    files: ['src/**/*.test.ts'],
    rules: { '@typescript-eslint/no-unused-vars': 'warn' },
  },

  // Playwright specs run in Node (test runner) and drive a browser via page.evaluate.
  // They legitimately use both Node and browser globals.
  {
    files: ['e2e/**/*.ts', 'playwright.config.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },
);
