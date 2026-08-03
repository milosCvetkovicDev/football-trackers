import { useMemo } from 'react';
import { useEvents } from './useEvents';
import type { DetectorParams, EventsResult, TacticalEvent, TacticalEventType } from './types';

/**
 * Track A (ADR-0020): the review-mode tactical-event timeline. Renders the server's movement-derived phases
 * (high_tempo / transition / stoppage) as a time strip + an accessible list, plus the team-shape series as a
 * compact compactness sparkline.
 *
 * HONESTY (event-detection-contract §0.5, ADR-0018 lineage): these are HEURISTICS over team movement, NOT
 * confirmed ball events. The header says so in words; every event shows its `confidence` and the run's min
 * player-count (a thin-data signal); the structural detector params are shown as "proposed / unvalidated". The
 * colour is never the sole signal — every event carries its type word + numbers in the list (a11y).
 *
 * Security (§0.2, PM-S5): `useEvents` holds the (team-centroid-bearing) result in memory only; nothing here
 * persists it. The result is team-aggregate — no playerId/name to render.
 */

type Theme = 'normal' | 'outdoor';

interface EventTimelineProps {
  session: string;
  /** The committed review window (same one the aggregate uses), or null to render nothing/idle. */
  window: { from: number; to: number } | null;
  theme: Theme;
}

const EVENT_LABEL: Record<TacticalEventType, string> = {
  high_tempo: 'High tempo',
  transition: 'Transition',
  stoppage: 'Stoppage',
};
// Distinct hues; paired ALWAYS with the type word + numbers so colour is never the only signal (a11y).
const EVENT_COLOR: Record<TacticalEventType, string> = {
  high_tempo: '#ff7043', // warm — many players running hard at once
  transition: '#42a5f5', // blue — the team shifted territory
  stoppage: '#90a4ae', // grey — low-movement / dead time
};

export function EventTimeline({ session, window, theme }: EventTimelineProps) {
  const result = useEvents(session, window);

  if (result.status === 'loading') return <Panel>Detecting tactical events…</Panel>;
  if (result.status === 'error') {
    return (
      <Panel tone="bad">
        Couldn&rsquo;t load tactical events for this window. Check the time range and try again.
      </Panel>
    );
  }
  if (result.status === 'empty') {
    return <Panel>No tactical events detected in this window.</Panel>;
  }
  return <EventsBody data={result.data} theme={theme} />;
}

function EventsBody({ data, theme }: { data: EventsResult; theme: Theme }) {
  const span = Math.max(1, data.to - data.from);
  const outdoor = theme === 'outdoor';

  // Stable, time-ordered list for the table + strip (the server already sorts by fromTs, but be defensive).
  const events = useMemo(() => [...data.events].sort((a, b) => a.fromTs - b.fromTs), [data.events]);

  const counts = useMemo(() => {
    const c: Record<TacticalEventType, number> = { high_tempo: 0, transition: 0, stoppage: 0 };
    for (const e of events) c[e.type] += 1;
    return c;
  }, [events]);

  return (
    <section
      aria-label="Tactical events"
      style={{
        border: '1px solid #2a2d33',
        borderRadius: 10,
        background: '#16181d',
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>Tactical events</span>
        <span style={{ opacity: 0.6, fontSize: 12 }}>
          movement-derived heuristics from GPS — <strong>not</strong> confirmed ball events
        </span>
      </div>

      {/* Provenance: which speed band + the proposed/unvalidated structural params the detectors used (§0.5). */}
      <Provenance data={data} />

      {/* Compactness sparkline: stretch (mean distance from centroid) over the window — the team-shape series. */}
      <CompactnessSparkline data={data} outdoor={outdoor} />

      {/* The colour strip is a glance cue; the list below is the accessible, numeric source of truth. */}
      <TimelineStrip events={events} from={data.from} span={span} counts={counts} />

      <EventList events={events} />
    </section>
  );
}

function Provenance({ data }: { data: EventsResult }) {
  const p: DetectorParams = data.detectorParams;
  return (
    <div
      role="note"
      aria-label="Detector provenance"
      style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, opacity: 0.75 }}
    >
      <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>
        band {data.ageBand} · HSR ≥ {data.thresholds.hsrMps.toFixed(2)} m/s · {Math.round(data.bucketMs)} ms buckets
      </span>
      <span style={{ opacity: 0.85 }}>
        proposed thresholds (unvalidated): tempo ≥ {(p.highTempoFraction * 100).toFixed(0)}% of players for{' '}
        {p.highTempoMinS}s · transition ≥ {p.transitionM} m in {p.transitionWindowS}s · stoppage &lt;{' '}
        {p.stoppageSpeedMps} m/s for {p.stoppageMinS}s · ≥ {p.minPlayersForEvents} players required
      </span>
    </div>
  );
}

