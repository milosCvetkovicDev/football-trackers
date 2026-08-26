# ADR-0024 — The coach view reports its own failures (a minimal client beacon)

**Status:** Implemented (audit Phase 5, 2026-08-26) · **Date:** 2026-08-26 ·
(`POST /sessions/:id/client-beacon` in `server/src/server.ts`, `client/src/beacon.ts`,
`ft_client_events_total{kind}` in `server/src/metrics.ts`; gated by `server/test/beacon-e2e.ts`.)

## Context

Everything this system measures stops at the server's own process boundary. `/metrics` reports packets
ingested, sockets open, fixes fanned out, reads served — and every one of those can be perfectly healthy while
the only thing that matters has failed: **the coach cannot see the children.**

The 2026-08-03 audit made that concrete. `useLiveTelemetry` gives up after a capped series of reconnects
(C-2), and before Phase 5 that terminal state was the end of the match — with nothing on the server side to
say it had happened. Add a render crash caught by an error boundary, or a review read that hangs until its
deadline, and the same holds: the touchline sees a dead screen, the dashboard stays green, and nobody knows
until someone walks over and says so.

Server-side signals cannot substitute. A tablet that has stopped reconnecting produces *no* traffic — its
absence is indistinguishable from a coach who simply closed the tab, which is the overwhelmingly more common
case. Only the client knows the difference between "I left" and "I broke".

The obvious solution — ship an error/RUM SDK — is unacceptable here for reasons that have nothing to do with
cost. This page displays **children's live positions**. A conventional client-telemetry payload carries stack
traces, breadcrumbs, URLs, user agents and DOM context; on this page every one of those is a plausible
carrier for a child's name or coordinates, and the whole architecture ([ADR-0016](0016-player-name-roster.md),
[ADR-0010](0010-location-data-retention.md)) is built to keep those out of anything that leaves the roster
store or outlives the retention window.

## Decision

Add exactly one client→server write, designed as the **narrowest thing that answers "did the coach's view
break?"** and nothing more.

- **A closed vocabulary of four kinds** — `ws_gave_up`, `ws_manual_retry`, `render_error`, `fetch_timeout` —
  validated against an allow-list **at the route**. An unrecognised kind is a 400; it never reaches the
  exposition. Metric cardinality is therefore fixed at four *by construction*, which is the same rule the
  audit's §S-5 (unbounded metric cardinality) forced everywhere else.
- **The body is `{kind}` and nothing else.** Extra keys are a 400. No stack trace, no error message, no URL,
  no user agent, no player id, no coordinates. The error MESSAGE deliberately never leaves the device:
  messages routinely interpolate whatever was being rendered, and here that is a child.
- **Session scope comes from the URL**, so the endpoint reuses the *same* `sessionGetGate` as `/roster`,
  `/config` and `/history` instead of inventing a second authz path for a body-carried session id. Anonymous
  is allowed (`allowAnonymous: true`): the anon principal owns the live pitch on an isolated LAN, so it must be
  able to report that the live pitch broke.
- **Strict Origin** (not the lenient GET variant): a browser always sends `Origin` on a POST, so an absent one
  means a non-browser caller. Plus a 256-byte body cap and a per-principal token bucket — the events that fire
  are precisely the ones that repeat in a loop, so the client also throttles each kind to one report per 30 s.
- **The metric carries the KIND only** — no session label, no player label. Which sessions have a struggling
  tablet is not a question `/metrics` should answer to whoever can scrape it, and a session label would
  reintroduce the enumeration oracle every other route avoids. The four series are seeded present-at-0 at
  boot so `increase(...) > 0` can fire on the first occurrence rather than needing a baseline.

## Consequences

- **+** The one failure that matters most — a coach who cannot see the pitch — is now alertable
  (`CoachViewDark`, `CoachViewCrashing`, `CoachViewReadsTimingOut` in
  [observability.md](../architecture/observability.md)).
- **+** `ws_manual_retry` is a quiet second-order signal: a rise *without* a matching `ws_gave_up` says the
  automatic backoff is too slow for a touchline, not that the network is broken.
- **+** No new dependency, no third party, no data leaving the LAN. ~40 lines of client, ~40 of server.
- **−** Four counters is genuinely coarse. There is no way to ask "*why* did that render throw?" from
  `/metrics` alone — that answer stays in the browser console, on the device, where the message can safely
  contain whatever it contains. This is the trade the privacy invariant demands, and it is deliberate.
- **−** One more authenticated write surface on a server that had none. Mitigated by reusing the existing gate,
  the closed vocabulary, the size cap and the rate limit — all pinned by `test/beacon-e2e.ts`, which asserts
  the authz matrix, the refusals, and that a rejected kind never appears in the exposition.
- **−** The rate-limit bucket map is keyed per principal (or per IP for anon) and, like `rosterBuckets`, has no
  sweep. Bounded in practice by the account count plus the tiny set of LAN clients.

## Alternatives considered

- **A third-party error/RUM SDK (Sentry et al.)** — rejected on the privacy invariant, above: the default
  payload is precisely the kind of context this system is built to never emit, and auditing an SDK's
  scrubbing on every upgrade is a larger ongoing commitment than the four counters it would replace.
- **Infer client health server-side from WS connect/disconnect patterns** — rejected: a tablet that has given
  up produces no traffic at all, so the interesting state is invisible exactly when it matters. It also cannot
  see a render crash or a fetch deadline, which happen with the socket perfectly healthy.
- **Send the error message/stack, scrubbed** — rejected. A scrubber is a filter that must be right every time
  against text nobody controls; the invariant here is "never write a child's name down", and the only
  implementation of that with no failure mode is not to send free text at all.
- **Log to the browser console only** — rejected: that is the status quo. It requires someone to already be
  looking at the broken device, which is the one thing you cannot count on mid-match.
- **A session label on the metric** — rejected: it would make `/metrics` enumerate which sessions are live,
  the same oracle `/roster`, `/history` and `/config` all deliberately avoid.
