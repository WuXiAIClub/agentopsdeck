import { sessionRuntimeId, tokenSnapshotRequestId, tokenUsageRange, validateNativeTokenUsage,
  validateNativeTokenUsageExport, validateNativeTokenSnapshot, type NativeTokenUsage,
  type NativeTokenUsageExport, type NativeTokenSnapshot } from '@agentopsdeck/shared';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { StorageAdmissionDeferred } from '../storage/work-admission.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { NativeTokenExportTooLarge } from './native-token-usage.js';
import { NativeTokenSnapshotConflict, NativeTokenSnapshotLimit } from './native-token-snapshots.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionEvidence, type ApplicationTransactionClient } from '../auth/application-transaction-gate.js';
import { applicationUsageCommit } from './application-usage-transaction.js';

export type CodexPublicUsageScope = { runtime: 'codex'; key: string; authorization: string };
type Identity = { runtime: 'codex'; key: string; readerId: string };
type Range = { from: number; to: number; bucketMs: number };
type Failure = { error: 401 | 403 | 404 | 409 | 413 | 503; code?: 'token_export_limit' };
type Result<T> = Failure | Identity & { body: T };
export type ConnectorCodexPublicUsageCommands = {
  codexPublicUsageRange: { input: CodexPublicUsageScope & Range; output: Result<NativeTokenUsage> };
  codexPublicUsageExport: { input: CodexPublicUsageScope & Range; output: Result<NativeTokenUsageExport> };
  codexPublicUsageSnapshotCreate: { input: CodexPublicUsageScope & Range & { requestId: string; application?: ApplicationTransactionEvidence }; output: Result<NativeTokenSnapshot> };
  codexPublicUsageSnapshotRead: { input: CodexPublicUsageScope & { requestId: string }; output: Result<NativeTokenSnapshot> };
  codexPublicUsageDeliver: { input: CodexPublicUsageScope & { readerId: string }; output: Failure | Identity };
};
export type ConnectorCodexPublicUsageKind = keyof ConnectorCodexPublicUsageCommands;
export const connectorCodexPublicUsageSteps = Object.freeze({ codexPublicUsageRange: 301, codexPublicUsageExport: 302,
  codexPublicUsageSnapshotCreate: 303, codexPublicUsageSnapshotRead: 304, codexPublicUsageDeliver: 305 });
export const isConnectorCodexPublicUsageKind = (kind: string): kind is ConnectorCodexPublicUsageKind => Object.hasOwn(connectorCodexPublicUsageSteps, kind);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v
  && typeof v === 'object' && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.length
  && Buffer.byteLength(v) <= max && !/[\x00-\x1f\x7f]/.test(v);
const scope = (v: Record<string, unknown>) => v.runtime === 'codex' && text(v.key, 512)
  && sessionRuntimeId(v.key) === 'codex' && v.key !== 'codex:';
export function validConnectorCodexPublicUsageInput(kind: ConnectorCodexPublicUsageKind, value: unknown): boolean {
  const deliver = kind === 'codexPublicUsageDeliver', read = kind === 'codexPublicUsageSnapshotRead';
  const snapshot = read || kind === 'codexPublicUsageSnapshotCreate';
  if (!fields(value, ['runtime', 'key', 'authorization', ...(deliver ? ['readerId'] : read ? [] : ['from', 'to', 'bucketMs']), ...(snapshot ? ['requestId'] : [])], kind === 'codexPublicUsageSnapshotCreate' ? ['application'] : [])
    || !scope(value) || !text(value.authorization, 4096) || deliver && !text(value.readerId, 512)) return false;
  if (Object.hasOwn(value, 'application') && !validApplicationTransactionEvidence(value.application)) return false;
  try {
    if (snapshot && tokenSnapshotRequestId(value.requestId) !== value.requestId) return false;
    if (!deliver && !read) {
      if (['from', 'to', 'bucketMs'].some(key => typeof value[key] !== 'number')) return false;
      tokenUsageRange(value.from, value.to, value.bucketMs);
    }
    return true;
  } catch { return false; }
}
export function validConnectorCodexPublicUsageOutput(kind: ConnectorCodexPublicUsageKind, value: unknown): boolean {
  if (fields(value, ['error'], ['code'])) return typeof value.error === 'number' && [401, 403, 404, 409, 413, 503].includes(value.error)
    && (!Object.hasOwn(value, 'code') || kind === 'codexPublicUsageExport' && value.error === 413 && value.code === 'token_export_limit');
  if (!fields(value, ['runtime', 'key', 'readerId', ...(kind === 'codexPublicUsageDeliver' ? [] : ['body'])])
    || !scope(value) || !text(value.readerId, 512)) return false;
  if (kind === 'codexPublicUsageDeliver') return true;
  try {
    const usage = kind === 'codexPublicUsageRange' ? validateNativeTokenUsage(value.body)
      : kind === 'codexPublicUsageExport' ? validateNativeTokenUsageExport(value.body).usage : validateNativeTokenSnapshot(value.body).data.usage;
    return usage.runtime === 'codex';
  } catch { return false; }
}
class AccessChanged extends Error { constructor(readonly status: 401 | 403 | 404 | 409) { super('usage_authority_changed'); } }
/** The original Codex ledger, not an SDK journal or a second connection.
 * Deck existence is fenced by the local owner; SQL deletion and current bearer
 * authority are checked in this worker, including inside snapshot admission. */
