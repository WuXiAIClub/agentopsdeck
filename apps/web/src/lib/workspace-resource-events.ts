import { validBoardId, validWorkspaceFileCardResource } from '@agentopsdeck/shared';

export type WorkspaceResourceType = 'taskboard' | 'taskboard-binding' | 'drawing' | 'native-drawio' | 'metric-card' | 'card-file-binding' | 'card-configuration' | 'report';
type Listener = { scope: string; resourceId: string; resourceType: WorkspaceResourceType; notify: (revision: number) => void };
const resourceKey = (type: WorkspaceResourceType, id: string) => JSON.stringify([type, id]);
/** Shares the existing owner SSE; no per-card stream, polling, or task content. */
export function createWorkspaceResourceEvents() {
  const listeners = new Set<Listener>();
  const versions = new Map<string, number>();
  let scope = '', acquire: (() => { close: () => void } | undefined) | undefined;
  let connection: { close: () => void } | undefined;
  return {
    configure(start: typeof acquire) { acquire = start; },
    connected(owner: string) {
      // Re-deliver the first authoritative snapshot after reconnect. Consumers
      // already at that revision do nothing; failed reads get one fresh chance.
      versions.clear(); scope = owner;
    },
    receive(owner: string, value: unknown) {
      if (!value || typeof value !== 'object') return;
      const frame = value as { type?: unknown; resourceType?: unknown; resources?: unknown };
      if (frame.type !== 'workspace.revisions' || !['taskboard', 'taskboard-binding', 'drawing', 'native-drawio', 'metric-card', 'card-file-binding', 'card-configuration', 'report'].includes(frame.resourceType as string) || !Array.isArray(frame.resources) || frame.resources.length > (['taskboard-binding', 'card-file-binding'].includes(frame.resourceType as string) ? 256 : 64)) return;
      const resourceType = frame.resourceType as WorkspaceResourceType;
      const resources = frame.resources as { resourceId: unknown; revision: unknown }[];
      const validResource = resourceType === 'card-file-binding' || resourceType === 'card-configuration' ? validWorkspaceFileCardResource : validBoardId;
      if (resources.some(row => !row || !validResource(row.resourceId) || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1)) return;
      if (scope !== owner) { versions.clear(); scope = owner; }
      let changed = false;
      for (const row of resources) {
        const id = row.resourceId as string, revision = row.revision as number;
        const key = resourceKey(resourceType, id);
        if (revision <= (versions.get(key) ?? 0)) continue;
        versions.set(key, revision);
        changed = true;
        for (const listener of listeners) if (listener.scope === owner && listener.resourceId === id && listener.resourceType === resourceType) listener.notify(revision);
      }
      if (changed && resourceType === 'metric-card') {
        const key = resourceKey(resourceType, 'catalog'), revision = (versions.get(key) ?? 0) + 1;
        versions.set(key, revision);
        for (const listener of listeners) if (listener.scope === owner && listener.resourceId === 'catalog' && listener.resourceType === resourceType) listener.notify(revision);
      }
    },
    subscribe(owner: string, resourceId: string, notify: Listener['notify'], resourceType: WorkspaceResourceType = 'taskboard') {
      const listener = { scope: owner, resourceId, notify, resourceType }; listeners.add(listener);
      if (!connection) connection = acquire?.();
      const revision = scope === owner ? versions.get(resourceKey(resourceType, resourceId)) : undefined;
      if (revision !== undefined) notify(revision);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) { connection?.close(); connection = undefined; versions.clear(); scope = ''; }
      };
    },
  };
}
export const workspaceResourceEvents = createWorkspaceResourceEvents();
