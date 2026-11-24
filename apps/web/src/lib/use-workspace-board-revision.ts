import { useEffect, useState } from 'react';
import { workspaceResourceEvents, type WorkspaceResourceType } from './workspace-resource-events';

export function useWorkspaceBoardRevision(scope: string, resourceId: string, resourceType: WorkspaceResourceType = 'taskboard') {
  const [observed, setObserved] = useState({ scope, resourceId, resourceType, revision: 0, notice: 0 });
  useEffect(() => workspaceResourceEvents.subscribe(scope, resourceId, revision => {
    setObserved(previous => ({ scope, resourceId, resourceType, revision, notice: previous.notice + 1 }));
  }, resourceType), [scope, resourceId, resourceType]);
  return observed.scope === scope && observed.resourceId === resourceId && observed.resourceType === resourceType ? observed : { revision: 0, notice: 0 };
}
