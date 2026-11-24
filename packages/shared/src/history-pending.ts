/** Opt-in, read-only history preparation. Never a message delivery receipt. */
export const HISTORY_ASYNC_HEADER = 'x-agentopsdeck-history-async';
export const HISTORY_PENDING_CODE = 'history_preparing';
export const historyPendingBody = () => ({ code: HISTORY_PENDING_CODE, retryAfterMs: 1000 });
export function isHistoryPending(value: unknown): value is { code: typeof HISTORY_PENDING_CODE; retryAfterMs: number } {
  if (!value || typeof value !== 'object') return false;
  const body = value as Record<string, unknown>;
  return body.code === HISTORY_PENDING_CODE && Number.isSafeInteger(body.retryAfterMs)
    && (body.retryAfterMs as number) >= 250 && (body.retryAfterMs as number) <= 5000;
}
