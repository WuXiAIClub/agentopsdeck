import { parseSourceReference, sessionRuntimeId, type ChatMessageMedia } from '@agentopsdeck/shared';
import type { ConnectorScope, ConnectorTokenStore } from '../auth/connector-token.js';
import { claudeChatMessages, claudeMessageAnchor } from '../claude/session-view.js';
import { mediaResourceId } from '../messages/media-resource.js';
import { sourceReferenceMedia } from '../messages/source-preview.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { SDK_ATTACHMENT_CHUNK_BYTES } from './sdk-attachment-store.js';
import { SDK_ATTACHMENT_MAX_BYTES } from './sdk-attachment-input.js';

export type SessionMediaIdentity = { readerId: string; nativeSessionId: string | null };
export type SessionMediaInput = { authorization: string; key: string; messageId: string; resourceId: string;
  approval: boolean; expected?: SessionMediaIdentity };
export type SessionMediaObservation = SessionMediaIdentity & { key: string; messageId: string; resourceId: string;
  durable: boolean; mayApprove: boolean; mayApproveAdmin: boolean; source: ChatMessageMedia | null; attachment: ChatMessageMedia | null };
export const hasSourceApproveAdminScope = (scopes: readonly ConnectorScope[]) =>
  scopes.includes('source:approve:admin') || (scopes.includes('source:approve') && scopes.includes('connector:update'));
export const hasSourceApproveScope = (scopes: readonly ConnectorScope[]) =>
  hasSourceApproveAdminScope(scopes) || scopes.includes('source:approve');
type Failure = { error: 403 | 404 | 409 };
export type ConnectorSessionMediaCommands = {
  sessionMediaObserve: { input: SessionMediaInput; output: Failure | SessionMediaObservation };
  sessionMediaChunk: { input: SessionMediaInput & { expected: SessionMediaIdentity; offset: number; size: number };
    output: Failure | SessionMediaObservation & { offset: number; size: number; data: string } };
};
export type ConnectorSessionMediaKind = keyof ConnectorSessionMediaCommands;
export const connectorSessionMediaSteps = Object.freeze({ sessionMediaObserve: 351, sessionMediaChunk: 352 });
export const isConnectorSessionMediaKind = (kind: string): kind is ConnectorSessionMediaKind => Object.hasOwn(connectorSessionMediaSteps, kind);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v
  && typeof v === 'object' && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const identity = (v: unknown): v is SessionMediaIdentity => fields(v, ['readerId', 'nativeSessionId']) && text(v.readerId, 512)
  && (v.nativeSessionId === null || text(v.nativeSessionId, 512));
const chunk = (v: Record<string, unknown>) => Number.isSafeInteger(v.size) && Number(v.size) > 0 && Number(v.size) <= SDK_ATTACHMENT_MAX_BYTES
  && Number.isSafeInteger(v.offset) && Number(v.offset) >= 0 && Number(v.offset) < Number(v.size) && Number(v.offset) % SDK_ATTACHMENT_CHUNK_BYTES === 0;
export function validSessionMediaResource(v: unknown): v is ChatMessageMedia {
  if (!fields(v, ['type', 'url', 'name'], ['mimeType', 'size', 'sourceReference']) || !['image', 'file'].includes(String(v.type))
    || !text(v.url, 8192) || !text(v.name, 4096) || v.mimeType !== undefined && !text(v.mimeType, 128)
    || v.size !== undefined && (!Number.isSafeInteger(v.size) || Number(v.size) < 0 || Number(v.size) > SDK_ATTACHMENT_MAX_BYTES)) return false;
  if (v.sourceReference === undefined) return true;
  const r = v.sourceReference;
  if (!fields(r, ['href', 'path', 'line'], ['endLine']) || !text(r.href, 8192) || !text(r.path, 8192)) return false;
  const parsed = parseSourceReference(r.href);
  return !!parsed && parsed.path === r.path && parsed.line === r.line && parsed.endLine === r.endLine;
}
export function validConnectorSessionMediaInput(kind: ConnectorSessionMediaKind, v: unknown): boolean {
  return fields(v, ['authorization', 'key', 'messageId', 'resourceId', 'approval', ...(kind === 'sessionMediaChunk' ? ['expected', 'offset', 'size'] : [])],
    kind === 'sessionMediaObserve' ? ['expected'] : []) && typeof v.authorization === 'string' && v.authorization.length <= 4096
    && !/[\r\n\u0000]/.test(v.authorization) && text(v.key, 2048) && text(v.messageId, 4096)
    && typeof v.resourceId === 'string' && /^[a-f0-9]{64}$/.test(v.resourceId) && typeof v.approval === 'boolean'
    && (v.expected === undefined || identity(v.expected)) && (kind !== 'sessionMediaChunk' || chunk(v));
}
export function validConnectorSessionMediaOutput(kind: ConnectorSessionMediaKind, v: unknown): boolean {
  if (fields(v, ['error'])) return [403, 404, 409].includes(Number(v.error)) && typeof v.error === 'number';
  if (!fields(v, ['key', 'messageId', 'resourceId', 'readerId', 'nativeSessionId', 'durable', 'mayApprove', 'mayApproveAdmin', 'source', 'attachment',
    ...(kind === 'sessionMediaChunk' ? ['offset', 'size', 'data'] : [])]) || !text(v.key, 2048) || !text(v.messageId, 4096)
    || typeof v.resourceId !== 'string' || !/^[a-f0-9]{64}$/.test(v.resourceId)
    || !identity({ readerId: v.readerId, nativeSessionId: v.nativeSessionId }) || typeof v.durable !== 'boolean'
    || typeof v.mayApprove !== 'boolean' || typeof v.mayApproveAdmin !== 'boolean' || v.mayApproveAdmin && !v.mayApprove
    || v.source !== null && (!validSessionMediaResource(v.source) || !v.source.sourceReference || mediaResourceId(v.source.url) !== v.resourceId)
    || v.attachment !== null && (!validSessionMediaResource(v.attachment) || !v.attachment.url.startsWith('/api/sdk-attachments/')
      || !v.attachment.mimeType || !v.attachment.size || mediaResourceId(v.attachment.url) !== v.resourceId)) return false;
  if (kind === 'sessionMediaObserve') return true;
  if (!chunk(v) || !v.attachment || (v.attachment as ChatMessageMedia).size !== v.size || typeof v.data !== 'string'
    || v.data.length > Math.ceil(SDK_ATTACHMENT_CHUNK_BYTES / 3) * 4) return false;
  const bytes = Buffer.from(v.data, 'base64');
  return bytes.length === Math.min(SDK_ATTACHMENT_CHUNK_BYTES, Number(v.size) - Number(v.offset)) && bytes.toString('base64') === v.data;
}

