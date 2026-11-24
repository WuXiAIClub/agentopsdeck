import type { HermesLifecycleSnapshot } from '../hermes/journal.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { validHermesExecution, validConnectorHermesExecutionInput, validConnectorHermesExecutionOutput } from './connector-hermes-execution-domain.js';
import { validConnectorHermesHistoryInput, validConnectorHermesHistoryOutput, connectorHermesHistoryReplyMatches,
  type ConnectorHermesHistoryCommands } from './connector-hermes-history-domain.js';
import type { HermesHistoryPage, HermesHistoryPart } from '../hermes/journal.js';

export type ConnectorHermesLifecycleCommands = {
  hermesLifecyclePage: { input: { after: string; limit: number }; output: string[] };
  hermesLifecycleRead: { input: { key: string }; output: HermesLifecycleSnapshot };
  hermesLifecycleHistoryPage: { input: ConnectorHermesHistoryCommands['hermesHistoryProjection']['input']; output: HermesHistoryPage | null };
  hermesLifecycleHistoryPart: { input: ConnectorHermesHistoryCommands['hermesHistoryMessagePart']['input']; output: HermesHistoryPart | null };
  hermesLifecycleRepairTools: { input: { key: string; after: number; limit: number }; output: { key: string; after: number; next: number | null } };
};
export type ConnectorHermesLifecycleKind = keyof ConnectorHermesLifecycleCommands;
export const connectorHermesLifecycleSteps = Object.freeze({ hermesLifecyclePage: 170, hermesLifecycleRead: 171,
  hermesLifecycleHistoryPage: 172, hermesLifecycleHistoryPart: 173, hermesLifecycleRepairTools: 174 });
export const isConnectorHermesLifecycleKind = (kind: string): kind is ConnectorHermesLifecycleKind => Object.hasOwn(connectorHermesLifecycleSteps, kind);
const fields = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object'
  && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
export function validConnectorHermesLifecycleInput(kind: ConnectorHermesLifecycleKind, v: unknown): boolean {
  if (kind === 'hermesLifecyclePage') return validConnectorHermesExecutionInput('hermesExecutionPage', v);
  if (kind === 'hermesLifecycleRead') return validConnectorHermesHistoryInput('hermesHistorySnapshot', v);
  if (kind === 'hermesLifecycleHistoryPage') return validConnectorHermesHistoryInput('hermesHistoryProjection', v);
  if (kind === 'hermesLifecycleHistoryPart') return validConnectorHermesHistoryInput('hermesHistoryMessagePart', v);
  return fields(v, ['key', 'after', 'limit']) && validConnectorHermesHistoryInput('hermesHistorySnapshot', { key: v.key })
    && count(v.after) && count(v.limit) && v.limit >= 1 && v.limit <= 64;
}
export function validConnectorHermesLifecycleOutput(kind: ConnectorHermesLifecycleKind, v: unknown): boolean {
  if (kind === 'hermesLifecyclePage') return validConnectorHermesExecutionOutput('hermesExecutionPage', v);
  if (kind === 'hermesLifecycleHistoryPage') return validConnectorHermesHistoryOutput('hermesHistoryProjection', v);
  if (kind === 'hermesLifecycleHistoryPart') return validConnectorHermesHistoryOutput('hermesHistoryMessagePart', v);
  if (kind === 'hermesLifecycleRepairTools') return fields(v, ['key', 'after', 'next'])
    && validConnectorHermesHistoryInput('hermesHistorySnapshot', { key: v.key }) && count(v.after)
    && (v.next === null || count(v.next) && v.next > v.after);
  return fields(v, ['key', 'digest', 'title', 'execution', 'deletion'])
    && validConnectorHermesHistoryInput('hermesHistorySnapshot', { key: v.key })
    && typeof v.digest === 'string' && /^[a-f0-9]{64}$/.test(v.digest)
    && (v.title === null || typeof v.title === 'string' && v.title.length <= 120 && !/[\x00-\x1f\x7f]/.test(v.title))
    && (v.deletion === null || v.deletion === 'pending' || v.deletion === 'accepted')
    && (v.execution === null || validHermesExecution(v.execution) && v.execution.key === v.key)
    && (v.title !== null || v.execution === null) && (v.deletion !== 'accepted' || v.title === null);
}
export function connectorHermesLifecycleReplyMatches<K extends ConnectorHermesLifecycleKind>(kind: K,
  input: ConnectorHermesLifecycleCommands[K]['input'], output: unknown): boolean {
  if (!validConnectorHermesLifecycleOutput(kind, output)) return false;
  if (kind === 'hermesLifecyclePage') {
    const page = input as ConnectorHermesLifecycleCommands['hermesLifecyclePage']['input'];
    const values = output as string[];
    return values.length <= page.limit && values.every(key => Buffer.compare(Buffer.from(key), Buffer.from(page.after)) > 0);
  }
  if (kind === 'hermesLifecycleHistoryPage' || kind === 'hermesLifecycleHistoryPart') {
    return connectorHermesHistoryReplyMatches(kind === 'hermesLifecycleHistoryPage' ? 'hermesHistoryProjection' : 'hermesHistoryMessagePart',
      input as ConnectorHermesHistoryCommands['hermesHistoryProjection']['input'], output);
  }
  const request = input as ConnectorHermesLifecycleCommands['hermesLifecycleRepairTools']['input'];
  const value = output as HermesLifecycleSnapshot & { after: number };
  return value.key === request.key && (kind !== 'hermesLifecycleRepairTools' || value.after === request.after);
}

/** Internal startup/projection only. Observing pending deletion never grants
 * permission to attach, delete, interrupt or dispatch the original native. */
export function executeConnectorHermesLifecycle<K extends ConnectorHermesLifecycleKind>(kind: K,
  input: ConnectorHermesLifecycleCommands[K]['input'], owner: Pick<ConnectorUserStore, 'hermesJournal'>): ConnectorHermesLifecycleCommands[K]['output'] {
  if (!validConnectorHermesLifecycleInput(kind, input)) throw Error('connector_storage_unavailable');
  const v = input as ConnectorHermesLifecycleCommands['hermesLifecycleHistoryPage']['input']
    & ConnectorHermesLifecycleCommands['hermesLifecycleHistoryPart']['input']
    & ConnectorHermesLifecycleCommands['hermesLifecyclePage']['input'];
  const journal = owner.hermesJournal;
  const result = kind === 'hermesLifecyclePage' ? journal.lifecyclePage(v.after, v.limit)
    : kind === 'hermesLifecycleRead' ? journal.lifecycleSnapshot(v.key)
    : kind === 'hermesLifecycleHistoryPage' ? journal.lifecycleHistoryProjection(v.key, v.digest, v.offset, v.limit)
    : kind === 'hermesLifecycleHistoryPart' ? journal.lifecycleHistoryMessagePart(v.key, v.digest, v.index, v.offset)
    : { key: v.key, after: (input as ConnectorHermesLifecycleCommands['hermesLifecycleRepairTools']['input']).after,
      next: journal.repairToolsPage(v.key, (input as ConnectorHermesLifecycleCommands['hermesLifecycleRepairTools']['input']).after, v.limit) };
  if (!validConnectorHermesLifecycleOutput(kind, result) || !connectorHermesLifecycleReplyMatches(kind, input, result as ConnectorHermesLifecycleCommands[K]['output'])) throw Error('connector_storage_unavailable');
  return result as ConnectorHermesLifecycleCommands[K]['output'];
}
