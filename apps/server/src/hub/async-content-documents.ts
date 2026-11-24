import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { HubMemberRequestError } from './async-member-request.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { validHubContentDocumentCommand, validHubContentDocumentReply, type HubContentDocumentCommand } from './member-content-document-domain.js';

/** Own original ACKs through browser abort and shutdown. Never cancel/replay. */
export class AsyncHubContentDocuments {
  private readonly persistence: AuthRoutePersistence;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner,'command'>, diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
    this.persistence = new AuthRoutePersistence(diagnostics);
  }
  async begin(request: Request) {
    const evidence = Object.freeze(hubMemberEvidence(request)), expected = request.headers.get('x-agentopsdeck-recovery-scope');
    let denied: HubMemberRequestError | undefined;
    const refuse = (status: ConstructorParameters<typeof HubMemberRequestError>[0]): never => { denied ??= new HubMemberRequestError(status); throw denied; };
    const current = () => { if (denied) throw denied; if (request.signal.aborted) refuse(499); };
    current();
    const snapshot = (await this.persistence.run(6,() => this.owner.command('memberSnapshot',evidence))).value;
    current(); if (!snapshot) return refuse(401);
    if (expected !== null && expected !== snapshot.recoveryScope) return refuse(409);
    const proof = {evidence,expectedScope:snapshot.recoveryScope};
    const check = async () => {
      current(); const now = (await this.persistence.run(6,() => this.owner.command('memberSnapshot',evidence))).value;
      current(); if (!now || now.principal.userId !== snapshot.principal.userId || now.recoveryScope !== proof.expectedScope) return refuse(403);
    };
    const command = async (input: HubContentDocumentCommand) => {
      current();
      if (!validHubContentDocumentCommand(input)) throw new HubMemberRequestError(400);
      const frozen = Object.freeze({...input});
      const result = (await this.persistence.run(102,() => this.owner.command('contentDocument',{...proof,command:frozen}))).value;
      current();
      if (!validHubContentDocumentReply(frozen,result)) return refuse(503);
      if (!result) return refuse(403);
      if ('error' in result) throw new HubMemberRequestError(result.error);
      await check(); return result;
    };
    return {command,check,recoveryScope:proof.expectedScope};
  }
  close() { return this.persistence.close(); }
}
