/**
 * fetchDeadline.test.ts — Phase 5 unit gate for the client fetch deadline (audit §6 "Client": no
 * fetch deadlines).
 *
 * THE FAILURE THIS PREVENTS. `fetch()` has no default timeout. A half-open TCP connection — the
 * normal outcome when a pitch-side tablet walks out of Wi-Fi range mid-request — leaves the promise
 * pending for as long as the OS keeps the socket, which on iOS/Android is minutes. The review
 * surface then sits on "Loading match summary…" forever: no error, no retry, nothing to act on. A
 * deadline turns that into a stated failure the coach can respond to.
 *
 * The distinction the callers depend on is pinned here: a DEADLINE is an error the UI must show,
 * while a caller ABORT (session switch, unmount) is expected and must stay silent — conflating the
 * two would flash "couldn't load" every time someone changes the window.
 */
import { test, expect, afterEach } from 'bun:test';
import { fetchWithDeadline, isTimeoutError, FETCH_DEADLINE_MS } from './fetchDeadline';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A fetch stub that never settles until its signal aborts — the half-open-socket case. */
function hangingFetch(): { calls: Array<{ url: string; signal: AbortSignal }> } {
  const calls: Array<{ url: string; signal: AbortSignal }> = [];
  globalThis.fetch = ((url: string, init: RequestInit) => {
    const signal = init.signal as AbortSignal;
    calls.push({ url, signal });
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }) as unknown as typeof fetch;
  return { calls };
}

test('the default deadline is a coach-scale wait, not a browser-scale one', () => {
  // Long enough for a slow first scan on a Pi-class box; short enough that a coach still acts within
  // a match. (The number itself is the contract — a regression to "no deadline" fails here.)
  expect(FETCH_DEADLINE_MS).toBeGreaterThanOrEqual(3_000);
  expect(FETCH_DEADLINE_MS).toBeLessThanOrEqual(15_000);
});

test('a normal response passes straight through', async () => {
  globalThis.fetch = (async (url: string) =>
    new Response(JSON.stringify({ url }), { status: 200 })) as unknown as typeof fetch;
  const res = await fetchWithDeadline('/sessions/x/history', { signal: new AbortController().signal }, 50);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { url: string }).url).toBe('/sessions/x/history');
});

