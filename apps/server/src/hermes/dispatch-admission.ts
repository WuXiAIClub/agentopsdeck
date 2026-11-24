import { createHash } from 'node:crypto';
import { MAX_MESSAGE_CHARS } from '@agentopsdeck/shared';
import { describeBatch, waitingBatch, type CodexBatch } from '../codex/queued-batch.js';
import type { TurnQueue } from '../commands/turn-queue.js';
import type { HermesExecution, HermesJournal } from './journal.js';
import type { HermesMessagePayload } from './message-admission.js';

export type HermesDispatchPlan = { key: string; digest: string; text: string; members: string[]; batch?: CodexBatch };
export type HermesDispatchContext = { journal: HermesJournal; turns: TurnQueue;
  authorize: (key: string, payload: HermesMessagePayload) => boolean; available: () => boolean };
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v
  && typeof v === 'object' && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const identity = (v: unknown): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= 512 && !/[\x00-\x1f\x7f]/.test(v);
export const hermesDispatchSeparator = (v: unknown): v is string => typeof v === 'string'
  && /^\n\n\[Queued message boundary [a-f0-9-]{36}\]\n\n$/.test(v);
export function validHermesDispatchPayload(v: unknown): v is HermesMessagePayload {
  return fields(v, ['text', 'images', 'actorId'], ['executionGrant']) && identity(v.actorId)
    && typeof v.text === 'string' && !!v.text.trim() && v.text.length <= MAX_MESSAGE_CHARS
    && Array.isArray(v.images) && v.images.length === 0
    && (!Object.hasOwn(v, 'executionGrant') || fields(v.executionGrant, ['id', 'actorId', 'issuerTokenId'])
      && identity(v.executionGrant.id) && identity(v.executionGrant.actorId) && identity(v.executionGrant.issuerTokenId));
}
export function validHermesDispatchPlan(v: unknown): v is HermesDispatchPlan {
  if (!fields(v, ['key', 'digest', 'text', 'members'], ['batch']) || !identity(v.key) || !v.key.startsWith('hermes:') || v.key.length <= 7
    || typeof v.digest !== 'string' || !/^[a-f0-9]{64}$/.test(v.digest) || typeof v.text !== 'string'
    || !v.text.trim() || v.text.length > MAX_MESSAGE_CHARS || !Array.isArray(v.members)
    || v.members.length < 1 || v.members.length > 16 || !v.members.every(identity) || new Set(v.members).size !== v.members.length) return false;
  if (v.members.length === 1) return !Object.hasOwn(v, 'batch');
  return fields(v.batch, ['separator', 'members']) && hermesDispatchSeparator(v.batch.separator)
    && v.text.split(v.batch.separator).length === v.members.length && Array.isArray(v.batch.members)
    && v.batch.members.length === v.members.length && v.batch.members.every((member, index) => fields(member, ['id', 'createdAt', 'imageCount'])
      && member.id === (v.members as string[])[index] && Number.isSafeInteger(member.createdAt) && Number(member.createdAt) >= 0 && member.imageCount === 0);
}
const available = (c: HermesDispatchContext) => c.journal.checkPermission(c.available, []) === true;
const allowed = (c: HermesDispatchContext, key: string, p: HermesMessagePayload) => validHermesDispatchPayload(p)
  && c.journal.checkPermission(c.authorize, [key, p]) === true;

/** Original FIFO rows and current authority only. A digest is not a lease.
 * Re-select with the same separator inside claim's original savepoint. */
export function planHermesDispatch(c: HermesDispatchContext, key: string, separator?: string, block = false): HermesDispatchPlan | 'blocked' | null {
  if (!available(c) || c.journal.deletion(key) || !c.journal.canStart(key)) return null;
  const session = c.journal.session(key);
  if (!session) return null;
  const prefix = c.turns.dispatchPrefix<HermesMessagePayload>('hermes', key), head = prefix[0];
  if (!head || head.state !== 'queued') return null;
  if (!allowed(c, key, head.payload)) { if (block) c.turns.block('hermes', head.id); return 'blocked'; }
  const entries = waitingBatch(prefix, entry => allowed(c, key, entry.payload));
  const batchFor = (): CodexBatch | undefined => {
    if (entries.length < 2) return;
    if (separator === undefined) return describeBatch(entries);
    if (!hermesDispatchSeparator(separator) || entries.some(entry => entry.payload.text.includes(separator))) throw Error('connector_storage_unavailable');
    return { separator, members: entries.map(entry => ({ id: entry.id, createdAt: entry.createdAt, imageCount: 0 })) };
  };
  let batch = batchFor(), text = entries.map(entry => entry.payload.text).join(batch?.separator ?? '');
  while (text.length > MAX_MESSAGE_CHARS && entries.length > 1) {
    entries.pop(); batch = batchFor(); text = entries.map(entry => entry.payload.text).join(batch?.separator ?? '');
  }
  if (!entries.length) return null;
  const value = { key, text, members: entries.map(entry => entry.id), ...(batch ? { batch } : {}) };
  const digest = createHash('sha256').update(JSON.stringify({ value, entries,
    session: { key: session.key, stored: session.stored, started: session.started } })).digest('hex');
  const result = { ...value, digest };
  if (!validHermesDispatchPlan(result)) throw Error('connector_storage_unavailable');
  return result;
}
export function claimHermesDispatch(c: HermesDispatchContext, request: { key: string; digest: string; id: string; live: string; epoch: string; separator?: string }): HermesExecution | null {
  const plan = planHermesDispatch(c, request.key, request.separator, true);
  if (!plan || plan === 'blocked' || plan.digest !== request.digest) return null;
  const now = Date.now(), execution: HermesExecution = { id: request.id, key: request.key, live: request.live, epoch: request.epoch,
    phase: 'starting', members: plan.members, ...(plan.batch ? { batch: plan.batch } : {}), at: now, updated: now };
  return c.journal.begin(execution, c.turns, () => {
    const fresh = planHermesDispatch(c, request.key, request.separator);
    return !!fresh && fresh !== 'blocked' && fresh.digest === request.digest;
  }) ? execution : null;
}
/** Re-read the exact claimed FIFO, not caller actors or a stale plan. */
export function hermesDispatchNativeReady(c: HermesDispatchContext, expected: HermesExecution): boolean {
  if (!available(c) || c.journal.deletion(expected.key) || !c.journal.session(expected.key)) return false;
  const current = c.journal.current(expected.key);
  if (!current || current.phase !== 'starting' || expected.phase !== 'starting'
    || ['id', 'key', 'live', 'epoch', 'at'].some(k => current[k as keyof HermesExecution] !== expected[k as keyof HermesExecution])
    || JSON.stringify(current.members) !== JSON.stringify(expected.members) || JSON.stringify(current.batch) !== JSON.stringify(expected.batch)) return false;
  const prefix = c.turns.dispatchPrefix<HermesMessagePayload>('hermes', expected.key);
  return current.members.every((member, index) => {
    const entry = prefix[index];
    return !!entry && entry.id === member && entry.state === 'dispatching' && allowed(c, expected.key, entry.payload);
  });
}
