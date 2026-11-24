import { sqliteAuthKinds, validSqliteAuthOutput, executeSqliteAuthCommand,
  type SqliteAuthCommands, type SqliteAuthKind } from '../auth/sqlite-owner-domain.js';
import type { SqlitePasskeys } from '../auth/sqlite-passkeys.js';
import type { HubStore } from './hub-store.js';
import { validHubMemberInput, type HubMemberEvidence } from './member-owner-domain.js';
import { requireConnectionReady } from '../storage/connection-recovery.js';
import type { OriginalLocalPreferences } from '../auth/local-preference-domain.js';
import { validHubLocalPreferenceCommand, validHubLocalPreferenceResult, executeHubLocalPreference,
  type HubLocalPreferenceCommand, type HubLocalPreferenceResult } from './local-preference-domain.js';
import { OriginalJsonAuthCommandStore } from '../auth/original-json-command-store.js';
import { validOriginalJsonAuthCommand, executeOriginalJsonAuthCommand,
  type OriginalJsonAuthCommand, type OriginalJsonAuthResult } from '../auth/original-json-command-domain.js';
import { validOriginalJsonSqliteInput, executeOriginalJsonSqliteCommand } from '../auth/original-json-sqlite-commands.js';
import { validCurrentKeyBinding, type CurrentKeyBindingCommand, type CurrentKeyBindingResult,
  type OriginalAuthCurrentKey } from '../auth/current-key-binding.js';

/** These fixed operations may use ORIGINAL application member authority.
 * Administrator issuance/authentication/session storage never accepts it. */
export const hubRequestAuthKinds = ['authorized', 'clearSessions', 'revoke', 'registrationOptions', 'verifyRegistration'] as const;
export type HubRequestAuthKind = typeof hubRequestAuthKinds[number];
export type HubLegacyAuthCommand = { [K in SqliteAuthKind]: {
  kind: K; input: SqliteAuthCommands[K]['input'];
} & (K extends HubRequestAuthKind ? { hubEvidence?: HubMemberEvidence } : {}) }[SqliteAuthKind] | OriginalJsonAuthCommand | CurrentKeyBindingCommand | HubLocalPreferenceCommand;
export type HubLegacyAuthResult = { [K in SqliteAuthKind]: {
  kind: K; value: SqliteAuthCommands[K]['output'];
} }[SqliteAuthKind] | OriginalJsonAuthResult | CurrentKeyBindingResult | HubLocalPreferenceResult;
const record = (value: unknown): value is Record<string, unknown> => !!value
  && typeof value === 'object' && !Array.isArray(value);
export function validHubLegacyAuthCommand(value: unknown): value is HubLegacyAuthCommand {
  if (validHubLocalPreferenceCommand(value)) return true;
  if (record(value) && value.kind === 'currentKeyBinding') return Object.keys(value).length === 2
    && Object.hasOwn(value, 'kind') && Object.hasOwn(value, 'input') && validCurrentKeyBinding(value.input);
  if (validOriginalJsonAuthCommand(value)) return true;
  if (!record(value) || !Object.hasOwn(value, 'kind') || !Object.hasOwn(value, 'input')
    || !sqliteAuthKinds.includes(value.kind as SqliteAuthKind)
    || !validOriginalJsonSqliteInput(value.kind as SqliteAuthKind, value.input)) return false;
  const keys = Object.keys(value);
  if (!Object.hasOwn(value, 'hubEvidence')) return keys.length === 2;
  return keys.length === 3 && hubRequestAuthKinds.includes(value.kind as HubRequestAuthKind)
    && validHubMemberInput('memberSnapshot', value.hubEvidence);
}
export function validHubLegacyAuthResult(value: unknown): value is HubLegacyAuthResult {
  if (validHubLocalPreferenceResult(value)) return true;
  if (record(value) && value.kind === 'currentKeyBinding') return Object.keys(value).length === 2
    && Object.hasOwn(value, 'kind') && Object.hasOwn(value, 'value') && validCurrentKeyBinding(value.value);
  if (record(value) && Object.keys(value).length === 2 && Object.hasOwn(value, 'kind') && Object.hasOwn(value, 'value')
    && (value.kind === 'originalJsonSession' || value.kind === 'originalJsonAuthorized')) return typeof value.value === 'boolean';
  return record(value) && Object.keys(value).length === 2
    && Object.hasOwn(value, 'kind') && Object.hasOwn(value, 'value')
    && sqliteAuthKinds.includes(value.kind as SqliteAuthKind)
    && validSqliteAuthOutput(value.kind as SqliteAuthKind, value.value);
}
/** Called only INSIDE the original worker with its original two owners.
 * Rebuild the raw request once, re-read BOTH original connections at every
 * permission callback. Auth's original mutation invokes this synchronously
 * inside its own transaction, including after WebAuthn's asynchronous proof.
 * Never call it from an HTTP preflight and cache its permission result. */
export function requireOriginalAuthReady(auth: SqlitePasskeys | OriginalJsonAuthCommandStore) {
  if (auth instanceof OriginalJsonAuthCommandStore) auth.assertReady(); else requireConnectionReady(auth.db);
}
export async function executeHubLegacyAuthCommand(hub: HubStore, auth: SqlitePasskeys | OriginalJsonAuthCommandStore,
  digest: string | undefined, command: HubLegacyAuthCommand, legacy: (request: Request) => boolean,
  currentKey?: OriginalAuthCurrentKey, preferences?: OriginalLocalPreferences): Promise<HubLegacyAuthResult> {
  if (!validHubLegacyAuthCommand(command)) throw Error('hub_member_storage_unavailable');
  requireOriginalAuthReady(auth);
  if (command.kind === 'localPreferenceChange' || command.kind === 'localPreferenceSnapshot') {
    if (!preferences) throw Error('hub_member_storage_unavailable');
    return executeHubLocalPreference(command, hub, preferences, legacy);
  }
  if (command.kind === 'currentKeyBinding') {
    if (!currentKey) throw Error('hub_member_storage_unavailable');
    if (auth instanceof OriginalJsonAuthCommandStore) auth.invalidateAuthenticationDeliveries();
    return { kind: command.kind, value: currentKey.update(command.input) };
  }
  if (command.kind === 'originalJsonSession' || command.kind === 'originalJsonAuthorized') {
    if (!(auth instanceof OriginalJsonAuthCommandStore)) throw Error('hub_member_storage_unavailable');
    return executeOriginalJsonAuthCommand(auth, digest, command);
  }
  const evidence = 'hubEvidence' in command ? command.hubEvidence : undefined;
  let authorize: (() => boolean) | undefined;
  if (evidence !== undefined) {
    const headers = new Headers();
    if (evidence.accessKey !== undefined) headers.set('x-agentopsdeck-key', evidence.accessKey);
    if (evidence.sessionToken !== undefined) headers.set('cookie', `agentopsdeck_session=${encodeURIComponent(evidence.sessionToken)}`);
    const request = new Request('http://auth.invalid/', { headers });
    authorize = () => {
      requireOriginalAuthReady(auth);
      // Original requestPrincipal always enters the original Hub connection
      // (member SQL or the legacy observed savepoint), retaining its own
      // recovery/closed fence without exposing HubStore's private database.
      return hub.identities.requestPrincipal(request, legacy) !== undefined;
    };
  }
  return { kind: command.kind,
    value: await (auth instanceof OriginalJsonAuthCommandStore
      ? executeOriginalJsonSqliteCommand(auth, digest, command.kind, command.input, authorize)
      : executeSqliteAuthCommand(auth, digest, command.kind, command.input, authorize)) } as HubLegacyAuthResult;
}
