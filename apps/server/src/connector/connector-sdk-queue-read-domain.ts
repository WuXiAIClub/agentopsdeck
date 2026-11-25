import { sessionRuntimeId, type QueuedMessagePage, type QueuedCommandPage } from '@agentopsdeck/shared';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import type { SdkAgentId } from './sdk-execution-journal.js';

type Input = { runtime: SdkAgentId; key: string; authorization: string; after: number };
type Failure = { error: 401 | 403 };
export type ConnectorSdkQueueReadCommands = {
  sdkQueuePage: { input: Input; output: Failure | { key: string; page: QueuedMessagePage } };
  sdkQueueCommandPage: { input: Input; output: Failure | { key: string; page: QueuedCommandPage } };
};
export type ConnectorSdkQueueReadKind = keyof ConnectorSdkQueueReadCommands;
export const connectorSdkQueueReadSteps = Object.freeze({ sdkQueuePage: 82, sdkQueueCommandPage: 83 });
export const isConnectorSdkQueueReadKind = (kind: string): kind is ConnectorSdkQueueReadKind => Object.hasOwn(connectorSdkQueueReadSteps, kind);
const fields = (v: unknown, names: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && names.every(k => Object.hasOwn(v, k)) && Object.keys(v).length === names.length;
const id = (v: unknown): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= 512 && !/[\u0000-\u001f\u007f]/.test(v);
const key = (v: unknown): v is string => id(v) && ['claude-code', 'ghcp', 'antigravity'].includes(sessionRuntimeId(v)) && v !== `${sessionRuntimeId(v)}:`;
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
export function validConnectorSdkQueueReadInput(_kind: ConnectorSdkQueueReadKind, v: unknown): boolean {
  return fields(v, ['runtime', 'key', 'authorization', 'after']) && ['claude-code', 'ghcp', 'antigravity'].includes(String(v.runtime))
    && key(v.key) && sessionRuntimeId(v.key) === v.runtime && count(v.after)
    && typeof v.authorization === 'string' && !!v.authorization.trim() && Buffer.byteLength(v.authorization) <= 4096
    && !/[\r\n\u0000]/.test(v.authorization);
}
export function validConnectorSdkQueueReadOutput(kind: ConnectorSdkQueueReadKind, v: unknown): boolean {
  return validOwnedQueueReadOutput(kind === 'sdkQueueCommandPage', v, key);
}
/** Shared metadata wire validation, not runtime authority. Callers retain their
 * own key policy; Hermes is never re-labelled as an SDK session. */
export function validOwnedQueueReadOutput(command: boolean, v: unknown, validKey: (v: unknown) => boolean): boolean {
  if (fields(v, ['error'])) return v.error === 401 || v.error === 403;
  if (!fields(v, ['key', 'page']) || !validKey(v.key) || !fields(v.page, ['items', 'nextCursor'])
    || !Array.isArray(v.page.items) || v.page.items.length > 64) return false;
  let previous = 0;
  const ids = new Set<string>();
  for (const item of v.page.items) {
    if (!fields(item, [command ? 'commandKey' : 'id', 'state', 'createdAt', 'version'])
      || !['queued', 'blocked', 'dispatching', 'outcome_unknown'].includes(String(item.state)) || !count(item.createdAt)
      || typeof item.version !== 'string' || !/^[1-9]\d{0,15}:[1-9]\d{0,15}$/.test(item.version)) return false;
    const [sequence, revision] = item.version.split(':').map(Number);
    if (!count(sequence) || !count(revision) || sequence! <= previous) return false;
    previous = sequence!;
    if (command) {
      if (item.commandKey !== null && (typeof item.commandKey !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(item.commandKey))) return false;
    } else {
      if (!id(item.id) || ids.has(item.id)) return false;
      ids.add(item.id);
    }
  }
  return v.page.nextCursor === null || v.page.items.length === 64 && v.page.nextCursor === String(previous);
}

/** Original metadata-only bounded reads. Raw manager view and actor-only
 * command view retain the existing route semantics; neither loads bodies or
 * grants arbitrary caller-declared management authority. Candidate only. */
export function executeConnectorSdkQueueRead<K extends ConnectorSdkQueueReadKind>(kind: K,
  input: Input, owner: ConnectorUserStore, tokens?: ConnectorTokenStore): ConnectorSdkQueueReadCommands[K]['output'] {
  if (!tokens || !validConnectorSdkQueueReadInput(kind, input)) throw Error('connector_storage_unavailable');
  const principal = tokens.authenticateAuthorization(input.authorization);
  if (!principal) return { error: 401 };
  const allowed = () => {
    const fresh = tokens.authenticateAuthorization(input.authorization);
    return !!fresh && fresh.tokenId === principal.tokenId && !fresh.tokenId.startsWith('actor_')
      && (fresh.scopes.includes('messages:read') || fresh.scopes.includes('queue:manage')) ? fresh : undefined;
  };
  const fresh = allowed();
  if (!fresh) return { error: 403 };
  const manager = kind === 'sdkQueuePage' && fresh.scopes.includes('queue:manage');
  const raw = owner.turns.summaryPage(input.runtime, input.key, fresh.tokenId, manager, input.after);
  const keys = kind === 'sdkQueueCommandPage'
    ? owner.commands.queueCommandKeys(JSON.stringify([fresh.tokenId, input.key]), raw.items.map(item => item.id)) : undefined;
  const page = keys ? { items: raw.items.map(({ id: _, ...item }, index) => ({ ...item, commandKey: keys[index]! })), nextCursor: raw.nextCursor } : raw;
  const final = allowed();
  if (!final || manager && !final.scopes.includes('queue:manage')) return { error: 403 }; // publication uses the exact original authority
  const result = { key: input.key, page };
  if (!validConnectorSdkQueueReadOutput(kind, result)) throw Error('connector_storage_unavailable');
  return result as ConnectorSdkQueueReadCommands[K]['output'];
}
