import { fork, type ChildProcess } from 'node:child_process';
import { createPrivateWorkerScope, WORKER_SCOPE_ENV, type PrivateWorkerScope } from '../connector/private-worker-scope.js';
import { fileURLToPath } from 'node:url';
import { COPILOT_CLI_VERSION, COPILOT_PROTOCOL_VERSION, type CopilotNativeTurn, type CopilotHistoryIdentity } from './dispatch-adapter.js';
import { copilotWorkerEnvironment } from './worker-environment.js';
import { copilotLifecycleFrame, copilotHistoryIdentities, type CopilotWorkerReply, type CopilotWorkerStart, type CopilotLifecycleFrame } from './worker-protocol.js';
import { validateCopilotProjection, type CopilotProjectedMessage } from './message-projection.js';
import { validateCopilotStream, type CopilotTextStream } from './stream-projection.js';
import { validateCopilotToolDetail, type CopilotToolDetail } from './tool-details.js';
import { validateSdkMetricSample, type SdkMetricSample } from '../connector/sdk-metrics.js';
import { WorkerInteractionPort, type WorkerInteractionContext } from '../commands/interaction-port.js';

const failed = () => new Error('Copilot private worker outcome is unconfirmed');
export type CopilotWorkerLaunch = { entry: string; execArgv: string[]; beforeStart?: (pid: number) => Promise<void> };
export type CopilotWorkerProjection = { project?: (row: CopilotProjectedMessage, detail?: CopilotToolDetail) => void;
  stream?: (snapshot: CopilotTextStream) => void; metrics?: (sample: SdkMetricSample) => void; interaction?: WorkerInteractionContext };
export const copilotWorkerLaunch = (): CopilotWorkerLaunch => ({ entry: fileURLToPath(new URL('./worker-main.js', import.meta.url)), execArgv: [] });

/** Parent never imports SDK or reads credentials. Completion requires valid
 * durable identities AND observed process exit/group absence, not native idle. */
export class CopilotWorkerTurn implements CopilotNativeTurn {
  private readonly child: ChildProcess;
  private readonly interaction?: WorkerInteractionPort;
  private readonly scope: PrivateWorkerScope | undefined;
  private readonly pending: CopilotLifecycleFrame[] = [];
  private wake: (() => void) | undefined;
  private ended = false;
  private bad = false;
  private exited = false;
  private iterated = false;
  private handshake = false;
  private ack = false;
  private history: CopilotHistoryIdentity[] | undefined;
  private projectionFrame: CopilotLifecycleFrame | undefined;
  private interruptWaiter: { resolve: () => void; reject: (error: Error) => void } | undefined;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private interruptTimer: ReturnType<typeof setTimeout> | undefined;
  private exitTimer: ReturnType<typeof setTimeout> | undefined;
  private verify!: (value: Awaited<CopilotNativeTurn['verified']>) => void;
  private rejectVerify!: (error: Error) => void;
  private admit!: (value: { messageId: string }) => void;
  private rejectAdmit!: (error: Error) => void;
  readonly verified: CopilotNativeTurn['verified'];
  readonly admitted: CopilotNativeTurn['admitted'];
  readonly finished: Promise<void>;

