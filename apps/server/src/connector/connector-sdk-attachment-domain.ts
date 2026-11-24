import { sessionRuntimeId } from '@agentopsdeck/shared';
import type { ConnectorUserStore } from './connector-user-store.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { createTurnAuthorizer } from './execution-grants.js';
import { validSdkDispatchPayload, validSdkDispatchExecution } from './connector-sdk-dispatch-domain.js';
import { validSdkJournalSnapshot } from './connector-sdk-journal-domain.js';
import type { SdkTextInput } from './sdk-dispatch.js';
import type { SdkAgentId, SdkCompactRef } from './sdk-execution-journal.js';
import { SDK_ATTACHMENT_CHUNK_BYTES, type SdkAttachmentManifestItem } from './sdk-attachment-store.js';
import { SDK_ATTACHMENT_MAX_BYTES, SDK_ATTACHMENTS_MAX_BYTES, SDK_ATTACHMENT_MAX_ITEMS } from './sdk-attachment-input.js';

type Scope = { runtime: SdkAgentId; ref: SdkCompactRef };
type Chunk = { admissionId: string; id: string; offset: number; size: number };
export type ConnectorSdkAttachmentCommands = {
  sdkExecutionAttachmentManifest: { input: Scope; output: { ref: SdkCompactRef; items: SdkAttachmentManifestItem[] } };
  sdkExecutionAttachmentChunk: { input: Scope & Chunk; output: { ref: SdkCompactRef; data: string } & Chunk };
};
export type ConnectorSdkAttachmentKind = keyof ConnectorSdkAttachmentCommands;
export const connectorSdkAttachmentSteps = Object.freeze({ sdkExecutionAttachmentManifest: 84, sdkExecutionAttachmentChunk: 85 });
export const isConnectorSdkAttachmentKind = (k: string): k is ConnectorSdkAttachmentKind => Object.hasOwn(connectorSdkAttachmentSteps, k);
const fields = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\u0000-\u001f\u007f]/.test(v);
const ref = (v: unknown): v is SdkCompactRef => fields(v, ['key', 'id', 'epoch', 'nativeSessionId'])
  && id(v.key) && id(v.id) && id(v.epoch) && id(v.nativeSessionId)
  && ['claude-code', 'ghcp'].includes(sessionRuntimeId(v.key)) && !v.key.endsWith(':');
const chunk = (v: Record<string, unknown>) => id(v.admissionId) && id(v.id) && Number.isSafeInteger(v.size)
  && Number(v.size) > 0 && Number(v.size) <= SDK_ATTACHMENT_MAX_BYTES && Number.isSafeInteger(v.offset)
  && Number(v.offset) >= 0 && Number(v.offset) < Number(v.size) && Number(v.offset) % SDK_ATTACHMENT_CHUNK_BYTES === 0;
export function validConnectorSdkAttachmentInput(k: ConnectorSdkAttachmentKind, v: unknown): boolean {
  return fields(v, k === 'sdkExecutionAttachmentManifest' ? ['runtime', 'ref'] : ['runtime', 'ref', 'admissionId', 'id', 'offset', 'size'])
    && ref(v.ref) && v.runtime === sessionRuntimeId(v.ref.key) && (k === 'sdkExecutionAttachmentManifest' || chunk(v));
}
export function validConnectorSdkAttachmentOutput(k: ConnectorSdkAttachmentKind, v: unknown): boolean {
  if (k === 'sdkExecutionAttachmentChunk') {
    if (!fields(v, ['ref', 'admissionId', 'id', 'offset', 'size', 'data']) || !ref(v.ref) || !chunk(v)
      || typeof v.data !== 'string' || v.data.length > Math.ceil(SDK_ATTACHMENT_CHUNK_BYTES / 3) * 4) return false;
    const body = Buffer.from(v.data, 'base64');
    return body.length === Math.min(SDK_ATTACHMENT_CHUNK_BYTES, Number(v.size) - Number(v.offset)) && body.toString('base64') === v.data;
  }
  if (!fields(v, ['ref', 'items']) || !ref(v.ref) || !Array.isArray(v.items) || v.items.length > SDK_ATTACHMENT_MAX_ITEMS) return false;
  let total = 0;
  return new Set(v.items.map(i => i && JSON.stringify([i.admissionId, i.id]))).size === v.items.length && v.items.every(i =>
    fields(i, ['admissionId', 'id', 'name', 'mimeType', 'size', 'sha256']) && id(i.admissionId) && id(i.id)
    && typeof i.name === 'string' && i.name.length > 0 && i.name.length <= 255 && !/[\\/\u0000-\u001f\u007f]/.test(i.name)
    && typeof i.mimeType === 'string' && i.mimeType.length > 0 && i.mimeType.length <= 128
    && Number.isSafeInteger(i.size) && Number(i.size) > 0 && Number(i.size) <= SDK_ATTACHMENT_MAX_BYTES
    && (total += Number(i.size)) <= SDK_ATTACHMENTS_MAX_BYTES && typeof i.sha256 === 'string' && /^[a-f0-9]{64}$/.test(i.sha256));
}
/** Fixed reads against the original owner, never a caller-supplied actor or SQL.
 * Every read and publication rechecks the exact durable intent and authority. */
