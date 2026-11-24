import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validRemoteCommand, validRemoteSnapshot, type RemoteCommand, type RemoteSnapshot } from '@agentopsdeck/shared';
import { WorkspaceRemote } from './workspace-remote.js';

const snapshot: RemoteSnapshot = { name: 'Computer', targets: [{ id: 's1', title: 'Session', kind: 'session' }], active: 's1' };
const command = (sequence = 1): RemoteCommand => ({ id: randomUUID(), sequence, revision: 1, target: 's1', action: 'draft', text: 'Private draft' });
const signal = () => new AbortController().signal;
const allow = () => true;

test('explicit send is session-only and a delivered send is never automatically replayed', async () => {
  assert.ok(validRemoteCommand({ ...command(), action: 'send' }));
  assert.equal(validRemoteCommand({ ...command(), action: 'send', text: '' }), false);
  const service = new WorkspaceRemote();
  try {
    const a = service.create('alice', { ...snapshot, targets: [...snapshot.targets, { id: 'note', title: 'Note', kind: 'notebook' }] });
    const receiving = service.poll('alice', a.device.id, a.hostToken, signal(), allow);
    await assert.rejects(service.command('alice', a.device.id, { ...command(), action: 'send', target: 'note' }, signal(), allow), /not_a_session/);
    assert.equal(service.list('alice')[0]!.sequence, 0);
    const c = { ...command(), action: 'send' as const };
    const sent = service.command('alice', a.device.id, c, signal(), allow);
    assert.equal((await receiving)?.action, 'send');
    service.acknowledge('alice', a.device.id, a.hostToken, c.id, 'unknown');
    assert.equal(await sent, 'unknown');
    assert.equal(await service.command('alice', a.device.id, c, signal(), allow), 'unknown');
    assert.equal(await service.poll('alice', a.device.id, a.hostToken, signal(), allow, 1), null);
  } finally { service.close(); }
});

test('remote schemas bound catalogs and input; reject unknown fields and unsafe labels', () => {
  assert.ok(validRemoteSnapshot(snapshot)); assert.ok(validRemoteCommand(command()));
  for (const value of [{ ...snapshot, token: 'x' }, { ...snapshot, active: 'missing' }, { ...snapshot, targets: [snapshot.targets[0], snapshot.targets[0]] },
    { ...snapshot, name: 'x\n' }, { ...snapshot, targets: Array(65).fill(snapshot.targets[0]) }]) assert.equal(validRemoteSnapshot(value), false);
  for (const value of [{ ...command(), send: true }, { ...command(), text: 'x'.repeat(8001) }, { ...command(), sequence: 0 },
    { ...command(), id: '-'.repeat(36) }, { ...command(), action: 'focus' }, { ...command(), action: 'shell' }]) assert.equal(validRemoteCommand(value), false);
});
test('same-account device catalogs never expose host tokens; enforce device and host boundaries', async () => {
  const service = new WorkspaceRemote();
  try {
    const a = service.create('alice', snapshot);
    assert.deepEqual(service.list('admin'), []); assert.ok(!JSON.stringify(service.list('alice')).includes(a.hostToken));
    assert.throws(() => service.update('bob', a.device.id, a.hostToken, snapshot), /unavailable/);
    assert.throws(() => service.update('alice', a.device.id, 'wrong', snapshot), /unavailable/);
    await assert.rejects(service.poll('alice', a.device.id, '', signal(), allow, 1), /unavailable/);
    service.remove('bob', a.device.id); assert.equal(service.list('alice').length, 1);
    for (let i = 0; i < 3; i++) service.create('alice', snapshot);
    assert.throws(() => service.create('alice', snapshot), /limit/);
    service.list('alice')[0]!.targets.length = 0; assert.equal(service.list('alice')[0]!.targets.length, 1);
  } finally { service.close(); }
});
test('receiver acknowledgement, idempotence, content conflict and monotonic sequence', async () => {
  const service = new WorkspaceRemote();
  try {
    const a = service.create('alice', snapshot), c = command();
    const receive = service.poll('alice', a.device.id, a.hostToken, signal(), allow);
    await assert.rejects(service.poll('alice', a.device.id, a.hostToken, signal(), allow), /already_connected/);
    const sent = service.command('alice', a.device.id, c, signal(), allow);
    const delivery = await receive;
    assert.equal(delivery?.text, c.text); assert.ok(delivery!.validForMs > 0); assert.ok(delivery!.waitedMs >= 0);
    assert.throws(() => service.acknowledge('alice', a.device.id, 'wrong', c.id, 'applied'), /unavailable/);
    service.acknowledge('alice', a.device.id, a.hostToken, c.id, 'applied');
    assert.equal(await sent, 'applied'); assert.equal(await service.command('alice', a.device.id, c, signal(), allow), 'applied');
    await assert.rejects(service.command('alice', a.device.id, { ...c, text: 'different' }, signal(), allow), /conflict/);
    await assert.rejects(service.command('alice', a.device.id, command(), signal(), allow), /sequence_changed/);
    assert.throws(() => service.acknowledge('alice', a.device.id, a.hostToken, c.id, 'applied'), /expired/);
    assert.equal(await service.poll('alice', a.device.id, a.hostToken, signal(), allow, 1), null);
  } finally { service.close(); }
});
test('stale catalog and absent receiver do not admit or consume a sequence', async () => {
  const service = new WorkspaceRemote();
  try {
    const a = service.create('alice', snapshot);
    await assert.rejects(service.command('alice', a.device.id, command(), signal(), allow), /offline/);
    service.update('alice', a.device.id, a.hostToken, { ...snapshot, name: 'Updated' });
    const receive = service.poll('alice', a.device.id, a.hostToken, signal(), allow, 5);
    await assert.rejects(service.command('alice', a.device.id, command(), signal(), allow), /view_changed/);
    assert.equal(service.list('alice')[0]!.sequence, 0); assert.equal(await receive, null);
  } finally { service.close(); }
});

