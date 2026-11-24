import { fork, type ChildProcess } from 'node:child_process';
import { createPrivateWorkerScope, WORKER_SCOPE_ENV, type PrivateWorkerScope } from './private-worker-scope.js';

export type PrivateWorkerDeletion = { kind: 'delete-native'; id: string; nativeSessionId: string };
export type PrivateWorkerPreflightFailure = { kind: 'preflight-failed' };

/** Control-only startup/deletion worker. Never admits user input. Success requires
 * the exact ACK, successful process exit and absence of its process group. */
export class PrivateWorkerPreflight {
  private readonly child: ChildProcess;
  private readonly scope: PrivateWorkerScope | undefined;
  private exited = false;
  private transportClosed = false;
  private accepted = false;
  private failed = false;
  private failedCleanupAcknowledged = false;
  private failedCleanupConfirmed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  readonly finished: Promise<void>;
  readonly ready: Promise<boolean>;

  constructor(request: { kind: 'preflight'; config: unknown } | (PrivateWorkerDeletion & { config: unknown }), options: {
    workspace: string; env: NodeJS.ProcessEnv; timeoutMs: number;
    launch: { entry: string; execArgv: string[]; beforeStart?: (pid: number) => Promise<void> };
  }) {
    if (!['linux', 'win32'].includes(process.platform)) throw new Error('Private worker startup verification requires Linux or Windows');
    const message = structuredClone(request), { launch } = options;
    this.scope = createPrivateWorkerScope(request.config);
    try {
      this.child = fork(launch.entry, [], { cwd: options.workspace, env: { ...options.env, ...(this.scope ? { [WORKER_SCOPE_ENV]: this.scope.path } : {}) },
        execArgv: launch.execArgv, detached: process.platform !== 'win32', ...{ windowsHide: true }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json' });
    } catch (error) { this.scope?.close(); throw error; }
    this.finished = new Promise(resolve => {
      this.child.once('exit', () => {
        this.scope?.close();
        this.exited = true; clearTimeout(this.timer);
      });
      // Exit can precede buffered IPC; only close completes the protocol.
      this.child.once('close', code => {
        this.exited = true; this.transportClosed = true; clearTimeout(this.timer);
        this.failedCleanupConfirmed = !this.failed && this.failedCleanupAcknowledged && code === 1;
        if (code !== 0 || !this.accepted) this.failed = true;
        resolve();
      });
      this.child.once('error', () => {
        this.close();
        if (!this.child.pid) { this.exited = true; clearTimeout(this.timer); }
      });
    });
    this.ready = this.finished.then(() => !this.failed && this.accepted
      && (!this.scope || this.scope.quiescent()) && this.inspectQuiescence());
    this.child.on('message', value => {
      if (this.failed || this.transportClosed) return;
      const frame = value as Record<string, unknown> | null;
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) { this.close(); return; }
      const failedCleanup = request.kind === 'preflight' && Object.keys(frame).length === 1 && frame.kind === 'preflight-failed';
      const valid = request.kind === 'preflight'
        ? Object.keys(frame).length === 1 && frame.kind === 'preflight-complete'
        : Object.keys(frame).length === 3 && frame.kind === 'delete-complete'
          && frame.id === request.id && frame.nativeSessionId === request.nativeSessionId;
      if ((!valid && !failedCleanup) || this.accepted || this.failedCleanupAcknowledged) { this.close(); return; }
      this.accepted = valid;
      this.failedCleanupAcknowledged = failedCleanup;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.close(), 12_000);
    });
    this.timer = setTimeout(() => this.close(), options.timeoutMs);
    const send = () => {
      if (!this.failed && !this.exited) this.child.send(message, error => { if (error) this.close(); });
    };
    if (launch.beforeStart && this.child.pid) void launch.beforeStart(this.child.pid).then(send, () => this.close());
    else send();
  }

  inspectQuiescence(): boolean {
    if (!this.exited || !this.transportClosed) return false;
    if (this.scope) return this.scope.cleaned();
    if (!this.child.pid) return true;
    // A failed preflight can prove physical cleanup without becoming ready.
    // Its separate ACK is valid only with the expected, uncancelled exit.
    if (process.platform === 'win32') return !this.failed && this.accepted || this.failedCleanupConfirmed;
    try { process.kill(-this.child.pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  }
  close() {
    this.scope?.close();
    if (!this.transportClosed) this.failed = true;
    clearTimeout(this.timer);
    // Control workers never admit inference. Deletion timeout is UNKNOWN, not
    // permission to retry. Cancellation targets only this still-live
    // worker, never a cached PID after exit or an unrelated native session.
    if (this.child.pid && !this.exited) {
      try { if (process.platform === 'win32') this.child.kill('SIGKILL'); else process.kill(-this.child.pid, 'SIGKILL'); } catch { /* inspection fails closed */ }
    }
  }
}
