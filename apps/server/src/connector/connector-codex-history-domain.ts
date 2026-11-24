import { createHash } from 'node:crypto';
import type { ConnectorUserStore } from './connector-user-store.js';
import type { CodexStartupMetadata } from './connector-codex-startup-domain.js';
import { validConnectorCodexStartupOutput } from './connector-codex-startup-domain.js';
import type { TurnContextProof } from '../codex/turn-context.js';
import { validTurnContextProof } from '../codex/turn-context.js';
import type { CodexBatch } from '../codex/queued-batch.js';

type Identity = { id: string; turnId: string | null };
type Evidence = { proof: TurnContextProof | null; batch: CodexBatch | null };
export const CODEX_HISTORY_EVIDENCE_LIMIT = 64;
export type ConnectorCodexHistoryCommands = {
  codexHistoryOpen: { input: { sessionKey: string; token: string }; output: string };
  codexHistoryPage: { input: { token: string; offset: number }; output: CodexStartupMetadata[] };
  codexHistoryChunk: { input: { token: string; index: number; offset: number }; output: string };
  codexHistoryEvidence: { input: { token: string; identities: Identity[] }; output: Evidence[] };
  codexHistoryFinish: { input: { token: string; abandon: boolean }; output: boolean };
};
export type ConnectorCodexHistoryKind = keyof ConnectorCodexHistoryCommands;
export const connectorCodexHistorySteps = Object.freeze({ codexHistoryOpen: 222, codexHistoryPage: 223,
  codexHistoryChunk: 224, codexHistoryEvidence: 225, codexHistoryFinish: 226 });
export const isConnectorCodexHistoryKind = (kind: string): kind is ConnectorCodexHistoryKind => Object.hasOwn(connectorCodexHistorySteps, kind);
const fields = (v: unknown, keys: string[]): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
const text = (v: unknown, n: number): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= n;
const token = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const integer = (v: unknown, max: number): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= max;
function validBatch(v: unknown): v is CodexBatch {
  return fields(v, ['separator', 'members']) && text(v.separator, 4800) && Array.isArray(v.members)
    && v.members.length >= 2 && v.members.length <= 16 && v.members.every(m => fields(m, ['id', 'createdAt', 'imageCount'])
      && text(m.id, 512) && Number.isFinite(m.createdAt) && integer(m.imageCount, Number.MAX_SAFE_INTEGER))
    && new Set(v.members.map(m => m.id)).size === v.members.length && Buffer.byteLength(JSON.stringify(v)) <= 4800;
}
export function validConnectorCodexHistoryInput(kind: ConnectorCodexHistoryKind, v: unknown): boolean {
  if (kind === 'codexHistoryOpen') return fields(v, ['sessionKey', 'token']) && text(v.sessionKey, 4096) && token(v.token);
  if (kind === 'codexHistoryPage') return fields(v, ['token', 'offset']) && token(v.token) && integer(v.offset, 10000) && v.offset % 64 === 0;
  if (kind === 'codexHistoryChunk') return fields(v, ['token', 'index', 'offset']) && token(v.token)
    && integer(v.index, 9999) && integer(v.offset, 32 * 1024 * 1024 - 1) && v.offset % 65536 === 0;
  if (kind === 'codexHistoryFinish') return fields(v, ['token', 'abandon']) && token(v.token) && typeof v.abandon === 'boolean';
  return fields(v, ['token', 'identities']) && token(v.token) && Array.isArray(v.identities) && v.identities.length <= CODEX_HISTORY_EVIDENCE_LIMIT
    && v.identities.length > 0 && v.identities.every(i => fields(i, ['id', 'turnId']) && text(i.id, 512) && (i.turnId === null || text(i.turnId, 512)));
}
export function validConnectorCodexHistoryOutput(kind: ConnectorCodexHistoryKind, v: unknown): boolean {
  if (kind === 'codexHistoryOpen') return token(v);
  if (kind === 'codexHistoryPage') return validConnectorCodexStartupOutput('codexStartupQueuePage', v);
  if (kind === 'codexHistoryChunk') return validConnectorCodexStartupOutput('codexStartupQueueChunk', v);
  if (kind === 'codexHistoryFinish') return typeof v === 'boolean';
  return Array.isArray(v) && v.length <= CODEX_HISTORY_EVIDENCE_LIMIT && v.every(e => fields(e, ['proof', 'batch'])
    && (e.proof === null || fields(e.proof, ['hash', 'originalLength']) && validTurnContextProof(e.proof as TurnContextProof))
    && (e.batch === null || validBatch(e.batch)));
}

/** One bounded DISPLAY read window. No transaction stays open across IPC;
 * final session stamp detects changed queue/execution, including remove/reinsert.
 * Context/batch evidence is append-only and bound by original execution writes. */
