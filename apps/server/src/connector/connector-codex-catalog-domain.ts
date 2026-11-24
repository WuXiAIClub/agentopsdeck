import type { ConnectorTokenStore } from '../auth/connector-token.js';
import type { ConnectorUserStore } from './connector-user-store.js';

export type CodexCatalogScope = { authorization: string; kind: 'models' } | { authorization: string; kind: 'skills'; key: string };
export type CodexCatalogIdentity = { readerId: string };
export type CodexCatalogFailure = { error: 403 | 404 | 409 };
export type ConnectorCodexCatalogCommands = {
  codexCatalogAuthorize: { input: CodexCatalogScope; output: CodexCatalogIdentity | CodexCatalogFailure };
  codexCatalogDeliver: { input: CodexCatalogScope & CodexCatalogIdentity; output: CodexCatalogIdentity | CodexCatalogFailure };
};
export type ConnectorCodexCatalogKind = keyof ConnectorCodexCatalogCommands;
// Append-only diagnostic steps. No native/SQL/path/callback supplied by callers.
export const connectorCodexCatalogSteps = Object.freeze({ codexCatalogAuthorize: 288, codexCatalogDeliver: 289 });
export const isConnectorCodexCatalogKind = (v: string): v is ConnectorCodexCatalogKind => Object.hasOwn(connectorCodexCatalogSteps, v);
const fields = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0
  && Buffer.byteLength(v) <= max && !/[\x00-\x1f\x7f]/.test(v);
export function validConnectorCodexCatalogInput(kind: ConnectorCodexCatalogKind, v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const row = v as Record<string, unknown>;
  return fields(row, ['authorization', 'kind', ...(row.kind === 'skills' ? ['key'] : []), ...(kind === 'codexCatalogDeliver' ? ['readerId'] : [])])
    && typeof row.authorization === 'string' && Buffer.byteLength(row.authorization) <= 4096 && !/[\x00-\x1f\x7f]/.test(row.authorization)
    && (row.kind === 'models' || row.kind === 'skills' && text(row.key, 512) && row.key.startsWith('codex:') && row.key.length > 6)
    && (kind !== 'codexCatalogDeliver' || text(row.readerId, 512));
}
export function validConnectorCodexCatalogOutput(_kind: ConnectorCodexCatalogKind, v: unknown): v is CodexCatalogIdentity | CodexCatalogFailure {
  return fields(v, ['error']) ? [403, 404, 409].includes(v.error as number) : fields(v, ['readerId']) && text(v.readerId, 512);
}
/** Current authority is always derived inside the sole token/DB owner. A
 * catalog result is display data, never execution or idle-state evidence. */
export function executeConnectorCodexCatalog<K extends ConnectorCodexCatalogKind>(kind: K,
  input: ConnectorCodexCatalogCommands[K]['input'], owner: ConnectorUserStore,
  tokens?: ConnectorTokenStore): ConnectorCodexCatalogCommands[K]['output'] {
  if (!validConnectorCodexCatalogInput(kind, input)) throw Error('connector_storage_unavailable');
  const actor = tokens?.authenticateAuthorization(input.authorization);
  if (!actor?.scopes.includes(input.kind === 'models' ? 'models:read' : 'messages:read')) return { error: 403 };
  if (input.kind === 'skills') {
    if (actor.scopes.includes('execution:delegate')) return { error: 403 };
    if (owner.commands.sessionDeletion(input.key)) return { error: 404 };
  }
  if ('readerId' in input && input.readerId !== actor.tokenId) return { error: 409 };
  return { readerId: actor.tokenId };
}
