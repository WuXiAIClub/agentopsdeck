export type ReadHealth = { failures: number; detail?: string; severity?: 'warning' | 'error' };
export const healthyRead: ReadHealth = { failures: 0 };
export function isCancelledRead(cause: unknown) {
  return cause instanceof Error && cause.name === 'AbortError';
}
/** Cancellation is control flow. A single failed background read with usable
 * content is degraded, not a failed run. Auth/initial/explicit failures are immediate. */
export function failedRead(previous: ReadHealth, cause: unknown, hasContent: boolean, foreground = false): ReadHealth {
  if (isCancelledRead(cause)) return previous;
  const status = typeof cause === 'object' && cause !== null && 'status' in cause ? cause.status : undefined;
  const failures = previous.failures + 1;
  return { failures, detail: cause instanceof Error ? cause.message : String(cause),
    severity: !hasContent || foreground || status === 401 || status === 403 || cause instanceof Error && cause.name === 'AuthRequiredError' || failures > 1 ? 'error' : 'warning' };
}
