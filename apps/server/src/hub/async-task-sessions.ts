import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { encodeHubMemberJson, type AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { HUB_TASK_SESSION_BYTES, validHubTaskSessionCommand, validHubTaskSessionResult,
  type HubTaskSessionCommand, type HubTaskSessionResult } from './member-task-session-domain.js';

/** Private original-ACK lane. The route drains its complete external effects
 * before retiring this lane; a cancelled browser never cancels committed SQL. */
export class AsyncHubTaskSessions {
  private readonly persistence: AuthRoutePersistence;
  private readonly requests: AsyncHubMemberRequests;
  constructor(private readonly database: Pick<AsyncHubMemberOwner,'command'>,
    diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
    this.persistence = new AuthRoutePersistence(diagnostics);
    this.requests = new AsyncHubMemberRequests(database,diagnostics);
  }
  async begin(request: Request) {
    const evidence = Object.freeze(hubMemberEvidence(request));
    const expected = request.headers.get('x-agentopsdeck-recovery-scope');
    let denied: HubMemberRequestError | undefined;
    const refuse = (status: ConstructorParameters<typeof HubMemberRequestError>[0]): never => {
      denied ??= new HubMemberRequestError(status); throw denied;
    };
    const current = () => { if (denied) throw denied; if (request.signal.aborted) refuse(499); };
    current();
    const snapshot = await this.requests.begin(request);
    current();
    if (expected !== null && expected !== snapshot.recoveryScope) return refuse(409);
    const proof = { evidence, expectedScope: snapshot.recoveryScope };
    const check = async ():Promise<void> => {
      current();
      await snapshot.check(); current();
    };
    const command = async <A extends HubTaskSessionCommand['action']>(input: HubTaskSessionCommand & {action:A}) => {
      current();
      // Freeze before the first await: caller-owned arrays cannot change the
      // fixed transaction intent while its original ACK is pending.
      const frozen = JSON.parse(encodeHubMemberJson(input, HUB_TASK_SESSION_BYTES)) as HubTaskSessionCommand;
      if (!validHubTaskSessionCommand(frozen)) return refuse(503);
      const value = (await this.persistence.run(109, () => this.database.command('taskSession', {...proof,command:frozen}))).value;
      await check();
      if (!validHubTaskSessionResult(value)) return refuse(503);
      if (!value) return refuse(401);
      if ('error' in value) throw new HubMemberRequestError(value.error);
      if (value.action !== frozen.action) return refuse(503);
      const r = value.receipt;
      if (r && (r.intent.owner !== snapshot.principal.userId || r.intent.boardId !== frozen.boardId
        || r.intent.requestId !== (frozen.action === 'prepare' ? frozen.input.requestId : frozen.id))) return refuse(503);
      return value as Extract<NonNullable<HubTaskSessionResult>,{action:A}>;
    };
    return { owner:snapshot.principal.userId, check, command };
  }
  async close() { await Promise.all([this.requests.close(),this.persistence.close()]); }
}
