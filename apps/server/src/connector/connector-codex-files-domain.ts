import { sessionRuntimeId, validateSessionFilePage, validateSessionFileRebuild,
  type SessionFilePage, type SessionFileRebuild } from '@agentopsdeck/shared';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { SessionFileRebuilds, FileRebuildError } from '../messages/session-file-rebuild.js';
import { FileIndexCursorError } from '../messages/session-file-index.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionEvidence } from '../auth/application-transaction-gate.js';

type Scope = { runtime: 'codex'; key: string; authorization: string };
type Identity = { runtime: 'codex'; key: string; readerId: string; generation: string | null };
type Failure = { error: 401 | 403 | 404 | 409 | 429 };
type Result<T> = Failure | Identity & { body: T };
export type ConnectorCodexFilesCommands = {
  codexFilesPage: { input: Scope & { cursor?: string }; output: Result<SessionFilePage> };
  codexFilesStart: { input: Scope & { application?: ApplicationTransactionEvidence }; output: Result<SessionFileRebuild> };
  codexFilesStep: { input: Scope & { jobId: string; step: number; application?: ApplicationTransactionEvidence }; output: Result<SessionFileRebuild> };
  codexFilesCancel: { input: Scope & { jobId: string; application?: ApplicationTransactionEvidence }; output: Result<SessionFileRebuild> };
  codexFilesDeliver: { input: Scope & Pick<Identity, 'readerId' | 'generation'>; output: Failure | Identity };
};
export type ConnectorCodexFilesKind = keyof ConnectorCodexFilesCommands;
export const connectorCodexFilesSteps = Object.freeze({ codexFilesPage: 306, codexFilesStart: 307,
  codexFilesStep: 308, codexFilesCancel: 309, codexFilesDeliver: 310 });
export const isConnectorCodexFilesKind = (kind: string): kind is ConnectorCodexFilesKind => Object.hasOwn(connectorCodexFilesSteps, kind);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v
  && typeof v === 'object' && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.length
  && Buffer.byteLength(v) <= max && !/[\u0000-\u001f\u007f]/.test(v);
const scope = (v: Record<string, unknown>) => v.runtime === 'codex' && text(v.key, 512)
  && sessionRuntimeId(v.key) === 'codex' && v.key !== 'codex:';
const generation = (v: unknown) => v === null || text(v, 512);
export function validConnectorCodexFilesInput(kind: ConnectorCodexFilesKind, value: unknown): boolean {
  return fields(value, ['runtime', 'key', 'authorization',
    ...(kind === 'codexFilesStep' || kind === 'codexFilesCancel' ? ['jobId'] : []),
    ...(kind === 'codexFilesStep' ? ['step'] : []), ...(kind === 'codexFilesDeliver' ? ['readerId', 'generation'] : [])],
  kind === 'codexFilesPage' ? ['cursor'] : kind === 'codexFilesDeliver' ? [] : ['application']) && scope(value) && text(value.authorization, 4096)
    && (!Object.hasOwn(value, 'application') || validApplicationTransactionEvidence(value.application))
    && (!Object.hasOwn(value, 'cursor') || text(value.cursor, 1024))
    && (!Object.hasOwn(value, 'jobId') || typeof value.jobId === 'string' && /^[a-f0-9-]{36}$/.test(value.jobId))
    && (kind !== 'codexFilesStep' || Number.isSafeInteger(value.step) && Number(value.step) >= 0 && Number(value.step) <= 10_000)
    && (kind !== 'codexFilesDeliver' || text(value.readerId, 512) && generation(value.generation));
}
export function validConnectorCodexFilesOutput(kind: ConnectorCodexFilesKind, value: unknown): boolean {
  if (fields(value, ['error'])) return typeof value.error === 'number' && [401, 403, 404, 409, 429].includes(value.error);
  if (!fields(value, ['runtime', 'key', 'readerId', 'generation', ...(kind === 'codexFilesDeliver' ? [] : ['body'])])
    || !scope(value) || !text(value.readerId, 512) || !generation(value.generation)) return false;
  if (kind === 'codexFilesDeliver') return true;
  try {
    if (kind === 'codexFilesPage') validateSessionFilePage(value.body as SessionFilePage);
    else { if (value.generation === null) return false; validateSessionFileRebuild(value.body as SessionFileRebuild); }
    return true;
  } catch { return false; }
}

/** Original verified projection and original bounded rebuild state machine.
 * One instance per sole database owner. No raw history/native/filesystem effects. */
export function createConnectorCodexFiles(owner: ConnectorUserStore, tokens?: ConnectorTokenStore) {
  const binding = (key: string) => owner.commands.sessionDeletion(key) ? undefined : owner.fileIndex.projectionBinding(key);
  const rebuilds = new SessionFileRebuilds(owner.fileIndex, binding,
    (key, before) => owner.fileIndex.projectionEvidencePage(key, before), Date.now, () => 'verified-projection');
  const execute = <K extends ConnectorCodexFilesKind>(kind: K, input: ConnectorCodexFilesCommands[K]['input']): ConnectorCodexFilesCommands[K]['output'] => {
    if (!validConnectorCodexFilesInput(kind, input)) throw Error('connector_storage_unavailable');
    const actor = tokens?.authenticateAuthorization(input.authorization);
    if (!actor) return { error: 401 };
    if (actor.tokenId.startsWith('actor_') || actor.scopes.includes('execution:delegate') || !actor.scopes.includes('messages:read')) return { error: 403 };
    if (owner.commands.sessionDeletion(input.key)) return { error: 404 };
    const current = binding(input.key) ?? null;
    const identity: Identity = { runtime: 'codex', key: input.key, readerId: actor.tokenId, generation: current };
    if (kind === 'codexFilesDeliver' && 'readerId' in input) return input.readerId === actor.tokenId && input.generation === current
      ? identity : { error: 409 };
    if (kind !== 'codexFilesPage' && current === null) return { error: 404 };
    try {
      const body = kind === 'codexFilesPage'
        ? validateSessionFilePage({ ...owner.fileIndex.page(input.key, (input as ConnectorCodexFilesCommands['codexFilesPage']['input']).cursor),
          ...(current === null ? {} : { rebuildAvailable: true }) })
        : validateSessionFileRebuild(kind === 'codexFilesStart' ? rebuilds.start(input.key, actor.tokenId)
          : kind === 'codexFilesCancel' ? rebuilds.cancel(input.key, actor.tokenId, (input as ConnectorCodexFilesCommands['codexFilesCancel']['input']).jobId)
            : rebuilds.step(input.key, actor.tokenId, (input as ConnectorCodexFilesCommands['codexFilesStep']['input']).jobId,
              (input as ConnectorCodexFilesCommands['codexFilesStep']['input']).step));
      const result = { ...identity, body };
      if (!validConnectorCodexFilesOutput(kind, result)) throw Error('connector_storage_unavailable');
      return result as ConnectorCodexFilesCommands[K]['output'];
    } catch (error) {
      if (error instanceof FileIndexCursorError) return { error: 409 };
      if (error instanceof FileRebuildError) return { error: error.status };
      throw error;
    }
  };
  return Object.assign(execute, { dispose: () => rebuilds.close() });
}
