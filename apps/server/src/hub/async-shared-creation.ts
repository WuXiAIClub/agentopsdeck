import type { CommandReceipt } from '../commands/receipts.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthReadCancelledError, AuthRouteReadWait } from '../auth/route-read-wait.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { Dispatch } from '../connector/transport.js';
import { HubRequestWork } from './async-request-work.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { ConnectorClient, ConnectorClientError } from './connector-client.js';
import { ConnectorResponseBudgetPool, type ConnectorResponseCollector } from './response-budget.js';
import { validOwnerControlReceipt } from './member-owner-control-domain.js';
import { copyOriginalRequest, pinOriginalRequestScope } from './original-request-scope.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { validHubSharedCreationReply, validHubSharedCreationTarget, validSharedCreationPayload,
  type HubSharedCreationCommand, type HubSharedCreationTarget } from './member-shared-creation-domain.js';

export type HubSharedCreationRequest = { check(): Promise<void>;
  send(key: string, payload: { label: string }): Promise<CommandReceipt>;
  recover(key: string): Promise<CommandReceipt | undefined> };
export type AsyncHubSharedCreationPort = { open(request: Request, target: HubSharedCreationTarget): Promise<HubSharedCreationRequest>; close(): Promise<void> };
type Local = { connectionId: string; dispatch: Dispatch };

/** SQL and identity stay together in the sole owner; only original Connector
 * effects leave it. Unknown owner ACK permanently fences this request. */
