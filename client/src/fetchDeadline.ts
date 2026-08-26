/**
 * fetchDeadline.ts — a deadline for every request the coach view makes (Phase 5; audit §6 "Client":
 * no fetch deadlines, and the "try again" copy is misleading).
 *
 * `fetch()` has no timeout. The failure this fixes is not a slow server — it is the HALF-OPEN SOCKET
 * a tablet leaves behind when it walks out of Wi-Fi range mid-request: the TCP connection is gone but
 * nothing tells the browser, so the promise stays pending for as long as the OS keeps the socket
 * (minutes on iOS/Android). The review surface then sits on "Loading match summary…" indefinitely —
 * no error, no retry, nothing for the coach to act on, and on the server side an inflight scan slot
 * held by a client that will never read the answer.
 *
 * The distinction every caller depends on:
 *   - TIMEOUT  → the request exceeded its deadline. This is a real failure the UI must SHOW.
 *   - ABORT    → the caller cancelled (session switch, unmount, a new query superseding this one).
 *                Expected and routine; the UI must stay silent, because the next effect owns the state.
 * They arrive as different error names (`TimeoutError` vs `AbortError`); `isTimeoutError` is the
 * check, so no caller has to remember which DOMException name means what.
 */

/**
 * Deadline for the SMALL reads — `/auth/me`, `/auth/login`, `/roster`, `/config`. These are indexed
 * lookups over tiny files; 8 s is already far beyond any healthy response, so exceeding it means the
 * link is gone, not that the server is busy.
 */
export const FETCH_DEADLINE_MS = 8_000;

/**
 * Deadline for the SCANS — `/history` and `/events`. These page over the raw fix table, and the server
 * bounds their COST (a 24 h span cap, a rows-per-chunk yield) but never their TIME: a wide window over
 * a busy session on a Pi-class box can legitimately run for tens of seconds.
 *
 * A checker lens caught the original mistake here — every read shared the 8 s deadline, justified by a
 * comment claiming "the server's own off-loop scan cap is the slower bound", which does not exist. The
 * consequence was worse than a slow spinner: a legitimate long scan was aborted at 8 s and shown as a
 * failure, every "Try again" reproduced it exactly (so the window was permanently unreadable), and
 * because the server does not observe the client's disconnect, each abandoned attempt kept its
 * `scanLoad` slot until it finished — three of those and every review read in the deployment answers
 * 503 `busy`. Pressure on that shared slot is why this number is generous rather than tight.
 */
export const SCAN_DEADLINE_MS = 30_000;

/** Statuses that may not carry a body — `new Response(body, {status})` throws for these. */
const NULL_BODY_STATUS = new Set([204, 205, 304]);

/** True for the error thrown when a request exceeded its deadline (as opposed to being aborted). */
export function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

/**
 * `fetch` with a deadline, composed with the caller's own abort signal.
 *
 * @param url        request URL (same-origin paths, per ADR-0015).
 * @param init       the usual init — `signal` is REQUIRED and is the caller's disposal signal.
 * @param deadlineMs override the default deadline.
 * The returned Response has ALREADY been read into memory (see below), so `res.json()`/`res.text()`
 * at the call site resolve immediately and the deadline covers the whole exchange, headers and body.
 *
 * @throws DOMException('TimeoutError') on deadline; the caller's abort reason on disposal; whatever
 *         `fetch` threw otherwise (a network error is passed through unchanged, never disguised).
 */
export async function fetchWithDeadline(
  url: string,
  init: RequestInit & { signal: AbortSignal },
  deadlineMs: number = FETCH_DEADLINE_MS,
): Promise<Response> {
  const outer = init.signal;
  // An already-disposed caller must not open a socket at all (a session switch during startup).
  if (outer.aborted) throw abortError(outer.reason);

  const inner = new AbortController();
  let timedOut = false;
  const onOuterAbort = () => inner.abort(outer.reason);
  outer.addEventListener('abort', onOuterAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    inner.abort();
  }, deadlineMs);

  try {
    const res = await fetch(url, { ...init, signal: inner.signal });
    // READ THE BODY INSIDE THE DEADLINE. `fetch()` resolves as soon as the response HEADERS arrive;
    // the body streams afterwards. Returning here would have bounded only the headers — and the
    // half-open socket this module exists for is far more likely to strand a multi-packet /history
    // page mid-BODY, where every caller's `await res.json()` would then hang forever with no error,
    // no `fetch_timeout` beacon, and "Loading match summary…" on screen for the rest of the match.
    // (A checker lens caught this: the module's own docstring described the bug it still had.)
    //
    // 204/205/304 must not be given a body — constructing one throws — and they have none to read.
    if (NULL_BODY_STATUS.has(res.status)) return res;
    const body = await res.text();
    // Hand back an equivalent response whose body is already in memory, so `res.json()` at the call
    // sites resolves immediately and every call site keeps working unchanged. Nothing here streams:
    // every consumer parses the whole body anyway.
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  } catch (err) {
    // The abort we raised ourselves surfaces as a generic AbortError; re-label it so callers can tell
    // "the network never answered" from "we cancelled this on purpose".
    if (timedOut) {
      throw new DOMException(`request exceeded its ${deadlineMs} ms deadline`, 'TimeoutError');
    }
    throw err;
  } finally {
    // Always release the timer AND the listener: a timer left armed would fire against a controller
    // that is already done (one leaked timer per request in a view that fetches on every change).
    clearTimeout(timer);
    outer.removeEventListener('abort', onOuterAbort);
  }
}

/** The error `fetch` would have thrown for an aborted signal, preserving a caller-supplied reason. */
function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}
