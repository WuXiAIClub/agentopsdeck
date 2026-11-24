import { fork, type ChildProcess } from 'node:child_process';
import { createPrivateWorkerScope, WORKER_SCOPE_ENV, type PrivateWorkerScope } from '../connector/private-worker-scope.js';
import { fileURLToPath } from 'node:url';
import type { ClaudeConfig } from './config.js';
import type { ClaudeNativeTurn } from './dispatch-adapter.js';
import { claudeWorkerEnvironment } from './worker-environment.js';
import { validateClaudeProjection, type ClaudeProjectedMessage } from './message-projection.js';
import { validateClaudeToolDetails, type ClaudeToolDetail } from './tool-details.js';
import { validateClaudeTextStream, validateClaudeStreamFinal, type ClaudeTextStream, type ClaudeStreamFinal } from './stream-projection.js';
import { claudeLifecycleFrame, claudeWorkerFailureCodes, type ClaudeWorkerFailureCode, type ClaudeHistoryIdentity, type ClaudeWorkerReply, type ClaudeWorkerStart } from './worker-protocol.js';
import { validateSdkMetricSample, type SdkMetricSample } from '../connector/sdk-metrics.js';
import { WorkerInteractionPort, type WorkerInteractionContext } from '../commands/interaction-port.js';

const failed = () => new Error('Claude private worker outcome is unconfirmed');

/** Native-turn transport; the parent never loads SDK/config/credentials.
 * Only default-denied-tool workers are supported. A process-group check is
 * NOT a general proof for arbitrary tools that can detach their descendants. */
export class ClaudeWorkerTurn implements ClaudeNativeTurn {
  private readonly child: ChildProcess;
  private readonly interaction?: WorkerInteractionPort;
  private readonly scope: PrivateWorkerScope | undefined;
  private readonly pending: Record<string, unknown>[] = [];
  private wake: (() => void) | undefined;
  private ended = false;
  private bad = false;
  private streamError = false;
  private history: ClaudeHistoryIdentity[] | undefined;
  private exited = false;
  private iterationStarted = false;
  private interruptWaiter: { resolve: () => void; reject: (error: Error) => void } | undefined;
  private interruptTimer: ReturnType<typeof setTimeout> | undefined;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private exitTimer: ReturnType<typeof setTimeout> | undefined;
  readonly finished: Promise<void>;
  private failure: ClaudeWorkerFailureCode | undefined;
  private projectionIdentity: { uuid: string; parent: unknown } | undefined;
  private streamParent: { parent: unknown } | undefined;
  private metricIdentity: { id: string; type: unknown } | undefined;
  get failureCode() { return this.failure; }