test('focus updates preserve catalog revision; expired receipts cannot replay and rate budgets are bounded', async () => {
  const service = new WorkspaceRemote();
  try {
    const a = service.create('alice', snapshot), first = command();
    assert.equal(service.update('alice', a.device.id, a.hostToken, { ...snapshot, active: null }).revision, 1);
    for (let sequence = 1; sequence <= 90; sequence++) {
      const c = sequence === 1 ? first : command(sequence);
      const receive = service.poll('alice', a.device.id, a.hostToken, signal(), allow);
      const sent = service.command('alice', a.device.id, c, signal(), allow);
      await receive; service.acknowledge('alice', a.device.id, a.hostToken, c.id, 'applied'); assert.equal(await sent, 'applied');
    }
    await assert.rejects(service.command('alice', a.device.id, first, signal(), allow), /sequence_changed/);
    const receive = service.poll('alice', a.device.id, a.hostToken, signal(), allow, 1);
    await assert.rejects(service.command('alice', a.device.id, command(91), signal(), allow), /rate_limit/);
    assert.equal(await receive, null);
  } finally { service.close(); }
});
test('timeout never replays a delivered command and preserves unknown receipt', async () => {
  const service = new WorkspaceRemote(Date.now, 60_000, 20);
  try {
    const a = service.create('alice', snapshot), c = command();
    const receive = service.poll('alice', a.device.id, a.hostToken, signal(), allow);
    const sent = service.command('alice', a.device.id, c, signal(), allow);
    await receive; assert.equal(await sent, 'unknown');
    assert.equal(await service.command('alice', a.device.id, c, signal(), allow), 'unknown');
    assert.equal(await service.poll('alice', a.device.id, a.hostToken, signal(), allow, 1), null);
    assert.throws(() => service.acknowledge('alice', a.device.id, a.hostToken, c.id, 'applied'), /expired/);
  } finally { service.close(); }
});
test('abort, expiry, revocation and shutdown invalidate a receiver without replay', async () => {
  let now = 1;
  const service = new WorkspaceRemote(() => now, 100);
  try {
    const a = service.create('alice', snapshot), controller = new AbortController();
    const receive = service.poll('alice', a.device.id, a.hostToken, controller.signal, allow);
    controller.abort(); await assert.rejects(receive, /unavailable/); assert.deepEqual(service.list('alice'), []);
    const b = service.create('alice', snapshot); now = 102;
    assert.deepEqual(service.list('alice'), []);
    await assert.rejects(service.poll('alice', b.device.id, b.hostToken, signal(), allow), /unavailable/);
    const c = service.create('alice', snapshot);
    await assert.rejects(service.poll('alice', c.device.id, c.hostToken, signal(), () => false), /unavailable/);
    const d = service.create('alice', snapshot), polling = service.poll('alice', d.device.id, d.hostToken, signal(), allow);
    const sent = service.command('alice', d.device.id, command(), signal(), allow);
    service.close(); await assert.rejects(polling, /unavailable/); assert.equal(await sent, 'unknown');
  } finally { service.close(); }
});
