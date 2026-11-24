import { sessionRuntimeId, tokenSnapshotRequestId, tokenUsageRange, validateNativeTokenUsage,
  validateNativeTokenUsageExport, validateNativeTokenSnapshot, type NativeTokenUsage,
  type NativeTokenUsageExport, type NativeTokenSnapshot } from '@agentopsdeck/shared';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { StorageAdmissionDeferred } from '../storage/work-admission.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import type { SdkHistoryScope, SdkHistoryIdentity } from './connector-sdk-history-domain.js';
import { NativeTokenExportTooLarge } from './native-token-usage.js';
import { NativeTokenSnapshotConflict, NativeTokenSnapshotLimit } from './native-token-snapshots.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionEvidence, type ApplicationTransactionClient } from '../auth/application-transaction-gate.js';
import { applicationUsageCommit } from './application-usage-transaction.js';

type Range = { from: number; to: number; bucketMs: number };
type Failure = { error: 401 | 403 | 404 | 409 | 413 | 503; code?: 'token_export_limit' };
type Result<T> = Failure | SdkHistoryIdentity & { body: T };
export type ConnectorSdkUsageCommands = {
  sdkUsageRange: { input: SdkHistoryScope & Range; output: Result<NativeTokenUsage> };
  sdkUsageExport: { input: SdkHistoryScope & Range; output: Result<NativeTokenUsageExport> };
  sdkUsageSnapshotCreate: { input: SdkHistoryScope & Range & { requestId: string; application?: ApplicationTransactionEvidence }; output: Result<NativeTokenSnapshot> };
  sdkUsageSnapshotRead: { input: SdkHistoryScope & { requestId: string }; output: Result<NativeTokenSnapshot> };
};
export type ConnectorSdkUsageKind = keyof ConnectorSdkUsageCommands;
export const connectorSdkUsageSteps = Object.freeze({ sdkUsageRange: 129, sdkUsageExport: 130, sdkUsageSnapshotCreate: 131, sdkUsageSnapshotRead: 132 });
export const isConnectorSdkUsageKind = (kind: string): kind is ConnectorSdkUsageKind => Object.hasOwn(connectorSdkUsageSteps, kind);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v
  && typeof v === 'object' && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.length && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const scope = (v: Record<string, unknown>) => (v.runtime === 'claude-code' || v.runtime === 'ghcp')
  && text(v.key, 512) && sessionRuntimeId(v.key) === v.runtime && v.key !== `${v.runtime}:`;
export function validConnectorSdkUsageInput(kind: ConnectorSdkUsageKind, value: unknown): boolean {
  const snapshot = kind === 'sdkUsageSnapshotRead' || kind === 'sdkUsageSnapshotCreate';
  if (!fields(value, ['runtime', 'key', 'authorization', ...(kind === 'sdkUsageSnapshotRead' ? [] : ['from', 'to', 'bucketMs']), ...(snapshot ? ['requestId'] : [])], kind === 'sdkUsageSnapshotCreate' ? ['application'] : [])
    || !scope(value) || !text(value.authorization, 4096) || Buffer.byteLength(value.authorization) > 4096) return false;
  if (Object.hasOwn(value, 'application') && !validApplicationTransactionEvidence(value.application)) return false;
  try {
    if (snapshot && tokenSnapshotRequestId(value.requestId) !== value.requestId) return false;
    if (kind !== 'sdkUsageSnapshotRead') {
      if (['from', 'to', 'bucketMs'].some(key => typeof value[key] !== 'number')) return false;
      tokenUsageRange(value.from, value.to, value.bucketMs);
    }
    return true;
  } catch { return false; }
}
export function validConnectorSdkUsageOutput(kind: ConnectorSdkUsageKind, value: unknown): boolean {
  if (fields(value, ['error'], ['code'])) return [401, 403, 404, 409, 413, 503].includes(Number(value.error)) && typeof value.error === 'number'
    && (!Object.hasOwn(value, 'code') || kind === 'sdkUsageExport' && value.error === 413 && value.code === 'token_export_limit');
  if (!fields(value, ['runtime', 'key', 'readerId', 'nativeSessionId', 'body']) || !scope(value)
    || !text(value.readerId, 512) || !text(value.nativeSessionId, 512)) return false;
  try {
    const usage = kind === 'sdkUsageRange' ? validateNativeTokenUsage(value.body)
      : kind === 'sdkUsageExport' ? validateNativeTokenUsageExport(value.body).usage : validateNativeTokenSnapshot(value.body).data.usage;
    return usage.runtime === value.runtime;
  } catch { return false; }
}
class AccessChanged extends Error { constructor(readonly status: 401 | 403 | 404 | 409) { super('usage_authority_changed'); } }
/** One existing connection, including the original immutable snapshot receipt.
 * The capacity await is outside its SQL transaction; the guard authenticates
 * the original bearer again immediately before committing and after awaiting. */
