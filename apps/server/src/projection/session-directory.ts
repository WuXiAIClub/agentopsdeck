import { isAgentRuntimeId, sessionRuntimeId, type SessionDirectoryPage, type SessionDirectoryQuery } from '@agentopsdeck/shared';

const keys = ['runtime', 'sessionKey', 'after', 'limit'];
const validKey = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && !(sessionRuntimeId(value) !== 'openclaw' && value === `${sessionRuntimeId(value)}:`)
  && Buffer.byteLength(value) <= 2048 && !/[\x00-\x1f\x7f]/.test(value)
  && Buffer.from(value, 'utf8').toString('utf8') === value;
const runtimeOf = sessionRuntimeId;

/** Shared by the route and credential bridge: duplicates and unknown filters fail closed. */
export function parseSessionDirectoryQuery(params: URLSearchParams): SessionDirectoryQuery {
  for (const key of params.keys()) if (!keys.includes(key) || params.getAll(key).length !== 1) throw new Error('Invalid session directory query');
  const runtime = params.get('runtime'), sessionKey = params.get('sessionKey'), after = params.get('after'), rawLimit = params.get('limit');
  if (runtime !== null && !isAgentRuntimeId(runtime)
    || sessionKey !== null && !validKey(sessionKey) || after !== null && !validKey(after)
    || rawLimit !== null && !/^(?:[1-9][0-9]?|100)$/.test(rawLimit)
    || sessionKey !== null && runtime !== null && runtime !== runtimeOf(sessionKey)) throw new Error('Invalid session directory query');
  return { ...(runtime ? { runtime } : {}), ...(sessionKey ? { sessionKey } : {}), ...(after ? { after } : {}), limit: Number(rawLimit ?? 50) };
}

export function sessionDirectoryParams(query: SessionDirectoryQuery) {
  const params = new URLSearchParams();
  // Also reject extra runtime JS fields, rather than silently dropping an agent filter.
  if (Object.keys(query).some(key => !keys.includes(key))) throw new Error('Invalid session directory query');
  for (const key of keys as Array<keyof SessionDirectoryQuery>) if (query[key] !== undefined) params.set(key, String(query[key]));
  parseSessionDirectoryQuery(params);
  return params;
}

/** One map scan, <=101 keys retained. No full-catalog copy/sort, cache, or runtime refresh.
 * Pagination is live keyset traversal, not a stable snapshot across requests. */
export function projectSessionDirectory(keys: Iterable<string>, query: SessionDirectoryQuery, sourceCursor: string): SessionDirectoryPage {
  const q = parseSessionDirectoryQuery(sessionDirectoryParams(query)), limit = q.limit!;
  const selected: string[] = [];
  for (const key of keys) {
    if (!validKey(key) || key <= (q.after ?? '') || q.sessionKey !== undefined && key !== q.sessionKey
      || q.runtime !== undefined && runtimeOf(key) !== q.runtime) continue;
    if (selected.length === limit + 1 && key >= selected[limit]!) continue;
    let low = 0, high = selected.length;
    while (low < high) { const mid = (low + high) >>> 1; if (selected[mid]! < key) low = mid + 1; else high = mid; }
    selected.splice(low, 0, key);
    if (selected.length > limit + 1) selected.pop();
  }
  return { sessions: selected.slice(0, limit).map(sessionKey => ({ sessionKey, runtime: runtimeOf(sessionKey) })),
    nextCursor: selected.length > limit ? selected[limit - 1]! : null, sourceCursor };
}

/** Do not relay an upstream catalog, private fields, broadened resources, or broken cursors. */
export function sessionDirectoryPage(value: unknown, query: SessionDirectoryQuery): SessionDirectoryPage {
  const q = parseSessionDirectoryQuery(sessionDirectoryParams(query));
  const page = value as SessionDirectoryPage;
  if (!page || !Array.isArray(page.sessions) || page.sessions.length > q.limit! || typeof page.sourceCursor !== 'string'
    || page.sourceCursor.length > 4096 || /[\x00-\x1f\x7f]/.test(page.sourceCursor)) throw new Error('Invalid session directory page');
  let previous = q.after ?? '';
  const sessions = page.sessions.map(item => {
    if (!item || !validKey(item.sessionKey) || item.sessionKey <= previous || item.runtime !== runtimeOf(item.sessionKey)
      || q.runtime !== undefined && item.runtime !== q.runtime || q.sessionKey !== undefined && item.sessionKey !== q.sessionKey) throw new Error('Invalid session directory resource');
    previous = item.sessionKey;
    return { sessionKey: item.sessionKey, runtime: item.runtime };
  });
  if (page.nextCursor !== null && (sessions.length !== q.limit || page.nextCursor !== previous)) throw new Error('Invalid session directory cursor');
  return { sessions, nextCursor: page.nextCursor, sourceCursor: page.sourceCursor };
}
