import { record } from './protocol.js';
import type { HermesHistorySnapshot } from './journal.js';
import type { HermesHistoryRow } from './history.js';

/** Shared original native protocol. No I/O, SQL, authority or retry. */
export function hermesNativeIdentity(result: unknown) {
  if (!record(result) || typeof result.session_id !== 'string' || !result.session_id
    || typeof result.stored_session_id !== 'string' || !result.stored_session_id
    || [result.session_id, result.stored_session_id].some(id => id.length > 256 || /[\x00-\x1f\x7f]/.test(id))) throw new Error('Invalid Hermes session identity');
  return { live: result.session_id, stored: result.stored_session_id };
}

export function hermesNativeAttachment(session: HermesHistorySnapshot, result: unknown) {
  const resume = session.started || session.nativeAllocated === true;
  const identity = hermesNativeIdentity(resume && record(result)
    ? { session_id: result.session_id, stored_session_id: result.session_key } : result);
  if (resume && identity.stored !== session.stored) throw new Error('Hermes stored identity changed');
  if (record(result) && (result.running === true || result.auto_continue || result.queued || result.hydrating
    || result.pending_approval || result.pending_connection || result.inflight
    || typeof result.status === 'string' && result.status !== 'idle'
    || Array.isArray(result.open_requests) && result.open_requests.length)) throw new Error('Hermes session has unmanaged work');
  return identity;
}

export function hermesNativeHistory(value: unknown): HermesHistoryRow[] {
  if (!record(value) || !Array.isArray(value.messages) || value.messages.length > 50_000) throw new Error('Invalid Hermes history');
  const rows: HermesHistoryRow[] = [], ids = new Set<number>();
  for (const row of value.messages) {
    if (!record(row) || !['user', 'assistant', 'system', 'tool'].includes(String(row.role)) || row.text != null && typeof row.text !== 'string') throw new Error('Invalid Hermes history row');
    const id = Number.isSafeInteger(row.row_id) && (row.row_id as number) > 0 ? row.row_id as number : undefined;
    if (id !== undefined && ids.has(id)) throw new Error('Duplicate Hermes history row');
    if (id !== undefined) ids.add(id);
    rows.push({ hidden: row.display_kind === 'hidden', ...(id === undefined ? {} : { row_id: id }), role: row.role as HermesHistoryRow['role'], text: typeof row.text === 'string' ? row.text : '',
      ...(row.role === 'tool' ? { toolName: typeof row.name === 'string' ? row.name.slice(0, 256) : 'tool' } : {}),
      timestamp: typeof row.timestamp === 'number' && Number.isFinite(row.timestamp) ? row.timestamp * 1000 : 0 });
  }
  return rows;
}
