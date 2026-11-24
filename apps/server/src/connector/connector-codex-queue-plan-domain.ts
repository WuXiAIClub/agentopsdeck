import { createHash, randomUUID } from 'node:crypto';
import type { ConnectorUserStore } from './connector-user-store.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { createTurnAuthorizer, type ExecutionGrantAuthority } from './execution-grants.js';
import { codexAdmissionProof, type CodexAdmissionProof } from '../codex/dispatch-admission.js';
import { describeBatch, waitingBatch, type CodexBatch } from '../codex/queued-batch.js';
import type { QueuedTurn } from '../commands/turn-queue.js';
import type { CodexImageAttachment } from '../codex/app-server.js';
import { validConnectorCodexDispatchInput } from './connector-codex-dispatch-domain.js';

export type CodexQueuePayload = { text: string; images: CodexImageAttachment[]; actorId?: string; executionGrant?: ExecutionGrantAuthority };
export type CodexQueueEntry = QueuedTurn<CodexQueuePayload>;
export type CodexQueuePlan = { state: 'ready'; sessionKey: string; planId: string; commandId: string;
  proof: CodexAdmissionProof; batch?: CodexBatch; bytes: number; digest: string };
type Ref = { sessionKey: string; planId: string };
export type ConnectorCodexQueuePlanCommands = {
  codexQueuePlan: { input: { sessionKey: string }; output: CodexQueuePlan | { state: 'blocked'; sessionKey: string } | null };
  codexQueuePlanChunk: { input: Ref & { offset: number }; output: Ref & { offset: number; chunk: string } | null };
  codexQueuePlanRelease: { input: Ref; output: boolean };
};
export type ConnectorCodexQueuePlanKind = keyof ConnectorCodexQueuePlanCommands;
export const connectorCodexQueuePlanSteps = Object.freeze({ codexQueuePlan: 241, codexQueuePlanChunk: 242, codexQueuePlanRelease: 243 });
export const isConnectorCodexQueuePlanKind = (kind: string): kind is ConnectorCodexQueuePlanKind => Object.hasOwn(connectorCodexQueuePlanSteps, kind);
export const CODEX_QUEUE_PLAN_CHUNK_BYTES = 65536;
export const CODEX_QUEUE_PLAN_BODY_BYTES = 33 * 1024 * 1024;
const PLAN_TTL_MS = 120_000, PLAN_TOTAL_BYTES = 64 * 1024 * 1024;
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, any> => !!v && typeof v === 'object'
  && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const id = (v: unknown, max = 512): v is string => typeof v === 'string' && !!v.trim() && Buffer.byteLength(JSON.stringify(v)) <= max && !/[\x00-\x1f\x7f]/.test(v);
