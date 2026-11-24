import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { windowsControlEnvironment, windowsPowerShell, powershellArguments, windowsPrivateControl, windowsPrivateTemporaryDirectory } from './windows-private-worker.js';

/** The guardian is spawned BEFORE assignment, so it stays outside the job.
 * Its sole job handle has KILL_ON_JOB_CLOSE and no breakaway flag. Assignment
 * precedes SDK import/native spawn. EOF, guardian death or owner death kills
 * descendants; PID scans/taskkill are never used as ownership evidence. */
export const WINDOWS_JOB_SOURCE = `
using System;
using System.Runtime.InteropServices;
public static class AgentOpsDeckWorkerJob {
 [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
  public long ProcessTime, JobTime; public uint Flags;
  public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveLimit;
  public UIntPtr Affinity; public uint Priority, Scheduling;
 }
 [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
 [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
  public BasicLimits Basic; public IoCounters Io;
  public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
 }
 [StructLayout(LayoutKind.Sequential)] struct Accounting {
  public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
  public uint Faults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
 }
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits data, uint length);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting data, uint length, IntPtr returned);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 static void Require(bool ok) { if (!ok) throw new Exception("job unconfirmed"); }
 public static string Identity(uint pid) {
  IntPtr process=OpenProcess(0x1000,false,pid); Require(process!=IntPtr.Zero);
  try { long created,exited,kernel,user; Require(GetProcessTimes(process,out created,out exited,out kernel,out user)); return created.ToString(); }
  finally { CloseHandle(process); }
 }
 public static void Run(uint pid, string created) {
  IntPtr job=CreateJobObject(IntPtr.Zero,null); Require(job!=IntPtr.Zero);
  IntPtr process=IntPtr.Zero;
  try {
   ExtendedLimits limits=new ExtendedLimits(); limits.Basic.Flags=0x2000;
   Require(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))));
   process=OpenProcess(0x1101,false,pid); Require(process!=IntPtr.Zero);
   long actual,exited,kernel,user; Require(GetProcessTimes(process,out actual,out exited,out kernel,out user));
   Require(actual.ToString()==created); // exact creation identity, never a reusable PID alone
   Require(AssignProcessToJobObject(job,process));
   Console.WriteLine("ready"); Console.Out.Flush();
   string line;
   while ((line=Console.ReadLine())!=null) {
    Accounting count; Require(QueryInformationJobObject(job,1,out count,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero));
    if (line=="empty") { Console.WriteLine(count.ActiveProcesses==1 ? "empty" : "busy"); Console.Out.Flush(); }
    else if (line=="release") {
     Require(count.ActiveProcesses==1);
     // Worker stays alive as a leader until all native descendants exit.
     // Only this verified clean path may disarm kill-on-close for normal exit.
     limits.Basic.Flags=0;
     Require(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))));
     Console.WriteLine("released"); Console.Out.Flush(); return;
    } else throw new Exception("job protocol");
   }
  } finally {
   // KILL_ON_JOB_CLOSE covers every abnormal path after assignment.
   if (process!=IntPtr.Zero) CloseHandle(process); CloseHandle(job);
  }
 }
}`;
const script = (action: string) => "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n" + WINDOWS_JOB_SOURCE + "\n'@\n" + action;
let current: WindowsWorkerJob | undefined;
const failure = () => new Error('Windows worker job supervision unconfirmed');
export class WindowsWorkerJob {
  private readonly child: ChildProcessWithoutNullStreams;
  private waiter: { resolve(value: string): void; reject(error: Error): void } | undefined;
  private dead = false;
  private released = false;
  private constructor(identity: string, temporary: string) {
    this.child = spawn(windowsPowerShell(), powershellArguments(script('[AgentOpsDeckWorkerJob]::Run([uint32]$env:AOD_JOB_PID,$env:AOD_JOB_CREATED)')), {
      env: windowsControlEnvironment({ AOD_JOB_PID: String(process.pid), AOD_JOB_CREATED: identity, TEMP: temporary, TMP: temporary }), windowsHide: true, stdio: 'pipe',
    });
    // Never expose native diagnostics. Drain stderr to avoid blocking control.
    this.child.stderr.on('error', () => {});
    this.child.stderr.resume();
    this.child.stdout.on('error', () => this.failed());
    createInterface({ input: this.child.stdout }).on('error', () => this.failed()).on('line', line => {
      if (!this.waiter || !['ready', 'empty', 'busy', 'released'].includes(line)) { this.abort(); return; }
      const waiter = this.waiter; this.waiter = undefined; waiter.resolve(line);
    });
    this.child.on('error', () => this.failed());
    this.child.on('exit', () => this.failed());
    this.child.stdin.on('error', () => this.failed());
  }
  private failed() { this.dead = true; this.waiter?.reject(failure()); this.waiter = undefined; }
  private reply(command?: string): Promise<string> {
    if (this.dead || this.waiter) return Promise.reject(failure());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.abort(); reject(failure()); }, 15_000);
      this.waiter = { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
      if (command) this.child.stdin.write(command + '\n');
    });
  }
  static async enter(privateHome: string) {
    if (process.platform !== 'win32' || current) throw failure();
    const temporary = windowsPrivateTemporaryDirectory(privateHome);
    const identity = windowsPrivateControl(script('[Console]::Write([AgentOpsDeckWorkerJob]::Identity([uint32]$env:AOD_JOB_PID))'), { AOD_JOB_PID: String(process.pid), TEMP: temporary, TMP: temporary });
    if (!/^\d+$/.test(identity)) throw failure();
    const job = new WindowsWorkerJob(identity, temporary);
    try { if (await job.reply() !== 'ready') throw failure(); current = job; }
    catch { job.abort(); throw failure(); }
  }
  static active() { return !!current && !current.dead && !current.released; }
  static async empty() { if (!current || !WindowsWorkerJob.active()) throw failure(); return await current.reply('empty') === 'empty'; }
  static async release() {
    if (!current || !WindowsWorkerJob.active() || await current.reply('release') !== 'released') throw failure();
    current.released = true; current.child.stdin.end();
  }
  static terminate() { current?.abort(); }
  private abort() { this.failed(); this.child.stdin.destroy(); /* guardian closes the exact job handle on EOF */ }
}
