import { registerCacheCleaner } from './cache-cleaners.js';
import { workspaceFileCardResource, type WorkspaceFileCardKind } from '@agentopsdeck/shared';
import { isSessionPane, type Pane } from './workspace-layout.js';
import type { FileCardDocument } from './workspace-file-card-context.js';

export const fileConfigurationKinds = new Set<WorkspaceFileCardKind>(['website', 'browser', 'research', 'terminal', 'media', 'dashboard']);
const MAX_PANE_DIGESTS = 256;
const MAX_FILE_CARD_CONFIGS = 128;
const paneDigestCache = new Map<string, string>();
const fileCardConfigCache = new Map<string, FileCardDocument | null>();

function rememberPaneDigest(cacheKey: string, resource: string): string {
  paneDigestCache.delete(cacheKey);
  paneDigestCache.set(cacheKey, resource);
  while (paneDigestCache.size > MAX_PANE_DIGESTS) {
    const oldest = paneDigestCache.keys().next().value;
    if (oldest === undefined) break;
    paneDigestCache.delete(oldest);
  }
  return resource;
}

export function syncFileCardPaneResource(pane: Pane): { resolved: boolean; resource: string | undefined } {
  if (pane.kind === 'moderator' || pane.kind === 'docker' || pane.kind === 'subagents' || pane.kind === 'file-browser' || pane.kind === 'file-editor' || pane.kind === 'image-viewer' || pane.kind === 'git-tree' || pane.kind === 'issue-source') {
    return { resolved: true, resource: undefined };
  }
  if (isSessionPane(pane)) return { resolved: true, resource: undefined };
  if (pane.kind === 'notebook') return { resolved: true, resource: workspaceFileCardResource('notebook', `${pane.target}:${pane.resourceId}`) };
  if (pane.kind === 'antigravity-quota' || pane.kind === 'git-repo-status' || pane.kind === 'session-hub' || (pane.kind === 'metric-card' && pane.resourceId === 'catalog')) return { resolved: true, resource: undefined };
  if (!fileConfigurationKinds.has(pane.kind)) return { resolved: true, resource: workspaceFileCardResource(pane.kind, pane.resourceId) };
  const digestKey = JSON.stringify(['agentopsdeck.workspace-file-pane', 1, pane.kind, pane.id]);
  const cached = paneDigestCache.get(digestKey);
  return cached !== undefined ? { resolved: true, resource: cached } : { resolved: false, resource: undefined };
}

export function readCachedFileCardConfiguration(scope: string, resource: string | undefined): FileCardDocument | undefined {
  if (!scope || !resource) return undefined;
  const cached = fileCardConfigCache.get(`${scope}\0${resource}`);
  return cached ? { ...cached } : undefined;
}

export function writeCachedFileCardConfiguration(scope: string, resource: string | undefined, document: FileCardDocument | null): void {
  if (!scope || !resource) return;
  const key = `${scope}\0${resource}`;
  fileCardConfigCache.delete(key);
  fileCardConfigCache.set(key, document ? { ...document } : null);
  while (fileCardConfigCache.size > MAX_FILE_CARD_CONFIGS) {
    const oldest = fileCardConfigCache.keys().next().value;
    if (oldest === undefined) break;
    fileCardConfigCache.delete(oldest);
  }
}

export function clearCachedFileCardConfigurations(): void {
  fileCardConfigCache.clear();
}
registerCacheCleaner(clearCachedFileCardConfigurations);

/** Existing layout IDs are stable across reload/move/resize and account sync.
 * A namespaced digest gives service panes a stable UUID without adding local-only
 * identity storage or leaking URLs/terminal targets into a route. */
export async function fileCardPaneResource(pane: Pane): Promise<string | undefined> {
  const sync = syncFileCardPaneResource(pane);
  if (sync.resolved || !pane.kind || isSessionPane(pane)) return sync.resource;
  if (pane.kind === 'antigravity-quota' || pane.kind === 'git-repo-status' || pane.kind === 'session-hub' || pane.kind === 'moderator' || pane.kind === 'docker' || pane.kind === 'subagents' || pane.kind === 'file-browser' || pane.kind === 'file-editor' || pane.kind === 'image-viewer' || pane.kind === 'git-tree' || pane.kind === 'issue-source') return undefined;
  const digestKey = JSON.stringify(['agentopsdeck.workspace-file-pane', 1, pane.kind, pane.id]);
  const data = new TextEncoder().encode(digestKey);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  hash[6] = (hash[6]! & 15) | 64; hash[8] = (hash[8]! & 63) | 128;
  const hex = [...hash.slice(0, 16)].map(n => n.toString(16).padStart(2, '0')).join('');
  return rememberPaneDigest(digestKey, workspaceFileCardResource(pane.kind, `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`));
}
