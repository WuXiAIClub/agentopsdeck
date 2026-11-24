import { createReadStream } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Readable } from 'node:stream';
import { BOARD_MAX_BODY_BYTES, BOARD_STATUSES, validBoardId, validBoardUuid } from '@agentopsdeck/shared';
import { validBoardAgentWrite } from '../hub/workspace-board-capabilities.js';
import { validBoardAgentRead, type BoardAgentRead } from '../hub/workspace-board-read.js';

/** A one-shot tool for an operator's private launcher. Credentials are inherited
 * on fd 3, never argv/stdin/environment, and cannot authenticate human Hub APIs.
 * The Agent supplies only read/update and the public mutation on stdin. */
export type BoardToolCredential = { endpoint: string; token: string; expiresAt: number };
type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
export function validBoardToolCredential(value: unknown, now = Date.now()): value is BoardToolCredential {
  if (!object(value) || Object.keys(value).length !== 3 || typeof value.endpoint !== 'string' || value.endpoint.length > 2048
    || typeof value.token !== 'string' || !/^aod_board_[A-Za-z0-9_-]{43}$/.test(value.token)
    || !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= now || (value.expiresAt as number) > now + 86400000) return false;
  try {
    const url = new URL(value.endpoint);
    return !url.username && !url.password && !url.search && !url.hash && url.pathname === '/api/workspace-agent/v1/board'
      && url.href === value.endpoint && (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname));
  } catch { return false; }
}
function validSnapshot(value: unknown, query: BoardAgentRead) {
  const paged = Object.keys(query).length > 0;
  if (!(object(value) && Object.keys(value).every(k => ['resourceId', 'revision', 'tasks', ...(paged ? ['page', 'unchanged'] : [])].includes(k))
    && validBoardId(value.resourceId) && Number.isSafeInteger(value.revision) && (value.revision as number) >= 1
    && Array.isArray(value.tasks) && value.tasks.length <= 200
    && value.tasks.every(task => object(task) && Object.keys(task).every(k => ['id', 'title', 'status', 'detail'].includes(k))
      && validBoardUuid(task.id) && typeof task.title === 'string' && task.title.length <= 240
      && (task.status === undefined || BOARD_STATUSES.includes(task.status as typeof BOARD_STATUSES[number]))
      && (task.detail === undefined || typeof task.detail === 'string' && task.detail.length <= 4000)))) return false;
  const tasks = value.tasks as Record<string, unknown>[];
  if (new Set(tasks.map(t => t.id)).size !== tasks.length) return false;
  if (!paged) return true;
  if (query.revision !== undefined && value.revision !== query.revision) return false;
  if ('unchanged' in value) return value.unchanged === true && value.revision === query.ifRevision && !tasks.length && !('page' in value);
  const page = value.page, offset = query.offset ?? 0, limit = query.limit ?? 20;
  if (!object(page) || Object.keys(page).length !== 4 || page.offset !== offset || page.limit !== limit
    || !Number.isSafeInteger(page.total) || (page.total as number) < 0 || (page.total as number) > 200
    || tasks.length !== Math.min(limit, Math.max(0, (page.total as number) - offset))
    || page.nextOffset !== (offset + tasks.length < (page.total as number) ? offset + tasks.length : null)) return false;
  return tasks.every(t => (query.includeDetail || !('detail' in t)) && (!query.status || t.status === query.status)
    && (!query.taskIds || query.taskIds.includes(t.id as string)));
}
export async function executeBoardTool(command: string, input: unknown, credential: unknown, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<Json> {
  if (!validBoardToolCredential(credential)) return { error: 'Private task grant unavailable or expired' };
  const query = input === undefined ? {} : input;
  if (!['read', 'update'].includes(command) || command === 'update' && !validBoardAgentWrite(input)
    || command === 'read' && !validBoardAgentRead(query)) return { error: 'Invalid tool input' };
  const write = command === 'update', mutationId = write ? (input as { mutationId: string }).mutationId : undefined;
  const uncertain = () => ({ error: write ? 'Outcome unknown. Inspect the board; if retrying, keep the identical mutation and revision. Never create a replacement mutation automatically.' : 'Task board unavailable', ...(write ? { mutationId, uncertain: true } : {}) });
  const timeout = AbortSignal.timeout(Math.min(10000, Math.max(1, credential.expiresAt - Date.now())));
  const deadline = signal ? AbortSignal.any([timeout, signal]) : timeout;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => { void reader?.cancel().catch(() => {}); };
  deadline.addEventListener('abort', cancel, { once: true });
  try {
    deadline.throwIfAborted();
    const body = write ? JSON.stringify(input) : undefined;
    if (body && Buffer.byteLength(body) > BOARD_MAX_BODY_BYTES) return { error: 'Tool input too large' };
    const endpoint = new URL(credential.endpoint);
    if (!write && Object.keys(query as BoardAgentRead).length) endpoint.searchParams.set('read', JSON.stringify(query));
    const response = await fetcher(endpoint.href, { method: write ? 'POST' : 'GET', redirect: 'error', credentials: 'omit', signal: deadline,
      headers: { authorization: `Bearer ${credential.token}`, accept: 'application/json', ...(write ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body } : {}) });
    reader = response.body?.getReader();
    if (!response.ok) {
      // Never reflect an upstream error body, URL or credential into tool output.
      if ([400, 401, 403, 409, 413, 429].includes(response.status)) return { error: response.status === 409
        ? write ? 'Revision conflict or mutation reuse. Read the board and reconcile explicitly.' : 'Board revision changed. Explicitly restart the read; do not merge pages from different revisions.'
        : 'Task request rejected', status: response.status, ...(write ? { mutationId } : {}) };
      return uncertain();
    }
    if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) return uncertain();
    const chunks: Uint8Array[] = []; let bytes = 0;
    if (reader) for (;;) {
      deadline.throwIfAborted(); const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength; if (bytes > BOARD_MAX_BODY_BYTES) return uncertain(); chunks.push(next.value);
    }
    deadline.throwIfAborted();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
    if (text.includes(credential.token)) return uncertain();
    const result: unknown = JSON.parse(text);
    if (!write) return validSnapshot(result, query as BoardAgentRead) ? { board: result } : uncertain();
    return object(result) && Object.keys(result).length === 3 && result.status === 'saved' && result.mutationId === mutationId
      && Number.isSafeInteger(result.revision) && (result.revision as number) >= 1 ? result : uncertain();
  } catch { return uncertain(); }
  finally { deadline.removeEventListener('abort', cancel); cancel(); reader?.releaseLock(); }
}
async function boundedInput(stream: Readable, maxBytes: number, emptyRead = false) {
  const timer = setTimeout(() => stream.destroy(Error('Input deadline')), 3000);
  const chunks: Buffer[] = []; let bytes = 0;
  try {
    for await (const chunk of stream) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.length; if (bytes > maxBytes) throw Error('Input too large'); chunks.push(data);
    }
    const text = Buffer.concat(chunks, bytes).toString('utf8');
    return emptyRead && !text.trim() ? {} : JSON.parse(text) as unknown;
  } finally { clearTimeout(timer); stream.destroy(); }
}
export async function boardToolMain() {
  try {
    if (process.argv.length !== 3 || !['read', 'update'].includes(process.argv[2]!)) throw Error('Invalid command');
    const credential = await boundedInput(createReadStream('', { fd: 3, autoClose: true }), 4096);
    const command = process.argv[2]!;
    const input = await boundedInput(process.stdin, command === 'update' ? BOARD_MAX_BODY_BYTES : 4096, command === 'read');
    const result = await executeBoardTool(command, input, credential);
    process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = 'error' in result ? 1 : 0;
  } catch { process.stdout.write('{"error":"Private task tool unavailable or invalid input"}\n'); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await boardToolMain();
