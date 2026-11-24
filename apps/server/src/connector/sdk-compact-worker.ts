import { fork, type ChildProcess } from 'node:child_process';
import { createPrivateWorkerScope, WORKER_SCOPE_ENV, type PrivateWorkerScope } from './private-worker-scope.js';
import type { SdkCompactExecution } from './sdk-compact-dispatch.js';
import type { SdkCompactRef, SdkCompactResult, SdkCompactSettlement } from './sdk-execution-journal.js';

export type CompactWorkerRequest<C> = { kind: 'compact'; config: C; execution: SdkCompactExecution };
export type CompactWorkerReply = { kind: 'compact-finished'; proof: SdkCompactRef & SdkCompactResult };
export type SdkOwnedCompactWorker = Pick<SdkCompactWorker, 'result' | 'finished' | 'inspectSettlement' | 'inspectQuiescence' | 'interrupt' | 'close'>;
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,512}$/.test(v);
const failure = () => new Error('Native compact outcome is unconfirmed');

export function validateCompactExecution(execution: SdkCompactExecution, runtime: string) {
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  if (!execution || execution.kind !== 'compact' || !uuid.test(execution.id) || !uuid.test(execution.nativeSessionId)
    || !identifier(execution.key) || !execution.key.startsWith(`${runtime}:`) || !identifier(execution.epoch)
    || execution.nativeMode !== 'resume' || execution.phase !== 'dispatching' || !Array.isArray(execution.members) || execution.members.length !== 0
    || !execution.control || !identifier(execution.control.actorId)) throw failure();
}

/** Dedicated control transport. No prompt, summary, tool output or raw error
 * crosses IPC. Completion requires exact proof AND successful worker/group exit.
 * Cleanup after a failed call is not evidence that native compact succeeded. */
export class SdkCompactWorker {
  private readonly child: ChildProcess;
  private readonly scope: PrivateWorkerScope | undefined;
  private exited = false;
  private bad = false;
  private cleanExit = false;
  private proof?: SdkCompactRef & SdkCompactResult;
  private timer?: ReturnType<typeof setTimeout>;
  private stop: { resolve(): void; reject(error: Error): void } | undefined;
  private stopTimer?: ReturnType<typeof setTimeout>;
  readonly finished: Promise<void>;
  readonly result: Promise<SdkCompactRef & SdkCompactResult>;
  private readonly execution: SdkCompactExecution;
  private failure: string | undefined;
  get failureCode() { return this.failure; }

