/**
 * boundary.ts — Phase 3 "boundary correctness" (audit S-1/S-2/S-3/S-5), the pure parts, no broker:
 *
 *   1. metrics registry: a non-finite value never reaches the exposition (Gauge.set / Counter.inc guard),
 *      and a label's distinct values are capped — the overflow collapses into one `_other` series.
 *   2. env.ts: every numeric knob is parsed ONCE, finitely, with a LOUD fallback to the default — a typo'd
 *      `HISTORY_MAX_SPAN_MS=6h` must enforce the default cap, not `NaN` (which compared false everywhere and
 *      admitted a 10-year export). The resolved config is listable so boot can log it.
 *   3. wire.ts: the telemetry + status frames are validated field by field — a string `fix`, a missing
 *      `sats`, a `{$gt:0}` ts are `bad_payload`, never a row, never a WS frame, never a metric sample; a
 *      skewed status frame (fields missing) still becomes a finite-number health envelope with the documented
 *      unmetered sentinels.
 *
 *   bun run test/boundary.ts
 *
 * Exits 0 on success, 1 on any failed assertion.
 */

export {};

process.env.LOG_LEVEL = 'error';
// Knobs read by env.ts during the test (set BEFORE import).
process.env.BOUNDARY_TEST_OK = '7';
process.env.BOUNDARY_TEST_TYPO = '6h';
process.env.BOUNDARY_TEST_BELOW_MIN = '0';
process.env.BOUNDARY_TEST_FLOAT_INT = '2.7';
process.env.BOUNDARY_TEST_NEG_OK = '-3';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

