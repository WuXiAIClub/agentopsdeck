import { AsyncLocalStorage } from 'node:async_hooks';
import { CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { CommandCapacity, CommandConflict, type CommandReceipt } from '../commands/receipts.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { StorageAdmissionDeferred } from '../storage/work-admission.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { validConnectorUpdateOutput, type ConnectorUpdateCommands, type ConnectorUpdateKind,
  type UpdateOperatorEvidence, type UpdateOperatorMode } from './connector-update-domain.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';
import { UpdateAuthorizationError } from './update-service.js';
import type { UpdatePersistence, UpdateReceiptPort } from './update-persistence.js';
import { validAuthorizedMaintenanceOutput, validAuthorizedMaintenanceResumeOutput,
  type ConnectorAuthorizedMaintenanceCommands } from './connector-authorized-maintenance-domain.js';
import { validConnectorCodexResumeInput, type ConnectorCodexResumeCommands } from './connector-codex-resume-domain.js';
import type { CodexNativeJournal } from '../codex/app-server.js';
import { validConnectorMaintenanceInput, type ConnectorMaintenanceCommands, type ConnectorMaintenanceKind } from './connector-maintenance-domain.js';
import type { RuntimeMaintenanceCommandPort } from './runtime-maintenance-persistence.js';
import { checkMaintenanceLocal } from './maintenance-local-guard.js';

type Operator = { actorId: string; recover: boolean; check: () => Promise<void> };
type Context = { evidence: UpdateOperatorEvidence; operator: Operator; mode: UpdateOperatorMode };
/** Root-owned capability, never a public arbitrary receipt RPC. Every mutation
 * is made by the original updater under this captured operator context. */
export class AsyncUpdatePersistence implements UpdatePersistence {
  readonly asynchronous = true as const;
  readonly receipts: UpdateReceiptPort;
  readonly maintenance: RuntimeMaintenanceCommandPort = { command: (kind, input, check) => this.maintenanceCommand(kind, input, check) };
  /** Compose only prepare/begin. The original journal retains its exact ACK
   * settlement and projection refresh even after operator revocation. */
  maintenanceResumes(journal: Pick<CodexNativeJournal, 'finishResume'>, check: () => void):
    Pick<CodexNativeJournal, 'prepareResume' | 'beginResume' | 'finishResume'> {
    return {
      prepareResume: input => this.maintenanceResume('codexResumePrepare', input, check),
      beginResume: receipt => this.maintenanceResume('codexResumeBegin', receipt, check),
      finishResume: (receipt, outcome) => this.track(() => journal.finishResume(receipt, outcome)),
    };
  }
  private readonly context = new AsyncLocalStorage<Context>();
  private readonly pending = new Set<Promise<unknown>>();
  private closing = false;
  constructor(private readonly owner: Pick<AsyncConnectorOwner, 'command'>, readonly nodeId: string,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
    this.receipts = {
      get: async (scope, key) => (await this.read(scope, key)) ?? undefined,
      claim: (scope, key, payload) => this.claim(scope, key, payload, true),
      claimAsync: async (scope, key, payload, isolated, authorityId, admit, bind, settings, check, transactionCheck) => {
        if (isolated || authorityId !== undefined || admit || bind || settings || transactionCheck) throw Error('Invalid update persistence callback');
        check?.(); // Local lock ONLY. Worker owns the transaction permission check.
        const reply = await this.claim(scope, key, payload, false);
        check?.();
        return reply;
      },
      settle: async (scope, key, result) => {
        const original = await this.read(scope, key);
        if (!original) throw new CommandConflict('Original update receipt required');
        const reply = await this.command('updateReceiptSettle', { scope, key, receiptId: original.id, result });
        if (reply.scope !== scope || reply.key !== key || reply.receipt?.id !== original.id) throw Error('Invalid original update settlement');
        return reply.receipt;
      },
    };
  }
  private track<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing && !this.context.getStore()) return Promise.reject(new UpdateAuthorizationError());
    const pending = Promise.resolve().then(action);
    this.pending.add(pending);
    void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending));
    return pending;
  }
  private async command<K extends ConnectorUpdateKind>(kind: K, input: ConnectorUpdateCommands[K]['input']): Promise<
    Extract<ConnectorUpdateCommands[K]['output'], { status: 200 }>['value']> {
    const output = await this.track(() => this.owner.command(kind, input));
    if (!validConnectorUpdateOutput(kind, output)) throw Error('Invalid update owner response');
    if (output.status !== 200) {
      if (output.error === 'authority') throw new UpdateAuthorizationError();
      if (output.error === 'conflict') throw new CommandConflict('Update command identity conflict');
      if (output.error === 'capacity') throw new CommandCapacity('Command receipt capacity reached');
      throw new StorageAdmissionDeferred('Command storage admission unavailable');
    }
    return output.value as Extract<ConnectorUpdateCommands[K]['output'], { status: 200 }>['value'];
  }
  private async read(scope: string, key: string): Promise<CommandReceipt | null> {
    const reply = await this.command('updateReceiptInspect', { scope, key });
    if (reply.scope !== scope || reply.key !== key) throw Error('Invalid original update receipt');
    return reply.receipt;
  }
  private async claim(scope: string, key: string, payload: unknown, existing: boolean) {
    const current = this.context.getStore();
    if (!current) throw new UpdateAuthorizationError();
    await current.operator.check();
    const reply = await this.command('updateReceiptClaim', { scope, key, payload, existing,
      ...current.evidence, actorId: current.operator.actorId });
    if (reply.scope !== scope || reply.key !== key || !reply.receipt) throw Error('Invalid original update claim');
    return { fresh: reply.fresh, receipt: reply.receipt };
  }
  private maintenanceCommand<K extends ConnectorMaintenanceKind>(kind: K, input: ConnectorMaintenanceCommands[K]['input'],
    check: () => void = () => {}): Promise<ConnectorMaintenanceCommands[K]['output']> {
    const current = this.context.getStore();
    if (!current || current.mode !== 'readiness' || this.closing || !validConnectorMaintenanceInput(kind, input))
      return Promise.reject(new UpdateAuthorizationError());
    const original = structuredClone(input);
    return this.track(async () => {
      checkMaintenanceLocal(check);
      await current.operator.check();
      checkMaintenanceLocal(check);
      const output = await this.owner.command('runtimeMaintenanceAuthorized', { ...current.evidence,
        actorId: current.operator.actorId, kind, input: original } as ConnectorAuthorizedMaintenanceCommands['runtimeMaintenanceAuthorized']['input']);
      checkMaintenanceLocal(check);
      await current.operator.check();
      checkMaintenanceLocal(check);
      if (!validAuthorizedMaintenanceOutput(output) || output.status !== 200 || output.value.kind !== kind)
        throw new UpdateAuthorizationError();
      return output.value.value as ConnectorMaintenanceCommands[K]['output'];
    });
  }
  private maintenanceResume<K extends 'codexResumePrepare' | 'codexResumeBegin'>(kind: K,
    input: ConnectorCodexResumeCommands[K]['input'], check: () => void): Promise<ConnectorCodexResumeCommands[K]['output']> {
    const current = this.context.getStore();
    if (!current || current.mode !== 'readiness' || this.closing || !validConnectorCodexResumeInput(kind, input))
      return Promise.reject(new UpdateAuthorizationError());
    const original = structuredClone(input);
    return this.track(async () => {
      checkMaintenanceLocal(check);
      await current.operator.check();
      checkMaintenanceLocal(check);
      const output = await this.owner.command('runtimeMaintenanceResumeAuthorized', { ...current.evidence,
        actorId: current.operator.actorId, kind, input: original } as ConnectorAuthorizedMaintenanceCommands['runtimeMaintenanceResumeAuthorized']['input']);
      // An accepted prepare/begin is durable evidence. Do NOT discard that
      // receipt on late cancellation: the original executor must settle a
      // known prewrite as not_dispatched, or preserve an unknown begin ACK.
      if (!validAuthorizedMaintenanceResumeOutput(output) || output.status !== 200 || output.value.kind !== kind)
        throw new UpdateAuthorizationError();
      return output.value.value as ConnectorCodexResumeCommands[K]['output'];
    });
  }
  run<T>(request: Request, mode: UpdateOperatorMode, action: (operator: Operator) => Promise<T>): Promise<T> {
    if (this.closing || this.pending.size >= 32) return Promise.reject(new CommandCapacity('Update admission unavailable'));
    const evidence = { authorization: request.headers.get('authorization') ?? '',
      expectedNode: request.headers.get(EXPECTED_NODE_HEADER) ?? '', protocol: request.headers.get(CONNECTOR_PROTOCOL_HEADER) ?? '',
      originPresent: request.headers.has('origin') };
    return this.track(async () => {
      const trace = guardedTrace(this.diagnostics, 'connector-sqlite-command');
      trace.add('step', 341); let failed = true;
      const warning = setTimeout(() => trace.reportPending({ pending: 1 }), 30_000); warning.unref();
      try {
        if (request.signal.aborted || this.closing) throw new UpdateAuthorizationError();
        const original = await this.command('updateOperatorCheck', { ...evidence, mode });
        const actorId = original.actorId, recover = original.recover;
        let active = true;
        const check = async () => {
          if (!active || request.signal.aborted || this.closing) throw new UpdateAuthorizationError();
          const current = await this.command('updateOperatorCheck', { ...evidence, mode, actorId });
          if (current.actorId !== actorId || current.recover !== recover || !active || request.signal.aborted || this.closing)
            throw new UpdateAuthorizationError();
        };
        // action receives a copy; changing it cannot replace the captured evidence.
        const operator = { actorId, recover, check };
        try {
          const result = await this.context.run({ evidence, operator: { ...operator }, mode }, async () => {
            await check();
            const result = await action({ ...operator });
            await check(); // Do not deliver a private result after revocation/cancellation.
            return result;
          });
          failed = false; trace.add('settled', 1); return result;
        } finally { active = false; }
      } finally { clearTimeout(warning); trace.finish(failed); }
    });
  }
  async close(): Promise<void> {
    this.closing = true;
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
