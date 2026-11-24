import { sessionRuntimeId } from '@agentopsdeck/shared';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import type { ConnectorUserStore } from './connector-user-store.js';

export type PublicReadRuntime = 'codex' | 'openclaw';
export type RuntimeReadScope = { key: string; authorization: string };
export type RuntimeReadIdentity = { key: string; readerId: string };
export type RuntimeReadFailure = { error: 403 | 404 | 409 };
const fields = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.length && Buffer.byteLength(v) <= max && !/[\x00-\x1f\x7f]/.test(v);
const key = (runtime: PublicReadRuntime, v: unknown): v is string => text(v, 512) && sessionRuntimeId(v) === runtime;
export function validRuntimeReadInput(runtime: PublicReadRuntime, deliver: boolean, v: unknown): boolean {
  return fields(v, ['key', 'authorization', ...(deliver ? ['readerId'] : [])])
    && key(runtime, v.key) && typeof v.authorization === 'string' && Buffer.byteLength(v.authorization) <= 4096
    && !/[\x00-\x1f\x7f]/.test(v.authorization) && (!deliver || text(v.readerId, 512));
}
export function validRuntimeReadOutput(runtime: PublicReadRuntime, v: unknown): v is RuntimeReadIdentity | RuntimeReadFailure {
  return fields(v, ['error']) ? typeof v.error === 'number' && [403, 404, 409].includes(v.error)
    : fields(v, ['key', 'readerId']) && key(runtime, v.key) && text(v.readerId, 512);
}
/** Public reads require current messages:read, not send/delegation policy.
 * A display snapshot cannot prove native idleness or release protection. */
export function executeRuntimeRead(runtime: PublicReadRuntime, deliver: boolean,
  input: RuntimeReadScope | RuntimeReadScope & { readerId: string }, owner: ConnectorUserStore,
  tokens?: ConnectorTokenStore): RuntimeReadIdentity | RuntimeReadFailure {
  if (!validRuntimeReadInput(runtime, deliver, input)) throw Error('connector_storage_unavailable');
  const actor = tokens?.authenticateAuthorization(input.authorization);
  if (!actor?.scopes.includes('messages:read')) return { error: 403 };
  if (owner.commands.sessionDeletion(input.key)) return { error: 404 };
  if ('readerId' in input && input.readerId !== actor.tokenId) return { error: 409 };
  const result = { key: input.key, readerId: actor.tokenId };
  if (!validRuntimeReadOutput(runtime, result)) throw Error('connector_storage_unavailable');
  return result;
}