export async function executeConnectorSdkUsage<K extends ConnectorSdkUsageKind>(kind: K,
  input: ConnectorSdkUsageCommands[K]['input'], owner: ConnectorUserStore, tokens?: ConnectorTokenStore,
  application?: ApplicationTransactionClient): Promise<ConnectorSdkUsageCommands[K]['output']> {
  if (!validConnectorSdkUsageInput(kind, input)) throw Error('connector_storage_unavailable');
  const commit = kind === 'sdkUsageSnapshotCreate'
    ? applicationUsageCommit(input.runtime, input as ConnectorSdkUsageCommands['sdkUsageSnapshotCreate']['input'], application) : undefined;
  const observe = (): SdkHistoryIdentity => {
    const actor = tokens?.authenticateAuthorization(input.authorization);
    if (!actor) throw new AccessChanged(401);
    if (actor.tokenId.startsWith('actor_') || actor.scopes.includes('execution:delegate') || !actor.scopes.includes('messages:read')) throw new AccessChanged(403);
    const journal = input.runtime === 'claude-code' ? owner.claudeJournal : owner.copilotJournal;
    const session = journal.session(input.key);
    if (!session || journal.deletion(input.key) || owner.commands.sessionDeletion(input.key)) throw new AccessChanged(404);
    return { runtime: input.runtime, key: input.key, readerId: actor.tokenId, nativeSessionId: session.nativeSessionId };
  };
  try {
    const identity = observe();
    const check = () => {
      const current = observe();
      if (current.readerId !== identity.readerId || current.nativeSessionId !== identity.nativeSessionId) throw new AccessChanged(409);
    };
    let body: NativeTokenUsage | NativeTokenUsageExport | NativeTokenSnapshot | undefined;
    if (kind === 'sdkUsageSnapshotRead' && 'requestId' in input) body = owner.tokenUsage.readSnapshot(input.runtime, input.key, input.requestId);
    else if ('from' in input) {
      body = kind === 'sdkUsageRange' ? owner.tokenUsage.range(input.runtime, input.key, input.from, input.to, input.bucketMs)
        : kind === 'sdkUsageExport' ? owner.tokenUsage.export(input.runtime, input.key, input.from, input.to, input.bucketMs)
          : await owner.tokenUsage.snapshotAsync(input.runtime, input.key, (input as ConnectorSdkUsageCommands['sdkUsageSnapshotCreate']['input']).requestId,
            input.from, input.to, input.bucketMs, check, commit);
    }
    check();
    if (!body) return { error: 404 };
    const result = { ...identity, body };
    if (!validConnectorSdkUsageOutput(kind, result)) throw Error('connector_storage_unavailable');
    return result as ConnectorSdkUsageCommands[K]['output'];
  } catch (error) {
    if (error instanceof AccessChanged) return { error: error.status };
    if (error instanceof NativeTokenSnapshotConflict) return { error: 409 };
    if (error instanceof NativeTokenSnapshotLimit || error instanceof NativeTokenExportTooLarge) return { error: 413,
      ...(kind === 'sdkUsageExport' ? { code: 'token_export_limit' as const } : {}) };
    if (error instanceof StorageAdmissionDeferred) return { error: 503 };
    throw error;
  }
}
