import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { HubMemberRequestError } from './async-member-request.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { validHubDelegationResult, type HubDelegationCommand, type HubDelegationResult } from './member-delegation-domain.js';

/** Private original-ACK lane. Neither HTTP abort nor close can release an
 * accepted SQL command early; the enclosing route drains effects before close. */
export class AsyncHubDelegations {
  private readonly persistence: AuthRoutePersistence;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner,'command'>, private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
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
    const command = async <A extends HubDelegationCommand['action']>(input: HubDelegationCommand & {action:A}) => {
      current();
      const result = (await this.persistence.run(101,() => this.owner.command('delegation',{...proof,command:input}))).value;
      current();
      if (!validHubDelegationResult(result)) return refuse(503);
      if (!result) return refuse(403);
      if ('error' in result) { if (result.error === 403) return refuse(403); throw new HubMemberRequestError(result.error); }
      if (result.action !== input.action) return refuse(503);
      if ('batch' in result && result.batch && (result.batch.owner !== snapshot.principal.userId
        || result.batch.preview.resource.resourceId !== input.boardId
        || !('batchId' in input) || result.batch.batchId !== input.batchId)) return refuse(503);
      if (result.action === 'snapshot' && result.snapshot.board.resourceId !== input.boardId) return refuse(503);
      if ('requestId' in result && (!('requestId' in input) || result.requestId !== input.requestId
        || result.batchId !== input.batchId)) return refuse(503);
      if (result.action === 'claim' && result.intent && (result.intent.owner !== snapshot.principal.userId
        || result.intent.boardId !== input.boardId)) return refuse(503);
      return result as Extract<NonNullable<HubDelegationResult>,{action:A}>;
    };
    const check = async () => {
      current(); const now = (await this.persistence.run(6,() => this.owner.command('memberSnapshot',evidence))).value;
      current(); if (!now || now.principal.userId !== snapshot.principal.userId || now.recoveryScope !== proof.expectedScope) return refuse(403);
    };
    const effect = (step:number) => {
      const trace = this.diagnostics.start('hub-delegation-effect');
      trace.add('step',step); trace.reportPending(); return trace;
    };
    return {owner:snapshot.principal.userId,command,check,effect};
  }
  close() { return this.persistence.close(); }
}