  constructor(private readonly request: CopilotWorkerStart, launch: CopilotWorkerLaunch = copilotWorkerLaunch(),
    private readonly projection: CopilotWorkerProjection = {}) {
    if (!['linux', 'win32'].includes(process.platform)) throw new Error('Copilot private worker supervision requires Linux or Windows');
    if (request.interactionMode === 'interactive' && !projection.interaction) throw failed();
    this.request = structuredClone(request);
    this.verified = new Promise((resolve, reject) => { this.verify = resolve; this.rejectVerify = reject; });
    this.admitted = new Promise((resolve, reject) => { this.admit = resolve; this.rejectAdmit = reject; });
    void this.verified.catch(() => {}); void this.admitted.catch(() => {});
    this.scope = createPrivateWorkerScope(request.config);
    try {
      this.child = fork(launch.entry, [], { cwd: request.config.workspace, env: { ...copilotWorkerEnvironment(request.config), ...(this.scope ? { [WORKER_SCOPE_ENV]: this.scope.path } : {}) },
        execArgv: launch.execArgv, detached: process.platform !== 'win32', ...{ windowsHide: true }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json' });
    } catch (error) { this.scope?.close(); throw error; }
    if (projection.interaction && request.interactionMode === 'interactive') this.interaction = new WorkerInteractionPort(
      { executionId: request.execution.id, epoch: request.execution.epoch }, projection.interaction,
      frame => { this.child.send(frame, error => { if (error) this.fail(); }); },
      () => !this.bad && !this.ended && !this.exited && !this.history && !this.interruptWaiter);
    this.finished = new Promise(resolve => {
      this.child.once('exit', code => {
        try { this.interaction?.exited(); } catch { this.bad = true; } // audit failure must not strand child cleanup
        this.scope?.close();
        this.exited = true;
        if (code !== 0 || !this.history) this.fail();
        this.ended = true;
        clearTimeout(this.startupTimer); clearTimeout(this.interruptTimer); clearTimeout(this.exitTimer);
        this.interruptWaiter?.reject(failed()); this.interruptWaiter = undefined;
        this.wake?.(); resolve();
      });
      this.child.once('error', () => {
        this.fail(); if (!this.child.pid) { this.scope?.close(); this.exited = true; resolve(); }
      });
    });
    this.child.on('message', value => this.receive(value));
    this.child.on('disconnect', () => { if (!this.history) this.fail(); });
    this.startupTimer = setTimeout(() => this.fail(), request.config.startupTimeoutMs);
    const send = () => { if (!this.ended) this.child.send(this.request, error => { if (error) this.fail(); }); };
    if (launch.beforeStart && this.child.pid) void launch.beforeStart(this.child.pid).then(send, () => { this.fail(); this.close(); });
    else send();
  }

  async *[Symbol.asyncIterator]() {
    if (this.iterated) throw failed();
    this.iterated = true;
    while (!this.ended || this.pending.length) {
      if (this.pending.length) yield this.pending.shift()!;
      else await new Promise<void>(resolve => { this.wake = resolve; });
    }
    if (this.bad) throw failed();
  }
  interrupt(): Promise<void> {
    if (this.ended || this.bad || !this.handshake || this.history || this.interruptWaiter) return Promise.reject(failed());
    this.interaction?.close('stopped');
    const promise = new Promise<void>((resolve, reject) => { this.interruptWaiter = { resolve, reject }; });
    this.interruptTimer = setTimeout(() => { this.interruptWaiter?.reject(failed()); this.interruptWaiter = undefined; }, this.request.config.startupTimeoutMs);
    this.child.send({ kind: 'interrupt' }, error => {
      if (error) { clearTimeout(this.interruptTimer); this.interruptWaiter?.reject(failed()); this.interruptWaiter = undefined; }
    });
    return promise;
  }
  async historyIdentities() { return { sessionId: this.request.execution.nativeSessionId, entries: structuredClone(this.history ?? []) }; }
  async inspectQuiescence() {
    if (!this.exited || this.bad || !this.history || !this.child.pid) return false;
    if (this.scope) return this.scope.quiescent();
    if (process.platform === 'win32') return true;
    try { process.kill(-this.child.pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  }
  async inspectCleaned() {
    if (!this.exited) return false;
    if (!this.child.pid) return true;
    if (this.scope) return this.scope.cleaned();
    if (process.platform === 'win32') return !this.bad;
    try { process.kill(-this.child.pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  }
  close() {
    this.interaction?.close('stopped');
    this.scope?.close();
    if (!this.exited || !this.history) this.fail();
    // Explicit cleanup only. A timeout alone never retries or signals native.
    if (this.child.pid && !this.exited) {
      try { if (process.platform === 'win32') this.child.kill('SIGKILL'); else process.kill(-this.child.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') this.bad = true; }
    }
  }
  private fail() {
    this.interaction?.close();
    this.bad = true; this.ended = true;
    clearTimeout(this.startupTimer); clearTimeout(this.interruptTimer); clearTimeout(this.exitTimer);
    this.rejectVerify(failed()); this.rejectAdmit(failed());
    this.interruptWaiter?.reject(failed()); this.interruptWaiter = undefined;
    this.wake?.();
  }
  private receive(value: unknown) {
    if (this.bad || this.exited) return;
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw failed();
      const reply = value as CopilotWorkerReply;
      if (typeof reply.kind === 'string' && reply.kind.startsWith('interaction-')) {
        if (!this.handshake || this.history || !this.interaction?.receive(value)) throw failed();
        return;
      }
      if (reply.kind === 'verified') {
        if (this.handshake || reply.sessionId !== this.request.execution.nativeSessionId || reply.version !== COPILOT_CLI_VERSION
          || reply.protocolVersion !== COPILOT_PROTOCOL_VERSION) throw failed();
        this.handshake = true; this.verify({ sessionId: reply.sessionId, version: reply.version, protocolVersion: reply.protocolVersion });
      } else if (reply.kind === 'admitted') {
        if (!this.handshake || this.ack || this.history || typeof reply.messageId !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(reply.messageId)) throw failed();
        this.ack = true; clearTimeout(this.startupTimer); this.admit({ messageId: reply.messageId });
      } else if (reply.kind === 'event') {
        if (!this.handshake || this.history || this.pending.length >= 256) throw failed();
        const event = copilotLifecycleFrame(reply.event);
        this.projectionFrame = event; this.pending.push(event); this.wake?.();
      } else if (reply.kind === 'projection') {
        if (!this.handshake || this.history || !this.projectionFrame) throw failed();
        const row = validateCopilotProjection(reply.row, this.projectionFrame);
        const detail = validateCopilotToolDetail(reply.detail, row);
        this.projectionFrame = undefined; this.projection.project?.(row, detail);
      } else if (reply.kind === 'stream') {
        if (!this.handshake || this.history) throw failed();
        this.projectionFrame = undefined;
        this.projection.stream?.(validateCopilotStream(reply.snapshot));
      } else if (reply.kind === 'metrics') {
        const event = this.projectionFrame;
        if (!this.handshake || this.history || reply.nativeSessionId !== this.request.execution.nativeSessionId
          || !event || event.agentId !== undefined || event.data.parentToolCallId !== undefined
          || !['session.usage_info', 'assistant.usage', 'session.compaction_complete'].includes(event.type)) throw failed();
        const sample = validateSdkMetricSample(reply.sample);
        if (sample.eventId !== event.id || sample.usage && (sample.usage.scope !== 'last-call' || event.type !== 'assistant.usage')
          || sample.compacted && event.type !== 'session.compaction_complete'
          || sample.context && event.type === 'assistant.usage') throw failed();
        this.projectionFrame = undefined; this.projection.metrics?.(sample);
      } else if (reply.kind === 'interrupted') {
        if (!this.interruptWaiter) throw failed();
        clearTimeout(this.interruptTimer); this.interruptWaiter.resolve(); this.interruptWaiter = undefined;
      } else if (reply.kind === 'finished') {
        if (!this.handshake || !this.ack || this.history || reply.sessionId !== this.request.execution.nativeSessionId
          || !Array.isArray(reply.history) || reply.history.length > 10_000) throw failed();
        this.history = copilotHistoryIdentities(reply.history.map(row => ({ id: row.id, type: row.type, data: row })));
        // Don't finish iteration before actual exit. Native idle + history is
        // not permission to release the durable queue or HOME ownership.
        this.exitTimer = setTimeout(() => this.fail(), 12_000);
      } else throw failed();
    } catch { this.fail(); }
  }
}
