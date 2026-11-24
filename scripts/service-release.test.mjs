import assert from 'node:assert/strict';
import test from 'node:test';
import { serviceState, pinRelease, activateRelease } from './service-release.mjs';

test('inactive is data, not a command failure', () => {
  const state = serviceState('example.service', (_binary, args) => {
    assert.ok(args.includes('show')); assert.ok(!args.includes('is-active'));
    return 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlPID=0\nControlGroup=\n';
  });
  assert.equal(state.ActiveState, 'inactive');
});
test('pins literal root-template launcher and rejects drift before shutdown', () => {
  const previous = { release: 'old-release', manifest: 'a'.repeat(64) };
  const next = { release: 'new-release', manifest: 'b'.repeat(64) };
  const source = "const release = `${root}/releases/old-release`;\nif (hash !== '" + previous.manifest + "') throw Error();";
  const pinned = pinRelease(source, previous, next);
  assert.ok(pinned.includes('${root}/releases/new-release'));
  assert.ok(pinned.includes(next.manifest));
  assert.throws(() => pinRelease(pinned, previous, next), /pin changed/);
});
test('failed activation actually restores and starts the previous release', async () => {
  const steps = [];
  let attempt = 0;
  await assert.rejects(activateRelease({
    install: async () => { steps.push('install'); },
    start: async () => { steps.push('start'); },
    verify: async () => { steps.push('verify'); if (!attempt++) throw new Error('unhealthy'); },
    stop: async () => { steps.push('stop'); },
    restore: async () => { steps.push('restore'); },
    recordFailure: async () => { steps.push('record'); },
  }), /unhealthy/);
  assert.deepEqual(steps, ['install', 'start', 'verify', 'record', 'stop', 'restore', 'start', 'verify']);
});
test('failed failure recording cannot prevent recovery and failed stop prevents pin restoration', async () => {
  let restored = false;
  await assert.rejects(activateRelease({
    install: async () => { throw new Error('install'); },
    start: async () => {}, verify: async () => {},
    stop: async () => { throw new Error('not stopped'); },
    restore: async () => { restored = true; },
    recordFailure: async () => { throw new Error('disk full'); },
  }), AggregateError);
  assert.equal(restored, false);
});