/**
 * A compact sparkline of `stretchM` (mean distance of players from their centroid — team compactness) across
 * the series. Drawn as an SVG polyline; a low value = a compact team, high = stretched. Labelled for AT.
 */
function CompactnessSparkline({ data, outdoor }: { data: EventsResult; outdoor: boolean }) {
  const { series, from, to } = data;
  const W = 600;
  const H = 44;
  const span = Math.max(1, to - from);

  const path = useMemo(() => {
    if (series.length < 2) return '';
    let max = 0;
    for (const b of series) if (b.stretchM > max) max = b.stretchM;
    if (max <= 0) return '';
    return series
      .map((b, i) => {
        const x = ((b.ts - from) / span) * W;
        const y = H - (b.stretchM / max) * (H - 4) - 2;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }, [series, from, span]);

  const peak = useMemo(() => series.reduce((m, b) => (b.stretchM > m ? b.stretchM : m), 0), [series]);
  if (!path) return null;

  return (
    <figure style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Team compactness over the window: mean spread from the centre, peaking near ${Math.round(peak)} metres.`}
        style={{ width: '100%', height: H, display: 'block', background: '#0e0f12', borderRadius: 8 }}
      >
        <path d={path} fill="none" stroke={outdoor ? '#ffdf2b' : '#7cc0ff'} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption style={{ marginTop: 4, opacity: 0.55, fontSize: 12 }}>
        Team compactness (mean distance from the centre) — lower is more compact.
      </figcaption>
    </figure>
  );
}

/** The colour strip: each event a positioned bar over the [from..to] window. A glance cue, not the only signal. */
function TimelineStrip({
  events,
  from,
  span,
  counts,
}: {
  events: TacticalEvent[];
  from: number;
  span: number;
  counts: Record<TacticalEventType, number>;
}) {
  const summary = (Object.keys(counts) as TacticalEventType[])
    .filter((t) => counts[t] > 0)
    .map((t) => `${counts[t]} ${EVENT_LABEL[t].toLowerCase()}`)
    .join(', ');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div
        role="img"
        aria-label={`Event timeline: ${summary || 'no events'}.`}
        style={{
          position: 'relative',
          width: '100%',
          height: 22,
          background: '#0e0f12',
          borderRadius: 6,
          overflow: 'hidden',
        }}
      >
        {events.map((e, i) => {
          const left = Math.max(0, Math.min(100, ((e.fromTs - from) / span) * 100));
          const width = Math.max(0.6, Math.min(100 - left, ((e.toTs - e.fromTs) / span) * 100));
          return (
            <span
              key={`${e.type}-${e.fromTs}-${i}`}
              aria-hidden="true"
              title={`${EVENT_LABEL[e.type]} · ${new Date(e.fromTs).toLocaleTimeString()}`}
              style={{
                position: 'absolute',
                left: `${left}%`,
                width: `${width}%`,
                top: 0,
                bottom: 0,
                background: EVENT_COLOR[e.type],
                opacity: 0.45 + 0.5 * e.confidence, // higher-confidence events read stronger
              }}
            />
          );
        })}
      </div>
      {/* Legend — colour + word together. */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, opacity: 0.8 }}>
        {(Object.keys(EVENT_LABEL) as TacticalEventType[]).map((t) => (
          <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span
              aria-hidden="true"
              style={{ width: 11, height: 11, borderRadius: 2, background: EVENT_COLOR[t], display: 'inline-block' }}
            />
            {EVENT_LABEL[t]} ({counts[t]})
          </span>
        ))}
      </div>
    </div>
  );
}

/** The accessible, numeric source of truth — one row per event, type word + time + confidence + players. */
function EventList({ events }: { events: TacticalEvent[] }) {
  if (events.length === 0) {
    return <p style={{ margin: 0, opacity: 0.6, fontSize: 12 }}>No phase events detected (team-shape series shown above).</p>;
  }
  return (
    <table
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        fontVariantNumeric: 'tabular-nums',
        fontSize: 13,
      }}
    >
      <caption style={{ textAlign: 'left', padding: '2px 0 6px', opacity: 0.55 }}>
        Detected phases (GPS heuristic). &ldquo;Players&rdquo; is the fewest reporting at any point in the phase —
        a low number means thin data.
      </caption>
      <thead>
        <tr style={{ textAlign: 'left', opacity: 0.7 }}>
          <th style={th}>Phase</th>
          <th style={th}>Start</th>
          <th style={{ ...th, textAlign: 'right' }}>Duration</th>
          <th style={{ ...th, textAlign: 'right' }}>Confidence</th>
          <th style={{ ...th, textAlign: 'right' }}>Players</th>
          <th style={{ ...th, textAlign: 'right' }}>Detail</th>
        </tr>
      </thead>
      <tbody>
        {events.map((e, i) => (
          <tr key={`${e.type}-${e.fromTs}-${i}`} data-testid="event-row" style={{ borderTop: '1px solid #23262c' }}>
            <td style={td}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span
                  aria-hidden="true"
                  style={{ width: 10, height: 10, borderRadius: 2, background: EVENT_COLOR[e.type] }}
                />
                {EVENT_LABEL[e.type]}
              </span>
            </td>
            <td style={td}>{new Date(e.fromTs).toLocaleTimeString()}</td>
            <td style={{ ...td, textAlign: 'right' }}>{((e.toTs - e.fromTs) / 1000).toFixed(1)} s</td>
            <td style={{ ...td, textAlign: 'right' }}>{Math.round(e.confidence * 100)}%</td>
            <td style={{ ...td, textAlign: 'right' }}>{e.minCount}</td>
            <td style={{ ...td, textAlign: 'right', fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>
              {detailText(e)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One compact detail scalar per event type. */
function detailText(e: TacticalEvent): string {
  if (e.type === 'high_tempo' && e.peakHsrFraction != null) return `${Math.round(e.peakHsrFraction * 100)}% peak`;
  if (e.type === 'transition' && e.centroidShiftM != null) return `${Math.round(e.centroidShiftM)} m shift`;
  if (e.type === 'stoppage' && e.meanSpeedMps != null) return `${e.meanSpeedMps.toFixed(2)} m/s`;
  return '—';
}

function Panel({ children, tone }: { children: React.ReactNode; tone?: 'bad' }) {
  return (
    <p
      role={tone === 'bad' ? 'alert' : undefined}
      style={{
        margin: 0,
        padding: '12px 14px',
        border: '1px solid #2a2d33',
        borderRadius: 10,
        background: '#16181d',
        color: tone === 'bad' ? '#ff8d8d' : '#e8e8e8',
        opacity: tone === 'bad' ? 1 : 0.8,
      }}
    >
      {children}
    </p>
  );
}

const th: React.CSSProperties = { padding: '6px 10px', fontWeight: 600 };
const td: React.CSSProperties = { padding: '6px 10px' };
