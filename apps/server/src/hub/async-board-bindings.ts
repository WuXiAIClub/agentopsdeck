import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { HubMemberRequestError } from './async-member-request.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { validHubBoardBindingResult, type HubBoardBindingCommand, type HubBoardBindingResult } from './member-board-binding-domain.js';

/** Private ACK lane, closed by its route only after original effects drain. */
export class AsyncHubBoardBindings {
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
    const proof = { evidence,expectedScope:snapshot.recoveryScope };
    const command = async <A extends HubBoardBindingCommand['action']>(command: HubBoardBindingCommand & { action:A }) => {
      current();
      const value = (await this.persistence.run(100,() => this.owner.command('boardBinding',{...proof,command}))).value;
      current();
      if (!validHubBoardBindingResult(value)) return refuse(503);
      if (!value) return refuse(401);
      if ('error' in value) { if (value.error === 403) return refuse(403); throw new HubMemberRequestError(value.error); }
      if (value.action !== command.action) return refuse(503);
      if ('binding' in value && value.binding && (value.binding.boardId !== command.boardId
        || 'id' in command && value.binding.requestId !== command.id
        || 'target' in command && value.binding.sessionId !== command.target.sessionId
        || 'input' in command && (value.binding.requestId !== command.input.requestId || value.binding.sessionId !== command.input.sessionId))) return refuse(503);
      if (value.action === 'list' && value.bindings.some(b => b.boardId !== command.boardId)) return refuse(503);
      if (value.action === 'target' && 'sessionId' in command && value.target.sessionId !== command.sessionId) return refuse(503);
      return value as Extract<NonNullable<HubBoardBindingResult>,{ action:A }>;
    };
    const check = async () => {
      current();
      const now = (await this.persistence.run(6,() => this.owner.command('memberSnapshot',evidence))).value;
      current(); if (!now || now.recoveryScope !== proof.expectedScope || now.principal.userId !== snapshot.principal.userId) return refuse(403);
    };
    return { owner:snapshot.principal.userId,command,check };
  }
  close() { return this.persistence.close(); }
}
