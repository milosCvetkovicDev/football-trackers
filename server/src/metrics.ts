/**
 * Metrics — a tiny, zero-dependency Prometheus registry.
 *
 * Why hand-rolled instead of prom-client: this project's whole point is owning
 * the stack with no subscriptions or heavyweight deps (NFR-OWN-1). The exposition
 * format is simple, and cardinality here is *bounded* — a session has ≤ ~20
 * players — so per-session/per-player labels are safe (no unbounded label
 * explosion). Scrape `GET /metrics` with Prometheus; dashboard in Grafana.
 *
 * See docs/architecture/observability.md for the metric catalogue and SLOs.
 */

type Labels = Record<string, string | number>;

/** Stable identity for a label set (order-independent), used to dedupe series. */
function seriesKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function renderLabels(labels: Labels, extra?: Labels): string {
  const all = { ...labels, ...extra };
  const keys = Object.keys(all);
  if (keys.length === 0) return '';
  return (
    '{' +
    keys
      .map((k) => `${k}="${escapeLabelValue(String(all[k]))}"`)
      .join(',') +
    '}'
  );
}

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: string,
  ) {}
  protected abstract collect(): string[];
  render(): string {
    const lines = this.collect();
    if (lines.length === 0) return '';
    return (
      `# HELP ${this.name} ${this.help}\n` +
      `# TYPE ${this.name} ${this.type}\n` +
      lines.join('\n') +
      '\n'
    );
  }
}

class Counter extends Metric {
  private series = new Map<string, { labels: Labels; v: number }>();
  constructor(name: string, help: string) {
    super(name, help, 'counter');
  }
  inc(labels: Labels = {}, delta = 1): void {
    const k = seriesKey(labels);
    const s = this.series.get(k);
    if (s) s.v += delta;
    else this.series.set(k, { labels, v: delta });
  }
  protected collect(): string[] {
    return [...this.series.values()].map(
      ({ labels, v }) => `${this.name}${renderLabels(labels)} ${v}`,
    );
  }
}

class Gauge extends Metric {
  private series = new Map<string, { labels: Labels; v: number }>();
  constructor(name: string, help: string) {
    super(name, help, 'gauge');
  }
  set(labels: Labels, value: number): void {
    this.series.set(seriesKey(labels), { labels, v: value });
  }
  inc(labels: Labels = {}, delta = 1): void {
    const k = seriesKey(labels);
    const s = this.series.get(k);
    if (s) s.v += delta;
    else this.series.set(k, { labels, v: delta });
  }
  dec(labels: Labels = {}, delta = 1): void {
    this.inc(labels, -delta);
  }
  protected collect(): string[] {
    return [...this.series.values()].map(
      ({ labels, v }) => `${this.name}${renderLabels(labels)} ${v}`,
    );
  }
}