try {
  // ── 1. registry guards ────────────────────────────────────────────────────────────────────────────
  const { metrics, registry, capLabel } = await import('../src/metrics');
  const L = { session: 'bnd', player: 'p1' };
  metrics.fixType.set(L, 3);
  metrics.fixType.set(L, Number.NaN);
  assert(/ft_fix_type\{[^}]*session="bnd"[^}]*\}\s+3$/m.test(registry.render()), 'a NaN set must be ignored — the previous finite value stays');
  metrics.fixType.set({ session: 'bnd', player: 'inf' }, Number.POSITIVE_INFINITY);
  assert(!/player="inf"/.test(registry.render()), 'an Infinity set must not create a series');
  metrics.fixType.set({ session: 'bnd', player: 'str' }, '3\nft_injected 999' as unknown as number);
  assert(!/player="str"/.test(registry.render()) && !/ft_injected/.test(registry.render()), 'a string smuggled into set() must not reach the exposition');
  metrics.fixType.set({ session: 'bnd', player: 'undef' }, undefined as unknown as number);
  assert(!/player="undef"/.test(registry.render()), 'undefined must not reach the exposition');
  metrics.received.inc({ session: 'bnd', player: 'cnt' }, 2);
  metrics.received.inc({ session: 'bnd', player: 'cnt' }, Number.NaN);
  metrics.received.inc({ session: 'bnd', player: 'cnt' }, '5' as unknown as number);
  assert(/ft_telemetry_received_total\{[^}]*player="cnt"[^}]*\}\s+2$/m.test(registry.render()), 'a non-finite/non-number counter delta must be ignored');
  // Prometheus exposition: every sample value must be a plain decimal.
  for (const line of registry.render().split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{.*\})?\s+(\S+)$/.exec(line);
    assert(m !== null && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(m[2]), `malformed sample line: ${JSON.stringify(line)}`);
  }

  // capLabel: distinct values per label name are bounded; the overflow is one shared bucket. Admission is a
  // privilege (checker finding): peek NEVER reserves a slot — only validated traffic and boot seeding admit,
  // so 32 junk publishes can no longer evict the real match session into `_other` for the process lifetime.
  const { capLabelPeek, seedLabel } = await import('../src/metrics');
  seedLabel('session', 'seeded-real');
  assert(capLabelPeek('session', 'never-admitted') === '_other', 'peek on an unadmitted value reads _other');
  assert(capLabelPeek('session', 'never-admitted') === '_other', '…and does NOT reserve a slot as a side effect');
  assert(capLabelPeek('session', 'seeded-real') === 'seeded-real', 'a boot-seeded session keeps its own label');
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) seen.add(capLabel('session', `novel-${i}`));
  assert(seen.size <= 33 && seen.has('_other'), `500 novel session labels must collapse to ≤ 33 incl. "_other", got ${seen.size}`);
  assert(capLabel('session', 'novel-0') === 'novel-0', 'a value admitted before the cap keeps its own label forever (stable series)');
  assert(capLabel('session', 'novel-499') === '_other', 'a value first seen after the cap stays in the overflow bucket');
  assert(capLabel('session', 'seeded-real') === 'seeded-real', 'a seeded session survives the flood — the cap cannot evict it');

  // ── 2. env.ts ─────────────────────────────────────────────────────────────────────────────────────
  const env = await import('../src/env');
  assert(env.envNumber('BOUNDARY_TEST_OK', 1, { min: 1 }) === 7, 'a valid value is used');
  assert(env.envNumber('BOUNDARY_TEST_TYPO', 42, { min: 1 }) === 42, 'a typo ("6h") falls back to the DEFAULT, never NaN');
  assert(env.envNumber('BOUNDARY_TEST_BELOW_MIN', 42, { min: 1 }) === 42, 'a value below min falls back to the default');
  assert(env.envNumber('BOUNDARY_TEST_UNSET', 42) === 42, 'unset → default');
  assert(env.envNumber('BOUNDARY_TEST_NEG_OK', 30) === -3, 'without a min, a negative is accepted (RETENTION_DAYS<=0 = disabled)');
  // Timer knobs: setInterval clamps any delay > 2^31-1 ms to 1 ms (the audit's hot loop) — a "sweep monthly"
  // value must be REJECTED, not honoured as a 1 ms loop the boot log then vouches for.
  process.env.BOUNDARY_TEST_SWEEP = '2592000000'; // 30 days in ms
  assert(env.envTimerMs('BOUNDARY_TEST_SWEEP', 3_600_000, { min: 1_000 }) === 3_600_000,
    'a timer above 2^31-1 ms must fall back (setInterval would clamp it to a 1 ms hot loop)');
  process.env.BOUNDARY_TEST_SWEEP_OK = '86400000';
  assert(env.envTimerMs('BOUNDARY_TEST_SWEEP_OK', 3_600_000, { min: 1_000 }) === 86_400_000, 'a sane timer passes');
  // URL values: userinfo credentials must never reach the boot log.
  process.env.BOUNDARY_TEST_URL = 'mqtt://ingest:s3cret@broker.local:1883';
  assert(env.envString('BOUNDARY_TEST_URL', '') === 'mqtt://ingest:s3cret@broker.local:1883', 'the VALUE returned to code keeps the credentials');
  const urlKnob = env.resolvedConfig().find((r) => r.name === 'BOUNDARY_TEST_URL');
  assert(urlKnob !== undefined && !String(urlKnob.value).includes('s3cret') && String(urlKnob.value).includes('broker.local'),
    `the RECORDED value must have userinfo redacted, got ${JSON.stringify(urlKnob?.value)}`);
  // Booleans stay STRICT for security knobs: only exact lowercase true/false; 'TRUE' must not enable anything.
  process.env.BOUNDARY_TEST_BOOL_UP = 'TRUE';
  assert(env.envBool('BOUNDARY_TEST_BOOL_UP', false) === false, "envBool('TRUE') must fall back to the default, not loosen");
  assert(env.envInt('BOUNDARY_TEST_FLOAT_INT', 5, { min: 1 }) === 5, 'an integer knob given 2.7 falls back (not floor, not NaN)');
  assert(env.envString('BOUNDARY_TEST_STR_UNSET', 'dflt') === 'dflt', 'string default');
  const resolved = env.resolvedConfig();
  const byName = Object.fromEntries(resolved.map((r) => [r.name, r]));
  assert(byName.BOUNDARY_TEST_OK?.source === 'env' && byName.BOUNDARY_TEST_OK.value === 7, `resolved config records env-sourced values, got ${JSON.stringify(byName.BOUNDARY_TEST_OK)}`);
  assert(byName.BOUNDARY_TEST_TYPO?.source === 'fallback' && byName.BOUNDARY_TEST_TYPO.provided === '6h', `a fallback is recorded WITH the rejected raw value so boot can log it loudly, got ${JSON.stringify(byName.BOUNDARY_TEST_TYPO)}`);
  assert(byName.BOUNDARY_TEST_UNSET?.source === 'default', 'an unset knob is recorded as default');
  assert(!JSON.stringify(resolved).includes('password') || resolved.every((r) => !/PASSWORD|SECRET|TOKEN/i.test(r.name) || r.value === '<redacted>'), 'secrets never appear in the resolved config');

  // ── 3. wire.ts ────────────────────────────────────────────────────────────────────────────────────
  const { coerceTelemetry, coerceStatus } = await import('../src/wire');
  const goodRaw = { id: 'trk-01', pl: '01', ts: 1, lat: 44.8125, lon: 20.4612, spd: 3.2, hdg: 90, fix: 3, sats: 11, pdop: 1.2 };
  const okT = coerceTelemetry(goodRaw, 'test', '01', 1_700_000_000_000);
  assert(okT.ok && okT.value.lat === 44.8125 && okT.value.serverTs === 1_700_000_000_000 && okT.value.sessionId === 'test', 'a well-formed frame coerces');
  assert(okT.ok && !('displayName' in okT.value) && Object.keys(okT.value).sort().join() === 'fix,hdg,id,lat,lon,pdop,pl,playerId,sats,serverTs,sessionId,spd,ts', `explicit fields only, got ${okT.ok ? Object.keys(okT.value).join() : 'drop'}`);
  const dropT = (over: Record<string, unknown>, why: string): void => {
    const r = coerceTelemetry({ ...goodRaw, ...over }, 'test', '01', 0);
    assert(!r.ok, `${why} must be dropped`);
    assert(r.reason === 'bad_payload', `${why}: reason must be bad_payload, got ${r.reason}`);
  };
  dropT({ fix: '3\nft_injected_metric 999' }, 'a string fix (the audit injection)');
  dropT({ fix: '3' }, 'a numeric-looking string fix');
  dropT({ sats: undefined }, 'a missing sats');
  dropT({ pdop: null }, 'a null pdop');
  dropT({ hdg: Number.NaN }, 'a NaN hdg');
  dropT({ ts: { $gt: 0 } }, 'an object ts');
  dropT({ lat: '44.8' }, 'a string lat');
  dropT({ spd: Number.POSITIVE_INFINITY }, 'an Infinity speed');
  dropT({ id: 'x'.repeat(65) }, 'an over-long device id');
  dropT({ id: 'trk\n01' }, 'a device id with a control char');
  dropT({ id: 7 }, 'a non-string device id');
  assert(!coerceTelemetry(null, 'test', '01', 0).ok && !coerceTelemetry([], 'test', '01', 0).ok && !coerceTelemetry('x', 'test', '01', 0).ok, 'non-object bodies are dropped');
  const mism = coerceTelemetry({ ...goodRaw, pl: '02' }, 'test', '01', 0);
  assert(!mism.ok && mism.reason === 'id_mismatch', 'body pl ≠ topic player is id_mismatch');
  const range = coerceTelemetry({ ...goodRaw, lat: 91 }, 'test', '01', 0);
  assert(!range.ok && range.reason === 'out_of_range', 'lat 91 is out_of_range');
  const nofix = coerceTelemetry({ ...goodRaw, fix: 1 }, 'test', '01', 0);
  assert(!nofix.ok && nofix.reason === 'no_fix', 'fix 1 is no_fix');

  // Range bounds (checker findings): physically impossible values must not reach the DB/WS/gauges.
  dropT({ spd: -5 }, 'a negative speed');
  dropT({ hdg: 361 }, 'a heading over 360');
  dropT({ hdg: -1 }, 'a negative heading');
  dropT({ fix: 9 }, 'a fix type over 5');
  dropT({ fix: 2.5 }, 'a non-integer fix');
  dropT({ sats: 1e9 }, 'a satellite count beyond hardware');
  dropT({ pdop: -1 }, 'a negative pdop');
  dropT({ ts: -1 }, 'a negative device ts');
  function dropT2(over: Record<string, unknown>, why: string): void {
    const r = coerceTelemetry({ ...goodRaw, ...over }, 'test', '01', 0);
    assert(!r.ok && r.reason === 'out_of_range', `${why} must be out_of_range, got ${r.ok ? 'ok' : r.reason}`);
  }
  dropT2({ lat: 91 }, 'lat 91');

  const skewed = coerceStatus({ id: 'trk-01', pl: '01', ts: 1, up: 12 }, 'test', '01', 5);
  assert(skewed.ok, 'a status frame missing optional fields is ACCEPTED (a firmware skew must not blind the health card)');
  if (skewed.ok) {
    const s = skewed.value;
    // rssi sentinel is -127, NOT 0: 0 dBm is the STRONGEST possible signal and rendered a signal-less device
    // as a green card (checker finding); -127 classifies as "bad", so a coach investigates instead of trusting it.
    assert(s.up === 12 && s.pct === -1 && s.batt === 0 && s.rssi === -127 && s.fix === 0 && s.sats === 0 && s.backlog === 0 && s.heap === 0 && s.pub === 0 && s.stash === 0,
      `missing status fields take the documented unmetered/unknown sentinels, got ${JSON.stringify(s)}`);
    for (const v of Object.values(s)) assert(typeof v === 'string' || Number.isFinite(v), 'every status value is a finite number (or an id string)');
  }
  const badUp = coerceStatus({ id: 'trk-01', pl: '01', ts: 1, up: '12' }, 'test', '01', 5);
  assert(!badUp.ok && badUp.reason === 'bad_payload', 'a non-numeric up is bad_payload');
  const badBatt = coerceStatus({ id: 'trk-01', pl: '01', ts: 1, up: 12, batt: 'low' }, 'test', '01', 5);
  assert(badBatt.ok && badBatt.value.batt === 0, 'a non-numeric optional status field takes its sentinel rather than dropping the frame');
  // Physically impossible status values take the sentinel too (a wrapped battPct 250 must not read "ok").
  const wild = coerceStatus({ id: 'trk-01', pl: '01', ts: 1, up: 12, pct: 250, rssi: 1e6, batt: 1e308, sats: -4, fix: 99, backlog: -1 }, 'test', '01', 5);
  assert(wild.ok, 'wild-but-finite optional fields never drop the frame');
  if (wild.ok) {
    const w = wild.value;
    assert(w.pct === -1 && w.rssi === -127 && w.batt === 0 && w.sats === 0 && w.fix === 0 && w.backlog === 0,
      `out-of-range status fields take their sentinels, got ${JSON.stringify(w)}`);
  }
  const negUp = coerceStatus({ id: 'trk-01', pl: '01', ts: 1, up: -5 }, 'test', '01', 5);
  assert(!negUp.ok && negUp.reason === 'bad_payload', 'a negative uptime is bad_payload (up is the required liveness field)');
  const statusMism = coerceStatus({ id: 'trk-01', pl: '02', ts: 1, up: 12 }, 'test', '01', 5);
  assert(!statusMism.ok && statusMism.reason === 'id_mismatch', 'status body pl ≠ topic player is id_mismatch');

  console.log('\n✅ BOUNDARY PASSED — non-finite values never reach /metrics, labels capped with an overflow bucket, '
    + 'env knobs fall back loudly (never NaN), wire frames validated field by field with sentinels for skewed status');
  process.exit(0);
} catch (err) {
  console.error('\n❌ BOUNDARY FAILED:', (err as Error).message);
  process.exit(1);
}