export function executeConnectorSdkAttachment<K extends ConnectorSdkAttachmentKind>(k: K,
  input: ConnectorSdkAttachmentCommands[K]['input'], owner: ConnectorUserStore, tokens?: ConnectorTokenStore): ConnectorSdkAttachmentCommands[K]['output'] {
  if (!validConnectorSdkAttachmentInput(k, input) || !tokens) throw Error('connector_storage_unavailable');
  const journal = input.runtime === 'claude-code' ? owner.claudeJournal : owner.copilotJournal;
  const authorize = createTurnAuthorizer(owner.executionGrants, (token, scope) => tokens.hasScope(token, scope));
  const check = () => {
    const snapshot = journal.readSnapshot(input.ref.key), e = snapshot.execution;
    if (!validSdkJournalSnapshot(snapshot) || snapshot.deletion || !snapshot.session
      || snapshot.session.nativeSessionId !== input.ref.nativeSessionId) throw Error('connector_storage_unavailable');
    if (!e || !validSdkDispatchExecution(e) || e.kind === 'compact' || e.phase !== 'dispatching' || e.stopRequested || e.id !== input.ref.id
      || e.epoch !== input.ref.epoch || e.nativeSessionId !== input.ref.nativeSessionId) throw Error('connector_storage_unavailable');
    const rows = owner.turns.dispatchPrefix<SdkTextInput>(input.runtime, e.key).slice(0, e.members.length);
    if (rows.length !== e.members.length || rows.some((row, index) => row.id !== e.members[index] || row.state !== 'dispatching'
      || !validSdkDispatchPayload(row.payload) || !authorize(row.payload.actorId,
        { runtime: input.runtime, sessionKey: e.key }, 'messages:send', row.payload.executionGrant))) throw Error('connector_storage_unavailable');
    return { e, counts: rows.map(row => row.payload.attachmentCount ?? 0) };
  };
  const { e, counts } = check();
  let result: unknown;
  if (k === 'sdkExecutionAttachmentManifest') result = { ref: input.ref, items: owner.sdkAttachments.executionManifest(e, counts) };
  else {
    const v = input as ConnectorSdkAttachmentCommands['sdkExecutionAttachmentChunk']['input'];
    const index = e.members.indexOf(v.admissionId);
    if (index < 0 || counts[index] === 0) throw Error('connector_storage_unavailable');
    const body = owner.sdkAttachments.executionChunk(e.key, v.admissionId, v.id, v.offset, v.size);
    result = { ref: v.ref, admissionId: v.admissionId, id: v.id, offset: v.offset, size: v.size, data: body.toString('base64') };
  }
  check();
  if (!validConnectorSdkAttachmentOutput(k, result)) throw Error('connector_storage_unavailable');
  return result as ConnectorSdkAttachmentCommands[K]['output'];
}
