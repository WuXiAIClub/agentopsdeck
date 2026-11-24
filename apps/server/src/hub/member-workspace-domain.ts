import type { WorkspacePreferences } from '@agentopsdeck/shared';
import { workspacePreferencesSchema } from './workspace-preferences.js';

/** Includes the existing 5000-session schema, escaped keys and all tag/style
 * fields, not merely the HTTP body's 8MiB budget. Old valid saved documents
 * must not become a 16KiB worker-protocol error. No content is truncated. */
export const HUB_WORKSPACE_BYTES = 48 * 1024 * 1024;
export const HUB_WORKSPACE_NODES = 100_000;
export function validHubWorkspaceDocument(value: unknown): value is WorkspacePreferences {
  return workspacePreferencesSchema.safeParse(value).success;
}
/** The last successful original CAS may produce MAX_SAFE_INTEGER. It is
 * readable but no longer writable; input validation must not reject reading
 * that persisted revision or reset its optimistic concurrency token. */
export function validHubWorkspaceStoredDocument(value: unknown): value is WorkspacePreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return validHubWorkspaceDocument(v.revision === Number.MAX_SAFE_INTEGER
    ? { ...v, revision: Number.MAX_SAFE_INTEGER - 1 } : value);
}
export type HubWorkspaceResult = { document: WorkspacePreferences } | { conflict: true } | null;
export function validHubWorkspaceResult(value: unknown, save: boolean): value is HubWorkspaceResult {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 1 && (save && v.conflict === true
    || Object.hasOwn(v, 'document') && validHubWorkspaceStoredDocument(v.document));
}
