import { AuthPersistenceError } from './private-store.js';
import { sqliteAuthKinds, validSqliteAuthInput, validSqliteAuthOutput, sqliteAuthRefusal, sqliteAuthRefusalError,
  type SqliteAuthKind, type SqliteAuthRefusal } from './sqlite-owner-domain.js';
import { validOriginalJsonAuthCommand, type OriginalJsonAuthCommand } from './original-json-command-domain.js';
import { validOriginalJsonSqliteInput } from './original-json-sqlite-commands.js';
import { validCurrentKeyBinding } from './current-key-binding.js';
import { validLocalPreferenceFiles, validLocalPreferenceInput, validLocalPreferenceOutput, validLocalPreferenceSnapshot, type LocalPreferenceFiles } from './local-preference-domain.js';

/** One original standalone Auth owner, selecting the existing format only.
 * Absence of kind preserves the original SQLite constructor contract. */
export type StandaloneAuthOwnerConfig = ({ kind?: 'sqlite'; file: string; legacyFiles: string[] }
  | { kind: 'json'; passkeysFile: string; sessionsFile: string }) & { accessKeyDigest?: string; legacyPreferences?: LocalPreferenceFiles };
export type StandaloneAuthKind = SqliteAuthKind | OriginalJsonAuthCommand['kind'] | 'currentKeyBinding' | 'localPreference' | 'localPreferenceSnapshot';
export const standaloneAuthKinds: readonly StandaloneAuthKind[] = [...sqliteAuthKinds, 'originalJsonSession', 'originalJsonAuthorized', 'currentKeyBinding', 'localPreference', 'localPreferenceSnapshot'];
// Stable public diagnostic codes: adding a command must not renumber existing
// logs. The child SQL-failure lane uses its own pre-existing 0-based phases.
const commandSteps: Record<StandaloneAuthKind, number> = {
  status: 1, list: 2, authorized: 3, sessionCurrent: 4, accessKeySession: 5,
  issueAdministratorSession: 6, deleteSession: 7, clearSessions: 8, credentialCurrent: 9,
  revoke: 10, registrationOptions: 11, authenticationOptions: 12,
  verifyRegistration: 13, verifyAuthentication: 14,
  originalJsonSession: 15, originalJsonAuthorized: 16, issueUnrestrictedSession: 17, currentKeyBinding: 18,
  localPreference: 19, localPreferenceSnapshot: 20,
};
export function standaloneAuthCommandStep(kind: unknown): number {
  return typeof kind === 'string' && Object.hasOwn(commandSteps, kind) ? commandSteps[kind as StandaloneAuthKind] : 0;
}
export function standaloneAuthConfig(value: unknown): StandaloneAuthOwnerConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuthPersistenceError();
  const config = value as Record<string, unknown>;
  const validPath = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && !v.includes('\0');
  if (config.accessKeyDigest !== undefined && (typeof config.accessKeyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(config.accessKeyDigest))) {
    throw new AuthPersistenceError();
  }
  if (config.legacyPreferences !== undefined && !validLocalPreferenceFiles(config.legacyPreferences)) throw new AuthPersistenceError();
  const keys = config.kind === 'json' ? ['kind', 'passkeysFile', 'sessionsFile', 'accessKeyDigest', 'legacyPreferences']
    : ['kind', 'file', 'legacyFiles', 'accessKeyDigest', 'legacyPreferences'];
  if (Object.keys(config).some(key => !keys.includes(key))) throw new AuthPersistenceError();
  if (config.kind === 'json') {
    if (!validPath(config.passkeysFile) || !validPath(config.sessionsFile)) throw new AuthPersistenceError();
  } else if (config.kind !== undefined && config.kind !== 'sqlite'
    || !validPath(config.file) || !Array.isArray(config.legacyFiles)
    || !config.legacyFiles.every(p => typeof p === 'string' && !p.includes('\0'))) throw new AuthPersistenceError();
  return config as StandaloneAuthOwnerConfig;
}
export function validStandaloneAuthInput(kind: StandaloneAuthKind, input: unknown, json = false): boolean {
  if (kind === 'localPreferenceSnapshot') return !!input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 0;
  if (kind === 'currentKeyBinding') return validCurrentKeyBinding(input);
  if (kind === 'localPreference') return validLocalPreferenceInput(input, json);
  return kind === 'originalJsonSession' || kind === 'originalJsonAuthorized'
    ? validOriginalJsonAuthCommand({ kind, input }) : json ? validOriginalJsonSqliteInput(kind, input) : validSqliteAuthInput(kind, input);
}
export function validStandaloneAuthOutput(kind: StandaloneAuthKind, output: unknown): boolean {
  if (kind === 'localPreferenceSnapshot') return validLocalPreferenceSnapshot(output);
  if (kind === 'currentKeyBinding') return validCurrentKeyBinding(output);
  if (kind === 'localPreference') return validLocalPreferenceOutput(output);
  return kind === 'originalJsonSession' || kind === 'originalJsonAuthorized'
    ? typeof output === 'boolean' : validSqliteAuthOutput(kind, output);
}
export function standaloneAuthRefusal(kind: StandaloneAuthKind | 'close', error: unknown) {
  return sqliteAuthKinds.includes(kind as SqliteAuthKind) ? sqliteAuthRefusal(kind as SqliteAuthKind, error) : undefined;
}
export function standaloneAuthRefusalError(kind: StandaloneAuthKind | 'close', value: SqliteAuthRefusal) {
  return sqliteAuthKinds.includes(kind as SqliteAuthKind) ? sqliteAuthRefusalError(kind as SqliteAuthKind, value) : undefined;
}