  constructor(private readonly request: ClaudeWorkerStart,
    // Internal test/build injection, never accepted from Hub request payloads.
    launch: { entry: string; execArgv: string[]; beforeStart?: (pid: number) => Promise<void> } = {
      entry: fileURLToPath(new URL('./worker-main.js', import.meta.url)), execArgv: [],
    }, private readonly onProjection: (rows: ClaudeProjectedMessage[], stream?: ClaudeStreamFinal, details?: ClaudeToolDetail[]) => void = () => {},
    private readonly onStream: (snapshot: ClaudeTextStream) => void = () => {},
    private readonly onMetrics: (sample: SdkMetricSample) => void = () => {}, interaction?: WorkerInteractionContext) {
    if (!['linux', 'win32'].includes(process.platform)) throw new Error('Claude private worker supervision requires Linux or Windows');
    if (request.interactionMode === 'interactive' && !interaction) throw failed();
    this.request = structuredClone(request);
    this.scope = createPrivateWorkerScope(request.config);
    try {
      this.child = fork(launch.entry, [], { cwd: request.config.workspace, env: { ...claudeWorkerEnvironment(request.config), ...(this.scope ? { [WORKER_SCOPE_ENV]: this.scope.path } : {}) },
        execArgv: launch.execArgv, detached: process.platform !== 'win32', ...{ windowsHide: true }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json' });
    } catch (error) { this.scope?.close(); throw error; }
    if (interaction && request.interactionMode === 'interactive') this.interaction = new WorkerInteractionPort(
      { executionId: request.execution.id, epoch: request.execution.epoch }, interaction,
      frame => { this.child.send(frame, error => { if (error) this.fail(); }); },
      () => !this.bad && !this.ended && !this.exited && !this.history && !this.interruptWaiter);
    this.finished = new Promise(resolve => {
      this.child.once('exit', code => {
        try { this.interaction?.exited(); } catch { this.bad = true; } // audit failure must not strand child cleanup
        this.scope?.close();
        this.exited = true;
        clearTimeout(this.startupTimer); clearTimeout(this.exitTimer); clearTimeout(this.interruptTimer);
        if (code !== 0 || !this.history) this.bad = true;
        this.ended = true;
        this.interruptWaiter?.reject(failed()); this.interruptWaiter = undefined;
        this.wake?.(); resolve();
      });
      this.child.once('error', () => {
        this.fail();
        if (!this.child.pid) { this.scope?.close(); this.exited = true; resolve(); }
      });
    });
    this.child.on('message', message => this.receive(message));
    this.child.on('disconnect', () => {
      if (!this.history) this.fail();
    });
    this.startupTimer = setTimeout(() => this.fail(), request.config.startupTimeoutMs);
    const send = () => { if (!this.ended) this.child.send(this.request, error => { if (error) this.fail(); }); };
    if (launch.beforeStart && this.child.pid) {
      // Test harness registers nested detached ownership before any native
      // side effect, so cancellation can verify cleanup before deleting HOME.
      void launch.beforeStart(this.child.pid).then(send, () => { this.fail(); this.close(); });
    } else send();
  }

  async *[Symbol.asyncIterator]() {
    if (this.iterationStarted) throw failed();
    this.iterationStarted = true;
    while (!this.ended || this.pending.length) {
      if (this.pending.length) yield this.pending.shift()!;
      else await new Promise<void>(resolve => { this.wake = resolve; });
    }
    if (this.bad || this.streamError) throw failed();
  }

  interrupt(): Promise<void> {
    if (this.ended || this.bad || this.history || this.interruptWaiter) return Promise.reject(failed());
    this.interaction?.close('stopped');
    const promise = new Promise<void>((resolve, reject) => { this.interruptWaiter = { resolve, reject }; });
    this.interruptTimer = setTimeout(() => {
      this.interruptWaiter?.reject(failed()); this.interruptWaiter = undefined;
      // No automatic retry or kill on an unconfirmed interrupt ACK.
    }, this.request.config.startupTimeoutMs);
    this.child.send({ kind: 'interrupt' }, error => {
      if (error) { this.interruptWaiter?.reject(failed()); this.interruptWaiter = undefined; clearTimeout(this.interruptTimer); }
    });
    return promise;
  }

  async historyIdentities() { return structuredClone(this.history ?? []); }

  async inspectQuiescence() {
    if (!this.exited || this.bad || !this.history || !this.child.pid) return false;
    if (this.scope) return this.scope.quiescent();
    // Windows clean exit follows worker-side Job drain and guarded release.
    // Failure/forced termination never reaches this successful branch.
    if (process.platform === 'win32') return true;
    try { process.kill(-this.child.pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  }

  close() {
    this.interaction?.close('stopped');
    this.scope?.close();
    // Explicit owner shutdown, NOT an admission-timeout recovery/retry.
    // Never target other runtime/session workers or an unresolved PID.
    if (!this.exited || !this.history) this.fail();
    // The worker retains its own group-leader lifetime until descendants
    // drain (or self-terminates the group on deadline). Never signal a saved
    // PID after leader exit: that ID may already belong to another process.
    if (this.child.pid && !this.exited) {
      try { if (process.platform === 'win32') this.child.kill('SIGKILL'); else process.kill(-this.child.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') this.bad = true; }
    }
  }

  private fail() {
    this.interaction?.close();
    this.bad = true; this.ended = true;
    clearTimeout(this.startupTimer); clearTimeout(this.interruptTimer);
    this.interruptWaiter?.reject(failed()); this.interruptWaiter = undefined;
    this.wake?.();
    // An unknown execution may still be running. Do not kill on ACK loss.
  }

  private receive(message: unknown) {
    if (this.bad || this.exited) return;
    try {
      if (!message || typeof message !== 'object') throw failed();
      const reply = message as ClaudeWorkerReply;
      if (typeof reply.kind === 'string' && reply.kind.startsWith('interaction-')) {
        if (this.history || !this.interaction?.receive(message)) throw failed();
        return;
      }
      if (reply.kind === 'event') {
        if (this.history || this.pending.length >= 256) throw failed();
        const frame = claudeLifecycleFrame(reply.event);
        if (frame.session_id !== this.request.execution.nativeSessionId) throw failed();
        if (frame.type === 'system' && frame.subtype === 'init') clearTimeout(this.startupTimer);
        this.projectionIdentity = ['user', 'assistant'].includes(frame.type as string) && typeof frame.uuid === 'string'
          ? { uuid: frame.uuid, parent: frame.parent_tool_use_id } : undefined;
        this.streamParent = frame.type === 'stream_event' ? { parent: frame.parent_tool_use_id } : undefined;
        this.metricIdentity = (frame.parent_tool_use_id === null || frame.parent_tool_use_id === undefined)
          && (frame.type === 'assistant' || frame.type === 'result' || frame.type === 'system' && frame.subtype === 'compact_boundary')
          && typeof frame.uuid === 'string' ? { id: frame.uuid, type: frame.type } : undefined;
        this.pending.push(frame); this.wake?.();
      } else if (reply.kind === 'projection') {
        if (this.history || !this.projectionIdentity) throw failed();
        const rows = validateClaudeProjection(reply.rows, this.projectionIdentity.uuid, this.projectionIdentity.parent);
        const stream = reply.stream === undefined ? undefined : validateClaudeStreamFinal(reply.stream);
        const details = validateClaudeToolDetails(reply.details ?? [], rows);
        this.projectionIdentity = undefined;
        this.onProjection(rows, stream, details);
      } else if (reply.kind === 'stream') {
        if (this.history || !this.streamParent) throw failed();
        const snapshot = validateClaudeTextStream(reply.snapshot);
        if (snapshot.parentToolUseId !== this.streamParent.parent) throw failed();
        this.streamParent = undefined;
        this.onStream(snapshot);
      } else if (reply.kind === 'metrics') {
        if (this.history || reply.nativeSessionId !== this.request.execution.nativeSessionId || !this.metricIdentity) throw failed();
        const sample = validateSdkMetricSample(reply.sample);
        if (sample.eventId !== this.metricIdentity.id
          || sample.usage && (sample.usage.scope !== 'last-turn' || this.metricIdentity.type !== 'result')
          || sample.compacted && this.metricIdentity.type !== 'system'
          || sample.context && this.metricIdentity.type === 'result') throw failed();
        this.metricIdentity = undefined;
        this.onMetrics(sample);
      } else if (reply.kind === 'interrupted') {
        if (!this.interruptWaiter) throw failed();
        clearTimeout(this.interruptTimer);
        this.interruptWaiter.resolve(); this.interruptWaiter = undefined;
      } else if (reply.kind === 'finished') {
        if (this.history || !Array.isArray(reply.history) || reply.history.length > 10_000 || typeof reply.streamError !== 'boolean') throw failed();
        this.history = reply.history.map(row => {
          if (!row || !['user', 'assistant'].includes(row.type) || typeof row.uuid !== 'string' || row.uuid.length > 512
            || row.session_id !== this.request.execution.nativeSessionId
            || row.parent_tool_use_id !== null && (typeof row.parent_tool_use_id !== 'string' || row.parent_tool_use_id.length > 512)) throw failed();
          return { type: row.type, uuid: row.uuid, session_id: row.session_id, parent_tool_use_id: row.parent_tool_use_id };
        });
        this.streamError = reply.streamError;
        clearTimeout(this.startupTimer);
        // A finished IPC frame alone never proves worker/native exit.
        this.exitTimer = setTimeout(() => this.fail(), 12_000);
        this.child.send({ kind: 'finished-ack', id: this.request.execution.id,
          nativeSessionId: this.request.execution.nativeSessionId }, error => { if (error) this.fail(); });
      } else if (reply.kind === 'failed') {
        if (reply.code && claudeWorkerFailureCodes.includes(reply.code)) this.failure = reply.code;
        this.fail();
      } else throw failed();
    } catch { this.fail(); }
  }
}
