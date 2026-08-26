/**
 * beacon.ts — the minimal client beacon (Phase 5; audit §6 "Client": no client observability).
 *
 * WHAT IT CLOSES. Everything this system measures stops at the server's process boundary. When the
 * coach's tablet exhausts its reconnect budget, or the review view crashes into its error boundary,
 * or a read hits its deadline, `/metrics` stays green while the touchline stares at a dead screen —
 * so the one failure that matters most (the coach can't see the children) is the one nobody is
 * alerted on. Four counted events close that gap.
 *
 * WHAT IT DELIBERATELY IS NOT. This runs on a device displaying children's live positions, so the
 * beacon is the narrowest thing that answers "did the coach's view break?":
 *   - a CLOSED four-value vocabulary and nothing else — no free text, no player id, no position, no
 *     user agent, no stack trace (an error message can easily contain a name);
 *   - session-SCOPED by URL, so the server runs the same authz gate as every other session read
 *     rather than a second one invented for this endpoint;
 *   - throttled per kind, because the events that fire are exactly the ones that repeat in a loop;
 *   - fire-and-forget: telemetry about a broken view must never break the view further, so every
 *     failure path here is a silent no-op.
 */

/** The closed vocabulary. MUST match the server's allow-list in server.ts (BEACON_KINDS). */
export const BEACON_KINDS = [
  'ws_gave_up', // the live socket exhausted its reconnect budget — the coach's feed is dead
  'ws_manual_retry', // the coach pressed "Reconnect now" — i.e. the automatic path had failed them
  'render_error', // a render threw and an error boundary caught it
  'fetch_timeout', // a read hit its deadline (FETCH_DEADLINE_MS)
] as const;

export type BeaconKind = (typeof BEACON_KINDS)[number];

/** One report per kind per this interval. A reconnect storm must not become a request storm. */
export const BEACON_MIN_INTERVAL_MS = 30_000;

/** Same charset the server validates session ids with (TOPIC_ID_RE / validSessionId). */
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

const lastSentAt = new Map<BeaconKind, number>();

/**
 * Report one event. Returns whether a request was actually issued (false = dropped: unknown kind,
 * implausible session, throttled, or no `fetch` in this environment). Never throws.
 */
export function sendBeacon(kind: BeaconKind, sessionId: string, now: number = Date.now()): boolean {
  if (!(BEACON_KINDS as readonly string[]).includes(kind)) return false;
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return false;
  if (typeof fetch !== 'function') return false;

  const last = lastSentAt.get(kind);
  if (last !== undefined && now - last < BEACON_MIN_INTERVAL_MS) return false;
  lastSentAt.set(kind, now);

  try {
    void fetch(`/sessions/${encodeURIComponent(sessionId)}/client-beacon`, {
      method: 'POST',
      credentials: 'same-origin', // the HttpOnly session cookie authorises it, like every other read
      headers: { 'content-type': 'application/json' },
      // keepalive so an event fired as the tab closes still lands — "gave up and put the tablet
      // away" is precisely a case worth counting.
      keepalive: true,
      body: JSON.stringify({ kind }),
    }).catch(() => {
      /* the view is already degraded; a failed report must not make it worse */
    });
  } catch {
    /* ditto — `fetch` itself throwing (locked-down webview) is not the caller's problem */
  }
  return true;
}

/** Clear the throttle state (tests). */
export function resetBeacon(): void {
  lastSentAt.clear();
}
