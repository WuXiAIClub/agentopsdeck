import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { validHubIssuerManagementCommand, validHubIssuerManagementResult,
  type HubIssuerManagementCommand } from './member-issuer-management-domain.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthReadCancelledError, AuthRouteReadWait } from '../auth/route-read-wait.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { copyOriginalRequest } from './original-request-scope.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { HubRequestWork } from './async-request-work.js';
import { ConnectorClient } from './connector-client.js';
import { ConnectorResponseBudgetPool } from './response-budget.js';
import type { Dispatch } from '../connector/transport.js';

export type LocalIssuerOperator = {
  create(hubId: string, createSessions?: boolean): { token: string; record: { id: string } } | Promise<{ token: string; record: { id: string } }>;
  revoke(id: string): boolean | Promise<boolean>;
  revokeRetiredGrant?: (input: { expectedNode: string; issuerTokenId: string; hubId: string; body: unknown }) =>
    import('../connector/connector-grant-domain.js').ConnectorGrantCommands['localRetiredGrantRevoke']['output']
    | Promise<import('../connector/connector-grant-domain.js').ConnectorGrantCommands['localRetiredGrantRevoke']['output']>;
};
type Local = { connectionId: string; dispatch: Dispatch };
export type IssuerManagementRequest = {
  read(): Promise<{ hubId: string; localSetupAllowed: boolean; issuer: { issuerId: string; nodeId: string; version: number; creationAllowed?: true } | null }>;
  check(): Promise<void>;
  configure(token: string): Promise<{ hubId: string; issuer: { issuerId: string; nodeId: string; version: number; creationAllowed?: true } }>;
  disable(): Promise<void>;
  provision(nodeVersion: unknown, createSessions: boolean): Promise<{ status: 200 | 201; issuer: { issuerId: string; nodeId: string; version: number; creationAllowed?: true } }>;
};
export type AsyncHubIssuerManagementPort = { open(request: Request, connectionId: string): Promise<IssuerManagementRequest>; close(): Promise<void> };

/** Original effects run here; original proof, pin, vault and policy transactions
 * stay in the sole owner. An unknown ACK fences this workflow, never retries. */
