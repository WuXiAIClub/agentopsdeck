export type HistoryRefreshOptions = { maxAgeMs?: number; fresh?: boolean; readOnly?: boolean; priority?: number };

/** A newer runtime-owned snapshot superseded this read. Not execution readiness
 * and not permission to publish the discarded snapshot. Read-only clients may
 * negotiate preparation and poll again; real source failures remain errors. */
export class HistoryReadSuperseded extends Error {}

/** Display admission pressure, not a source error or evidence of readiness. */
export class HistoryReadDeferred extends Error {}

/** One history projection per session at a time. A terminal-triggered read
 * drains pre-existing work before reading again; it never certifies an older
 * in-flight response or a best-effort local fallback as synchronized history.
 */
export function createHistoryRefresh<T>(read: (sessionKey: string, authoritative: boolean) => Promise<T>, validate: (result: T) => void = () => {}) {
  const inflight = new Map<string, Promise<void>>();
  const last = new Map<string, number>();
  let closing: Promise<void> | undefined;
  const refresh = async (sessionKey: string, options: HistoryRefreshOptions = {}) => {
    if (closing) throw new Error('History projection is closed');
    if (options.fresh) {
      while (inflight.has(sessionKey)) await inflight.get(sessionKey)!.catch(() => {});
    } else {
      const existing = inflight.get(sessionKey);
      if (existing) return existing;
      if ((options.maxAgeMs ?? 0) > Date.now() - (last.get(sessionKey) ?? 0)) return;
    }
    if (closing) throw new Error('History projection is closed');
    last.delete(sessionKey);
    const task = Promise.resolve().then(() => read(sessionKey, options.fresh === true)).then(result => {
      validate(result);
      if (!closing) last.set(sessionKey, Date.now());
    }).finally(() => { inflight.delete(sessionKey); });
    inflight.set(sessionKey, task);
    return task;
  };
  return Object.assign(refresh, {
    invalidate: () => last.clear(),
    ready: (sessionKey: string) => !closing && last.has(sessionKey) && !inflight.has(sessionKey),
    close: () => closing ??= Promise.allSettled([...inflight.values()]).then(() => { last.clear(); }),
  });
}

export function gatewayHistoryRows(result: unknown, sessionKey: string): any[] {
  if (Array.isArray(result)) return validateRows(result);
  if (!result || typeof result !== 'object') throw new Error('Invalid Gateway history');
  const record = result as Record<string, unknown>;
  if (record.sessionKey !== undefined && record.sessionKey !== sessionKey) throw new Error('Gateway history session mismatch');
  if (!Array.isArray(record.messages)) throw new Error('Invalid Gateway history');
  return validateRows(record.messages);
}

function validateRows(rows: any[]) {
  if (rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('Invalid Gateway history row');
  return rows;
}
