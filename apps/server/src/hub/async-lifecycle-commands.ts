import type { ConnectorLifecycleReceipt, ConnectorLifecycleStatus } from '@agentopsdeck/shared';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthReadCancelledError, AuthRouteReadWait } from '../auth/route-read-wait.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { copyOriginalRequest } from './original-request-scope.js';
import type { MaintenanceJob } from '../lifecycle/connector-maintenance.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { HubRequestWork } from './async-request-work.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { LifecycleClient } from './lifecycle-client.js';
import { lifecyclePublicStatus, type LifecycleEffect } from './lifecycle-command-facts.js';
import { validHubLifecycleReply, validHubLifecycleTarget, type HubLifecycleCommand, type HubLifecycleTarget } from './member-lifecycle-domain.js';

export type HubLifecycleRequestPort = {
  check(): Promise<void>;
  status(): Promise<ConnectorLifecycleStatus>;
  send(key: string): Promise<ConnectorLifecycleReceipt>;
  recover(key: string): Promise<ConnectorLifecycleReceipt | undefined>;
};
export type AsyncHubLifecyclePort = {
  open(request: Request, target: HubLifecycleTarget): Promise<HubLifecycleRequestPort>;
  close(): Promise<void>;
};

/** Identity and complete receipt transactions execute in the original owner.
 * Only the original strict LifecycleClient performs external effects. */
export class AsyncHubLifecycleCommands implements AsyncHubLifecyclePort {
  private readonly work = new HubRequestWork(32);
  private readonly requests: AsyncHubMemberRequests;
  private readonly persistence: AuthRoutePersistence;
  private readonly reads: AuthRouteReadWait;
  private readonly drain: () => Promise<void>;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30000, timeoutMs = 30000) {
    this.requests = new AsyncHubMemberRequests(owner, diagnostics, warningMs, timeoutMs);
    this.persistence = new AuthRoutePersistence(diagnostics, warningMs);
    this.reads = new AuthRouteReadWait(this.persistence, diagnostics, timeoutMs);
    this.drain = createIndependentDrain([() => this.work.close(), () => this.requests.close(), () => this.persistence.close()], 'hub-route-drain', diagnostics);
  }
  close() { void this.work.close(); return this.drain(); }
  /** Numeric protocol phases only; never log a target, key, URL or credential.
   * The original effect remains owned by work/drain, not this observation. */
  private async network<T>(step: 1 | 2 | 3, operation: () => Promise<T>): Promise<T> {
    const trace = this.diagnostics.start('hub-maintenance-effect');
    trace.add('step', step);
    try { const value = await operation(); trace.add('settled', 1); trace.finish(); return value; }
    catch (error) { trace.add('unknown', 1); trace.finish(true); throw error; }
  }
  open(request: Request, target: HubLifecycleTarget): Promise<HubLifecycleRequestPort> {
    return this.work.run(() => this.openOriginal(request, target));
  }
  private async openOriginal(request: Request, input: HubLifecycleTarget): Promise<HubLifecycleRequestPort> {
    if (!validHubLifecycleTarget(input)) throw new HubMemberRequestError(409);
    const target = Object.freeze({ connectionId: input.connectionId, operation: input.operation });
    const original = copyOriginalRequest(request);
    const evidence = Object.freeze(hubMemberEvidence(original)), authority = await this.requests.begin(original);
    this.work.check();
    let failed = false;
    const check = async () => { this.work.check(); if (failed) throw new HubMemberRequestError(503); await authority.check(); this.work.check(); };
    type Action<C = HubLifecycleCommand> = C extends HubLifecycleCommand ? Omit<C, 'target'> : never;
    const command = async (action: Action) => {
      this.work.check();
      if (failed) throw new HubMemberRequestError(503);
      const command = { ...action, target } as HubLifecycleCommand;
      let value;
      try {
        const run = () => { this.work.check(); original.signal.throwIfAborted(); return this.owner.command('lifecycleCommand', { evidence, expectedScope: authority.recoveryScope, command }); };
        const result = action.action === 'claim' || action.action === 'observe'
          ? await this.persistence.run(90, run) : await this.reads.run(original, 90, run);
        this.work.check();
        if (!validHubLifecycleReply(command, result.value)) throw new HubMemberRequestError(503);
        value = result.value;
      } catch (error) {
        failed = true;
        throw new HubMemberRequestError(error instanceof AuthReadCancelledError || original.signal.aborted ? 499 : 503);
      }
      if (!value) throw new HubMemberRequestError(401);
      if ('error' in value) throw new HubMemberRequestError(value.error);
      return value;
    };
    const effect = async (key: string, write: boolean) => {
      const value = await command({ action: 'effect', key, write });
      if (value.action !== 'effect' || !value.effect?.delivery) throw new HubMemberRequestError(503);
      const snapshot = value.effect;
      const guard = async () => { await command({ action: 'effectCheck', key, write, digest: snapshot.digest }); };
      return { client: new LifecycleClient(snapshot.nodeId, snapshot.origin, snapshot.credential, guard), delivery: snapshot.delivery!, guard };
    };
    const observe = async (key: string, job: MaintenanceJob) => {
      const value = await command({ action: 'observe', key, job });
      if (value.action !== 'observe') throw new HubMemberRequestError(503);
      await check(); return value.observation;
    };
    const read = async (key: string): Promise<ConnectorLifecycleReceipt | undefined> => {
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) throw new HubMemberRequestError(409);
      const value = await command({ action: 'get', key });
      if (value.action !== 'get') throw new HubMemberRequestError(503);
      if (!value.receipt) return undefined;
      try {
        const { client, delivery } = await effect(key, false);
        const job = await this.network(3, () => client.command(delivery, target.operation, original.signal));
        return await observe(key, job);
      } catch { /* No new authority, endpoint or POST for historical recovery. */ }
      await check(); return { command: value.receipt, observationUnavailable: true };
    };
    const status = async (): Promise<ConnectorLifecycleStatus> => {
      const value = await command({ action: 'status' });
      if (value.action !== 'status') throw new HubMemberRequestError(503);
      if (!value.effect) { await check(); return { configured: false }; }
      const snapshot: LifecycleEffect = value.effect;
      const guard = async () => { await command({ action: 'statusCheck', digest: snapshot.digest }); };
      const result = await this.network(1, () => new LifecycleClient(snapshot.nodeId, snapshot.origin, snapshot.credential, guard).status(original.signal));
      await guard(); await check(); return lifecyclePublicStatus(result);
    };
    return {
      check,
      status: () => this.work.run(status),
      recover: key => this.work.run(() => read(key)),
      send: key => this.work.run(async () => {
        if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) throw new HubMemberRequestError(409);
        const prepared = await command({ action: 'prepare' });
        if (prepared.action !== 'prepare') throw new HubMemberRequestError(503);
        const claimed = await command({ action: 'claim', key, pin: prepared.pin });
        if (claimed.action !== 'claim') throw new HubMemberRequestError(503);
        if (claimed.fresh) {
          try {
            const { client, delivery } = await effect(key, true);
            const job = await this.network(2, () => client.command(delivery, target.operation, original.signal, true));
            return await observe(key, job);
          } catch { /* Unknown ACK can ONLY lead to original GET. */ }
        }
        return (await read(key))!;
      }),
    };
  }
}
