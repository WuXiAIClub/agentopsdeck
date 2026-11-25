import { sessionRuntimeId, validateSessionFilePage, validateSessionFileRebuild,
  type SessionFilePage, type SessionFileRebuild } from '@agentopsdeck/shared';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { SessionFileRebuilds, FileRebuildError } from '../messages/session-file-rebuild.js';
import { FileIndexCursorError } from '../messages/session-file-index.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import type { SdkHistoryScope, SdkHistoryIdentity } from './connector-sdk-history-domain.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionEvidence } from '../auth/application-transaction-gate.js';

type Failure = { error: 401 | 403 | 404 | 409 | 429 };
type Result<T> = Failure | SdkHistoryIdentity & { body: T };
export type ConnectorSdkFilesCommands = {
  sdkFilesPage: { input: SdkHistoryScope & { cursor?: string }; output: Result<SessionFilePage> };
  sdkFilesStart: { input: SdkHistoryScope & { application?: ApplicationTransactionEvidence }; output: Result<SessionFileRebuild> };
  sdkFilesStep: { input: SdkHistoryScope & { jobId: string; step: number; application?: ApplicationTransactionEvidence }; output: Result<SessionFileRebuild> };
  sdkFilesCancel: { input: SdkHistoryScope & { jobId: string; application?: ApplicationTransactionEvidence }; output: Result<SessionFileRebuild> };
};
export type ConnectorSdkFilesKind = keyof ConnectorSdkFilesCommands;
export const connectorSdkFilesSteps = Object.freeze({ sdkFilesPage: 133, sdkFilesStart: 134, sdkFilesStep: 135, sdkFilesCancel: 136 });
export const isConnectorSdkFilesKind = (kind: string): kind is ConnectorSdkFilesKind => Object.hasOwn(connectorSdkFilesSteps, kind);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v
  && typeof v === 'object' && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.length && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const scope = (v: Record<string, unknown>) => (v.runtime === 'claude-code' || v.runtime === 'ghcp' || v.runtime === 'antigravity')
  && text(v.key, 512) && sessionRuntimeId(v.key) === v.runtime && v.key !== `${v.runtime}:`;
export function validConnectorSdkFilesInput(kind: ConnectorSdkFilesKind, value: unknown): boolean {
  return fields(value, ['runtime', 'key', 'authorization', ...(kind === 'sdkFilesStep' || kind === 'sdkFilesCancel' ? ['jobId'] : []),
    ...(kind === 'sdkFilesStep' ? ['step'] : [])], kind === 'sdkFilesPage' ? ['cursor'] : ['application'])
    && (!Object.hasOwn(value, 'application') || validApplicationTransactionEvidence(value.application))
    && scope(value) && text(value.authorization, 4096) && Buffer.byteLength(value.authorization) <= 4096
    && (!Object.hasOwn(value, 'cursor') || text(value.cursor, 1024))
    && (!Object.hasOwn(value, 'jobId') || typeof value.jobId === 'string' && /^[a-f0-9-]{36}$/.test(value.jobId))
    && (kind !== 'sdkFilesStep' || Number.isSafeInteger(value.step) && Number(value.step) >= 0 && Number(value.step) <= 10_000);
}
export function validConnectorSdkFilesOutput(kind: ConnectorSdkFilesKind, value: unknown): boolean {
  if (fields(value, ['error'])) return typeof value.error === 'number' && [401, 403, 404, 409, 429].includes(value.error);
  if (!fields(value, ['runtime', 'key', 'readerId', 'nativeSessionId', 'body']) || !scope(value)
    || !text(value.readerId, 512) || !text(value.nativeSessionId, 512)) return false;
  try {
    if (kind === 'sdkFilesPage') validateSessionFilePage(value.body as SessionFilePage);
    else validateSessionFileRebuild(value.body as SessionFileRebuild);
    return true;
  } catch { return false; }
}

/** One original request-driven state machine per command owner. No timers or
 * native effects; all original authority checks, scan and commit are synchronous.
 * Losing the worker loses only these derived jobs, never the persisted index. */
export function createConnectorSdkFiles(owner: ConnectorUserStore, tokens?: ConnectorTokenStore) {
  const binding = (key: string) => {
    const runtime = sessionRuntimeId(key);
    const journal = runtime === 'ghcp' ? owner.copilotJournal : runtime === 'antigravity' ? owner.antigravityJournal : owner.claudeJournal;
    return journal.deletion(key) || owner.commands.sessionDeletion(key) ? undefined : journal.session(key)?.nativeSessionId;
  };
  const rebuilds = new SessionFileRebuilds(owner.fileIndex, binding, (key, before) => {
    const runtime = sessionRuntimeId(key);
    return runtime === 'ghcp' ? owner.copilotTranscript.fileEvidencePage(key, before)
      : runtime === 'antigravity' ? owner.antigravityTranscript.fileEvidencePage(key, before)
      : owner.claudeTranscript.fileEvidencePage(key, before);
  });
  return <K extends ConnectorSdkFilesKind>(kind: K, input: ConnectorSdkFilesCommands[K]['input']): ConnectorSdkFilesCommands[K]['output'] => {
    if (!validConnectorSdkFilesInput(kind, input)) throw Error('connector_storage_unavailable');
    const actor = tokens?.authenticateAuthorization(input.authorization);
    if (!actor) return { error: 401 };
    if (actor.tokenId.startsWith('actor_') || actor.scopes.includes('execution:delegate') || !actor.scopes.includes('messages:read')) return { error: 403 };
    const nativeSessionId = binding(input.key);
    if (!nativeSessionId) return { error: 404 };
    const identity = { runtime: input.runtime, key: input.key, readerId: actor.tokenId, nativeSessionId };
    // Incarnation is part of the actor binding even for cancel: a new session
    // cannot observe or mutate an older incarnation's retained progress.
    const jobActor = JSON.stringify([actor.tokenId, nativeSessionId]);
    try {
      const body = kind === 'sdkFilesPage'
        ? validateSessionFilePage({ ...owner.fileIndex.page(input.key, (input as ConnectorSdkFilesCommands['sdkFilesPage']['input']).cursor, nativeSessionId), rebuildAvailable: true })
        : validateSessionFileRebuild(kind === 'sdkFilesStart' ? rebuilds.start(input.key, jobActor)
          : kind === 'sdkFilesCancel' ? rebuilds.cancel(input.key, jobActor, (input as ConnectorSdkFilesCommands['sdkFilesCancel']['input']).jobId)
            : rebuilds.step(input.key, jobActor, (input as ConnectorSdkFilesCommands['sdkFilesStep']['input']).jobId, (input as ConnectorSdkFilesCommands['sdkFilesStep']['input']).step));
      return { ...identity, body } as ConnectorSdkFilesCommands[K]['output'];
    } catch (error) {
      if (error instanceof FileIndexCursorError) return { error: 409 };
      if (error instanceof FileRebuildError) return { error: error.status };
      throw error;
    }
  };
}
