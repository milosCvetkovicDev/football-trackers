/**
 * contracts.test.ts — Phase 5 unit gate for `shouldOfferReconnect` (audit C-2).
 *
 * The audit's complaint was that the reconnect give-up was terminal with no way out. The fix is a
 * button — and a button is only a fix if it appears at the right times. Two ways to get that wrong,
 * both worse than no button:
 *   - offering it during the FIRST connect, where "connecting…" is the normal path, teaches a coach
 *     that the app is unreliable at every load;
 *   - offering it on an AUTHZ refusal, where reopening the socket repeats the same rejection, points
 *     the coach at the network when the problem is their account.
 * The rule lives in contracts.ts (like describeConnection) so the banner can't drift from it; these
 * cases pin it against every phase the hook can produce.
 */
import { test, expect } from 'bun:test';
import { shouldOfferReconnect, type ConnectionState } from './contracts';

const conn = (over: Partial<ConnectionState>): ConnectionState => ({
  phase: 'connecting',
  attempt: 0,
  willRetry: true,
  retryable: true,
  ...over,
});

test('the FIRST connect offers nothing — that is the normal path', () => {
  expect(shouldOfferReconnect(conn({ phase: 'connecting', attempt: 0 }))).toBe(false);
});

test('a reconnect attempt that has already failed offers the button', () => {
  // 'connecting' with attempt > 0 is the "reconnecting (try n)…" state: something DID break.
  expect(shouldOfferReconnect(conn({ phase: 'connecting', attempt: 1 }))).toBe(true);
  expect(shouldOfferReconnect(conn({ phase: 'connecting', attempt: 7 }))).toBe(true);
});

test('a drop being backed off offers the button (skip the wait)', () => {
  expect(shouldOfferReconnect(conn({ phase: 'disconnected', attempt: 3 }))).toBe(true);
});

test('the terminal give-up offers the button — the whole point of C-2', () => {
  expect(
    shouldOfferReconnect(
      conn({ phase: 'error', attempt: 9, willRetry: false, retryable: true, detail: 'gave up after 8 reconnect attempts' }),
    ),
  ).toBe(true);
});

test('a live connection offers nothing', () => {
  expect(shouldOfferReconnect(conn({ phase: 'live', attempt: 0 }))).toBe(false);
});

test('every POLICY terminal offers nothing — a locked door, not a stuck one', () => {
  for (const phase of ['unauthorized', 'forbidden', 'error'] as const) {
    expect(
      shouldOfferReconnect(conn({ phase, attempt: 1, willRetry: false, retryable: false })),
    ).toBe(false);
  }
});

test('retryable is authoritative: it can veto any phase', () => {
  // Belt-and-braces — the hook sets retryable:false on the 1008 paths, and nothing downstream may
  // second-guess it by reading the phase alone.
  expect(shouldOfferReconnect(conn({ phase: 'disconnected', retryable: false }))).toBe(false);
  expect(shouldOfferReconnect(conn({ phase: 'connecting', attempt: 4, retryable: false }))).toBe(false);
});
