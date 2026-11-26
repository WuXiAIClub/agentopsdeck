import { isDeepStrictEqual } from 'node:util';
import { sessionRuntimeId, type SessionExecutionSnapshot } from '@agentopsdeck/shared';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { sessionExecutionSnapshot } from '../projection/session-execution.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import type { SdkHistoryIdentity, SdkHistoryScope } from './connector-sdk-history-domain.js';
import type { SdkOwnerCatalogs } from './connector-sdk-local-domain.js';
import type { SdkAgentId } from './sdk-execution-journal.js';
import { sdkSessionView } from './sdk-session-view.js';
import { sdkModelChoices, validSdkModel } from './sdk-models.js';

type Denied = { error: 401 | 403 | 404 | 409 };
type CatalogScope = { runtime: SdkAgentId; authorization: string };
type CatalogIdentity = { runtime: SdkAgentId; readerId: string };
export type ConnectorSdkMetadataCommands = {
  sdkStateRead: { input: SdkHistoryScope & { connected: boolean }; output: (SdkHistoryIdentity & { body: SessionExecutionSnapshot }) | Denied };
  sdkModelsRead: { input: CatalogScope; output: (CatalogIdentity & { body: { models: { id: string; label: string }[] } }) | Denied };
  sdkModelsDeliver: { input: CatalogScope & { readerId: string }; output: CatalogIdentity | Denied };
};
export type ConnectorSdkMetadataKind = keyof ConnectorSdkMetadataCommands;
export const connectorSdkMetadataSteps = Object.freeze({ sdkStateRead: 137, sdkModelsRead: 138, sdkModelsDeliver: 139 } as const);
export const isConnectorSdkMetadataKind = (kind: string): kind is ConnectorSdkMetadataKind => Object.hasOwn(connectorSdkMetadataSteps, kind);
const fields = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const text = (v: unknown, max = 512): v is string => typeof v === 'string' && !!v.length && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const runtime = (v: unknown) => v === 'claude-code' || v === 'ghcp' || v === 'antigravity';
const key = (v: Record<string, unknown>) => text(v.key) && sessionRuntimeId(v.key) === v.runtime && v.key !== `${v.runtime}:`;
export function validConnectorSdkMetadataInput(kind: ConnectorSdkMetadataKind, v: unknown): boolean {
  return fields(v, ['runtime', 'authorization', ...(kind === 'sdkStateRead' ? ['key', 'connected'] : kind === 'sdkModelsDeliver' ? ['readerId'] : [])])
    && runtime(v.runtime) && text(v.authorization, 4096) && !!v.authorization.trim() && Buffer.byteLength(v.authorization) <= 4096
    && (kind !== 'sdkStateRead' || key(v) && typeof v.connected === 'boolean')
    && (kind !== 'sdkModelsDeliver' || text(v.readerId));
}
export function validConnectorSdkMetadataOutput(kind: ConnectorSdkMetadataKind, v: unknown): boolean {
  if (fields(v, ['error'])) return typeof v.error === 'number' && [401, 403, 404, 409].includes(v.error);
  if (!fields(v, ['runtime', 'readerId', ...(kind === 'sdkStateRead' ? ['key', 'nativeSessionId', 'body'] : kind === 'sdkModelsRead' ? ['body'] : [])])
    || !runtime(v.runtime) || !text(v.readerId)) return false;
  if (kind === 'sdkModelsDeliver') return true;
  if (kind === 'sdkModelsRead') return fields(v.body, ['models']) && Array.isArray(v.body.models) && v.body.models.length > 0
    && v.body.models.length <= 100 && v.body.models.every(m => fields(m, ['id', 'label']) && validSdkModel(m.id) && m.label === m.id)
    && new Set(v.body.models.map(m => m.id)).size === v.body.models.length;
  if (!key(v) || !text(v.nativeSessionId) || !v.body || typeof v.body !== 'object' || Array.isArray(v.body)) return false;
  try { return isDeepStrictEqual(v.body, sessionExecutionSnapshot(v.body, v.key as string)) && text((v.body as Record<string, unknown>).sourceCursor); }
  catch { return false; }
}

/** Original owner observation only. No projection, native calls or transcript
 * heuristic can turn an unknown execution into a completed execution. */
export function executeConnectorSdkMetadata<K extends ConnectorSdkMetadataKind>(kind: K,
  input: ConnectorSdkMetadataCommands[K]['input'], owner: ConnectorUserStore, tokens: ConnectorTokenStore | undefined,
  catalogs: SdkOwnerCatalogs): ConnectorSdkMetadataCommands[K]['output'] {
  if (!validConnectorSdkMetadataInput(kind, input)) throw Error('connector_storage_unavailable');
  const actor = tokens?.authenticateAuthorization(input.authorization);
  if (!actor) return { error: 401 };
  const scope = kind === 'sdkStateRead' ? 'messages:read' : 'models:read';
  if (actor.tokenId.startsWith('actor_') || actor.scopes.includes('execution:delegate') || !actor.scopes.includes(scope)) return { error: 403 };
  let result: unknown;
  if ('key' in input) {
    const journal = input.runtime === 'claude-code' ? owner.claudeJournal : input.runtime === 'ghcp' ? owner.copilotJournal : owner.antigravityJournal;
    const snapshot = journal.readSnapshot(input.key);
    if (!snapshot.session || snapshot.deletion || owner.commands.sessionDeletion(input.key)) return { error: 404 };
    const sourceCursor = owner.events.latestEventId();
    result = { runtime: input.runtime, key: input.key, readerId: actor.tokenId, nativeSessionId: snapshot.session.nativeSessionId,
      body: sessionExecutionSnapshot(sdkSessionView(input.runtime, snapshot.session, snapshot.execution ?? undefined, input.connected), input.key, sourceCursor) };
  } else if ('readerId' in input) {
    if (input.readerId !== actor.tokenId) return { error: 409 };
    result = { runtime: input.runtime, readerId: actor.tokenId };
  } else {
    const config = catalogs[input.runtime];
    if (!config) return { error: 404 };
    result = { runtime: input.runtime, readerId: actor.tokenId, body: { models: sdkModelChoices(config.model, config.modelChoices).map(id => ({ id, label: id })) } };
  }
  if (!validConnectorSdkMetadataOutput(kind, result)) throw Error('connector_storage_unavailable');
  return result as ConnectorSdkMetadataCommands[K]['output'];
}
