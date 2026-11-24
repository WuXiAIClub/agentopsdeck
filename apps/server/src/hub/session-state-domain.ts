import type { DatabaseSync } from 'node:sqlite';
import type { HubPrincipal } from './identity.js';
import { readHubConnectionDirectory, validHubConnectionDirectoryResult, HUB_CONNECTION_DIRECTORY_RPC_BYTES,
  type HubConnectionDirectoryResult } from './member-connection-directory-domain.js';
import { readSessionPreferences } from './preference-read.js';
import { PREFERENCE_BYTE_LIMIT, validPreferenceRows, type PreferenceRows } from './delivery-reader-protocol.js';

type Directory = Extract<HubConnectionDirectoryResult, { action: 'read' }>;
export type HubSessionStateCommand = { action: 'read' }
  | { action: 'check'; directoryVersion: number; preferenceVersion: number };
export type HubSessionStateResult = null
  | { action: 'read'; directory: Directory; preferences: PreferenceRows; preferenceVersion: number }
  | { action: 'check'; directoryVersion: number; preferenceVersion: number; ok: boolean };
// Combined fixed snapshot fits the existing 32MiB aggregate result budget.
export const HUB_SESSION_STATE_RPC_BYTES = HUB_CONNECTION_DIRECTORY_RPC_BYTES + PREFERENCE_BYTE_LIMIT + 1024;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length
  && keys.every(key => Object.hasOwn(v, key));
const version = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
export function validHubSessionStateCommand(v: unknown): v is HubSessionStateCommand {
  return object(v) && (v.action === 'read' ? fields(v, ['action']) : v.action === 'check'
    && fields(v, ['action', 'directoryVersion', 'preferenceVersion']) && version(v.directoryVersion) && version(v.preferenceVersion));
}
export function validHubSessionStateResult(v: unknown): v is HubSessionStateResult {
  try {
    if (v === null) return true;
    if (!object(v) || !version(v.preferenceVersion)) return false;
    if (v.action === 'check') return fields(v, ['action', 'directoryVersion', 'preferenceVersion', 'ok'])
      && version(v.directoryVersion) && typeof v.ok === 'boolean';
    return v.action === 'read' && fields(v, ['action', 'directory', 'preferences', 'preferenceVersion'])
      && object(v.directory) && v.directory.action === 'read' && validHubConnectionDirectoryResult(v.directory)
      && validPreferenceRows(v.preferences) && Buffer.byteLength(JSON.stringify(v)) <= HUB_SESSION_STATE_RPC_BYTES;
  } catch { return false; }
}
export function readHubSessionState(db: DatabaseSync, principal: HubPrincipal,
  command: HubSessionStateCommand): NonNullable<HubSessionStateResult> {
  if (!validHubSessionStateCommand(command)) throw new Error('hub_session_state_unavailable');
  const row = db.prepare('SELECT version FROM hub_session_preference_versions WHERE user_id=?').get(principal.userId);
  const preferenceVersion = row?.version ?? 0;
  if (!version(preferenceVersion) || row && preferenceVersion === 0) throw new Error('hub_session_state_unavailable');
  if (command.action === 'check') {
    const directory = readHubConnectionDirectory(db, principal, { action: 'check', version: command.directoryVersion });
    if (directory.action !== 'check') throw new Error('hub_session_state_unavailable');
    return { ...command, ok: directory.ok && preferenceVersion === command.preferenceVersion };
  }
  const directory = readHubConnectionDirectory(db, principal, { action: 'read' });
  if (directory.action !== 'read') throw new Error('hub_session_state_unavailable');
  const result = { action: 'read' as const, directory, preferences: readSessionPreferences(db, principal.userId), preferenceVersion };
  if (!validHubSessionStateResult(result)) throw new Error('hub_session_state_unavailable');
  return result;
}
