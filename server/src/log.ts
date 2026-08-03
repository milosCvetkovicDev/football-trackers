/**
 * Structured logging — one JSON object per line (ndjson), so logs are greppable
 * and machine-parseable (ship to Loki/Vector later without reformatting).
 *
 * Level gate via LOG_LEVEL env (debug|info|warn|error, default info).
 * Usage: log.info('mqtt connected', { url }); log.error('db insert failed', { err });
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = ORDER[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? ORDER.info;

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < MIN) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};