class Histogram extends Metric {
  private series = new Map<
    string,
    { labels: Labels; buckets: number[]; sum: number; count: number }
  >();
  constructor(
    name: string,
    help: string,
    readonly bounds: number[], // ascending upper bounds (seconds, etc.)
  ) {
    super(name, help, 'histogram');
  }
  observe(labels: Labels, value: number): void {
    if (!Number.isFinite(value)) return;
    const k = seriesKey(labels);
    let s = this.series.get(k);
    if (!s) {
      s = { labels, buckets: new Array(this.bounds.length).fill(0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    s.sum += value;
    s.count++;
    // bounds are ascending, so incrementing every bucket whose bound >= value
    // leaves buckets[i] == count of observations <= bounds[i] (already cumulative).
    for (let i = 0; i < this.bounds.length; i++) {
      if (value <= this.bounds[i]) s.buckets[i]++;
    }
  }
  protected collect(): string[] {
    const out: string[] = [];
    for (const s of this.series.values()) {
      for (let i = 0; i < this.bounds.length; i++) {
        out.push(
          `${this.name}_bucket${renderLabels(s.labels, { le: this.bounds[i] })} ${s.buckets[i]}`,
        );
      }
      out.push(`${this.name}_bucket${renderLabels(s.labels, { le: '+Inf' })} ${s.count}`);
      out.push(`${this.name}_sum${renderLabels(s.labels)} ${s.sum}`);
      out.push(`${this.name}_count${renderLabels(s.labels)} ${s.count}`);
    }
    return out;
  }
}

class Registry {
  private metrics: Metric[] = [];
  register<T extends Metric>(m: T): T {
    this.metrics.push(m);
    return m;
  }
  render(): string {
    return this.metrics.map((m) => m.render()).join('');
  }
}

export const registry = new Registry();

// Latency buckets tuned for an in-process pipeline: sub-ms to half a second.
const LATENCY_BUCKETS = [
  0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1,
];
// History reads are a background, seconds-scale op (a full paged match scan is a few seconds), so they
// need far wider buckets than the sub-ms live ingest path. See history.ts / ADR-0017 SLO.
const HISTORY_BUCKETS = [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30];

/**
 * Domain metric catalogue. `ft_` prefix; labels kept low-cardinality
 * (session, player, reason). Documented in docs/architecture/observability.md.
 */
export const metrics = {
  // --- ingest pipeline ---
  received: registry.register(
    new Counter('ft_telemetry_received_total', 'Telemetry packets received from MQTT'),
  ),
  dropped: registry.register(
    new Counter(
      'ft_telemetry_dropped_total',
      'Telemetry packets dropped before fan-out, by reason (bad_topic|bad_json|bad_payload|id_mismatch|out_of_range|rate|no_fix)',
    ),
  ),
  published: registry.register(
    new Counter('ft_telemetry_published_total', 'Telemetry packets fanned out to WS rooms'),
  ),
  ingestLatency: registry.register(
    new Histogram(
      'ft_ingest_duration_seconds',
      'Server-side processing time per packet: receipt -> persisted -> fanned out',
      LATENCY_BUCKETS,
    ),
  ),
  // --- data quality / freshness (per player) ---
  fixType: registry.register(
    new Gauge('ft_fix_type', 'Last GNSS fix type per player (0 none, 2 2D, 3 3D)'),
  ),
  sats: registry.register(new Gauge('ft_satellites', 'Last satellites-in-view per player')),
  pdop: registry.register(new Gauge('ft_pdop', 'Last positional DOP per player (lower is better)')),
  lastSeen: registry.register(
    new Gauge(
      'ft_player_last_seen_timestamp_seconds',
      'Unix time of the last accepted fix per player (alert on time()-this)',
    ),
  ),
  // --- persistence ---
  dbWrite: registry.register(
    new Histogram('ft_db_write_duration_seconds', 'SQLite insert latency', LATENCY_BUCKETS),
  ),
  dbErrors: registry.register(new Counter('ft_db_errors_total', 'Failed SQLite inserts')),
  // --- retention / data minimisation (ADR-0010) ---
  retentionPurged: registry.register(
    new Counter(
      'ft_retention_rows_purged_total',
      'Raw telemetry rows deleted by the retention job (seeded to 0 at boot so rate()/"stays 0" rules work)',
    ),
  ),
  retentionSweepFailures: registry.register(
    new Counter(
      'ft_retention_sweep_failures_total',
      'Retention sweeps that threw (caught, server kept running) — alert on increase()',
    ),
  ),
  rosterSessionsPruned: registry.register(
    new Counter(
      'ft_retention_roster_sessions_pruned_total',
      'Roster sessions dropped by the retention sweep because no fix remained and the provisioning stamp was older than the window (audit §4.5) — present-at-0',
    ),
  ),
  retentionLastRun: registry.register(
    new Gauge(
      'ft_retention_last_run_timestamp_seconds',
      'Unix time the retention sweep last ran (success or caught failure) — alert on time()-this > 2x sweep interval (sweep wedged)',
    ),
  ),
  oldestRawFixAge: registry.register(
    new Gauge(
      'ft_oldest_raw_fix_age_seconds',
      // Steady-state this legitimately reaches RETENTION_DAYS + one sweep interval, so an
      // alert needs headroom + dwell — see the rule in docs/architecture/observability.md.
      'Age of the oldest raw fix still stored, 0 if empty — the data-minimisation SLI proving the retention window holds',
    ),
  ),
  // --- broker / transport ---
  mqttConnected: registry.register(
    new Gauge('ft_mqtt_connected', 'Broker connection state (1 connected, 0 down)'),
  ),
  mqttReconnects: registry.register(
    new Counter('ft_mqtt_reconnects_total', 'MQTT reconnect attempts'),
  ),
  // --- live fan-out ---
  wsClients: registry.register(
    new Gauge('ft_ws_clients', 'Connected coach-view WebSocket clients per session'),
  ),
  wsRejected: registry.register(
    new Counter(
      'ft_ws_rejected_total',
      'Rejected /live WS upgrades, by reason (auth|origin|no_session|not_authorized_for_session)',
    ),
  ),
  wsSent: registry.register(
    new Counter('ft_ws_messages_sent_total', 'Telemetry envelopes pushed to WS rooms per session'),
  ),
  wsStatusSent: registry.register(
    new Counter(
      'ft_ws_status_envelopes_sent_total',
      'Device-health envelopes pushed to WS rooms per session (Phase 3; second /live envelope from the .../status topic)',
    ),
  ),
  // --- Phase 3 data endpoints (roster names + review/replay history) ---
  // result/mode labels are bounded; NEVER a session/player/name label — a per-session count on the
  // unauthenticated-scrapeable /metrics would enumerate which sessions have coaches/data (ADR-0016 §1.2/§3.1).
  rosterRequests: registry.register(
    new Counter(
      'ft_roster_requests_total',
      'GET /sessions/:id/roster requests by result (ok|rate_limited|unauthorized|login_required|forbidden|bad_session|forbidden_origin)',
    ),
  ),
  historyRequests: registry.register(
    new Counter(
      'ft_history_requests_total',
      'GET /sessions/:id/history requests by result (ok|rate_limited|busy|unauthorized|login_required|forbidden|bad_session|bad_params|forbidden_origin|internal)',
    ),
  ),
  historyReadSeconds: registry.register(
    new Histogram(
      'ft_history_read_seconds',
      'Wall time of a paged history read, by mode (aggregate|raw) — the ADR-0017 off-the-live-loop SLO',
      HISTORY_BUCKETS,
    ),
  ),
  historyRowsScanned: registry.register(
    new Counter(
      'ft_history_rows_scanned_total',
      'Telemetry rows scanned by history reads, by mode — the bulk-export volume signal',
    ),
  ),
  configRequests: registry.register(
    new Counter(
      'ft_config_requests_total',
      'GET /sessions/:id/config requests by result (ok|unauthorized|forbidden|bad_session|forbidden_origin) — Phase 4 age band',
    ),
  ),
  // --- tactical event detection (Track A; ADR-0020 / event-detection-contract) ---
  // result labels are bounded; NEVER a session/player/name label (same rule as history — a per-session count on
  // the scrapeable /metrics would enumerate which sessions have data). The events surface is team-aggregate.
  eventsRequests: registry.register(
    new Counter(
      'ft_events_requests_total',
      'GET /sessions/:id/events requests by result (ok|rate_limited|busy|unauthorized|login_required|forbidden|bad_session|bad_params|forbidden_origin|internal)',
    ),
  ),
  eventsReadSeconds: registry.register(
    new Histogram(
      'ft_events_read_seconds',
      'Wall time of a paged tactical-events read — the ADR-0020 off-the-live-loop SLO (shares the loop with history)',
      HISTORY_BUCKETS,
    ),
  ),
  eventsRowsScanned: registry.register(
    new Counter(
      'ft_events_rows_scanned_total',
      'Telemetry rows scanned by tactical-events reads — the bulk-export volume signal',
    ),
  ),
  // --- auth (Phase 2 — named login + cookie-on-upgrade; see docs/frontend/phase-2-auth-contract.md) ---
  // result is bounded {success|failure|throttled}; NEVER a username label (cardinality + PII — coach
  // usernames are audited in structured logs, not metrics; child names never appear anywhere).
  authLogins: registry.register(
    new Counter('ft_auth_logins_total', 'Login attempts by result (success|failure|throttled)'),
  ),
  authSessions: registry.register(
    new Gauge('ft_auth_sessions_active', 'Current live auth sessions (logged-in cookie principals)'),
  ),
  anonMode: registry.register(
    new Gauge(
      'ft_anon_mode_active',
      // NB: keep HELP starting with a letter (not a digit) — a leading digit makes loose value-scraping regexes match the HELP line.
      'Anonymous /live mode: enabled=1 (isolated-LAN bypass, scoped to ANON_SESSIONS), disabled=0 — alert if 1 on an internet-exposed deploy',
    ),
  ),
  // --- device self-telemetry (from the .../status topic) ---
  devBattVolts: registry.register(
    new Gauge('ft_device_battery_volts', 'Wearable battery voltage'),
  ),
  devBattPct: registry.register(
    new Gauge('ft_device_battery_percent', 'Wearable battery percent (-1 if unmetered)'),
  ),
  devRssi: registry.register(new Gauge('ft_device_wifi_rssi_dbm', 'Wearable WiFi RSSI')),
  devHeap: registry.register(new Gauge('ft_device_free_heap_bytes', 'Wearable free heap')),
  devUptime: registry.register(new Gauge('ft_device_uptime_seconds', 'Wearable uptime')),
  devBacklogBytes: registry.register(
    new Gauge(
      'ft_device_backlog_bytes',
      'Wearable flash backlog size — rising means it cannot reach the broker',
    ),
  ),
  devPublished: registry.register(
    new Gauge('ft_device_published', 'Device-side cumulative successful publishes (resets on reboot)'),
  ),
  devStashed: registry.register(
    new Gauge('ft_device_stashed', 'Device-side cumulative backlog appends (resets on reboot)'),
  ),
  devStatusLastSeen: registry.register(
    new Gauge('ft_device_status_last_seen_timestamp_seconds', 'Unix time of the last status frame'),
  ),
  // --- process / build ---
  processUptime: registry.register(
    new Gauge('ft_process_uptime_seconds', 'Server process uptime'),
  ),
  processRss: registry.register(
    new Gauge('ft_process_resident_memory_bytes', 'Server process resident memory'),
  ),
  buildInfo: registry.register(
    new Gauge('ft_build_info', 'Build/version info (always 1; read the labels)'),
  ),
};

/** Refresh point-in-time process gauges. Call right before rendering /metrics. */
export function updateRuntimeMetrics(): void {
  metrics.processUptime.set({}, process.uptime());
  metrics.processRss.set({}, process.memoryUsage().rss);
}
