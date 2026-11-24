import type { ConnectorTokenStore } from '../auth/connector-token.js';
import type { ConnectorUserStore } from './connector-user-store.js';

export type HermesReadScope = { key: string; authorization: string };
export type HermesReadIdentity = { key: string; readerId: string; stored: string; digest: string };
export type HermesReadFailure = { error: 401 | 403 | 404 | 409 };
export type ConnectorHermesReadCommands = {
  hermesReadAuthorize: { input: HermesReadScope; output: HermesReadIdentity | HermesReadFailure };
  hermesReadDeliver: { input: HermesReadScope & Omit<HermesReadIdentity, 'key'>; output: HermesReadIdentity | HermesReadFailure };
};
export type ConnectorHermesReadKind = keyof ConnectorHermesReadCommands;
export const connectorHermesReadSteps = Object.freeze({ hermesReadAuthorize: 186, hermesReadDeliver: 187 });
export const isConnectorHermesReadKind = (kind: string): kind is ConnectorHermesReadKind => Object.hasOwn(connectorHermesReadSteps, kind);
const fields = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.length && Buffer.byteLength(v) <= max && !/[\x00-\x1f\x7f]/.test(v);
const key = (v: unknown): v is string => text(v, 512) && v.startsWith('hermes:') && v !== 'hermes:';
const identity = (v: Record<string, unknown>) => key(v.key) && text(v.readerId, 512) && text(v.stored, 1024)
  && typeof v.digest === 'string' && /^[a-f0-9]{64}$/.test(v.digest);
export function validConnectorHermesReadInput(kind: ConnectorHermesReadKind, v: unknown): boolean {
  return fields(v, ['key', 'authorization', ...(kind === 'hermesReadDeliver' ? ['readerId', 'stored', 'digest'] : [])])
    && key(v.key) && text(v.authorization, 4096) && !!v.authorization.trim()
    && (kind !== 'hermesReadDeliver' || identity(v));
}
export function validConnectorHermesReadOutput(_kind: ConnectorHermesReadKind, v: unknown): boolean {
  return fields(v, ['error']) ? [401, 403, 404, 409].includes(Number(v.error)) && typeof v.error === 'number'
    : fields(v, ['key', 'readerId', 'stored', 'digest']) && identity(v);
}
export function sameHermesReader(a: HermesReadIdentity, b: HermesReadIdentity): boolean {
  return a.key === b.key && a.readerId === b.readerId && a.stored === b.stored && a.digest === b.digest;
}
/** Public observation only. Internal lifecycle/history commands cannot grant
 * HTTP authority, and no observation clears execution or interruption fences. */
export function executeConnectorHermesRead<K extends ConnectorHermesReadKind>(kind: K,
  input: ConnectorHermesReadCommands[K]['input'], owner: ConnectorUserStore, tokens?: ConnectorTokenStore): ConnectorHermesReadCommands[K]['output'] {
  if (!validConnectorHermesReadInput(kind, input)) throw Error('connector_storage_unavailable');
  const actor = tokens?.authenticateAuthorization(input.authorization);
  if (!actor) return { error: 401 };
  if (actor.tokenId.startsWith('actor_') || actor.scopes.includes('execution:delegate') || !actor.scopes.includes('messages:read')) return { error: 403 };
  if (owner.commands.sessionDeletion(input.key)) return { error: 404 };
  const original = owner.hermesJournal.readIdentity(input.key);
  if (!original) return { error: 404 };
  const result: HermesReadIdentity = { key: input.key, readerId: actor.tokenId, ...original };
  if ('readerId' in input && !sameHermesReader(input, result)) return { error: 409 };
  if (!validConnectorHermesReadOutput(kind, result)) throw Error('connector_storage_unavailable');
  return result;
}
