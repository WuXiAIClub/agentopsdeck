import { executeSqliteAuthCommand, validSqliteAuthInput, type SqliteAuthCommands, type SqliteAuthKind } from './sqlite-owner-domain.js';
import { executeOriginalJsonAuthCommand, validOriginalJsonAuthCommand, type OriginalJsonEvidence } from './original-json-command-domain.js';
import type { OriginalJsonAuthCommandStore } from './original-json-command-store.js';
import { AuthPersistenceError } from './private-store.js';

const requestKinds: readonly SqliteAuthKind[] = ['authorized', 'clearSessions', 'revoke', 'registrationOptions', 'verifyRegistration'];
/** Preserve JSON's original noncanonical session lookup without widening the
 * SQLite protocol or replacing a mutation-time check with a preflight grant. */
export function validOriginalJsonSqliteInput(kind: SqliteAuthKind, input: unknown): boolean {
  if (!requestKinds.includes(kind)) return validSqliteAuthInput(kind, input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const fields = input as Record<string, unknown>;
  const evidence = kind === 'authorized' ? input : fields.evidence;
  return validOriginalJsonAuthCommand({ kind: 'originalJsonAuthorized', input: evidence })
    && validSqliteAuthInput(kind, kind === 'authorized' ? {} : { ...fields, evidence: {} });
}
export function executeOriginalJsonSqliteCommand<K extends SqliteAuthKind>(store: OriginalJsonAuthCommandStore,
  digest: string | undefined, kind: K, input: SqliteAuthCommands[K]['input'], originalAuthority?: () => boolean) {
  if (!validOriginalJsonSqliteInput(kind, input)) throw new AuthPersistenceError();
  const evidence = (kind === 'authorized' ? input : (input as { evidence?: OriginalJsonEvidence }).evidence) as OriginalJsonEvidence;
  const authority = originalAuthority ?? (() => executeOriginalJsonAuthCommand(store, digest,
    { kind: 'originalJsonAuthorized', input: evidence }).value);
  // Built only inside the original worker from the raw request. The original
  // verifier calls it again after WebAuthn and immediately before its write.
  const sanitized = requestKinds.includes(kind)
    ? kind === 'authorized' ? {} : { ...input, evidence: {} } : input;
  return executeSqliteAuthCommand(store, digest, kind, sanitized as SqliteAuthCommands[K]['input'],
    requestKinds.includes(kind) ? authority : undefined);
}
