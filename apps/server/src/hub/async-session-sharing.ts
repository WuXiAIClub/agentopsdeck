import { copyOriginalRequest } from './original-request-scope.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { validHubSessionCollaboratorCommand, validHubSessionCollaboratorReply,
  type HubSessionCollaboratorCommand } from './member-session-collaborators-domain.js';
import { validHubSessionSharingCommand, validHubSessionSharingReply, type HubSessionSharingCommand } from './member-session-sharing-domain.js';
import type { SessionShareOptions } from './node-grants.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Awaited HTTP port. One original owner, no mutation timeout/replay,
 * no execution admission. Unknown settlement remains unknown to the caller. */
export class AsyncHubSessionSharing {
  private readonly requests: AsyncHubMemberRequests;
  private readonly persistence: AuthRoutePersistence;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>,
    diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30000, timeoutMs = 30000) {
    this.requests = new AsyncHubMemberRequests(owner, diagnostics, warningMs, timeoutMs);
    this.persistence = new AuthRoutePersistence(diagnostics, warningMs);
  }
  get pending() { return this.requests.pendingReads + this.persistence.pending; }
  close(): Promise<void> {
    const authority = this.requests.close(), commands = this.persistence.close();
    return Promise.all([authority, commands]).then(() => {});
  }
  async begin(request: Request, ownerUserId: string, sessionId: string) {
    const original = copyOriginalRequest(request);
    const evidence = Object.freeze(hubMemberEvidence(original)), authority = await this.requests.begin(original);
    const target = Object.freeze({ userId: authority.principal.userId, ownerUserId, sessionId });
    const authorize = Object.freeze({ ...target, action: 'authorize' as const });
    if (!validHubSessionCollaboratorCommand(authorize)) throw new HubMemberRequestError(404);
    const access = async (command: HubSessionCollaboratorCommand) => {
      await authority.check();
      if (original.signal.aborted) throw new HubMemberRequestError(499);
      let value;
      try { value = (await this.persistence.run(44, () => this.owner.command('sessionCollaborators', {
        evidence, expectedScope: authority.recoveryScope, command,
      }))).value; }
      catch { await authority.check(); throw new HubMemberRequestError(503); }
      if (value === null) throw new HubMemberRequestError(401);
      await authority.check();
      if (!validHubSessionCollaboratorReply(command, value)) throw new HubMemberRequestError(503);
      if (value.status !== 200) throw new HubMemberRequestError(value.status);
      if (original.signal.aborted) throw new HubMemberRequestError(499);
      return value;
    };
    const initial = await access(authorize), proof = Object.freeze({ ...initial.proof! });
    const check = () => access(Object.freeze({ ...target, action: 'check' as const, proof }));
    const run = async (input: HubSessionSharingCommand) => {
      if (!validHubSessionSharingCommand(input)) throw new HubMemberRequestError(400);
      // Copy all caller-owned options before the first permission await.
      const command: HubSessionSharingCommand = Object.freeze(input.action === 'delete' || input.action === 'revocation' ? { ...input, proof }
        : { ...input, proof, options: Object.freeze({ ...input.options }) });
      await check();
      if (original.signal.aborted) throw new HubMemberRequestError(499);
      let value;
      try { value = (await this.persistence.run(45, () => this.owner.command('sessionSharing', {
        evidence, expectedScope: authority.recoveryScope, command,
      }))).value; }
      catch { await authority.check(); throw new HubMemberRequestError(503); }
      if (value === null) throw new HubMemberRequestError(401);
      await authority.check();
      if (!validHubSessionSharingReply(command, value)) throw new HubMemberRequestError(503);
      if (value.status !== 200 && value.status !== 201) throw new HubMemberRequestError(value.status);
      await check(); // Recheck exact read/share versions, never undo a committed effect.
      return value;
    };
    return {
      async check() { await check(); },
      async create(recipientId: string, role: 'observer' | 'collaborator', options: SessionShareOptions) {
        const value = await run({ ...target, proof, action: 'create', recipientId, role, options });
        if (!value.grant) throw new HubMemberRequestError(503);
        return { grant: value.grant };
      },
      async update(id: string, version: number, role: 'observer' | 'collaborator', options: SessionShareOptions) {
        const value = await run({ ...target, proof, action: 'update', id, version, role, options });
        if (!value.grant) throw new HubMemberRequestError(503);
        return { grant: value.grant };
      },
      async remove(id: string, version: number) {
        const value = await run({ ...target, proof, action: 'delete', id, version });
        if (typeof value.ok !== 'boolean') throw new HubMemberRequestError(503);
        return { ok: value.ok, ...(value.revocation ? { revocation: value.revocation } : {}) };
      },
      async revocation(id: string, version: number) {
        const value = await run({ ...target, proof, action: 'revocation', id, version });
        if (!value.revocation) throw new HubMemberRequestError(503);
        return { revocation: value.revocation };
      },
    };
  }
}
