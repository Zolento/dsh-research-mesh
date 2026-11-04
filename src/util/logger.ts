/** Minimal structured logger used by services, workers and executors. */

/** Supported log levels, most to least verbose. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Structured fields attached to one log record. */
export type LogFields = Readonly<Record<string, unknown>>;

/** Logger surface injected into Mesh components. */
export interface MeshLogger {
  /** Diagnostic detail; hidden at the default level. */
  debug(message: string, fields?: LogFields): void;
  /** Normal lifecycle progress. */
  info(message: string, fields?: LogFields): void;
  /** Recoverable degradation requiring attention. */
  warn(message: string, fields?: LogFields): void;
  /** A failed operation or inconsistent state. */
  error(message: string, fields?: LogFields): void;
}

const SECRET_KEY = /(token|secret|password|passwd|private[_-]?key|api[_-]?key|authorization)/i;

/** Remove obvious secret-shaped fields before a record reaches stdout. */
function redact(fields: LogFields | undefined): Record<string, unknown> | undefined {
  if (fields === undefined) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    output[key] = SECRET_KEY.test(key) ? '[redacted]' : value;
  }
  return output;
}

/**
 * Create a prefixed console logger.
 * @param level - minimum level to emit.
 * @param sink - optional output sink; defaults to the console.
 * @param prefix - stable component prefix.
 * @returns logger.
 */
export function createLogger(
  level: LogLevel = 'info',
  sink: Pick<Console, 'debug' | 'info' | 'warn' | 'error'> = console,
  prefix = 'dsh-research-mesh',
): MeshLogger {
  const emit = (recordLevel: LogLevel, message: string, fields?: LogFields): void => {
    if (ORDER[recordLevel] < ORDER[level]) return;
    const line = `${prefix} ${recordLevel}: ${message}`;
    const clean = redact(fields);
    if (clean === undefined || Object.keys(clean).length === 0) {
      sink[recordLevel](line);
    } else {
      sink[recordLevel](line, clean);
    }
  };
  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

/** A logger that discards every record; useful in deterministic tests. */
export const silentLogger: MeshLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