export function createConnectorCodexHistoryCommands(owner: ConnectorUserStore) {
  type Snapshot = { token: string; sessionKey: string; rows: CodexStartupMetadata[]; stamp: string };
  let active: Snapshot | undefined;
  let body: { index: number; offset: number; bytes: Buffer } | undefined;
  const clearBody = () => { body?.bytes.fill(0); body = undefined; };
  const dispose = () => { clearBody(); active = undefined; };
  const capture = (sessionKey: string) => {
    const execution = owner.codexExecutions.get(sessionKey);
    const headId = owner.turns.headId('codex', sessionKey) ?? null;
    const rows: CodexStartupMetadata[] = [];
    let after = '0', bytes = 0;
    for (;;) {
      const page = owner.turns.bootstrapPage('codex', after, 64, sessionKey);
      if (!page.length) break;
      for (const row of page) {
        bytes += row.bytes + Buffer.byteLength(JSON.stringify(row));
        if (rows.length >= 10000 || bytes > 32 * 1024 * 1024) throw Error('connector_storage_unavailable');
        rows.push({ ...row, headId, executionCommandId: execution?.commandId ?? null });
        after = row.sequence;
      }
    }
    return { rows, stamp: createHash('sha256').update(JSON.stringify([execution ?? null, rows])).digest('hex') };
  };
  const execute = <K extends ConnectorCodexHistoryKind>(kind: K, input: ConnectorCodexHistoryCommands[K]['input']): ConnectorCodexHistoryCommands[K]['output'] => {
    if (!validConnectorCodexHistoryInput(kind, input)) throw Error('connector_storage_unavailable');
    // An unknown cleanup ACK may mean the window was already disposed. Only
    // abandonment is idempotent; a foreign active token is never evicted.
    if (!active && kind === 'codexHistoryFinish'
      && (input as ConnectorCodexHistoryCommands['codexHistoryFinish']['input']).abandon) {
      return false as ConnectorCodexHistoryCommands[K]['output'];
    }
    // A stale caller/colliding open must not dispose another accepted window.
    if (kind === 'codexHistoryOpen' ? !!active : !active || !('token' in input) || input.token !== active.token) throw Error('connector_storage_unavailable');
    try {
      let result: unknown;
      if (kind === 'codexHistoryOpen') {
        if (active) throw Error('connector_storage_unavailable');
        const { sessionKey, token } = input as ConnectorCodexHistoryCommands['codexHistoryOpen']['input'];
        active = { ...capture(sessionKey), token, sessionKey }; result = active.token;
      } else {
        const p = input as Exclude<ConnectorCodexHistoryCommands[ConnectorCodexHistoryKind]['input'], { sessionKey: string }>;
        if (!active || p.token !== active.token) throw Error('connector_storage_unavailable');
        if (kind === 'codexHistoryPage') {
          const { offset } = p as ConnectorCodexHistoryCommands['codexHistoryPage']['input'];
          result = active.rows.slice(offset, offset + 64);
        } else if (kind === 'codexHistoryChunk') {
          const { index, offset } = p as ConnectorCodexHistoryCommands['codexHistoryChunk']['input'];
          const row = active.rows[index];
          if (!row) throw Error('connector_storage_unavailable');
          if (!body) {
            if (offset !== 0) throw Error('connector_storage_unavailable');
            body = { index, offset, bytes: owner.turns.bootstrapBody('codex', active.sessionKey, row.id, row.version) };
          }
          if (body.index !== index || body.offset !== offset || owner.turns.version('codex', active.sessionKey, row.id) !== row.version) throw Error('connector_storage_unavailable');
          const end = Math.min(body.bytes.length, offset + 65536);
          result = body.bytes.subarray(offset, end).toString('base64'); body.offset = end;
          if (end === body.bytes.length) clearBody();
        } else if (kind === 'codexHistoryEvidence') {
          const { identities } = p as ConnectorCodexHistoryCommands['codexHistoryEvidence']['input'];
          result = identities.map(i => ({ proof: owner.codexExecutions.turnContextProof(active!.sessionKey, i.id, i.turnId ?? undefined) ?? null,
            batch: i.turnId ? owner.codexExecutions.batchForRun(active!.sessionKey, i.turnId) ?? null : null }));
        } else {
          const { abandon } = p as ConnectorCodexHistoryCommands['codexHistoryFinish']['input'];
          result = !abandon && !body && capture(active.sessionKey).stamp === active.stamp; dispose();
        }
      }
      if (!validConnectorCodexHistoryOutput(kind, result)) throw Error('connector_storage_unavailable');
      return result as ConnectorCodexHistoryCommands[K]['output'];
    } catch { dispose(); throw Error('connector_storage_unavailable'); }
  };
  return Object.assign(execute, { dispose });
}
