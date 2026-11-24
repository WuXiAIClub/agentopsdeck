import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { hubMemberFailureSteps } from './member-owner-domain.js';
import { executionLeaseOwnerSteps } from './member-execution-lease-domain.js';
import { validHubConnectorAccessCommand, validHubConnectorAccessReply, validHubConnectorAccessResult,
  type HubConnectorAccessCommand, type HubConnectorAccessResult } from './member-connector-access-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = [];
  stops = 0;
  postMessage(value: { id: number; kind: string; body: string }) { this.messages.push(value); }
  terminate() { this.stops++; return Promise.resolve(1); }
  reply(index: number, value: unknown) {
    const message = this.messages[index]!;
    this.emit('message', { id: message.id, kind: message.kind, ok: true, body: JSON.stringify(value) });
  }
}
const evidence = { accessKey: 'hub_key_synthetic' }, expectedScope = 'a'.repeat(64);
const command: HubConnectorAccessCommand = { action: 'open', id: 'local', maintenance: false };
function connectionFixture() {
  const store = new HubStore(':memory:', 'synthetic');
  store.upsertConnection({ id: 'local', kind: 'local', connectorUrl: 'local://aod-connector', label: 'Fixture' });
  const connection = store.getConnection('local', 'default')!;
  return { store, connection };
}

test('Connector access observation is distinct from all execution lease action stages', () => {
  const leaseSteps: readonly number[] = Object.values(executionLeaseOwnerSteps);
  assert.ok(!leaseSteps.includes(hubMemberFailureSteps.connectorAccess));
  assert.equal(new Set(Object.values(hubMemberFailureSteps)).size, Object.keys(hubMemberFailureSteps).length);
});

test('private credential DTO keeps legacy token capacity but rejects oversized and extra fields', async () => {
  const { store, connection } = connectionFixture();
  try {
    const remote = { ...connection, kind: 'remote', connectorUrl: 'http://fixture.invalid' };
    const reply = { connection: remote, epoch: 1, token: 't'.repeat(16_384) };
    assert.ok(validHubConnectorAccessResult(reply));
    for (const token of ['', 't'.repeat(16_385), 1, {}]) assert.equal(validHubConnectorAccessResult({ ...reply, token }), false);
    assert.equal(validHubConnectorAccessResult({ ...reply, authorized: true }), false);
    assert.equal(validHubConnectorAccessResult({ ok: true, epoch: 1, token: 'synthetic' }), false);
    assert.equal(validHubConnectorAccessCommand({ ...command, expectedEpoch: 1 }), false);
  } finally { await store.close(); }
});

for (const fault of ['wrong-connection', 'local-token', 'disabled', 'wrong-phase', 'wrong-epoch'] as const) {
  test(`wrong Connector ${fault} ACK fences owner without replay or early database release`, async () => {
    const { store, connection } = connectionFixture(), fake = new FakeWorker();
    const file = join(tmpdir(), `connector-ack-${randomUUID()}.sqlite`);
    const owner = new AsyncHubMemberOwner({ file }, quiet, () => fake as unknown as Worker);
    fake.emit('message', { kind: 'ready' }); await owner.open();
    const check: HubConnectorAccessCommand = { action: 'check', id: 'local', maintenance: false, expectedEpoch: 1 };
    const input = fault === 'wrong-epoch' ? check : command;
    let close: Promise<void> | undefined;
    try {
      const pending = owner.command('connectorAccess', { evidence, expectedScope, command: input });
      const denied = assert.rejects(pending); await tick();
      const reply = fault === 'wrong-phase' ? { ok: true, epoch: 1 } : fault === 'wrong-epoch' ? { ok: true, epoch: 2 }
        : { connection: { ...connection, ...(fault === 'wrong-connection' ? { id: 'other' } : {}),
          ...(fault === 'disabled' ? { status: 'disabled' } : {}) }, epoch: 1, token: fault === 'local-token' ? 'synthetic' : null };
      assert.equal(validHubConnectorAccessReply(input, reply), false);
      fake.reply(0, reply); await denied;
      assert.equal(owner.snapshot().unavailable, true); assert.equal(fake.messages.length, 1); assert.equal(fake.stops, 0);
      await assert.rejects(owner.command('connectorAccess', { evidence, expectedScope, command }));
      assert.equal(fake.messages.length, 1);
      assert.throws(() => new AsyncHubMemberOwner({ file }, quiet, () => new FakeWorker() as unknown as Worker));
      close = owner.close(); const stopped = assert.rejects(close); await tick();
      assert.equal(owner.snapshot().ownerExitConfirmed, false);
      assert.throws(() => new AsyncHubMemberOwner({ file }, quiet, () => new FakeWorker() as unknown as Worker));
      fake.emit('exit', 1); await stopped; assert.equal(owner.snapshot().ownerExitConfirmed, true);
    } finally { if (!owner.snapshot().ownerExitConfirmed) fake.emit('exit', 1); await close?.catch(() => {}); await store.close(); }
  });
}

test('valid check and null refusal replies never require or expose a credential token', async () => {
  const fake = new FakeWorker();
  const owner = new AsyncHubMemberOwner({ file: join(tmpdir(), `connector-check-${randomUUID()}.sqlite`) }, quiet, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' }); await owner.open();
  try {
    const check: HubConnectorAccessCommand = { action: 'check', id: 'local', maintenance: false, expectedEpoch: 1 };
    for (const reply of [{ ok: true, epoch: 1 }, null, { error: 'changed' }]) {
      const index = fake.messages.length;
      const pending: Promise<HubConnectorAccessResult> = owner.command('connectorAccess', { evidence, expectedScope, command: check });
      await tick(); fake.reply(index, reply); assert.deepEqual(await pending, reply);
      assert.equal(owner.snapshot().unavailable, false);
    }
  } finally {
    const index = fake.messages.length, close = owner.close(); await tick();
    fake.reply(index, null); fake.emit('exit', 0); await close;
  }
});
