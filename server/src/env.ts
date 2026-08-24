/**
 * Environment knobs, parsed ONCE, finitely, with a LOUD fallback (audit S-3).
 *
 * `Math.max(1, Number('6h'))` is NaN, and every comparison against NaN is false — so a typo'd
 * `HISTORY_MAX_SPAN_MS` silently admitted a 10-year export of children's raw location, a typo'd session
 * TTL made cookies valid forever, and three knobs fell into 1 ms hot loops. Every numeric knob now goes
 * through envNumber/envInt: a value that is not finite, not within [min, max], or not an integer when one is
 * required is REJECTED in favour of the default — and the rejection is recorded (with the raw value) so
 * server.ts can print the resolved configuration at boot, where an operator actually looks.
 *
 * Secrets (names matching PASSWORD/SECRET/TOKEN/KEY) are recorded as `<redacted>`.
 */
import { log } from './log';

export interface ResolvedKnob {
  name: string;
  value: number | string | boolean;
  default: number | string | boolean;
  source: 'env' | 'default' | 'fallback';
  /** The raw string that was rejected (source === 'fallback'). */
  provided?: string;
}

const resolved = new Map<string, ResolvedKnob>();
const SECRET_RE = /PASSWORD|SECRET|TOKEN|KEY/i;

/** URLs may carry credentials in the userinfo (mqtt://user:pass@host) — never record those. */
function redactUrlUserinfo(v: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(v)) return v;
  try {
    const u = new URL(v);
    if (u.username || u.password) {
      u.username = '<redacted>';
      u.password = '';
      return u.toString();
    }
  } catch {
    return '<redacted-url>'; // has an @ before the first slash but does not parse — do not risk it
  }
  return v;
}

function record(k: ResolvedKnob): void {
  if (SECRET_RE.test(k.name)) k = { ...k, value: k.value === '' ? '' : '<redacted>', default: k.default === '' ? '' : '<redacted>', provided: undefined };
  if (typeof k.value === 'string') k = { ...k, value: redactUrlUserinfo(k.value) };
  resolved.set(k.name, k);
  if (k.source === 'fallback') {
    log.warn('env: invalid value — using the default', { name: k.name, provided: SECRET_RE.test(k.name) ? '<redacted>' : k.provided, default: k.default });
  }
}

/** setInterval/setTimeout clamp any delay above 2^31-1 ms to 1 ms — the audit's hot loop. */
export const TIMER_MAX_MS = 2_147_483_647;

export interface NumberOpts {
  min?: number;
  max?: number;
}

/** A finite number within [min, max], else the default (loudly). */
export function envNumber(name: string, def: number, opts: NumberOpts = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    record({ name, value: def, default: def, source: 'default' });
    return def;
  }
  const n = Number(raw);
  const ok = raw.trim() !== '' && Number.isFinite(n) && (opts.min === undefined || n >= opts.min) && (opts.max === undefined || n <= opts.max);
  if (!ok) {
    record({ name, value: def, default: def, source: 'fallback', provided: raw });
    return def;
  }
  record({ name, value: n, default: def, source: 'env' });
  return n;
}

/** An integer within [min, max], else the default (loudly). */
export function envInt(name: string, def: number, opts: NumberOpts = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    record({ name, value: def, default: def, source: 'default' });
    return def;
  }
  const n = Number(raw);
  const ok = raw.trim() !== '' && Number.isInteger(n) && (opts.min === undefined || n >= opts.min) && (opts.max === undefined || n <= opts.max);
  if (!ok) {
    record({ name, value: def, default: def, source: 'fallback', provided: raw });
    return def;
  }
  record({ name, value: n, default: def, source: 'env' });
  return n;
}

/** A millisecond delay destined for setInterval/setTimeout: bounded above by TIMER_MAX_MS — a value past the
 *  32-bit clamp would run the job every 1 ms while the boot log vouched for the configured number. */
export function envTimerMs(name: string, def: number, opts: NumberOpts = {}): number {
  return envNumber(name, def, { ...opts, max: Math.min(opts.max ?? TIMER_MAX_MS, TIMER_MAX_MS) });
}

/** A string knob (recorded; secrets redacted). */
export function envString(name: string, def: string): string {
  const raw = process.env[name];
  const value = raw === undefined ? def : raw;
  record({ name, value, default: def, source: raw === undefined ? 'default' : 'env' });
  return value;
}

/** A boolean knob: EXACTLY 'true' or 'false' (lowercase); anything else — 'TRUE', '1', 'yes' — falls back
 *  loudly. Strict on purpose: these knobs loosen security (anon mode, proxy trust, cookie Secure), and the
 *  old code only honoured the exact lowercase spellings — case-insensitivity would have widened them. */
export function envBool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    record({ name, value: def, default: def, source: 'default' });
    return def;
  }
  if (raw !== 'true' && raw !== 'false') {
    record({ name, value: def, default: def, source: 'fallback', provided: raw });
    return def;
  }
  record({ name, value: raw === 'true', default: def, source: 'env' });
  return raw === 'true';
}

/** Every knob resolved so far, in first-seen order — for the boot log and for tests. */
export function resolvedConfig(): ResolvedKnob[] {
  return [...resolved.values()];
}

/** One structured line per boot with the whole resolved configuration; fallbacks are listed separately. */
export function logResolvedConfig(): void {
  const all = resolvedConfig();
  const config: Record<string, number | string | boolean> = {};
  for (const k of all) config[k.name] = k.value;
  const fallbacks = all.filter((k) => k.source === 'fallback').map((k) => ({ name: k.name, provided: k.provided, using: k.value }));
  log.info('config resolved', { config, fallbacks });
  if (fallbacks.length > 0) {
    // ERROR, not warn: an operator running LOG_LEVEL=error must still see that a knob they set was rejected
    // — an invalid cap silently replaced by a default is exactly the audit's S-3 failure shape.
    log.error('config: some env values were INVALID and replaced by defaults — check the list', { fallbacks });
  }
}
