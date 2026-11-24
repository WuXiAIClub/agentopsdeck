import type { ConnectorUserStore } from './connector-user-store.js';
import type { TurnQueueMetadata } from '../commands/turn-queue.js';
import { recoverCodexStartup } from '../codex/startup-recovery.js';

export type CodexStartupMetadata = TurnQueueMetadata & { headId: string | null; executionCommandId: string | null };
export type ConnectorCodexStartupCommands = {
  codexStartupRecover: { input: Record<string, never>; output: null };
  codexStartupQueuePage: { input: { after: string; limit: number }; output: CodexStartupMetadata[] };
  codexStartupQueueChunk: { input: { sessionKey: string; id: string; version: string; offset: number }; output: string };
};
export type ConnectorCodexStartupKind = keyof ConnectorCodexStartupCommands;
export const connectorCodexStartupSteps = Object.freeze({ codexStartupRecover: 218, codexStartupQueuePage: 219, codexStartupQueueChunk: 220 });
export const isConnectorCodexStartupKind = (kind: string): kind is ConnectorCodexStartupKind => Object.hasOwn(connectorCodexStartupSteps, kind);
const fields = (v: unknown, keys: string[]): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.length && Buffer.byteLength(v) <= max;
const sequence = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n;
const version = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,18}:[0-9]{1,16}$/.test(v)
  && sequence(v.split(':')[0]) && Number.isSafeInteger(Number(v.split(':')[1]));
export function validConnectorCodexStartupInput(kind: ConnectorCodexStartupKind, v: unknown): boolean {
  if (kind === 'codexStartupRecover') return fields(v, []);
  if (kind === 'codexStartupQueuePage') return fields(v, ['after', 'limit']) && sequence(v.after)
    && Number.isSafeInteger(v.limit) && v.limit >= 1 && v.limit <= 64;
  return fields(v, ['sessionKey', 'id', 'version', 'offset']) && text(v.sessionKey, 4096) && text(v.id, 512)
    && version(v.version) && Number.isSafeInteger(v.offset) && v.offset >= 0 && v.offset < 32 * 1024 * 1024
    && v.offset % 65536 === 0;
}
export function validConnectorCodexStartupOutput(kind: ConnectorCodexStartupKind, v: unknown): boolean {
  if (kind === 'codexStartupRecover') return v === null;
  if (kind === 'codexStartupQueueChunk') return typeof v === 'string' && v.length > 0 && v.length <= 87384
    && /^[A-Za-z0-9+/]+={0,2}$/.test(v) && Buffer.from(v, 'base64').toString('base64') === v;
  return Array.isArray(v) && v.length <= 64 && v.every((r, i) => fields(r, ['sequence', 'id', 'sessionKey', 'createdAt', 'state', 'version', 'bytes', 'headId', 'executionCommandId'])
    && (r.headId === null || text(r.headId, 512)) && (r.executionCommandId === null || text(r.executionCommandId, 512))
    && sequence(r.sequence) && r.sequence !== '0' && (i === 0 || BigInt(r.sequence) > BigInt(v[i - 1].sequence))
    && text(r.id, 512) && text(r.sessionKey, 4096) && typeof r.createdAt === 'number' && Number.isFinite(r.createdAt)
    && ['queued', 'dispatching', 'outcome_unknown', 'blocked'].includes(r.state) && version(r.version)
    && r.version.split(':')[0] === r.sequence && Number.isSafeInteger(r.bytes) && r.bytes > 0 && r.bytes <= 32 * 1024 * 1024);
}

/** Created once per physical worker owner. Recovery cannot be invoked again
 * after startup to reinterpret an active execution as a restarted one. */
export function createConnectorCodexStartupCommands(owner: ConnectorUserStore, queueFile?: string) {
  let recovered = false, failed = false;
  let body: { sessionKey: string; id: string; version: string; offset: number; bytes: Buffer } | undefined;
  const dispose = () => { body?.bytes.fill(0); body = undefined; };
  const execute = <K extends ConnectorCodexStartupKind>(kind: K, input: ConnectorCodexStartupCommands[K]['input']): ConnectorCodexStartupCommands[K]['output'] => {
    if (failed || !validConnectorCodexStartupInput(kind, input)) throw Error('connector_storage_unavailable');
    try {
      let result: unknown;
      if (kind === 'codexStartupRecover') {
        if (!recovered) { recoverCodexStartup(owner, queueFile); recovered = true; }
        result = null;
      } else {
        if (!recovered) throw Error('connector_storage_unavailable');
        if (kind === 'codexStartupQueuePage') {
          if (body) throw Error('connector_storage_unavailable');
          const p = input as ConnectorCodexStartupCommands['codexStartupQueuePage']['input'];
          const facts = new Map<string, Pick<CodexStartupMetadata, 'headId' | 'executionCommandId'>>();
          result = owner.turns.bootstrapPage('codex', p.after, p.limit).map(row => {
            let fact = facts.get(row.sessionKey);
            if (!fact) {
              fact = { headId: owner.turns.headId('codex', row.sessionKey) ?? null,
                executionCommandId: owner.codexExecutions.get(row.sessionKey)?.commandId ?? null };
              facts.set(row.sessionKey, fact);
            }
            return { ...row, ...fact };
          });
        } else {
          const p = input as ConnectorCodexStartupCommands['codexStartupQueueChunk']['input'];
          if (!body) {
            if (p.offset !== 0) throw Error('connector_storage_unavailable');
            body = { ...p, bytes: owner.turns.bootstrapBody('codex', p.sessionKey, p.id, p.version) };
          }
          if (body.sessionKey !== p.sessionKey || body.id !== p.id || body.version !== p.version || body.offset !== p.offset
            || owner.turns.version('codex', p.sessionKey, p.id) !== p.version) throw Error('connector_storage_unavailable');
          const end = Math.min(body.bytes.length, p.offset + 65536);
          result = body.bytes.subarray(p.offset, end).toString('base64');
          body.offset = end;
          if (end === body.bytes.length) dispose();
        }
      }
      if (!validConnectorCodexStartupOutput(kind, result)) throw Error('connector_storage_unavailable');
      return result as ConnectorCodexStartupCommands[K]['output'];
    } catch { failed = true; dispose(); throw Error('connector_storage_unavailable'); }
  };
  return Object.assign(execute, { dispose });
}
