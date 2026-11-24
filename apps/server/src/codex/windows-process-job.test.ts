import assert from 'node:assert/strict';
import test from 'node:test';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SECRET_DIRECTORY_ACL_SCRIPT, windowsAsyncControl } from '../connector/windows-async-control.js';
import { WINDOWS_PROCESS_JOB_SOURCE, WindowsProcessJob } from './windows-process-job.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
test('guardian source preserves exact identity, kill-on-close and kernel-confirmed zero-process drain', () => {
  assert.match(WINDOWS_PROCESS_JOB_SOURCE, /actual.ToString\(\)==created/);
  assert.match(WINDOWS_PROCESS_JOB_SOURCE, /AssignProcessToJobObject/);
  assert.match(WINDOWS_PROCESS_JOB_SOURCE, /limits.Basic.Flags=0x2000/);
  assert.match(WINDOWS_PROCESS_JOB_SOURCE, /TerminateJobObject\(job,1\)/);
  assert.match(WINDOWS_PROCESS_JOB_SOURCE, /while \(count.ActiveProcesses!=0\)/);
  assert.match(WINDOWS_PROCESS_JOB_SOURCE, /CloseHandle\(job\)/);
});
for (const outcome of ['confirmed', 'lost', 'failed-close'] as const) {
  test(`Windows job ${outcome}: signal success alone never releases ownership`, async t => {
    const previous = process.env.SystemRoot; process.env.SystemRoot = 'C:\\Windows';
    const guardian = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    let commands = ''; guardian.stdin.on('data', chunk => { commands += chunk; });
    const control = t.mock.method(cp, 'execFile', ((file: string, _args: string[], options: any, done: any) => {
      assert.equal(file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      assert.equal(options.env.AOD_JOB_PID, '123');
      setImmediate(() => done(null, '987654321', '')); return {};
    }) as any);
    const spawn = t.mock.method(cp, 'spawn', ((_file: string, _args: string[], options: any) => {
      assert.equal(options.env.AOD_JOB_CREATED, '987654321');
      assert.equal(options.env.TEMP, 'C:\\private'); assert.equal(options.env.PATH, undefined);
      setImmediate(() => guardian.stdout.write('ready\n')); return guardian;
    }) as any);
    syncBuiltinESMExports();
    try {
      const job = await WindowsProcessJob.assign(123, 'C:\\private');
      let drained = false; void job.drained.then(() => { drained = true; });
      job.stop(); job.stop(); await turn(); assert.equal(commands, 'stop\n'); assert.equal(drained, false);
      if (outcome !== 'lost') guardian.stdout.write('drained\n');
      await turn(); assert.equal(drained, false, 'explicit evidence must also survive guardian close');
      guardian.emit('close', outcome === 'failed-close' ? 1 : 0); await turn();
      assert.equal(drained, outcome === 'confirmed');
    } finally {
      control.mock.restore(); spawn.mock.restore(); syncBuiltinESMExports();
      if (previous === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = previous;
      guardian.stdout.destroy(); guardian.stderr.destroy(); guardian.stdin.destroy();
    }
  });
}

test('native Windows job terminates an assigned launcher and descendant and confirms empty job', { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-job-native-fixture-'));
  let child: cp.ChildProcess | undefined;
  try {
    await windowsAsyncControl(SECRET_DIRECTORY_ACL_SCRIPT, { AOD_SECRET_DIRECTORY: directory });
    child = cp.spawn(process.execPath, ['-e', `
      process.once('message',()=>{
        const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
        child.once('spawn',()=>process.send({pid:child.pid}));
      });
      setInterval(()=>{},1000);
    `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    await new Promise<void>((resolve, reject) => { child!.once('spawn', resolve); child!.once('error', reject); });
    const closed = new Promise<void>(resolve => child!.once('close', () => resolve()));
    const job = await WindowsProcessJob.assign(child.pid!, directory);
    const descendant = new Promise<number>(resolve => child!.once('message', value => resolve((value as { pid: number }).pid)));
    child.send!('launch-fixture');
    assert.ok(await descendant > 0);
    job.stop(); await Promise.all([job.drained, closed]);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
