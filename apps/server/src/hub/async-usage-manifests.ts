import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { HubMemberRequestError } from './async-member-request.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import type { HubUsageManifestCommand } from './member-usage-manifest-domain.js';

/** Private route lane. No cancel/deadline race: original owner work belongs to
 * this lane through its ACK. Route work drains effects before closing it. */
export class AsyncHubUsageManifests {
  private readonly persistence: AuthRoutePersistence;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner,'command'>, diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
    this.persistence = new AuthRoutePersistence(diagnostics);
  }
  async begin(request: Request) {
    const evidence = Object.freeze(hubMemberEvidence(request));
    const expected = request.headers.get('x-agentopsdeck-recovery-scope');
    let denied: HubMemberRequestError | undefined;
    const refuse = (status: ConstructorParameters<typeof HubMemberRequestError>[0]): never => { denied ??= new HubMemberRequestError(status); throw denied; };
    const current = () => { if (denied) throw denied; if (request.signal.aborted) refuse(499); };
    current();
    const snapshot = (await this.persistence.run(6, () => this.owner.command('memberSnapshot',evidence))).value;
    current(); if (!snapshot) return refuse(401);
    if (expected !== null && expected !== snapshot.recoveryScope) return refuse(409);
    const proof = { evidence, expectedScope: snapshot.recoveryScope };
    const command = async (command: HubUsageManifestCommand) => {
      current();
      const result = (await this.persistence.run(99, () => this.owner.command('usageManifest',{ ...proof,command }))).value;
      current(); if (!result) return refuse(401);
      if ('error' in result) { if (result.error === 403) return refuse(403); throw new HubMemberRequestError(result.error); }
      if (result.action !== command.action) return refuse(503);
      return result;
    };
    const check = async () => {
      current();
      const now = (await this.persistence.run(6, () => this.owner.command('memberSnapshot',evidence))).value;
      current(); if (!now || now.recoveryScope !== proof.expectedScope || now.principal.userId !== snapshot.principal.userId) return refuse(403);
    };
    return { owner: snapshot.principal.userId, command, check };
  }
  close() { return this.persistence.close(); }
}