  constructor(request: CompactWorkerRequest<unknown>, options: {
    runtime: string; workspace: string; env: NodeJS.ProcessEnv; timeoutMs: number;
    launch: { entry: string; execArgv: string[]; beforeStart?: (pid: number) => Promise<void> };
  }) {
    validateCompactExecution(request.execution, options.runtime);
    if (!['linux', 'win32'].includes(process.platform) || !['claude-code', 'ghcp'].includes(options.runtime)) throw failure();
    const message = structuredClone(request); this.execution = message.execution;
    this.scope = createPrivateWorkerScope(request.config);
    try {
      this.child = fork(options.launch.entry, [], { cwd: options.workspace, env: { ...options.env, ...(this.scope ? { [WORKER_SCOPE_ENV]: this.scope.path } : {}) },
        execArgv: options.launch.execArgv, detached: process.platform !== 'win32', ...{ windowsHide: true }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json' });
    } catch (error) { this.scope?.close(); throw error; }
    this.finished = new Promise(resolve => {
      this.child.once('exit', code => {
        this.scope?.close();
        this.exited = true; clearTimeout(this.timer); clearTimeout(this.stopTimer);
        if (code !== 0 || !this.proof) this.bad = true;
        this.cleanExit = code === 0 && !!this.proof && !this.bad;
        this.stop?.reject(failure()); this.stop = undefined; resolve();
      });
      this.child.once('error', () => {
        this.close();
        if (!this.child.pid) { this.exited = true; resolve(); }
      });
    });
    this.result = this.finished.then(async () => {
      if (this.bad || !this.proof || this.scope && !this.scope.quiescent() || !await this.inspectQuiescence()) throw failure();
      return structuredClone(this.proof);
    });
    void this.result.catch(() => {});
    this.child.on('message', value => {
      if (this.bad || this.exited) return;
      const frame = value as CompactWorkerReply | { kind: 'interrupted' } | { kind: 'failed'; code?: string };
      if (frame?.kind === 'failed') {
        // Enumerated stage only; never forward a native diagnostic or content.
        this.failure = ['configuration', 'policy', 'credential', 'native', 'process-group', 'history'].includes(frame.code ?? '') ? frame.code : 'native';
        this.close(); return;
      }
      if (frame?.kind === 'interrupted' && this.stop) {
        clearTimeout(this.stopTimer); this.stop.resolve(); this.stop = undefined; return;
      }
      const proof = frame?.kind === 'compact-finished' ? frame.proof : undefined;
      if (!proof || typeof proof !== 'object' || this.proof || Object.keys(proof).sort().join(',') !== 'completionEventId,epoch,id,key,nativeRequestId,nativeSessionId,outcome'
        || proof.id !== this.execution.id || proof.key !== this.execution.key || proof.epoch !== this.execution.epoch
        || proof.nativeSessionId !== this.execution.nativeSessionId || proof.nativeRequestId !== this.execution.id
        || !identifier(proof.completionEventId) || proof.outcome !== 'completed') { this.close(); return; }
      this.proof = structuredClone(proof); clearTimeout(this.timer);
      this.timer = setTimeout(() => this.close(), 12_000);
    });
    this.child.on('disconnect', () => { if (!this.proof) this.close(); });
    this.timer = setTimeout(() => this.close(), options.timeoutMs);
    const send = () => { if (!this.bad && !this.exited) this.child.send(message, error => { if (error) this.close(); }); };
    if (options.launch.beforeStart && this.child.pid) void options.launch.beforeStart(this.child.pid).then(send, () => this.close());
    else send();
  }

  interrupt(): Promise<void> {
    if (this.bad || this.exited || this.proof || this.stop) return Promise.reject(failure());
    return new Promise((resolve, reject) => {
      this.stop = { resolve, reject };
      this.stopTimer = setTimeout(() => { this.stop?.reject(failure()); this.stop = undefined; }, 10_000);
      this.child.send({ kind: 'interrupt-compact' }, error => {
        if (error) { clearTimeout(this.stopTimer); this.stop?.reject(failure()); this.stop = undefined; }
      });
    });
  }
  async inspectSettlement(): Promise<SdkCompactSettlement> {
    const proof = await this.result;
    return { id: proof.id, key: proof.key, epoch: proof.epoch, nativeSessionId: proof.nativeSessionId,
      completionEventId: proof.completionEventId, historyPersisted: true, nativeQuiescent: await this.inspectQuiescence() };
  }
  async inspectQuiescence() {
    // Cleanup inspection is separate from result certification. The driver
    // closes a completed control before checking cleanup; close marks the
    // transport bad but must not turn a verified empty scope into a live one.
    if (this.scope) return this.exited && this.scope.cleaned();
    if (!this.exited) return false;
    if (!this.child.pid) return true;
    if (process.platform === 'win32') return this.cleanExit;
    try { process.kill(-this.child.pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  }
  close() {
    this.scope?.close();
    this.bad = true; clearTimeout(this.timer); clearTimeout(this.stopTimer);
    this.stop?.reject(failure()); this.stop = undefined;
    if (this.child.pid && !this.exited) {
      try { if (process.platform === 'win32') this.child.kill('SIGKILL'); else process.kill(-this.child.pid, 'SIGKILL'); } catch { /* quiescence checked separately */ }
    }
  }
}