export class AsyncHubIssuerManagement implements AsyncHubIssuerManagementPort {
  private readonly work = new HubRequestWork(32);
  private readonly effects = new HubRequestWork(32);
  private readonly responses = new ConnectorResponseBudgetPool(32 * 8192);
  private readonly requests: AsyncHubMemberRequests;
  private readonly persistence: AuthRoutePersistence;
  private readonly reads: AuthRouteReadWait;
  private readonly drain: () => Promise<void>;
  private readonly pendingLocal = new Set<string>();
  private readonly local: Readonly<Local> | undefined;
  private readonly operator: Readonly<LocalIssuerOperator> | undefined;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>, local?: Local, operator?: LocalIssuerOperator,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30000, timeoutMs = 30000) {
    this.local = local ? Object.freeze({ ...local }) : undefined;
    this.operator = operator ? Object.freeze({ create: operator.create.bind(operator), revoke: operator.revoke.bind(operator) }) : undefined;
    this.requests = new AsyncHubMemberRequests(owner, diagnostics, warningMs, timeoutMs);
    this.persistence = new AuthRoutePersistence(diagnostics, warningMs);
    this.reads = new AuthRouteReadWait(this.persistence, diagnostics, timeoutMs);
    this.drain = createIndependentDrain([() => this.work.close(), () => this.effects.close(),
      () => this.requests.close(), () => this.persistence.close()], 'hub-route-drain', diagnostics);
  }
  close() { void this.work.close(); void this.effects.close(); return this.drain(); }
  private async effect<T>(step: number, run: () => Promise<T> | T): Promise<T> {
    const trace = guardedTrace(this.diagnostics, 'hub-issuer-management-effect'); trace.add('step', step);
    try { this.work.check(); const value = await run(); trace.add('settled', 1); trace.finish(); return value; }
    catch (error) { trace.add('unknown', 1); trace.finish(true); throw error; }
  }
  open(request: Request, connectionId: string) {
    const original = copyOriginalRequest(request);
    return this.work.run(() => this.openOriginal(original, connectionId));
  }
  private async openOriginal(original: Request, connectionId: string): Promise<IssuerManagementRequest> {
    if (!validHubIssuerManagementCommand({ connectionId, action: 'read' })) throw new HubMemberRequestError(404);
    const evidence = Object.freeze(hubMemberEvidence(original)), authority = await this.requests.begin(original);
    const expected = original.headers.get('x-agentopsdeck-recovery-scope');
    if (expected !== null && expected !== authority.recoveryScope) throw new HubMemberRequestError(409);
    let failure: HubMemberRequestError | undefined;
    type Action<C = HubIssuerManagementCommand> = C extends HubIssuerManagementCommand ? Omit<C, 'connectionId'> : never;
    const command = async (action: Action) => {
      const cleanup = action.action === 'cleanup';
      if (!cleanup) { this.work.check(); if (failure) throw failure; }
      const input = { connectionId, ...action } as HubIssuerManagementCommand;
      if (!validHubIssuerManagementCommand(input)) throw new HubMemberRequestError(409);
      let value;
      try {
        const run = () => this.owner.command('issuerManagement', { evidence, expectedScope: authority.recoveryScope, command: input });
        // Writes/cleanup own their original ACK, never the browser's read wait.
        value = (await (['install', 'disable', 'cleanup'].includes(action.action)
          ? this.persistence.run(96, run) : this.reads.run(original, 96, run))).value;
        if (!validHubIssuerManagementResult(value) || value && value.connectionId !== connectionId) throw Error('Invalid issuer reply');
      } catch (error) {
        failure = new HubMemberRequestError(error instanceof AuthReadCancelledError || original.signal.aborted ? 499 : 503);
        throw failure;
      }
      if (!value) { failure = new HubMemberRequestError(401); throw failure; }
      if ('error' in value.data) throw new HubMemberRequestError(value.data.error);
      if (value.data.action !== action.action) { failure = new HubMemberRequestError(503); throw failure; }
      return value.data;
    };
    const check = async () => {
      this.work.check(); if (failure) throw failure;
      try { await authority.check(); }
      catch (error) {
        // Persistence deliberately hides arbitrary original rejections. Keep
        // our own authority refusal before a Connector wait can box it.
        if (error instanceof HubMemberRequestError) failure = error;
        throw error;
      }
      this.work.check();
    };
    const configure = async (token: string, local: boolean, requireCreation = false, expectedVersion?: unknown,
      expectedPin?: string, expectedIssuer?: string) => {
      if (typeof token !== 'string' || !token.length || token.length > 4096 || /\s/.test(token)) throw new HubMemberRequestError(409);
      await check();
      const prepared = await command({ action: 'prepare', local });
      if (prepared.action !== 'prepare') throw new HubMemberRequestError(503);
      if (local && prepared.target.version !== expectedVersion) throw new HubMemberRequestError(409);
      if (expectedPin !== undefined && prepared.pin !== expectedPin) throw new HubMemberRequestError(409);
      const originalCheck = async () => { await check(); await command({ action: 'check', local, pin: prepared.pin }); };
      const transport = prepared.target.kind === 'local' ? this.local : undefined;
      if (prepared.target.kind === 'local' && transport?.connectionId !== connectionId) throw new HubMemberRequestError(503);
      const client = new ConnectorClient(transport ? 'http://connector.example.invalid' : prepared.target.origin, token,
        transport?.dispatch, 10000, 8192, { nodeId: prepared.target.nodeId, authorize: originalCheck,
          request(path, method) { if (method !== 'GET' || !['/execution-grants/issuer', '/execution-grants/issuer/creation'].includes(path)) throw new HubMemberRequestError(503); } });
      const network = async (path: string, step: number) => {
        try {
          return (await this.reads.run(original, 96, () => this.effects.run(async () => {
            const collector = this.responses.acquire(8192);
            try { return await this.effect(step, () => client.json<unknown>(path, { signal: original.signal }, collector)); }
            finally { collector.close(); }
          }))).value;
        } catch (error) {
          if (failure) throw failure;
          if (error instanceof AuthReadCancelledError || original.signal.aborted) {
            failure = new HubMemberRequestError(499); throw failure;
          }
          // A failed original probe is not a grant. Recheck current identity
          // before delivering the generic upstream error; never replay it.
          await check(); throw error;
        }
      };
      const identity = await network('/execution-grants/issuer', 1);
      if (!identity || typeof identity !== 'object' || Array.isArray(identity)) throw new HubMemberRequestError(409);
      const receipt = identity as Record<string, unknown>;
      if (receipt.nodeId !== prepared.target.nodeId || receipt.hubId !== prepared.hubId
        || typeof receipt.issuerTokenId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(receipt.issuerTokenId)) throw new HubMemberRequestError(409);
      if (expectedIssuer !== undefined && receipt.issuerTokenId !== expectedIssuer) throw new HubMemberRequestError(409);
      let creationAllowed = false;
      try {
        const capability = await network('/execution-grants/issuer/creation', 2) as Record<string, unknown> | null;
        creationAllowed = !!capability && capability.nodeId === receipt.nodeId && capability.hubId === receipt.hubId
          && capability.issuerTokenId === receipt.issuerTokenId && capability.creationAllowed === true;
      } catch { /* Older Connector may not expose optional creation capability. */ }
      await originalCheck();
      if (requireCreation && !creationAllowed) throw new HubMemberRequestError(409);
      const installed = await command({ action: 'install', local, pin: prepared.pin, token,
        issuerId: receipt.issuerTokenId, creationAllowed });
      if (installed.action !== 'install') throw new HubMemberRequestError(503);
      await check(); return { hubId: prepared.hubId, issuer: installed.issuer };
    };
    return {
      check,
      read: () => this.work.run(async () => {
        const value = await command({ action: 'read' });
        if (value.action !== 'read') throw new HubMemberRequestError(503);
        await check();
        return { hubId: value.hubId, issuer: value.issuer,
          localSetupAllowed: !!this.operator && this.local?.connectionId === connectionId && value.admin && value.kind === 'local' };
      }),
      configure: token => this.work.run(() => configure(token, false)),
      disable: () => this.work.run(async () => { await check(); await command({ action: 'disable' }); await check(); }),
      provision: (nodeVersion, createSessions) => this.work.run(async () => {
        if (!this.operator || this.local?.connectionId !== connectionId) throw new HubMemberRequestError(403);
        await check();
        const prepared = await command({ action: 'prepare', local: true });
        if (prepared.action !== 'prepare') throw new HubMemberRequestError(503);
        if (prepared.target.version !== nodeVersion) throw new HubMemberRequestError(409);
        const key = JSON.stringify([authority.principal.userId, connectionId]);
        if (this.pendingLocal.has(key)) throw new HubMemberRequestError(409);
        if (prepared.issuer && (!createSessions || prepared.issuer.creationAllowed)) return { status: 200, issuer: prepared.issuer };
        this.pendingLocal.add(key);
        let created: Awaited<ReturnType<LocalIssuerOperator['create']>> | undefined;
        try {
          await check(); await command({ action: 'check', local: true, pin: prepared.pin });
          created = (await this.persistence.run(96, () => this.effect(3, () => this.operator!.create(prepared.hubId, createSessions)))).value;
          await check();
          const result = await configure(created.token, true, createSessions, nodeVersion, prepared.pin, created.record.id);
          return { status: 201, issuer: result.issuer };
        } catch (error) {
          if (created) {
            try {
              const cleanup = await command({ action: 'cleanup', issuerId: created.record.id });
              if (cleanup.action === 'cleanup' && cleanup.neverInstalled) {
                await this.persistence.run(96, () => this.effect(4, () => this.operator!.revoke(created!.record.id)));
              }
            } catch { /* Unknown owner/identity/cleanup ACK: retain, never replay. */ }
          }
          throw error;
        } finally { this.pendingLocal.delete(key); }
      }),
    };
  }
}