/** Fixed public-media reads on the sole original SQL owner. Never execution
 * authority, arbitrary paths/SQL, full BLOBs or tool-detail text over IPC. */
export function executeConnectorSessionMedia<K extends ConnectorSessionMediaKind>(kind: K,
  input: ConnectorSessionMediaCommands[K]['input'], owner: ConnectorUserStore, tokens?: ConnectorTokenStore): ConnectorSessionMediaCommands[K]['output'] {
  if (!validConnectorSessionMediaInput(kind, input)) throw Error('connector_storage_unavailable');
  const actor = tokens?.authenticateAuthorization(input.authorization);
  if (!actor || !actor.scopes.includes('messages:read') || !actor.scopes.includes('media:read')
    || input.approval && !hasSourceApproveScope(actor.scopes)) return { error: 403 };
  const runtime = sessionRuntimeId(input.key), durable = runtime === 'claude-code' || runtime === 'ghcp';
  const journal = runtime === 'claude-code' ? owner.claudeJournal : runtime === 'ghcp' ? owner.copilotJournal : undefined;
  const session = journal?.session(input.key);
  if (owner.commands.sessionDeletion(input.key) || journal && (!session || journal.deletion(input.key))) return { error: 404 };
  const nativeSessionId = session?.nativeSessionId ?? null;
  if (input.expected && (input.expected.readerId !== actor.tokenId || input.expected.nativeSessionId !== nativeSessionId)) return { error: 409 };
  let source: ChatMessageMedia | null = null;
  if (runtime === 'ghcp') {
    const message = owner.copilotTranscript.message(input.key, input.messageId);
    if (message?.id === input.messageId && message.sessionKey === input.key)
      source = sourceReferenceMedia(message).find(m => mediaResourceId(m.url) === input.resourceId) ?? null;
  } else if (runtime === 'claude-code') {
    const anchor = claudeMessageAnchor(input.key, input.messageId), message = anchor && owner.claudeTranscript.message(input.key, anchor);
    const row = message && claudeChatMessages(input.key, [message]).find(m => m.id === input.messageId && m.sessionKey === input.key);
    if (row) source = sourceReferenceMedia(row).find(m => mediaResourceId(m.url) === input.resourceId) ?? null;
  }
  const attachment = durable ? owner.sdkAttachments.media(input.key, input.messageId).find(m => mediaResourceId(m.url) === input.resourceId) ?? null : null;
  const observation: SessionMediaObservation = { key: input.key, messageId: input.messageId, resourceId: input.resourceId,
    readerId: actor.tokenId, nativeSessionId, durable, mayApprove: hasSourceApproveScope(actor.scopes),
    mayApproveAdmin: hasSourceApproveAdminScope(actor.scopes), source, attachment };
  let result: unknown = observation;
  if (kind === 'sessionMediaChunk') {
    const v = input as ConnectorSessionMediaCommands['sessionMediaChunk']['input'];
    if (!attachment || attachment.size !== v.size) return { error: 404 };
    const bytes = owner.sdkAttachments.executionChunk(input.key, input.messageId, attachment.url.slice('/api/sdk-attachments/'.length), v.offset, v.size);
    result = { ...observation, offset: v.offset, size: v.size, data: bytes.toString('base64') };
  }
  const fresh = tokens?.authenticateAuthorization(input.authorization);
  if (!fresh || fresh.tokenId !== actor.tokenId || !fresh.scopes.includes('messages:read') || !fresh.scopes.includes('media:read')
    || input.approval && !hasSourceApproveScope(fresh.scopes)) return { error: 403 };
  if (!validConnectorSessionMediaOutput(kind, result)) throw Error('connector_storage_unavailable');
  return result as ConnectorSessionMediaCommands[K]['output'];
}