test('a hung request rejects with a TIMEOUT once the deadline passes', async () => {
  const { calls } = hangingFetch();
  const started = Date.now();
  let caught: unknown;
  try {
    await fetchWithDeadline('/sessions/x/history', { signal: new AbortController().signal }, 30);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeDefined();
  expect(isTimeoutError(caught)).toBe(true);
  expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  // The socket is released, not merely ignored — an abandoned-but-live request would keep the
  // connection (and the server's inflight scan slot) occupied.
  expect(calls[0].signal.aborted).toBe(true);
});

test('a caller abort is NOT reported as a timeout (session switch / unmount stays silent)', async () => {
  hangingFetch();
  const outer = new AbortController();
  const p = fetchWithDeadline('/sessions/x/history', { signal: outer.signal }, 10_000);
  outer.abort();
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeDefined();
  expect(isTimeoutError(caught)).toBe(false);
  expect((caught as Error).name).toBe('AbortError');
});

test('an already-aborted caller signal never opens a socket', async () => {
  const { calls } = hangingFetch();
  const outer = new AbortController();
  outer.abort();
  let caught: unknown;
  try {
    await fetchWithDeadline('/sessions/x/history', { signal: outer.signal }, 10_000);
  } catch (e) {
    caught = e;
  }
  expect((caught as Error).name).toBe('AbortError');
  expect(calls.length).toBe(0);
});

test('a network error is passed through unchanged (not disguised as a timeout)', async () => {
  globalThis.fetch = (async () => {
    throw new TypeError('Failed to fetch');
  }) as unknown as typeof fetch;
  let caught: unknown;
  try {
    await fetchWithDeadline('/x', { signal: new AbortController().signal }, 1_000);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(TypeError);
  expect(isTimeoutError(caught)).toBe(false);
});

test('the deadline timer does not outlive a completed request', async () => {
  // A timer left armed after a fast response keeps a handle alive per request in a view that fetches
  // on every window change — and, because that timer aborts the signal the response body is still
  // attached to, it can also kill the body of an already-returned response mid-read.
  //
  // The first version of this test asserted `res.ok` and `!outer.signal.aborted`, NEITHER of which
  // can ever be false (the timer aborts the module's INTERNAL controller, and the response has
  // already resolved) — a checker lens proved it stayed green with `clearTimeout` deleted. So watch
  // the timer itself: count what is armed and require it to be disarmed by the time we return.
  const realClear = globalThis.clearTimeout;
  const armed = new Set<unknown>();
  const realSet = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    const id = realSet(fn, ms);
    armed.add(id);
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => {
    armed.delete(id);
    return realClear(id as Parameters<typeof clearTimeout>[0]);
  }) as unknown as typeof clearTimeout;
  try {
    globalThis.fetch = (async () => new Response('ok')) as unknown as typeof fetch;
    const outer = new AbortController();
    const res = await fetchWithDeadline('/x', { signal: outer.signal }, 10);
    expect(res.ok).toBe(true);
    expect(armed.size).toBe(0); // FAILS if the finally's clearTimeout is removed
    expect(outer.signal.aborted).toBe(false);
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
});

test('the deadline covers the BODY, not just the headers', async () => {
  // The failure this bounds: a tablet that walks out of range AFTER the status line. `fetch()` has
  // already resolved, so a headers-only deadline is disarmed and the caller's `res.json()` hangs
  // forever — "Loading match summary…" with no error and no retry, which is the precise symptom this
  // module's docstring claims to fix.
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const signal = init.signal as AbortSignal;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"partial":'));
          // ...and then nothing, ever — until the deadline aborts the signal.
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;

  let caught: unknown;
  const started = Date.now();
  try {
    await fetchWithDeadline('/sessions/x/history', { signal: new AbortController().signal }, 40);
  } catch (e) {
    caught = e;
  }
  expect(isTimeoutError(caught)).toBe(true);
  expect(Date.now() - started).toBeGreaterThanOrEqual(35);
});

test('a 204 (no body) passes through without being reconstructed', async () => {
  // Constructing a Response with a body for a null-body status throws; the beacon-shaped 204 must
  // survive the buffering path untouched.
  globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
  const res = await fetchWithDeadline('/x', { signal: new AbortController().signal }, 1_000);
  expect(res.status).toBe(204);
});

test('the buffered response still exposes status, headers and a readable body', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ players: [1, 2, 3] }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })) as unknown as typeof fetch;
  const res = await fetchWithDeadline('/x', { signal: new AbortController().signal }, 1_000);
  expect(res.ok).toBe(true);
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store'); // no-store must survive (§0.2)
  expect(((await res.json()) as { players: number[] }).players).toEqual([1, 2, 3]);
});

test('a caller abort DURING the body still reports as an abort, not a timeout', () => {
  // The listener that forwards the caller's signal must survive until the BODY settles, not just until
  // the headers do — otherwise a session switch mid-download is uncancellable and the request runs on,
  // holding the connection (and, for a scan, the server's shared off-loop slot).
  const outer = new AbortController();
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const signal = init.signal as AbortSignal;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"partial":'));
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const p = fetchWithDeadline('/sessions/x/history', { signal: outer.signal }, 10_000);
  // Give the headers a turn to resolve, then cancel the way a session switch does.
  return new Promise<void>((resolve) => {
    setTimeout(async () => {
      outer.abort();
      let caught: unknown;
      try {
        await p;
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      expect(isTimeoutError(caught)).toBe(false); // an abort must stay SILENT in the UI
      expect((caught as Error).name).toBe('AbortError');
      resolve();
    }, 20);
  });
});
