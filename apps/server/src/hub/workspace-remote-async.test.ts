import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { RemoteCommand } from '@agentopsdeck/shared';
import { WorkspaceRemote } from './workspace-remote.js';

const snapshot = { name: 'Computer', targets: [{ id: 's1', title: 'Session', kind: 'session' as const }], active: 's1' };
const command = (): RemoteCommand => ({ id: randomUUID(), sequence: 1, revision: 1, target: 's1', action: 'send', text: 'PRIVATE_INPUT' });
const signal = () => new AbortController().signal;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve };
}

test('remote never treats an unresolved/rejected authorization Promise as authority', async () => {
  const service = new WorkspaceRemote(), permission = deferred<boolean>();
  const host = service.create('alice', snapshot);
  try {
    const receive = service.poll('alice', host.device.id, host.hostToken, signal(), () => permission.promise);
    const denied = service.command('alice', host.device.id, command(), signal(), async () => false);
    await assert.rejects(denied, /unavailable/);
    assert.equal(service.list('alice')[0]!.sequence, 0);
    permission.resolve(false); await assert.rejects(receive, /unavailable/);
    assert.deepEqual(service.list('alice'), []);
    const next = service.create('alice', snapshot);
    await assert.rejects(service.command('alice', next.device.id, command(), signal(), async () => { throw Error('owner unavailable'); }), /unavailable/);
    assert.equal(service.list('alice')[0]!.sequence, 0);
  } finally { permission.resolve(false); await service.close(); }
});

test('remote copies command before permission await and rechecks current catalog after it', async () => {
  const service = new WorkspaceRemote(), permission = deferred<boolean>();
  const host = service.create('alice', snapshot), input = command();
  const receive = service.poll('alice', host.device.id, host.hostToken, signal(), () => true);
  try {
    const sent = service.command('alice', host.device.id, input, signal(), () => permission.promise);
    input.text = 'MUTATED'; permission.resolve(true);
    const delivery = await receive; assert.equal(delivery?.text, 'PRIVATE_INPUT');
    service.acknowledge('alice', host.device.id, host.hostToken, input.id, 'applied');
    assert.equal(await sent, 'applied');
    const next = { ...command(), sequence: 2 }, gate = deferred<boolean>();
    const polling = service.poll('alice', host.device.id, host.hostToken, signal(), () => true);
    const changing = service.command('alice', host.device.id, next, signal(), () => gate.promise);
    service.update('alice', host.device.id, host.hostToken, { ...snapshot, targets: [{ ...snapshot.targets[0]!, title: 'Changed' }] });
    gate.resolve(true); await assert.rejects(changing, /view_changed/);
    assert.equal(service.list('alice')[0]!.sequence, 1);
    service.remove('alice', host.device.id); await assert.rejects(polling, /unavailable/);
  } finally { permission.resolve(false); await service.close(); }
});

test('remote shutdown retains original initial permission and refuses late input/late admission', async () => {
  const service = new WorkspaceRemote(), permission = deferred<boolean>();
  const host = service.create('alice', snapshot), input = command();
  const receive = service.poll('alice', host.device.id, host.hostToken, signal(), () => true);
  const rejectedReceive = assert.rejects(receive, /unavailable/);
  const sent = service.command('alice', host.device.id, input, signal(), () => permission.promise);
  const rejectedSend = assert.rejects(sent, /unavailable/);
  let drained = false;
  const close = service.close().then(() => { drained = true; });
  try {
    await tick(); assert.equal(drained, false); assert.deepEqual(service.list('alice'), []);
    assert.throws(() => service.create('alice', snapshot), /unavailable/);
    await assert.rejects(service.command('alice', host.device.id, input, signal(), () => true), /unavailable/);
    permission.resolve(true); await Promise.all([rejectedReceive, rejectedSend, close]);
    assert.equal(drained, true);
  } finally { permission.resolve(false); await close; }
});

test('remote periodic authorization is single-flight; close drains original check after UNKNOWN', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const service = new WorkspaceRemote(Date.now, 60_000, 60_000), gate = deferred<boolean>();
  const host = service.create('alice', snapshot), input = command(); let calls = 0;
  const receive = service.poll('alice', host.device.id, host.hostToken, signal(), () => true);
  const sent = service.command('alice', host.device.id, input, signal(), () => ++calls === 1 ? true : gate.promise);
  let closed = false;
  try {
    assert.equal((await receive)?.id, input.id);
    t.mock.timers.tick(250); await tick(); assert.equal(calls, 2);
    t.mock.timers.tick(2000); await tick(); assert.equal(calls, 2);
    const close = service.close().then(() => { closed = true; });
    assert.equal(await sent, 'unknown'); await tick(); assert.equal(closed, false);
    gate.resolve(true); await close; assert.equal(closed, true);
    assert.throws(() => service.acknowledge('alice', host.device.id, host.hostToken, input.id, 'applied'), /unavailable/);
  } finally { gate.resolve(false); await service.close(); }
});

test('remote rechecks expiry after delayed delivery authorization and cannot release expired input', async () => {
  let now = 0, checks = 0;
  const service = new WorkspaceRemote(() => now, 60_000, 60_000), gate = deferred<boolean>();
  const host = service.create('alice', snapshot), input = command();
  const receive = service.poll('alice', host.device.id, host.hostToken, signal(), () => ++checks === 1 ? true : gate.promise);
  const sent = service.command('alice', host.device.id, input, signal(), () => true);
  try {
    await tick(); assert.equal(checks, 2); now = 60_001; gate.resolve(true);
    assert.equal(await receive, null); assert.equal(await sent, 'unknown');
  } finally { gate.resolve(false); await service.close(); }
});
