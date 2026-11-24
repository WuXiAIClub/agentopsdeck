import { createHash } from 'node:crypto';
import { advanceMaintenance, newMaintenanceJob, terminalMaintenanceJob, type MaintenanceAdapter, type MaintenanceJob, type MaintenanceOperation } from './connector-maintenance.js';
import { MaintenanceConflict } from './maintenance-journal.js';
import type { MaintenanceJournal } from './connector-maintenance.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';

export interface SupervisorMaintenanceJournal extends MaintenanceJournal {
  get(id: string): MaintenanceJob | undefined | Promise<MaintenanceJob | undefined>;
  unresolved(nodeId: string): MaintenanceJob | undefined | Promise<MaintenanceJob | undefined>;
  enqueue(job: MaintenanceJob): MaintenanceJob | Promise<MaintenanceJob>;
}

export class MaintenanceForbidden extends Error {
  constructor() { super('Lifecycle maintenance is not authorized'); }
}
export class MaintenanceInvalidRequest extends Error {
  constructor() { super('Invalid lifecycle maintenance request'); }
}
export type MaintenanceAuthority = (actorId: string, nodeId: string, operation?: MaintenanceOperation) => Promise<boolean>;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value);

/**
 * Independent supervisor request/worker boundary. There are no shell commands,
 * credentials, deployment paths or branch names in its request protocol.
 *
 * The host MUST run outside the target service and authenticate the local IPC
 * peer before passing an actor ID here. Authority must read current durable
 * node policy (not rely on the Connector process surviving stop()).
 */
export class MaintenanceSupervisor {
  readonly nodeId: string;
  private readonly operations: readonly MaintenanceOperation[];
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private activeStep: Promise<MaintenanceJob | undefined> | undefined;
  private readonly diagnostics: PerformanceDiagnostics;
  private readonly stallWarningMs: number;

