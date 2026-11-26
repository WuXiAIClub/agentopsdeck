import { MAX_MESSAGE_CHARS, sessionRuntimeId, type ChatMessage } from '@agentopsdeck/shared';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { claudeHistoryMessage, claudeHistoryPage } from '../claude/history.js';
import { antigravityHistoryMessage, antigravityHistoryPage, copilotHistoryMessage, copilotHistoryPage } from '../copilot/history.js';
import { stableGatewayRowsRevision } from '../refresh/signature.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import type { SdkAgentId } from './sdk-execution-journal.js';

export type SdkHistoryScope = { runtime: SdkAgentId; key: string; authorization: string };
export type SdkHistoryIdentity = { runtime: SdkAgentId; key: string; readerId: string; nativeSessionId: string };
export type SdkHistoryPage = { messages: ChatMessage[]; totalCount: number; hiddenCount: number; updatedAt: number;
  revision: string; sourceCursor: string; limits: { maxMessageChars: number } };
export type SdkHistoryMessage = { message: ChatMessage; updatedAt: number; sourceCursor: string };
type Failure = { error: 401 | 403 | 404 | 409 };
export type ConnectorSdkHistoryCommands = {
  sdkHistoryPage: { input: SdkHistoryScope & { limit: number; before?: string }; output: Failure | SdkHistoryIdentity & { body: SdkHistoryPage } };
  sdkHistoryMessage: { input: SdkHistoryScope & { messageId: string }; output: Failure | SdkHistoryIdentity & { messageId: string; body: SdkHistoryMessage } };
  sdkHistoryDeliver: { input: SdkHistoryScope & { readerId: string; nativeSessionId: string }; output: Failure | SdkHistoryIdentity };
};
export type ConnectorSdkHistoryKind = keyof ConnectorSdkHistoryCommands;
export const connectorSdkHistorySteps = Object.freeze({ sdkHistoryPage: 126, sdkHistoryMessage: 127, sdkHistoryDeliver: 128 });
export const isConnectorSdkHistoryKind = (k: string): k is ConnectorSdkHistoryKind => Object.hasOwn(connectorSdkHistorySteps, k);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v
  && typeof v === 'object' && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.length && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const count = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const scope = (v: Record<string, unknown>) => (v.runtime === 'claude-code' || v.runtime === 'ghcp' || v.runtime === 'antigravity')
  && text(v.key, 512) && sessionRuntimeId(v.key) === v.runtime && v.key !== `${v.runtime}:`;
export function validConnectorSdkHistoryInput(k: ConnectorSdkHistoryKind, v: unknown): boolean {
  const extra = k === 'sdkHistoryPage' ? ['limit'] : k === 'sdkHistoryMessage' ? ['messageId'] : ['readerId', 'nativeSessionId'];
  return fields(v, ['runtime', 'key', 'authorization', ...extra], k === 'sdkHistoryPage' ? ['before'] : []) && scope(v)
    && typeof v.authorization === 'string' && !!v.authorization.trim() && Buffer.byteLength(v.authorization) <= 4096
    && !/[\r\n\u0000]/.test(v.authorization)
    && (k === 'sdkHistoryPage' ? count(v.limit) && Number(v.limit) >= 1 && Number(v.limit) <= 200
      && (!Object.hasOwn(v, 'before') || text(v.before, 4096)) : k === 'sdkHistoryMessage' ? text(v.messageId, 4096)
      : text(v.readerId, 512) && text(v.nativeSessionId, 512));
}
export function validConnectorSdkHistoryOutput(k: ConnectorSdkHistoryKind, v: unknown): boolean {
  if (fields(v, ['error'])) return typeof v.error === 'number' && [401, 403, 404, 409].includes(v.error);
  if (!fields(v, ['runtime', 'key', 'readerId', 'nativeSessionId', ...(k === 'sdkHistoryDeliver' ? [] : ['body']), ...(k === 'sdkHistoryMessage' ? ['messageId'] : [])])
    || !scope(v) || !text(v.readerId, 512) || !text(v.nativeSessionId, 512)) return false;
  if (k === 'sdkHistoryDeliver') return true;
  const message = (m: unknown) => fields(m, ['id', 'sessionKey', 'role', 'text', 'createdAt'],
    ['sessionRef', 'turnId', 'parentToolUseId', 'contentTruncated', 'phase', 'toolPreview', 'toolDetailAvailable', 'toolLineCount',
      'toolCallId', 'toolName', 'toolPhase', 'sourceFiles', 'media', 'status', 'queueVersion', 'queueDisposition', 'queueObservation',
      'localAdmission', 'updatedAt', 'failureReason', 'codexSubagent', 'inputTokens', 'outputTokens', 'totalTokens']) && text(m.id, 4096) && m.sessionKey === v.key
    && ['user', 'assistant', 'system', 'tool', 'unknown'].includes(String(m.role)) && typeof m.text === 'string' && count(m.createdAt);
  const body = v.body;
  if (!fields(body, k === 'sdkHistoryPage' ? ['messages', 'totalCount', 'hiddenCount', 'updatedAt', 'revision', 'sourceCursor', 'limits']
    : ['message', 'updatedAt', 'sourceCursor']) || !count(body.updatedAt) || !text(body.sourceCursor, 512)) return false;
  return k === 'sdkHistoryMessage' ? text(v.messageId, 4096) && message(body.message) : Array.isArray(body.messages) && body.messages.length <= 200
    && body.messages.every(message) && count(body.totalCount) && count(body.hiddenCount) && Number(body.hiddenCount) <= Number(body.totalCount)
    // stableGatewayRowsRevision uses an unpadded unsigned 64-bit base-36 hash,
    // not hexadecimal. Preserve the existing conditional-history wire format.
    && text(body.revision, 15) && /^r:[0-9a-z]{1,13}$/.test(body.revision)
    && fields(body.limits, ['maxMessageChars']) && body.limits.maxMessageChars === MAX_MESSAGE_CHARS;
}

