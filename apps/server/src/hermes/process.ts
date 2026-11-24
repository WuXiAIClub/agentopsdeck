import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { prepareExecutionHome, verifyExecutionBinary, verifyExecutionDirectory } from '../execution/private-environment.js';
import type { HermesConfig } from './config.js';
import { HermesRpcPeer } from './rpc-peer.js';
import { parseHermesEvent, readyEpoch, record, type HermesEvent } from './protocol.js';

// Fail closed before importing the backend: its default auto-continue may repeat
// tools on resume. Do not rewrite the user's config or echo its content/errors.
const bootstrap = `import os,sys,runpy
try:
 import fcntl
 lock_fd=os.open(os.path.join(os.environ['HERMES_HOME'],'agentopsdeck-connector.lock'),os.O_CREAT|os.O_RDWR,0o600)
 fcntl.flock(lock_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 import yaml
 with open(os.path.join(os.environ['HERMES_HOME'],'config.yaml')) as f: c=yaml.safe_load(f)
 assert c['desktop']['auto_continue']['enabled'] is False
except Exception:
 sys.exit(78)
runpy.run_module('tui_gateway.entry',run_name='__main__')`;

export class HermesProcess {
  private child: ChildProcessWithoutNullStreams | undefined;
  private peer: HermesRpcPeer | undefined;
  private starting: Promise<void> | undefined;
  private stopped = false;
  private lost = false;
  private exited: Promise<void> = Promise.resolve();
  ready = false;
  epoch: string | undefined;
  constructor(private readonly config: HermesConfig,
    private readonly event: (event: HermesEvent) => void,
    private readonly disconnected: () => void,
    private readonly launch = () => {
      verifyExecutionDirectory(config.sourceDirectory);
      verifyExecutionDirectory(config.workspace);
      const executable = verifyExecutionBinary(config.executable);
      const environment = prepareExecutionHome(config.homeDirectory, [config.sourceDirectory, config.workspace, executable]);
      return spawn(executable, ['-B', '-c', bootstrap], {
        cwd: config.sourceDirectory,
        env: { ...environment, PYTHONPATH: config.sourceDirectory, PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1',
          HERMES_HOME: config.homeDirectory, TERMINAL_CWD: config.workspace }, stdio: 'pipe',
      });
    }) {}

  start(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Hermes process is closed'));
    return this.starting ??= this.boot();
  }
  private async boot() {
    let rejectReady: (error: Error) => void = () => {};
    let resolveReady: () => void = () => {};
    const waiting = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const timer = setTimeout(() => rejectReady(new Error('Hermes startup timed out')), this.config.startupTimeoutMs);
    try {
      const child = this.child = this.launch();
      this.exited = new Promise(resolve => child.once('close', () => resolve()));
      // Native stderr can contain prompts/provider credentials. Drain, never log.
      child.stderr.resume();
      const lost = () => {
        if (this.lost) return;
        this.lost = true;
        this.ready = false; this.peer?.close(); rejectReady(new Error('Hermes process unavailable'));
        this.disconnected();
      };
      child.once('error', lost); child.once('exit', lost);
      this.peer = new HermesRpcPeer(child.stdout, child.stdin, {
        onClose: lost,
        onNotification: (method, params) => {
          if (method !== 'event') return;
          const event = parseHermesEvent(params);
          if (event.type === 'gateway.ready') { this.epoch = readyEpoch(event); resolveReady(); }
          else this.event(event);
        },
      });
      await waiting;
      const capabilities = await this.peer.request('gateway.capabilities');
      if (!record(capabilities) || capabilities.per_session_exclusive_submit !== true) throw new Error('Hermes lacks exclusive submit support');
      await this.peer.request('client.capabilities', { server_requests: false });
      if (child.exitCode !== null || this.stopped || this.lost) throw new Error('Hermes process unavailable');
      this.ready = true;
    } catch { await this.close(); throw new Error('Hermes failed readiness checks; verify dedicated configuration and pinned backend'); }
    finally { clearTimeout(timer); }
  }
  request(method: string, params: unknown = {}) {
    if (!this.ready || !this.peer) return Promise.reject(new Error('Hermes is not ready'));
    return this.peer.request(method, params);
  }
  async close() {
    this.stopped = true; this.ready = false; this.peer?.close();
    const child = this.child;
    if (!child) return;
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 2_000);
    child.kill('SIGTERM');
    try { await this.exited; } finally { clearTimeout(timer); }
  }
}
