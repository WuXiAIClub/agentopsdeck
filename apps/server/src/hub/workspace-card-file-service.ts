import { validWorkspaceFileCardResource, validWorkspaceFileCardWrite, workspaceFileCardContent, type WorkspaceFileCard } from '@agentopsdeck/shared';
import { ArchiveUpgradeConflict, type WorkspaceCardFiles } from './workspace-card-files.js';
import { HubWorkspaceFileService, HubFileBoardError, type FileBoardTarget } from './workspace-board-file-service.js';

/** Only thrown before an archive intent or Connector write is admitted. */
export class HubArchiveUpgradeRejected extends HubFileBoardError {
  constructor() { super(409); }
}

export class HubFileCardService extends HubWorkspaceFileService<WorkspaceFileCard> {
  constructor(private readonly cardFiles: WorkspaceCardFiles, private readonly cardTarget: (owner: string, sessionId: string) => FileBoardTarget) {
    const files = cardFiles, resolve = cardTarget;
    super(files, { get(owner, resource) {
      const value = files.projection.get(owner, resource);
      if (!value) throw new HubFileBoardError(404);
      return value;
    } }, resolve, {
      base: '/workspace/card-files', mode: 'workspace-card-file', eventPrefix: 'card-file',
      validResource: validWorkspaceFileCardResource, validWrite: validWorkspaceFileCardWrite,
      content: workspaceFileCardContent,
      events(client, ids, signal) {
        if (!client.fileCardEvents) throw new HubFileBoardError(503);
        return client.fileCardEvents(ids, signal);
      },
    });
  }
  async includeArchive(owner: string, resource: string, id: string, mutationId: string, revision: number) {
    return this.operation(async (signal, guard) => {
      const binding = this.cardFiles.get(owner, id);
      if (!binding || binding.resourceId !== resource) throw new HubArchiveUpgradeRejected();
      const target = this.cardTarget(owner, binding.sessionId); target.valid();
      if (target.connectionId !== binding.connectionId || target.authority !== binding.authority) throw new HubFileBoardError(403);
      // An admitted original request remains inspectable even after Connector
      // capabilities change. It can never be relabeled as not admitted.
      if (this.cardFiles.writeReceipt(owner, id, mutationId)) return this.inspectWrite(owner, resource, id, mutationId);
      if (binding.state !== 'active') throw new HubArchiveUpgradeRejected();
      const capability = await target.client.json<{ notebookArchiveProtocol?: number }>('/workspace/card-files', { signal });
      guard(); target.valid();
      if (this.cardFiles.writeReceipt(owner, id, mutationId)) return this.inspectWrite(owner, resource, id, mutationId);
      if (capability.notebookArchiveProtocol !== 1) throw new HubArchiveUpgradeRejected();
      const input = this.cardFiles.archiveUpgradePlan(owner, id, mutationId, revision);
      if (!input) throw new HubArchiveUpgradeRejected();
      let admitted = false;
      try {
        const result = await this.write(owner, resource, id, input, prepare => {
          try {
            const intent = this.cardFiles.admitArchiveUpgrade(owner, id, input, prepare);
            admitted = true;
            return intent;
          } catch (error) {
            if (error instanceof ArchiveUpgradeConflict) throw new HubArchiveUpgradeRejected();
            throw error;
          }
        });
        if (result.state === 'saved') await this.refresh(owner, resource, id);
        return result;
      } catch (error) {
        // Writable preflight can reject before the atomic admission callback.
        // Never turn a post-admission error into negative execution evidence.
        if (!admitted && error instanceof HubFileBoardError && error.status === 409
          && !this.cardFiles.writeReceipt(owner, id, mutationId)) throw new HubArchiveUpgradeRejected();
        throw error;
      }
    });
  }
}
