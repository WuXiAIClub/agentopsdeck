import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { windowsAsyncControlOutput } from '../connector/windows-async-control.js';
import { WINDOWS_JOB_SOURCE } from '../connector/windows-worker-job.js';
import { windowsControlEnvironment, windowsPowerShell, powershellArguments } from '../connector/windows-private-worker.js';

// Reuse the ABI declarations already covered by the SDK guardian. Unlike the
// SDK job, this job owns a gated bootstrap, not the Connector process itself.
// No native spawn is authorized before the exact bootstrap identity is assigned.
export const WINDOWS_PROCESS_JOB_SOURCE = WINDOWS_JOB_SOURCE.replace('public static void Run(uint pid, string created) {', `
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
 public static void Run(uint pid, string created) {`).replace(
  'if (line=="empty") {', `if (line=="stop") {
     Require(TerminateJobObject(job,1));
     do {
      Require(QueryInformationJobObject(job,1,out count,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero));
      if (count.ActiveProcesses!=0) System.Threading.Thread.Sleep(25);
     } while (count.ActiveProcesses!=0);
     Console.WriteLine("drained"); Console.Out.Flush(); return;
    } else if (line=="empty") {`);
const script = (action: string) => "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n" + WINDOWS_PROCESS_JOB_SOURCE + "\n'@\n" + action;
const failure = () => new Error('Windows native process supervision unconfirmed');

export class WindowsProcessJob {
  readonly drained: Promise<void>;
  private resolveDrain!: () => void;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readonly ready: Promise<void>;
  private readonly guardian: ChildProcessWithoutNullStreams;
  private assigned = false;
  private confirmed = false;
  private stopped = false;
  private dead = false;
  private constructor(pid: number, identity: string, temporary: string) {
    this.drained = new Promise(resolve => { this.resolveDrain = resolve; });
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.guardian = spawn(windowsPowerShell(), powershellArguments(script('[AgentOpsDeckWorkerJob]::Run([uint32]$env:AOD_JOB_PID,$env:AOD_JOB_CREATED)')), {
      env: windowsControlEnvironment({ AOD_JOB_PID: String(pid), AOD_JOB_CREATED: identity, TEMP: temporary, TMP: temporary }),
      windowsHide: true, stdio: 'pipe',
    });
    this.guardian.stderr.on('error', () => {});
    this.guardian.stderr.resume();
    this.guardian.stdout.on('error', () => this.failed());
    createInterface({ input: this.guardian.stdout }).on('error', () => this.failed()).on('line', line => {
      if (line === 'ready' && !this.assigned && !this.dead) {
        this.assigned = true; this.resolveReady();
      } else if (line === 'drained' && this.assigned && this.stopped && !this.confirmed && !this.dead) {
        this.confirmed = true; this.guardian.stdin.end();
      } else this.failed();
    });
    this.guardian.on('error', () => this.failed());
    this.guardian.stdin.on('error', () => this.failed());
    this.guardian.once('close', (code) => {
      if (this.confirmed && code === 0) { this.dead = true; this.resolveDrain(); }
      else this.failed();
    });
  }
  private failed() {
    if (this.dead) return;
    this.dead = true; this.rejectReady(failure()); this.guardian.stdin.destroy();
    // KILL_ON_JOB_CLOSE is containment, not positive drain evidence. A lost
    // guardian acknowledgment intentionally keeps the parent's lifetime fence.
    if (this.assigned && !this.confirmed) console.warn('[codex] Windows job drain unconfirmed; retaining runtime ownership');
  }
  static async assign(pid: number, temporary: string) {
    if (!Number.isSafeInteger(pid) || pid < 1) throw failure();
    const extra = { AOD_JOB_PID: String(pid), TEMP: temporary, TMP: temporary };
    const identity = await windowsAsyncControlOutput(script('[Console]::Write([AgentOpsDeckWorkerJob]::Identity([uint32]$env:AOD_JOB_PID))'), extra);
    if (!/^\d{1,20}$/.test(identity)) throw failure();
    const job = new WindowsProcessJob(pid, identity, temporary);
    const timer = setTimeout(() => job.failed(), 15_000);
    try { await job.ready; return job; }
    catch { job.failed(); throw failure(); }
    finally { clearTimeout(timer); }
  }
  stop() {
    if (this.stopped || this.dead) return;
    this.stopped = true;
    this.guardian.stdin.write('stop\n');
  }
}
