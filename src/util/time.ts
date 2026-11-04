/** Time and monotonic-order helpers. */

/**
 * Current wall-clock time as ISO-8601 UTC.
 * @returns e.g. `2026-11-05T00:00:00.000Z`.
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Current wall-clock time in epoch milliseconds.
 * @returns integer milliseconds.
 */
export function nowMs(): number {
  return Date.now();
}

/**
 * Convert epoch milliseconds to ISO-8601 UTC.
 * @param ms - epoch milliseconds.
 * @returns ISO string.
 */
export function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Parse an ISO timestamp into epoch milliseconds; NaN is rejected.
 * @param value - ISO timestamp.
 * @param field - field name for failures.
 * @returns epoch milliseconds.
 */
export function parseIsoMs(value: string, field: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${field} is not an ISO timestamp: ${value}`);
  return ms;
}

/**
 * Sleep for a bounded duration.
 * @param ms - non-negative milliseconds.
 * @param signal - optional cancellation.
 * @returns resolves after the delay or rejects with an AbortError.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
