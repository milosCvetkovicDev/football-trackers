/**
 * beacon.test.ts — Phase 5 unit gate for the minimal client beacon (audit §6 "Client": no client
 * observability).
 *
 * WHAT THE BEACON IS FOR. Everything the server knows today stops at its own process boundary: if a
 * coach's tablet gives up reconnecting, or the review view crashes into its error boundary, or a
 * fetch hits its deadline, the server sees NOTHING — the run looks healthy while the touchline sees
 * a dead screen. Four counted events close that gap.
 *
 * WHAT IT MUST NEVER BECOME. This runs on a device showing children's live positions, so the beacon
 * is deliberately the narrowest thing that answers "did the coach's view break?": a fixed enum and a
 * session id — no player id, no position, no free text, no user agent. The tests below pin that
 * shape, the fixed vocabulary (an unknown kind is dropped CLIENT-side, so a typo can never invent a
 * metric label), the throttle (a reconnect storm must not become a request storm), and the
 * fire-and-forget contract (telemetry about a broken view must never break the view further).
 */
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { sendBeacon, resetBeacon, BEACON_KINDS, BEACON_MIN_INTERVAL_MS } from './beacon';

const realFetch = globalThis.fetch;
interface Sent {
  url: string;
  init: RequestInit;
}
let sent: Sent[] = [];

beforeEach(() => {
  resetBeacon();
  sent = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('the vocabulary is a closed set (no free-text kinds reach the server)', () => {
  expect([...BEACON_KINDS].sort()).toEqual([
    'fetch_timeout',
    'render_error',
    'ws_gave_up',
    'ws_manual_retry',
  ]);
});

test('a beacon posts exactly {kind} to the session-scoped route, as same-origin JSON', () => {
  expect(sendBeacon('ws_gave_up', 'pw', 1_000)).toBe(true);
  expect(sent.length).toBe(1);
  // Session-SCOPED path, like every other session read: the server then runs the SAME authz gate
  // (/roster, /history, /config) instead of inventing a second one for a body-carried session id.
  expect(sent[0].url).toBe('/sessions/pw/client-beacon');
  expect(sent[0].init.method).toBe('POST');
  expect(sent[0].init.credentials).toBe('same-origin');
  expect((sent[0].init.headers as Record<string, string>)['content-type']).toBe('application/json');
  // keepalive so an event fired as the tab closes (the "gave up and put the tablet away" case) still lands.
  expect(sent[0].init.keepalive).toBe(true);
  const body = JSON.parse(sent[0].init.body as string) as Record<string, unknown>;
  expect(Object.keys(body)).toEqual(['kind']);
  expect(body).toEqual({ kind: 'ws_gave_up' });
});

test('the session id is percent-encoded into the path (never interpolated raw)', () => {
  expect(sendBeacon('ws_gave_up', 'u12.sat-2026', 1_000)).toBe(true);
  expect(sent[0].url).toBe('/sessions/u12.sat-2026/client-beacon');
});

test('an unknown kind is dropped client-side (a typo cannot invent a metric label)', () => {
  expect(sendBeacon('player_position' as never, 'pw', 1_000)).toBe(false);
  expect(sent.length).toBe(0);
});

test('a missing or implausible session id is dropped', () => {
  expect(sendBeacon('render_error', '', 1_000)).toBe(false);
  expect(sendBeacon('render_error', 'x'.repeat(65), 1_000)).toBe(false);
  expect(sendBeacon('render_error', 'has space', 1_000)).toBe(false);
  expect(sent.length).toBe(0);
});

test('the same kind is throttled; a different kind is not', () => {
  expect(sendBeacon('ws_manual_retry', 'pw', 1_000)).toBe(true);
  // A coach jabbing "Reconnect now" eight times must not become eight requests to a server that is
  // (by hypothesis) already struggling.
  expect(sendBeacon('ws_manual_retry', 'pw', 1_500)).toBe(false);
  expect(sendBeacon('ws_manual_retry', 'pw', 1_000 + BEACON_MIN_INTERVAL_MS - 1)).toBe(false);
  // ...but an unrelated event in the same moment is still reported.
  expect(sendBeacon('render_error', 'pw', 1_500)).toBe(true);
  expect(sent.length).toBe(2);
  // Past the window the first kind reports again.
  expect(sendBeacon('ws_manual_retry', 'pw', 1_000 + BEACON_MIN_INTERVAL_MS)).toBe(true);
  expect(sent.length).toBe(3);
});

test('a failing beacon never throws into the caller (fire and forget)', async () => {
  globalThis.fetch = (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
  expect(() => sendBeacon('render_error', 'pw', 1_000)).not.toThrow();
  // Give the rejected promise a turn to settle: an unhandled rejection here would crash a page whose
  // only sin was reporting that something else broke.
  await new Promise((r) => setTimeout(r, 5));
});

test('a beacon is skipped entirely when fetch is unavailable', () => {
  // @ts-expect-error deliberately removing the global to model an ancient/locked-down webview
  globalThis.fetch = undefined;
  expect(() => sendBeacon('render_error', 'pw', 1_000)).not.toThrow();
  expect(sendBeacon('render_error', 'pw', 1_000)).toBe(false);
});
