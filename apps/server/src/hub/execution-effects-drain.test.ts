import assert from 'node:assert/strict';
import test from 'node:test';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { ConnectorClient } from './connector-client.js';
import { HubExecutionEffects, type ExecutionEffectLocal, type ExecutionEffectOperation } from './execution-effects.js';
import type { ExecutionLease } from './execution-leases.js';
import type { Dispatch } from '../connector/transport.js';
import { EXPECTED_NODE_HEADER, NODE_ID_HEADER } from '../connector/node-identity.js';
import { EXECUTION_GRANT_HEADER } from '../connector/execution-authority.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const lease: ExecutionLease = {
  id: 7, grantKey: 'synthetic-grant-key', version: 3, nodeId: 'node_synthetic', issuerId: 'synthetic-issuer',
  proof: { userId: 'member', ownerUserId: 'owner', connectionId: 'connection', grantId: 'grant',
    version: 3, nodeVersion: 2, action: 'messages:send', resource: { runtime: 'codex', sessionKey: 'codex:synthetic/空 格' } },
  actions: ['messages:send'], expiresAt: 9_999_999_999_999, state: 'active',
  ref: { id: 'synthetic-execution-ref', actorId: 'synthetic-original-actor' },
};
const base = `/sessions/${encodeURIComponent(lease.proof.resource.sessionKey!)}`;
const command = { id: 'synthetic-receipt', key: 'original', fingerprint: 'a'.repeat(64), state: 'outcome_unknown', createdAt: 1, updatedAt: 1 };
class Effects extends HubExecutionEffects {
  constructor(private readonly dispatch: Dispatch, private readonly deadline: number) { super(); }
  protected client(original: ExecutionLease, _local?: ExecutionEffectLocal, operation?: ExecutionEffectOperation) {
    assert.deepEqual(original, lease);
    assert.ok(operation);
    return new ConnectorClient('http://connector.example.invalid', 'synthetic-only', this.dispatch, this.deadline, 128 * 1024, {
      nodeId: original.nodeId, authorize: operation.authorize,
      request(path, method) { assert.equal(path, operation.path); assert.equal(method, operation.method); },
    });
  }
}
const operations = [
  { name: 'receipt', method: 'GET', path: `${base}/commands/original`, body: { command },
    run: (effects: Effects, signal: AbortSignal) => effects.receiptFor(lease, 'original', () => {}, undefined, signal) },
  { name: 'queue', method: 'GET', path: `${base}/commands/original/queue`, body: { commandKey: 'original', queue: { presence: 'present', state: 'outcome_unknown', createdAt: 1, version: '1:1' } },
    run: (effects: Effects, signal: AbortSignal) => effects.queueFor(lease, 'original', () => {}, undefined, signal) },
  { name: 'message', method: 'POST', path: `${base}/messages`, body: { ok: true, command },
    run: (effects: Effects, signal: AbortSignal) => effects.messageFor(lease, 'original', { text: 'synthetic' }, () => {}, undefined, signal) },
  { name: 'mutation receipt', method: 'GET', path: `${base}/commands/original/queue/commands/mutation`, body: { command },
    run: (effects: Effects, signal: AbortSignal) => effects.queueMutationFor(lease, 'original', 'mutation', undefined, () => {}, undefined, signal) },
  { name: 'patch', method: 'PATCH', path: `${base}/commands/original/queue`, body: { ok: true, command: { ...command, key: 'mutation' } },
    run: (effects: Effects, signal: AbortSignal) => effects.queueMutationFor(lease, 'original', 'mutation', { method: 'PATCH', version: '1:1', text: 'synthetic' }, () => {}, undefined, signal) },
  { name: 'delete', method: 'DELETE', path: `${base}/commands/original/queue`, body: { ok: true, command: { ...command, key: 'mutation' } },
    run: (effects: Effects, signal: AbortSignal) => effects.queueMutationFor(lease, 'original', 'mutation', { method: 'DELETE', version: '1:1', text: '' }, () => {}, undefined, signal) },
  { name: 'page', method: 'GET', path: `${base}/queue/commands?cursor=0`, body: { items: [], nextCursor: null },
    run: (effects: Effects, signal: AbortSignal) => effects.queuePageFor(lease, '0', () => {}, undefined, signal) },
];

for (const operation of operations) for (const cause of ['abort', 'deadline'] as const) for (const phase of ['dispatch', 'cancel'] as const) {
  test(`execution ${operation.name} ${cause} retains original ${phase} and cancellation ACK`, async () => {
    const entered = gate(), release = gate(), cancelled = gate(), cancelAck = gate(), aborted = gate();
    const controller = new AbortController(), saved = structuredClone(lease);
    const requests: Request[] = [];
    const effects = new Effects(async request => {
      requests.push(request);
      request.signal.addEventListener('abort', aborted.resolve, { once: true });
      entered.resolve();
      if (phase === 'dispatch') await release.promise;
      return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled.resolve(); return cancelAck.promise; } }), {
        headers: { [NODE_ID_HEADER]: lease.nodeId, [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) },
      });
    }, cause === 'deadline' ? 100 : 10_000);
    let finished = false;
    const pending = assert.rejects(operation.run(effects, controller.signal), /synthetic abort|Deadline/).then(() => { finished = true; });
    try {
      await entered.promise;
      if (phase === 'cancel') await tick();
      if (cause === 'abort') controller.abort(new Error('synthetic abort'));
      await aborted.promise; await tick();
      assert.equal(finished, false, 'HTTP abort/deadline is not original stop proof');
      release.resolve(); await cancelled.promise; await tick();
      assert.equal(finished, false, 'original cancellation ACK remains pending');
      cancelAck.resolve(); await pending;
      assert.equal(finished, true); assert.deepEqual(lease, saved);
      assert.equal(requests.length, 1, 'never replay the original operation');
      const request = requests[0]!;
      assert.equal(request.method, operation.method);
      assert.equal(new URL(request.url).pathname + new URL(request.url).search, `/api/connector/v1${operation.path}`);
      assert.equal(request.headers.get(EXPECTED_NODE_HEADER), lease.nodeId);
      assert.equal(request.headers.get(EXECUTION_GRANT_HEADER), lease.ref!.id);
      if (operation.method !== 'GET') {
        assert.equal(request.headers.get('idempotency-key'), operation.method === 'POST' ? 'original' : 'mutation');
        if (operation.method !== 'POST') assert.equal(request.headers.get('if-match'), '"1:1"');
        if (operation.method === 'DELETE') assert.equal(await request.text(), '');
        else assert.deepEqual(await request.json(), operation.method === 'POST'
          ? { text: 'synthetic', idempotencyKey: 'original' } : { message: 'synthetic' });
      }
    } finally {
      release.resolve(); cancelAck.resolve(); controller.abort(new Error('synthetic abort'));
      await pending;
    }
  });
}

for (const operation of operations) test(`execution ${operation.name} preserves original wire result`, async () => {
  let calls = 0;
  const effects = new Effects(() => {
    calls++;
    return Response.json(operation.body, { status: 202,
      headers: { [NODE_ID_HEADER]: lease.nodeId, [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) } });
  }, 10_000);
  const result = await operation.run(effects, new AbortController().signal);
  assert.equal(calls, 1);
  if (operation.name === 'queue') assert.deepEqual(result, operation.body.queue);
  else if (operation.name === 'page') assert.deepEqual(result, operation.body);
  else if (operation.method === 'GET') assert.deepEqual(result, command);
  else assert.deepEqual(result, { ...operation.body.command, result: { status: 202, body: { ok: true } } });
});
