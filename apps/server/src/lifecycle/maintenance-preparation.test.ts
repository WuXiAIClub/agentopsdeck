import assert from 'node:assert/strict';
import test from 'node:test';
import { runSystemdPreparation } from './maintenance-preparation.js';

const command = { executable: '/usr/bin/node', args: ['/synthetic/builder.mjs', '--output', '/synthetic/result.json'],
  systemdRun: '/usr/bin/systemd-run', systemctl: '/usr/bin/systemctl' };

test('candidate build is bounded by a separate cgroup including descendant lifetime', async () => {
  const calls: { binary: string; args: string[]; timeout: number }[] = [];
  await runSystemdPreparation(command, '/synthetic/build', 1234, async (binary, args, timeout) => { calls.push({ binary, args, timeout }); });
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.binary, command.systemdRun);
  assert.ok(call.args.includes('--property=ExitType=cgroup'));
  assert.ok(call.args.includes('--property=KillMode=control-group'));
  assert.ok(call.args.includes('--property=RuntimeMaxSec=2s'));
  assert.ok(call.args.includes('--wait'));
  assert.ok(call.args.includes('--collect'));
  assert.ok(call.args.includes('--expand-environment=no'));
  assert.deepEqual(call.args.slice(call.args.indexOf('--') + 1), [command.executable, ...command.args]);
  assert.equal(call.timeout, 31_234);
  assert.ok(!call.args.some(arg => arg.startsWith('--setenv=HOME=')));
});

test('build timeout stops only its random unit and never reports preparation success', async () => {
  const calls: { binary: string; args: string[] }[] = [];
  await assert.rejects(runSystemdPreparation(command, '/synthetic/build', 1, async (binary, args) => {
    calls.push({ binary, args });
    throw new Error('private tool output must not escape');
  }), /^Error: Isolated candidate preparation could not be verified$/);
  assert.equal(calls.length, 2);
  const unit = calls[0]!.args.find(arg => arg.startsWith('--unit='))!.slice(7);
  assert.match(unit, /^agentopsdeck-candidate-[a-f0-9-]{36}\.service$/);
  assert.equal(calls[1]!.binary, command.systemctl);
  assert.deepEqual(calls[1]!.args, ['--user', 'stop', unit]);
});

test('invalid tools and deadlines fail before spawning', async () => {
  const unexpected = async () => { assert.fail('must not execute'); };
  for (const timeout of [NaN, Infinity, -1, 0, 1.5]) await assert.rejects(runSystemdPreparation(command, '/synthetic', timeout, unexpected));
  await assert.rejects(runSystemdPreparation({ ...command, systemdRun: 'systemd-run' }, '/synthetic', 1, unexpected));
});