export class AsyncHubSharedCreation implements AsyncHubSharedCreationPort {
  private readonly work = new HubRequestWork(32);
  private readonly effects = new HubRequestWork(32);
  private readonly responses = new ConnectorResponseBudgetPool(4 * 1024 * 1024);
  private readonly requests: AsyncHubMemberRequests;
  private readonly persistence: AuthRoutePersistence;
  private readonly reads: AuthRouteReadWait;
  private readonly drain: () => Promise<void>;
  private readonly local: Readonly<Local> | undefined;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>, local?: Local,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30000, timeoutMs = 30000) {
    this.local = local ? Object.freeze({ ...local }) : undefined;
    this.requests = new AsyncHubMemberRequests(owner, diagnostics, warningMs, timeoutMs);
    this.persistence = new AuthRoutePersistence(diagnostics, warningMs);
    this.reads = new AuthRouteReadWait(this.persistence, diagnostics, timeoutMs);
    this.drain = createIndependentDrain([() => this.work.close(), () => this.effects.close(), () => this.requests.close(), () => this.persistence.close()], 'hub-route-drain', diagnostics);
  }
  close() { void this.work.close(); void this.effects.close(); return this.drain(); }
  private async network<T>(request: Request, step: 1 | 2, run: (collector: ConnectorResponseCollector) => Promise<T>) {
    // HTTP may stop waiting, but original dispatch/body cancellation still owns
    // an effect slot and byte reservation until ConnectorClient's drain ACK.
    // No late continuation may observe/settle SQL or authorize another POST.
    let connectorError: ConnectorClientError | undefined;
    try {
      return (await this.reads.run(request, 95, () => this.effects.run(async () => {
        const collector = this.responses.acquire(128 * 1024);
        try {
          const trace = guardedTrace(this.diagnostics, 'hub-shared-creation-effect'); trace.add('step', step);
          try { const value = await run(collector); trace.add('settled', 1); trace.finish(); return value; }
          catch (error) {
            if (error instanceof ConnectorClientError) connectorError = error;
            trace.add('unknown', 1); trace.finish(true); throw error;
          }
        } finally { collector.close(); }
      }))).value;
    } catch (error) {
      if (connectorError) throw connectorError;
      throw error;
    }
  }
  open(request: Request, input: HubSharedCreationTarget): Promise<HubSharedCreationRequest> {
    // Snapshot BEFORE queuing: caller mutation cannot change target or evidence.
    if (!validHubSharedCreationTarget(input)) return Promise.reject(new HubMemberRequestError(409));
    const target = Object.freeze({ ...input });
    const original = copyOriginalRequest(request);
    return this.work.run(() => this.openOriginal(original, target));
  }
  private async openOriginal(original: Request, target: HubSharedCreationTarget): Promise<HubSharedCreationRequest> {
    const evidence = Object.freeze(hubMemberEvidence(original)), authority = await this.requests.begin(original);
    const expected = original.headers.get('x-agentopsdeck-recovery-scope');
    if (expected !== null && expected !== authority.recoveryScope) throw new HubMemberRequestError(409);
    pinOriginalRequestScope(original, authority.recoveryScope);
    this.work.check();
    let failure: HubMemberRequestError | undefined, pin: string | undefined;
    type Action<C = HubSharedCreationCommand> = C extends HubSharedCreationCommand ? Omit<C, 'target' | 'pin'> : never;
    const command = async (action: Action) => {
      this.work.check();
      if (failure) throw failure;
      const command = { ...action, target, ...(action.action === 'prepare' ? {} : { pin }) } as HubSharedCreationCommand;
      let value;
      try {
        const run = () => { this.work.check(); original.signal.throwIfAborted(); return this.owner.command('sharedCreation', { evidence, expectedScope: authority.recoveryScope, command }); };
        const result = action.action === 'claim' || action.action === 'observe'
          ? await this.persistence.run(95, run) : await this.reads.run(original, 95, run);
        this.work.check();
        if (!validHubSharedCreationReply(command, result.value)) throw new HubMemberRequestError(503);
        value = result.value;
      } catch (error) {
        failure = new HubMemberRequestError(error instanceof AuthReadCancelledError || original.signal.aborted ? 499 : 503);
        throw failure;
      }
      if (!value) { failure = new HubMemberRequestError(401); throw failure; }
      if ('error' in value.data) { failure = new HubMemberRequestError(value.data.error); throw failure; }
      return value.data;
    };
    const prepared = await command({ action: 'prepare' });
    if (prepared.action !== 'prepare') throw new HubMemberRequestError(503);
    pin = prepared.pin;
    const check = async () => {
      this.work.check(); if (failure) throw failure;
      await authority.check(); await command({ action: 'check' }); this.work.check();
    };
    const effect = async (key: string, write: boolean) => {
      const value = await command({ action: 'effect', key, write });
      if (value.action !== 'effect') throw new HubMemberRequestError(503);
      const snapshot = value.effect, local = snapshot.kind === 'local' ? this.local : undefined;
      if (snapshot.kind === 'local' && (!local || local.connectionId !== target.connectionId)) throw new HubMemberRequestError(503);
      const path = '/agents/codex/sessions' + (write ? '' : '/creation-commands/' + encodeURIComponent(snapshot.delivery));
      const client = new ConnectorClient(local ? 'http://connector.example.invalid' : snapshot.origin, snapshot.credential,
        local?.dispatch, 10000, 128 * 1024, { nodeId: snapshot.nodeId,
          authorize: async () => { await command({ action: 'effectCheck', key, write, digest: snapshot.digest }); },
          request: (requested, method) => {
            if (requested !== path || method !== (write ? 'POST' : 'GET')) throw new HubMemberRequestError(503);
          } });
      return { client, path, delivery: snapshot.delivery };
    };
    const observe = async (key: string, upstream: CommandReceipt) => {
      const value = await command({ action: 'observe', key, upstream });
      if (value.action !== 'observe') throw new HubMemberRequestError(503);
      await check(); return value.receipt ?? undefined;
    };
    const read = async (key: string): Promise<CommandReceipt | undefined> => {
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) throw new HubMemberRequestError(409);
      const value = await command({ action: 'get', key });
      if (value.action !== 'get') throw new HubMemberRequestError(503);
      if (!value.receipt || value.receipt.state !== 'outcome_unknown') { await check(); return value.receipt ?? undefined; }
      try {
        const { client, path } = await effect(key, false);
        const { command: upstream } = await this.network(original, 2, collector => client.json<{ command?: unknown }>(path, { signal: original.signal }, collector));
        if (validOwnerControlReceipt(upstream)) return await observe(key, upstream);
      } catch { /* GET original delivery only; owner failures remain fenced. */ }
      await check(); return value.receipt;
    };
    return {
      check,
      recover: key => this.work.run(() => read(key)),
      send: (key, payload) => {
        const body = structuredClone(payload);
        return this.work.run(async () => {
          if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key) || !validSharedCreationPayload(body)) throw new HubMemberRequestError(409);
          const claimed = await command({ action: 'claim', key, payload: body });
          if (claimed.action !== 'claim') throw new HubMemberRequestError(503);
          if (claimed.fresh) {
            try {
              const { client, path, delivery } = await effect(key, true);
              const response = await this.network(original, 1, collector => client.jsonResponse<{ key?: unknown; command?: unknown }>(path, {
                method: 'POST', signal: original.signal, headers: { 'content-type': 'application/json', 'idempotency-key': delivery }, body: JSON.stringify(body),
              }, collector));
              const upstream = response.body?.command;
              if (validOwnerControlReceipt(upstream)) {
                const receipt = { ...upstream, result: { status: response.status, body:
                  typeof response.body.key === 'string' ? { key: response.body.key } : {} } };
                if (validOwnerControlReceipt(receipt)) await observe(key, receipt);
              }
            } catch { /* HTTP failure is not a bound terminal receipt; recover the original delivery only. */ }
          }
          const receipt = await read(key);
          if (!receipt) throw new HubMemberRequestError(503);
          return receipt;
        });
      },
    };
  }
}