export async function executeConnectorCodexPublicUsage<K extends ConnectorCodexPublicUsageKind>(kind: K,
  input: ConnectorCodexPublicUsageCommands[K]['input'], owner: ConnectorUserStore,
  tokens?: ConnectorTokenStore, application?: ApplicationTransactionClient): Promise<ConnectorCodexPublicUsageCommands[K]['output']> {
  if (!validConnectorCodexPublicUsageInput(kind, input)) throw Error('connector_storage_unavailable');
  const commit = kind === 'codexPublicUsageSnapshotCreate'
    ? applicationUsageCommit('codex', input as ConnectorCodexPublicUsageCommands['codexPublicUsageSnapshotCreate']['input'], application) : undefined;
  const observe = (): Identity => {
    const actor = tokens?.authenticateAuthorization(input.authorization);
    if (!actor) throw new AccessChanged(401);
    if (actor.tokenId.startsWith('actor_') || actor.scopes.includes('execution:delegate') || !actor.scopes.includes('messages:read')) throw new AccessChanged(403);
    if (owner.commands.sessionDeletion(input.key)) throw new AccessChanged(404);
    if ('readerId' in input && input.readerId !== actor.tokenId) throw new AccessChanged(409);
    return { runtime: 'codex', key: input.key, readerId: actor.tokenId };
  };
  try {
    const identity = observe();
    const check = () => { if (observe().readerId !== identity.readerId) throw new AccessChanged(409); };
    let result: unknown;
    if (kind === 'codexPublicUsageDeliver') result = identity;
    else {
      let body: NativeTokenUsage | NativeTokenUsageExport | NativeTokenSnapshot | undefined;
      if (kind === 'codexPublicUsageSnapshotRead' && 'requestId' in input) body = owner.tokenUsage.readSnapshot('codex', input.key, input.requestId);
      else if ('from' in input) body = kind === 'codexPublicUsageRange' ? owner.tokenUsage.range('codex', input.key, input.from, input.to, input.bucketMs)
        : kind === 'codexPublicUsageExport' ? owner.tokenUsage.export('codex', input.key, input.from, input.to, input.bucketMs)
          : await owner.tokenUsage.snapshotAsync('codex', input.key, (input as ConnectorCodexPublicUsageCommands['codexPublicUsageSnapshotCreate']['input']).requestId,
            input.from, input.to, input.bucketMs, check, commit);
      check();
      result = body ? { ...identity, body } : { error: 404 };
    }
    if (!validConnectorCodexPublicUsageOutput(kind, result)) throw Error('connector_storage_unavailable');
    return result as ConnectorCodexPublicUsageCommands[K]['output'];
  } catch (error) {
    if (error instanceof AccessChanged) return { error: error.status };
    if (error instanceof NativeTokenSnapshotConflict) return { error: 409 };
    if (error instanceof NativeTokenSnapshotLimit || error instanceof NativeTokenExportTooLarge) return { error: 413,
      ...(kind === 'codexPublicUsageExport' ? { code: 'token_export_limit' as const } : {}) };
    if (error instanceof StorageAdmissionDeferred) return { error: 503 };
    throw error;
  }
}
