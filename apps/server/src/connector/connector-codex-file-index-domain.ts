import { isDeepStrictEqual } from 'node:util';
import { normalizeSourceFiles } from '@agentopsdeck/shared';
import type { CodexExecution } from '../codex/executions.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { validConnectorExecutionOutput } from './connector-execution-domain.js';
import { FILE_INDEX_ROWS, FILE_INDEX_BYTES, FILE_PROJECTION_ROWS, FILE_PROJECTION_BYTES,
  type FileEvidence, type ProjectionFileEvidence } from '../messages/session-file-evidence.js';

export type CodexFileIndexInput = { sessionKey: string; expected: CodexExecution | null; evidence: ProjectionFileEvidence };
export type ConnectorCodexFileIndexCommands = { codexFileIndexProjection: { input: CodexFileIndexInput; output: boolean } };
export type ConnectorCodexFileIndexKind = keyof ConnectorCodexFileIndexCommands;
export const CODEX_FILE_INDEX_COMMAND_BYTES = 7 * 1024 * 1024;
export const connectorCodexFileIndexSteps = Object.freeze({ codexFileIndexProjection: 280 });
export const isConnectorCodexFileIndexKind = (kind: string): kind is ConnectorCodexFileIndexKind => Object.hasOwn(connectorCodexFileIndexSteps, kind);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function batch(v: unknown, maxRows: number, maxBytes: number): v is FileEvidence {
  if (!object(v) || Object.keys(v).length !== 2 || !Array.isArray(v.rows) || typeof v.limited !== 'boolean' || v.rows.length > maxRows) return false;
  const identities = new Set<string>(); let bytes = 0;
  for (const row of v.rows) {
    if (!object(row)) return false;
    const { messageId, createdAt, ...file } = row;
    if (typeof messageId !== 'string' || !messageId.length || messageId.length > 4096
      || !Number.isSafeInteger(createdAt) || (createdAt as number) < 0
      || !isDeepStrictEqual(normalizeSourceFiles([file]), [file])) return false;
    const identity = JSON.stringify([messageId, file.path]);
    if (identities.has(identity)) return false;
    identities.add(identity); bytes += Buffer.byteLength(JSON.stringify(row));
    if (bytes > maxBytes) return false;
  }
  return true;
}
export function validConnectorCodexFileIndexInput(_kind: ConnectorCodexFileIndexKind, v: unknown): v is CodexFileIndexInput {
  if (!object(v) || Object.keys(v).length !== 3 || !Object.hasOwn(v, 'expected') || typeof v.sessionKey !== 'string'
    || !v.sessionKey.startsWith('codex:') || v.sessionKey.length <= 6 || Buffer.byteLength(JSON.stringify(v.sessionKey)) > 4096
    || /[\x00-\x1f\x7f]/.test(v.sessionKey)
    || !(v.expected === null || validConnectorExecutionOutput('codexExecutionRead', v.expected) && (v.expected as CodexExecution)?.sessionKey === v.sessionKey)) return false;
  const e = v.evidence;
  if (!object(e)) return false;
  if (Object.keys(e).length === 1 && e.invalid === true) return true;
  if (Object.keys(e).length !== 2 || !batch(e.index, FILE_INDEX_ROWS, FILE_INDEX_BYTES)
    || !batch(e.snapshot, FILE_PROJECTION_ROWS, FILE_PROJECTION_BYTES)) return false;
  const a = e.index, b = e.snapshot;
  // Independent budgets from the SAME newest-first scan, not arbitrary paired
  // replacements. The smaller retained window must be a suffix of the snapshot.
  return a.rows.length <= b.rows.length && isDeepStrictEqual(a.rows, b.rows.slice(b.rows.length - a.rows.length))
    && (a.rows.length === b.rows.length ? a.limited === b.limited : a.limited);
}
export const validConnectorCodexFileIndexOutput = (_kind: ConnectorCodexFileIndexKind, v: unknown): v is boolean => typeof v === 'boolean';
/** Observation, not authorization: never opens files or changes execution. */
export function executeConnectorCodexFileIndex(kind: ConnectorCodexFileIndexKind, input: CodexFileIndexInput, owner: ConnectorUserStore): boolean {
  if (!validConnectorCodexFileIndexInput(kind, input)) throw Error('connector_storage_unavailable');
  if (owner.commands.sessionDeletion(input.sessionKey) || owner.codexExecutions.isDeletedTerminal(input.sessionKey)
    || !isDeepStrictEqual(owner.codexExecutions.get(input.sessionKey) ?? null, input.expected)) return false;
  owner.fileIndex.replaceProjectionEvidence(input.sessionKey, input.evidence);
  return true;
}
