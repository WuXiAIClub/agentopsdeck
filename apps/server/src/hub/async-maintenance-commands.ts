import type { CommandReceipt } from '../commands/receipts.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthReadCancelledError, AuthRouteReadWait } from '../auth/route-read-wait.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { copyOriginalRequest } from './original-request-scope.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { HubRequestWork } from './async-request-work.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { ConnectorClient } from './connector-client.js';
import { maintenanceBoundary, validMaintenancePayload } from './maintenance-command-facts.js';
import type { LocalMaintenance } from './maintenance-commands.js';
import { validOwnerControlReceipt } from './member-owner-control-domain.js';
import { validHubMaintenanceReply, validHubMaintenanceTarget, type HubMaintenanceCommand, type HubMaintenanceTarget } from './member-maintenance-domain.js';

export type HubMaintenanceRequestPort = { check(): Promise<void>;
  send(key: string, payload: Record<string, unknown>): Promise<CommandReceipt>;
  recover(key: string): Promise<CommandReceipt | undefined> };
export type AsyncHubMaintenancePort = { open(request: Request, target: HubMaintenanceTarget): Promise<HubMaintenanceRequestPort>; close(): Promise<void> };

/** Complete original transactions in the sole owner; original ConnectorClient
 * effects stay on the main side. A timeout never releases an original claim. */
export class AsyncHubMaintenanceCommands implements AsyncHubMaintenancePort {
  private readonly work = new HubRequestWork(32);
  private readonly requests: AsyncHubMemberRequests;
  private readonly persistence: AuthRoutePersistence;
  private readonly reads: AuthRouteReadWait;
  private readonly drain: () => Promise<void>;
  private readonly local: Readonly<LocalMaintenance> | undefined;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>, local?: LocalMaintenance,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30000, timeoutMs = 30000) {
    this.local = local ? Object.freeze({ ...local }) : undefined;
    this.requests = new AsyncHubMemberRequests(owner, diagnostics, warningMs, timeoutMs);
    this.persistence = new AuthRoutePersistence(diagnostics, warningMs);
    this.reads = new AuthRouteReadWait(this.persistence, diagnostics, timeoutMs);
    this.drain = createIndependentDrain([() => this.work.close(), () => this.requests.close(), () => this.persistence.close()], 'hub-route-drain', diagnostics);
  }
  close() { void this.work.close(); return this.drain(); }
  private async network<T>(step: 4 | 5, run: () => Promise<T>) {
    const trace = this.diagnostics.start('hub-maintenance-effect'); trace.add('step', step);
    try { const value = await run(); trace.add('settled', 1); trace.finish(); return value; }
    catch (error) { trace.add('unknown', 1); trace.finish(true); throw error; }
  }
  open(request: Request, input: HubMaintenanceTarget) { return this.work.run(() => this.openOriginal(request, input)); }
  private async openOriginal(request: Request, input: HubMaintenanceTarget): Promise<HubMaintenanceRequestPort> {
    if (!validHubMaintenanceTarget(input)) throw new HubMemberRequestError(409);
    const target = Object.freeze({ connectionId: input.connectionId, operation: input.operation });
    const original = copyOriginalRequest(request);
    const evidence = Object.freeze(hubMemberEvidence(original)), authority = await this.requests.begin(original);
    this.work.check();
    let failed = false;
    const check = async () => { this.work.check(); if (failed) throw new HubMemberRequestError(503); await authority.check(); this.work.check(); };
    type Action<C = HubMaintenanceCommand> = C extends HubMaintenanceCommand ? Omit<C, 'target'> : never;
    const command = async (action: Action) => {
      this.work.check();
      if (failed) throw new HubMemberRequestError(503);
      const command = { ...action, target } as HubMaintenanceCommand;
      let value;
      try {
        const run = () => { this.work.check(); original.signal.throwIfAborted(); return this.owner.command('maintenanceCommand', { evidence, expectedScope: authority.recoveryScope, command }); };
        const result = action.action === 'claim' || action.action === 'observe'
          ? await this.persistence.run(91, run) : await this.reads.run(original, 91, run);
        this.work.check();
        if (!validHubMaintenanceReply(command, result.value)) throw new HubMemberRequestError(503);
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
      if (value.action !== 'effect') throw new HubMemberRequestError(503);
      const snapshot = value.effect;
      const local = snapshot.kind === 'local' ? this.local : undefined;
      if (snapshot.kind === 'local' && (!local || local.connectionId !== target.connectionId || !local.maintenanceToken || !local.dispatch)) throw new HubMemberRequestError(503);
      const path = `/${maintenanceBoundary(target)}/commands/${target.operation}${write ? '' : '/' + encodeURIComponent(snapshot.delivery)}`;
      const guard = async () => { await command({ action: 'effectCheck', key, write, digest: snapshot.digest }); };
      const client = new ConnectorClient(local ? 'http://connector.example.invalid' : snapshot.origin,
        local ? local.maintenanceToken : snapshot.credential!, local?.dispatch, 10000, 128 * 1024, {
          nodeId: snapshot.nodeId, authorize: guard, request: (requested, method) => {
            if (requested !== path || method !== (write ? 'POST' : 'GET')) throw new HubMemberRequestError(503);
          },
        });
      return { client, path, delivery: snapshot.delivery };
    };
    const observe = async (key: string, upstream: CommandReceipt) => {
      const value = await command({ action: 'observe', key, upstream });
      if (value.action !== 'observe') throw new HubMemberRequestError(503);
      await check(); return value.receipt;
    };
    const read = async (key: string): Promise<CommandReceipt | undefined> => {
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) throw new HubMemberRequestError(409);
      const value = await command({ action: 'get', key });
      if (value.action !== 'get') throw new HubMemberRequestError(503);
      if (!value.receipt || value.receipt.state !== 'outcome_unknown') { await check(); return value.receipt ?? undefined; }
      try {
        const { client, path } = await effect(key, false);
        const { command: upstream } = await this.network(5, () => client.json<{ command?: unknown }>(path, { signal: original.signal }));
        if (validOwnerControlReceipt(upstream)) return await observe(key, upstream);
      } catch { /* Recovery has one original GET authority, never another POST. */ }
      await check(); return value.receipt;
    };
    return {
      check,
      recover: key => this.work.run(() => read(key)),
      send: (key, payload) => {
        // Snapshot before yielding to work.run; downstream payload cannot drift.
        const body = structuredClone(payload);
        return this.work.run(async () => {
          if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key) || !validMaintenancePayload(target.operation, body)) throw new HubMemberRequestError(409);
          const prepared = await command({ action: 'prepare' });
          if (prepared.action !== 'prepare') throw new HubMemberRequestError(503);
          const claimed = await command({ action: 'claim', key, payload: body, pin: prepared.pin });
          if (claimed.action !== 'claim') throw new HubMemberRequestError(503);
          if (claimed.fresh) {
            try {
              const { client, path, delivery } = await effect(key, true);
              const response = await this.network(4, () => client.jsonResponse<Record<string, unknown> & { command?: unknown }>(path,
                { method: 'POST', signal: original.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, idempotencyKey: delivery }) }));
              if (response.body?.command) {
                const { command: upstream, ...result } = response.body;
                const receipt = { ...(typeof upstream === 'object' && upstream ? upstream : {}), result: { status: response.status, body: result } };
                if (validOwnerControlReceipt(receipt)) await observe(key, receipt);
              }
            } catch { /* Lost network/owner ACK retains original intent. */ }
          }
          return (await read(key))!;
        });
      },
    };
  }
}
