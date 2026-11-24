import { safeEqual } from './access-key.js';
import { accessKeyFromRequest } from './access-key.js';
import { sessionTokenFromRequest } from './passkeys.js';
import { createHash } from 'node:crypto';
import { AuthPersistenceError } from './private-store.js';
import type { OriginalJsonAuthCommandStore } from './original-json-command-store.js';

/** Original JSON readers accepted noncanonical pre-existing tokens. These
 * explicit operations preserve their lookup/deletion without widening
 * SQLite's schema or the canonical token issuance/verification protocol.
 * Oversized legacy data refuses safely, never truncates into another token. */
export type OriginalJsonSessionInput = { action: 'current' | 'access-key' | 'delete' | 'authentication-current'; token: string };
export type OriginalJsonEvidence = { sessionToken?: string; suppliedKeyDigest?: string };
export type OriginalJsonRouteCapability = {
  session(input: OriginalJsonSessionInput): Promise<boolean>;
  authorized(input: OriginalJsonEvidence): Promise<boolean>;
};
export function originalJsonEvidenceFromRequest(request: Request): OriginalJsonEvidence {
  const sessionToken = sessionTokenFromRequest(request), key = accessKeyFromRequest(request);
  return { ...(sessionToken === undefined ? {} : { sessionToken }),
    ...(key === undefined ? {} : { suppliedKeyDigest: createHash('sha256').update(key).digest('hex') }) };
}
export type OriginalJsonAuthCommand = { kind: 'originalJsonSession'; input: OriginalJsonSessionInput }
  | { kind: 'originalJsonAuthorized'; input: OriginalJsonEvidence };
export type OriginalJsonAuthResult = { kind: OriginalJsonAuthCommand['kind']; value: boolean };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const token = (v: unknown): v is string => typeof v === 'string' && Buffer.byteLength(v) <= 4096;
export function validOriginalJsonAuthCommand(v: unknown): v is OriginalJsonAuthCommand {
  if (!record(v) || Object.keys(v).length !== 2 || !Object.hasOwn(v, 'kind') || !Object.hasOwn(v, 'input') || !record(v.input)) return false;
  const i = v.input, keys = Object.keys(i);
  if (v.kind === 'originalJsonSession') return keys.length === 2 && Object.hasOwn(i, 'token') && token(i.token)
    && ['current', 'access-key', 'delete', 'authentication-current'].includes(i.action as string);
  return v.kind === 'originalJsonAuthorized' && keys.every(k => k === 'sessionToken' || k === 'suppliedKeyDigest')
    && (i.sessionToken === undefined || token(i.sessionToken))
    && (i.suppliedKeyDigest === undefined || typeof i.suppliedKeyDigest === 'string' && /^[a-f0-9]{64}$/.test(i.suppliedKeyDigest));
}
export function executeOriginalJsonAuthCommand(store: OriginalJsonAuthCommandStore, digest: string | undefined,
  command: OriginalJsonAuthCommand): OriginalJsonAuthResult {
  if (!validOriginalJsonAuthCommand(command)) throw new AuthPersistenceError();
  store.assertReady();
  if (command.kind === 'originalJsonAuthorized') {
    const proof = command.input;
    return { kind: command.kind, value: proof.sessionToken !== undefined && store.sessionAuthorized(proof.sessionToken)
      || digest === undefined || proof.suppliedKeyDigest !== undefined && safeEqual(digest, proof.suppliedKeyDigest) };
  }
  const { action, token } = command.input;
  return { kind: command.kind, value: action === 'delete' ? store.deleteSession(token)
    : action === 'authentication-current' ? store.authenticationCurrent(token)
    : action === 'access-key' ? store.isAccessKeySession(token) : store.sessionAuthorized(token) };
}