  constructor(private readonly journal: SupervisorMaintenanceJournal, private readonly adapter: MaintenanceAdapter,
    private readonly authority: MaintenanceAuthority,
    options: { nodeId: string; operations: readonly MaintenanceOperation[]; timeoutMs?: number; now?: () => number;
      diagnostics?: PerformanceDiagnostics; stallWarningMs?: number;
      receiptJournal?: Pick<SupervisorMaintenanceJournal, 'get' | 'unresolved'> }) {
    if (!identifier(options.nodeId) || !Array.isArray(options.operations) || !options.operations.length
      || options.operations.some(operation => !['restart', 'upgrade', 'recover'].includes(operation))
      || new Set(options.operations).size !== options.operations.length) throw new MaintenanceInvalidRequest();
    const timeout = options.timeoutMs ?? 30 * 60 * 1000;
    if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 24 * 60 * 60 * 1000) throw new MaintenanceInvalidRequest();
    this.nodeId = options.nodeId; this.operations = [...options.operations]; this.timeoutMs = timeout;
    this.now = options.now ?? Date.now;
    this.stallWarningMs = options.stallWarningMs ?? 30_000;
    if (!Number.isSafeInteger(this.stallWarningMs) || this.stallWarningMs < 1000
      || this.stallWarningMs > 24 * 60 * 60 * 1000) throw new MaintenanceInvalidRequest();
    this.diagnostics = options.diagnostics ?? performanceDiagnostics;
    this.receiptJournal = options.receiptJournal ?? journal;
  }
  private readonly receiptJournal: Pick<SupervisorMaintenanceJournal, 'get' | 'unresolved'>;

  private async authorize(actorId: string, operation?: MaintenanceOperation) {
    if (!identifier(actorId) || !await this.authority(actorId, this.nodeId, operation)) throw new MaintenanceForbidden();
  }

  private id(actorId: string, key: string) {
    if (!identifier(key)) throw new MaintenanceInvalidRequest();
    // Namespaced by node + immutable credential identity, not bearer secret.
    return `maintenance:${createHash('sha256').update(JSON.stringify([this.nodeId, actorId, key])).digest('hex')}`;
  }

  async status(actorId: string) {
    await this.authorize(actorId);
    const unresolved = await this.receiptJournal.unresolved(this.nodeId);
    await this.authorize(actorId);
    // Another credential's command/actor details are private. Its existence is
    // enough to disable conflicting maintenance; guessing IDs cannot read it.
    return { version: 1 as const, nodeId: this.nodeId, operations: [...this.operations],
      blocked: Boolean(unresolved), automaticUpdates: false as const,
      ...(unresolved?.actorId === actorId ? { job: unresolved } : {}) };
  }

  async command(actorId: string, key: string) {
    await this.authorize(actorId);
    const job = await this.receiptJournal.get(this.id(actorId, key));
    await this.authorize(actorId);
    if (!job) return undefined;
    if (job.actorId !== actorId || job.nodeId !== this.nodeId) throw new MaintenanceConflict();
    return job;
  }

  async submit(actorId: string, input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MaintenanceInvalidRequest();
    const request = input as Record<string, unknown>;
    if (Object.keys(request).some(key => key !== 'commandKey' && key !== 'operation') || !identifier(request.commandKey)
      || !this.operations.includes(request.operation as MaintenanceOperation)) throw new MaintenanceInvalidRequest();
    // Capture the validated request before yielding to the authority provider.
    // In-process/IPC callers must not change the admitted identity mid-check.
    const commandKey = request.commandKey;
    const operation = request.operation as MaintenanceOperation;
    await this.authorize(actorId, operation);
    const id = this.id(actorId, commandKey), existing = await this.journal.get(id);
    await this.authorize(actorId, operation);
    if (existing) {
      if (existing.nodeId !== this.nodeId || existing.actorId !== actorId || existing.operation !== operation) throw new MaintenanceConflict();
      // Server-assigned timestamps never change on duplicate delivery.
      return existing;
    }
    const createdAt = this.now();
    const job = await this.journal.enqueue(newMaintenanceJob({ id, actorId, nodeId: this.nodeId, operation,
      createdAt, deadline: createdAt + this.timeoutMs }));
    // Revocation during an async commit prevents disclosure, not the durable
    // receipt. A later authorized lookup must reconcile that original receipt.
    await this.authorize(actorId, operation);
    return job;
  }

  /** One step only; durable admission and HTTP response never execute a stage. */
  tick(): Promise<MaintenanceJob | undefined> {
    if (this.activeStep) return this.activeStep;
    let trace: ReturnType<typeof guardedTrace>;
    let stalled = false;
    let hadJob = false;
    let warning: ReturnType<typeof setTimeout> | undefined;
    const work = async () => {
      // activeStep is already published: even reentrant diagnostic observers
      // must join the original durable stage, never launch another effect.
      trace = guardedTrace(this.diagnostics, 'maintenance-supervisor-step');
      warning = setTimeout(() => {
        stalled = true;
        const diagnostic = guardedTrace(this.diagnostics, 'maintenance-supervisor-step');
        diagnostic.add('pending', 1); diagnostic.add('unknown', 1); diagnostic.add('timedOut', 1);
        diagnostic.add('sampleMs', this.stallWarningMs);
        diagnostic.finish(true);
      }, this.stallWarningMs);
      warning.unref();
      const job = await this.journal.unresolved(this.nodeId);
      hadJob = !!job;
      // Persisted executing means unknown outcome after restart. Do not recover
      // automatically: only an operator with proof of worker exit may do that.
      if (!job || terminalMaintenanceJob(job) || job.executing) return job;
      const adapter = Object.create(this.adapter) as MaintenanceAdapter;
      adapter.authorize = async snapshot => this.operations.includes(snapshot.operation)
        && await this.authority(snapshot.actorId, snapshot.nodeId, snapshot.operation)
        && await this.adapter.authorize(snapshot);
      // Bind methods to the real adapter; class-based OS adapters may have
      // private fields that cannot be used through a prototype proxy.
      for (const name of ['prepare', 'inspect', 'fence', 'releaseFence', 'stop', 'stopped', 'backup', 'activate', 'start', 'ready'] as const) {
        Object.defineProperty(adapter, name, { value: this.adapter[name].bind(this.adapter) });
      }
      if (this.adapter.recover) Object.defineProperty(adapter, 'recover', { value: this.adapter.recover.bind(this.adapter) });
      return advanceMaintenance(job, this.journal, adapter, this.now);
    };
    const active = Promise.resolve().then(work).then(job => {
      trace.add('settled', 1);
      if (job?.executing || (hadJob && !job)) trace.add('unknown', 1);
      if (stalled) trace.add('timedOut', 1);
      trace.finish(job?.stage === 'attention' || !!job?.executing || (hadJob && !job));
      return job;
    }, error => {
      trace.add('unknown', 1);
      if (stalled) trace.add('timedOut', 1);
      trace.finish(true); throw error;
    }).finally(() => {
      if (warning) clearTimeout(warning);
      if (this.activeStep === active) this.activeStep = undefined;
    });
    this.activeStep = active;
    return active;
  }

  /** Wait for an already-invoked effect; never abandon it to an automatic retry. */
  async drainWorker() { await this.activeStep; }
}
