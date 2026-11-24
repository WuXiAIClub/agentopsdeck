import { isRecord } from '../commands/turn-queue.js';
import { backgroundTerminals } from './background-terminals.js';

type Request = (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>;
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 4096 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

export class NativeMaintenanceInspectionError extends Error {
  constructor(readonly reason: 'native_thread_system_error' | 'native_thread_status_unavailable' | 'native_inspection_timeout') {
    super(reason === 'native_inspection_timeout' ? 'Native maintenance inspection timed out' : 'Native thread activity is unavailable');
  }
}

/** Fixed public codes only; never expose an arbitrary native error or path. */
export function nativeMaintenanceFailureReason(error: unknown) {
  if (!(error instanceof NativeMaintenanceInspectionError)) return undefined;
  return (['native_thread_system_error', 'native_thread_status_unavailable', 'native_inspection_timeout'] as const)
    .find(reason => reason === error.reason);
}

const sourceKinds = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];

/** Read-only native proof for the exclusively owned App Server process.
 * Includes native-loaded child/agent threads, not just projected sessions.
 * Never resume, interrupt, terminate, or replay work to obtain an idle result.
 * Caller must invalidate check() on connection/activity changes throughout.
 */
export async function inspectCodexMaintenance(request: Request, check: () => void,
  deadline = Date.now() + 4000, unmaterializedThreadIds: ReadonlySet<string> = new Set()) {
  const remaining = () => {
    check();
    const timeout = deadline - Date.now();
    if (timeout <= 0) throw new NativeMaintenanceInspectionError('native_inspection_timeout');
    return timeout;
  };
  const loaded = async () => {
    const threads = new Set<string>(), cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 32; page++) {
      const result = await request('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) }, remaining());
      remaining();
      if (!isRecord(result) || !Array.isArray(result.data) || result.data.length > 100
        || (result.nextCursor != null && !validId(result.nextCursor))) throw new Error('Invalid native loaded-thread page');
      for (const id of result.data) {
        if (!validId(id) || threads.has(id)) throw new Error('Invalid native loaded-thread identity');
        threads.add(id);
      }
      if (result.nextCursor == null) return threads;
      if (cursors.has(result.nextCursor)) throw new Error('Repeated native loaded-thread cursor');
      cursors.add(result.nextCursor); cursor = result.nextCursor;
    }
    throw new Error('Native loaded-thread page budget exceeded');
  };
  const before = await loaded();
  const statuses = new Map<string, 'idle' | 'active'>();
  // thread/read can scan/deserialize an arbitrarily large rollout even when
  // includeTurns=false. It is not a bounded activity query. The native list
  // supplies the same live status without hydrating history; require coverage
  // of EVERY loaded identity, including archived/provider/subagent threads.
  if (before.size) for (const archived of [false, true]) {
    const cursors = new Set<string>(), seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 32; page++) {
      const result = await request('thread/list', { limit: 100, archived, modelProviders: [], sourceKinds,
        useStateDbOnly: true, ...(cursor ? { cursor } : {}) }, remaining());
      remaining();
      if (!isRecord(result) || !Array.isArray(result.data) || result.data.length > 100
        || (result.nextCursor != null && !validId(result.nextCursor))) throw new Error('Invalid native thread-status page');
      for (const thread of result.data) {
        if (!isRecord(thread) || !validId(thread.id) || seen.has(thread.id)) throw new Error('Invalid native thread-status identity');
        seen.add(thread.id);
        if (!before.has(thread.id)) continue;
        if (statuses.has(thread.id)) throw new Error('Repeated native thread-status identity');
        if (isRecord(thread.status) && thread.status.type === 'systemError')
          throw new NativeMaintenanceInspectionError('native_thread_system_error');
        if (!isRecord(thread.status) || (thread.status.type !== 'idle' && thread.status.type !== 'active'))
          throw new NativeMaintenanceInspectionError('native_thread_status_unavailable');
        statuses.set(thread.id, thread.status.type);
      }
      if (statuses.size === before.size || result.nextCursor == null) break;
      if (cursors.has(result.nextCursor)) throw new Error('Repeated native thread-status cursor');
      cursors.add(result.nextCursor); cursor = result.nextCursor;
      if (page === 31) throw new Error('Native thread-status page budget exceeded');
    }
    if (statuses.size === before.size) break;
  }
  for (const threadId of before) {
    if (statuses.has(threadId)) continue;
    if (!unmaterializedThreadIds.has(threadId)) throw new NativeMaintenanceInspectionError('native_thread_status_unavailable');
    const result = await request('thread/read', { threadId, includeTurns: false }, remaining());
    remaining();
    if (!unmaterializedThreadIds.has(threadId) || !isRecord(result) || !isRecord(result.thread)
      || result.thread.id !== threadId || !isRecord(result.thread.status)
      || result.thread.status.type !== 'idle' || !Array.isArray(result.thread.turns) || result.thread.turns.length !== 0) {
      throw new NativeMaintenanceInspectionError('native_thread_status_unavailable');
    }
    statuses.set(threadId, 'idle');
  }
  let activeRuns = 0, terminals = 0;
  for (const threadId of before) {
    if (statuses.get(threadId) === 'active') activeRuns++;
    terminals += (await backgroundTerminals(request, threadId, check, deadline)).length;
    remaining();
  }
  const after = await loaded();
  if (before.size !== after.size || [...before].some(id => !after.has(id))) throw new Error('Native loaded threads changed during inspection');
  remaining();
  return { loadedThreads: before.size, activeRuns, backgroundTerminals: terminals };
}