const key = (v: unknown): v is string => id(v, 4096) && v.startsWith('codex:') && v.length > 6;
const planId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
export function validConnectorCodexQueuePlanInput(kind: ConnectorCodexQueuePlanKind, v: unknown): boolean {
  if (kind === 'codexQueuePlan') return fields(v, ['sessionKey']) && key(v.sessionKey);
  return fields(v, ['sessionKey', 'planId', ...(kind === 'codexQueuePlanChunk' ? ['offset'] : [])]) && key(v.sessionKey) && planId(v.planId)
    && (kind !== 'codexQueuePlanChunk' || Number.isSafeInteger(v.offset) && v.offset >= 0 && v.offset < CODEX_QUEUE_PLAN_BODY_BYTES && v.offset % CODEX_QUEUE_PLAN_CHUNK_BYTES === 0);
}
export function validConnectorCodexQueuePlanOutput(kind: ConnectorCodexQueuePlanKind, v: unknown): boolean {
  if (kind === 'codexQueuePlanRelease') return typeof v === 'boolean';
  if (v === null) return true;
  if (kind === 'codexQueuePlanChunk') return fields(v, ['sessionKey', 'planId', 'offset', 'chunk'])
    && validConnectorCodexQueuePlanInput(kind, { sessionKey: v.sessionKey, planId: v.planId, offset: v.offset })
    && typeof v.chunk === 'string' && v.chunk.length > 0 && v.chunk.length <= 87384 && /^[A-Za-z0-9+/]+={0,2}$/.test(v.chunk)
    && Buffer.from(v.chunk, 'base64').toString('base64') === v.chunk && Buffer.from(v.chunk, 'base64').length <= CODEX_QUEUE_PLAN_CHUNK_BYTES;
  if (fields(v, ['state', 'sessionKey']) && v.state === 'blocked' && key(v.sessionKey)) return true;
  return fields(v, ['state', 'sessionKey', 'planId', 'commandId', 'proof', 'bytes', 'digest'], ['batch'])
    && v.state === 'ready' && key(v.sessionKey) && planId(v.planId) && hash(v.digest) && Number.isSafeInteger(v.bytes)
    && v.bytes > 0 && v.bytes <= CODEX_QUEUE_PLAN_BODY_BYTES && validConnectorCodexDispatchInput('codexDispatchClaim', {
      sessionKey: v.sessionKey, commandId: v.commandId, proof: v.proof, connectionId: 'plan-validation', preparing: false,
      blockedGoalInput: false, ...(v.batch === undefined ? {} : { batch: v.batch }) })
    && (v.proof.count === 1 ? v.batch === undefined : v.batch?.members.length === v.proof.count && v.batch.members[0].id === v.commandId);
}
export function connectorCodexQueuePlanReplyMatches(kind: ConnectorCodexQueuePlanKind,
  input: ConnectorCodexQueuePlanCommands[ConnectorCodexQueuePlanKind]['input'], output: unknown): boolean {
  if (output === null || kind === 'codexQueuePlanRelease') return true;
  const v = output as { sessionKey: string; planId?: string; offset?: number }, p = input as Ref & { offset?: number };
  return v.sessionKey === p.sessionKey && (kind !== 'codexQueuePlanChunk' || v.planId === p.planId && v.offset === p.offset);
}
export function validCodexQueuePayload(v: unknown): v is CodexQueuePayload {
  return fields(v, ['text', 'images'], ['actorId', 'executionGrant']) && typeof v.text === 'string' && Array.isArray(v.images)
    && v.images.length <= 8 && (!!v.text.trim() || v.images.length > 0) && (v.actorId === undefined || id(v.actorId))
    && (v.executionGrant === undefined || fields(v.executionGrant, ['id', 'actorId', 'issuerTokenId'])
      && id(v.executionGrant.id) && id(v.executionGrant.actorId) && id(v.executionGrant.issuerTokenId))
    && v.images.every((image: unknown) => fields(image, ['filePath', 'media']) && typeof image.filePath === 'string' && !!image.filePath
      && !image.filePath.includes('\0') && !!image.media && typeof image.media === 'object' && !Array.isArray(image.media));
}
/** Body must be the worker's original snapshot, not a replacement from a caller. */
export function decodeCodexQueuePlan(plan: CodexQueuePlan, body: Buffer): CodexQueueEntry[] {
  if (body.length !== plan.bytes || createHash('sha256').update(body).digest('hex') !== plan.digest) throw Error('connector_storage_unavailable');
  const entries: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  if (!Array.isArray(entries) || entries.length !== plan.proof.count || entries.some((entry: unknown) =>
    !fields(entry, ['id', 'sessionKey', 'createdAt', 'state', 'payload']) || !id(entry.id) || entry.sessionKey !== plan.sessionKey
    || typeof entry.createdAt !== 'number' || !Number.isFinite(entry.createdAt) || entry.state !== 'queued' || !validCodexQueuePayload(entry.payload))
    || entries[0]?.id !== plan.commandId || new Set(entries.map(e => e.id)).size !== entries.length) throw Error('connector_storage_unavailable');
  if (waitingBatch(entries, () => true).length !== entries.length || (plan.batch ? plan.batch.members.some((member, index) => {
    const e = entries[index]; return member.id !== e.id || member.createdAt !== e.createdAt || member.imageCount !== e.payload.images.length
      || e.payload.text.includes(plan.batch!.separator);
  }) : entries.length !== 1)) throw Error('connector_storage_unavailable');
  return entries;
}
type Binding = { plan: CodexQueuePlan; entries: CodexQueueEntry[]; versions: string[]; body: Buffer; offset: number; expires: number };
/** Private measured buffers belong to this physical worker, never to HTTP or a new owner. */
export function createConnectorCodexQueuePlanCommands(owner: ConnectorUserStore, tokens?: ConnectorTokenStore, now = () => performance.now()) {
  const bindings = new Map<string, Binding>(); let retained = 0;
  const remove = (b: Binding) => { bindings.delete(b.plan.planId); retained -= b.body.length; b.body.fill(0); };
  const dispose = () => { for (const b of bindings.values()) remove(b); };
  const authorize = createTurnAuthorizer(owner.executionGrants, (actor, scope) => tokens?.hasScope(actor, scope) === true);
  const allowed = (entry: CodexQueueEntry) => owner.sdkCommandAdmissionOpen === true && validCodexQueuePayload(entry.payload)
    && authorize(entry.payload.actorId, { runtime: 'codex', sessionKey: entry.sessionKey }, 'messages:send', entry.payload.executionGrant);
  const current = (b: Binding) => owner.codexExecutions.canStart(b.plan.sessionKey, true)
    && owner.turns.headId('codex', b.plan.sessionKey) === b.plan.commandId
    && b.entries.every((entry, i) => owner.turns.version('codex', entry.sessionKey, entry.id) === b.versions[i] && allowed(entry));
  const execute = <K extends ConnectorCodexQueuePlanKind>(kind: K, input: ConnectorCodexQueuePlanCommands[K]['input']): ConnectorCodexQueuePlanCommands[K]['output'] => {
    if (!validConnectorCodexQueuePlanInput(kind, input) || !tokens) throw Error('connector_storage_unavailable');
    for (const b of bindings.values()) if (b.expires <= now()) remove(b);
    let value: unknown;
    if (kind === 'codexQueuePlan') {
      const { sessionKey } = input;
      // A second consumer cannot invalidate another live reader's plan.
      if (bindings.size >= 128 || [...bindings.values()].some(b => b.plan.sessionKey === sessionKey)
        || !owner.codexExecutions.canStart(sessionKey, true) || !owner.sdkCommandAdmissionOpen) value = null;
      else {
        const prefix = owner.turns.dispatchPrefix<CodexQueuePayload>('codex', sessionKey), head = prefix[0];
        if (!head || head.state !== 'queued') value = head?.state === 'blocked' ? { state: 'blocked', sessionKey } : null;
        else if (!allowed(head)) { owner.turns.block('codex', head.id); value = { state: 'blocked', sessionKey }; }
        else {
          const entries = waitingBatch(prefix, allowed), body = Buffer.from(JSON.stringify(entries));
          if (body.length > CODEX_QUEUE_PLAN_BODY_BYTES || retained + body.length > PLAN_TOTAL_BYTES) { body.fill(0); value = null; }
          else {
            const batch = describeBatch(entries), plan: CodexQueuePlan = { state: 'ready', sessionKey, planId: randomUUID(), commandId: head.id,
              proof: codexAdmissionProof(owner.turns, entries), ...(batch ? { batch } : {}), bytes: body.length, digest: createHash('sha256').update(body).digest('hex') };
            const versions = entries.map(entry => owner.turns.version('codex', sessionKey, entry.id)!);
            bindings.set(plan.planId, { plan, entries, versions, body, offset: 0, expires: now() + PLAN_TTL_MS }); retained += body.length;
            value = structuredClone(plan);
          }
        }
      }
    } else {
      const v = input as Ref & { offset?: number }, b = bindings.get(v.planId);
      if (!b || b.plan.sessionKey !== v.sessionKey) value = kind === 'codexQueuePlanRelease' ? false : null;
      else if (kind === 'codexQueuePlanRelease') { remove(b); value = true; }
      else if (v.offset !== b.offset || !current(b)) { remove(b); value = null; }
      else {
        const end = Math.min(b.body.length, b.offset + CODEX_QUEUE_PLAN_CHUNK_BYTES);
        value = { sessionKey: v.sessionKey, planId: v.planId, offset: b.offset, chunk: b.body.subarray(b.offset, end).toString('base64') };
        b.offset = end; if (end === b.body.length) remove(b);
      }
    }
    if (!validConnectorCodexQueuePlanOutput(kind, value)) throw Error('connector_storage_unavailable');
    return value as ConnectorCodexQueuePlanCommands[K]['output'];
  };
  return Object.assign(execute, { dispose });
}