/** One synchronous observation on the original connection. HTTP receives no
 * internal lifecycle authority; delivery must revalidate the original reader. */
export function executeConnectorSdkHistory<K extends ConnectorSdkHistoryKind>(kind: K,
  input: ConnectorSdkHistoryCommands[K]['input'], owner: ConnectorUserStore, tokens?: ConnectorTokenStore): ConnectorSdkHistoryCommands[K]['output'] {
  if (!validConnectorSdkHistoryInput(kind, input)) throw Error('connector_storage_unavailable');
  const actor = tokens?.authenticateAuthorization(input.authorization);
  if (!actor) return { error: 401 };
  if (actor.tokenId.startsWith('actor_') || actor.scopes.includes('execution:delegate') || !actor.scopes.includes('messages:read')) return { error: 403 };
  const journal = input.runtime === 'claude-code' ? owner.claudeJournal : input.runtime === 'ghcp' ? owner.copilotJournal : owner.antigravityJournal;
  const session = journal.session(input.key);
  if (!session || journal.deletion(input.key) || owner.commands.sessionDeletion(input.key)) return { error: 404 };
  const identity: SdkHistoryIdentity = { runtime: input.runtime, key: input.key, readerId: actor.tokenId, nativeSessionId: session.nativeSessionId };
  if ('readerId' in input && (input.readerId !== identity.readerId || input.nativeSessionId !== identity.nativeSessionId)) return { error: 409 };
  let result: unknown = identity;
  if (kind !== 'sdkHistoryDeliver') {
    const sourceCursor = owner.events.latestEventId();
    if ('limit' in input) {
      const page = (input.runtime === 'claude-code' ? claudeHistoryPage
        : input.runtime === 'ghcp' ? copilotHistoryPage : antigravityHistoryPage)(owner, input.key, input.limit, input.before);
      if (!page) return { error: 409 };
      result = { ...identity, body: { ...page, updatedAt: Date.now(), revision: stableGatewayRowsRevision(page.messages),
        sourceCursor, limits: { maxMessageChars: MAX_MESSAGE_CHARS } } };
    } else if ('messageId' in input) {
      const message = (input.runtime === 'claude-code' ? claudeHistoryMessage
        : input.runtime === 'ghcp' ? copilotHistoryMessage : antigravityHistoryMessage)(owner, input.key, input.messageId);
      if (!message) return { error: 404 };
      result = { ...identity, messageId: input.messageId, body: { message, updatedAt: Date.now(), sourceCursor } };
    }
  }
  const fresh = tokens?.authenticateAuthorization(input.authorization);
  if (!fresh || fresh.tokenId !== actor.tokenId || !fresh.scopes.includes('messages:read') || fresh.scopes.includes('execution:delegate')) return { error: 403 };
  if (!validConnectorSdkHistoryOutput(kind, result)) throw Error('connector_storage_unavailable');
  return result as ConnectorSdkHistoryCommands[K]['output'];
}
