import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { CONNECTOR_PROTOCOL_HEADER, CONNECTOR_PROTOCOL } from '@agentopsdeck/shared';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubOwnerControls } from './async-owner-control.js';
import { createAsyncConnectorClientResolver } from './async-connector-client.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { encodeHubSessionId } from './session-id.js';
import { registerHubCreationRoutes } from './creation-http.js';
import { registerHubDeletionRoutes } from './deletion-http.js';
import { registerHubSettingsRoutes } from './settings-http.js';
import { registerHubCompactRoutes } from './compact-http.js';
import { registerHubQueueRoutes } from './queue-http.js';
import { registerHubMessageRoutes } from './message-http.js';
import { ownerControlScope, validHubOwnerControlCommand, validHubOwnerControlReply,
  type OwnerControlTarget, type HubOwnerControlCommand } from './member-owner-control-domain.js';
import type { CommandReceipt } from '../commands/receipts.js';

const operations = ['create', 'delete', 'settings', 'compact', 'queue'] as const;
type Operation = typeof operations[number] | 'message';
const silence = new PerformanceDiagnostics(() => {});
const nodeId = `node_${randomUUID()}`, sessionId = encodeHubSessionId('local', 'codex:fixture');
const target = (operation: Operation): OwnerControlTarget => operation === 'create'
  ? { operation, connectionId: 'local', agentId: 'codex' }
  : { operation, connectionId: 'local', sessionId, ...(operation === 'queue' ? { messageId: 'queued' } : {}) };
const payload = (operation: Operation) => operation === 'settings' ? { title: 'new title' }
  : operation === 'queue' ? { method: 'PATCH', version: '"1:1"', text: 'text' } : {};

async function fixture(t: test.TestContext, saved?: Operation, diagnostics = silence, routeDiagnostics = diagnostics) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-owner-control-worker-')), file = join(root, 'hub.sqlite');
  const seed = new HubStore(file, 'synthetic-fixture');
  const key = seed.identities.issueKey('default'), cookie = seed.identities.createSession(key.token)!;
  seed.upsertConnection({ id: 'local', kind: 'local', label: 'Local', connectorUrl: 'local://aod-connector' });
  seed.pinConnectionNode('local', 'default', seed.connectionAuthority('local', 'default')!, nodeId);
  const epoch = seed.connectionAuthority('local', 'default')!;
  if (saved) await seed.commands.claimAsync(ownerControlScope('default', target(saved)), 'saved', payload(saved), true, saved === 'message' ? undefined : epoch);
  await seed.close(); // Never overlap a legacy connection with the worker.
  let worker = new AsyncHubMemberOwner({ file, encryptionSecret: 'synthetic-fixture' }, silence);
  await worker.open();
  t.after(async () => { await worker.close(); rmSync(root, { recursive: true, force: true }); });
  assert.ok(await worker.command('memberSnapshot', { sessionToken: cookie }), 'saved cookie authenticates on original worker');
  const calls: string[] = [], upstream = new Map<string, CommandReceipt>();
  const delivered: Record<string, unknown>[] = [];
  const deliveries = new Map<string, string>();
  let transportLoss = false, claimAckLoss = false, cancelledAfterClaim: AbortController | undefined;
  let receiptFault: 'key' | 'timestamp' | undefined, cleanupFailure = false, cleanupCalls = 0;
  let afterClaim: (() => Promise<void>) | undefined;
  let afterOriginal: ((kind: string, action?: string) => Promise<void>) | undefined;
  let responseBody: Record<string, unknown> | undefined, responseStatus = 200, explicitUnknown = false;
  const originalCalls: string[] = [];
  const observed = {
    async command<K extends Parameters<AsyncHubMemberOwner['command']>[0]>(kind: K, input: any): Promise<any> {
      originalCalls.push(`${kind}:${input.command?.action ?? ''}`);
      if (kind === 'ownerControl' && input.command.action === 'claimDigest') {
        assert.match(input.command.digest, /^[a-f0-9]{64}$/);
        assert.equal('payload' in input.command, false);
        assert.ok(Buffer.byteLength(JSON.stringify(input)) < 4096);
      }
      const value = await worker.command(kind, input);
      if (kind === 'ownerControl' && input.command.action === 'delivery' && value && 'delivery' in value) {
        deliveries.set(value.delivery, input.command.key);
      }
      await afterOriginal?.(kind, input.command?.action);
      if (kind === 'ownerControl' && ['claim', 'claimDigest'].includes(input.command.action)) {
        const hook = afterClaim; afterClaim = undefined; await hook?.();
        cancelledAfterClaim?.abort();
        if (claimAckLoss) { claimAckLoss = false; throw new Error('synthetic_lost_claim_ack'); }
      }
      if (kind === 'ownerControl' && input.command.action === 'cleanup') {
        cleanupCalls++;
        if (cleanupFailure) throw new Error('PRIVATE_cleanup_exception');
      }
      return value;
    },
  };
  const connector = createAsyncConnectorClientResolver(observed, { connectionId: 'local', token: 'synthetic-local',
    dispatch: async request => {
      const path = new URL(request.url).pathname;
      const headers = { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max), [NODE_ID_HEADER]: nodeId };
      if (request.method === 'GET') {
        calls.push('GET'); const delivery = decodeURIComponent(path.split('/').at(-1)!);
        return Response.json({ command: upstream.get(delivery) }, { headers });
      }
      calls.push(request.method);
      if (path.endsWith('/messages')) delivered.push(await request.json() as Record<string, unknown>);
      const delivery = request.headers.get('idempotency-key')!;
      // A real persisted unknown must exist before ANY outbound side effect.
      const snapshot = await worker.command('memberSnapshot', { accessKey: key.token }); assert.ok(snapshot);
      const operation: Operation = path.endsWith('/messages') ? 'message' : path.includes('/agents/') ? 'create' : path.endsWith('/compact') ? 'compact'
        : path.includes('/queue/') ? 'queue' : request.method === 'DELETE' ? 'delete' : 'settings';
      const claim = await worker.command('ownerControl', { evidence: { accessKey: key.token }, expectedScope: snapshot.recoveryScope,
        command: { target: target(operation), epoch, action: 'get', key: deliveries.get(delivery)! } });
      assert.ok(claim && 'receipt' in claim && claim.receipt?.state === 'outcome_unknown');
      const body = responseBody ?? (operation === 'create' ? { key: 'codex:created' } : operation === 'settings'
        ? { sessionKey: 'codex:fixture', settings: { title: 'new title' } } : operation === 'compact'
          ? { ok: true, status: 'compacting', runId: randomUUID() } : { ok: true });
      const status = operation === 'create' ? 201 : responseStatus;
      const command: CommandReceipt = { id: randomUUID(), key: delivery, state: explicitUnknown ? 'outcome_unknown' : 'accepted', createdAt: 1, updatedAt: 2,
        result: { status, body } };
      if (receiptFault === 'key') command.key = 'unrelated-delivery-key';
      if (receiptFault === 'timestamp') command.updatedAt = -1;
      upstream.set(delivery, command);
      if (transportLoss) throw new Error('synthetic_lost_transport_ack');
      return Response.json({ ...body, command }, { status, headers });
    } }, silence);
  const controls = new AsyncHubOwnerControls(observed, connector, diagnostics);
  await controls.open(new Request('http://fixture.invalid/', { headers: { cookie: `agentopsdeck_session=${cookie}` } }), 'default', target('delete'));
  const app = new Hono();
  const deps = { store: new Proxy({} as HubStore, { get() { throw new Error('sync_backend_forbidden'); } }),
    client: (() => { throw new Error('sync_resolver_forbidden'); }) as any, asyncOwnerControl: controls, owner: () => 'default',
    error: (c: any) => c.json({ error: 'synthetic_unavailable' }, 502), diagnostics: routeDiagnostics };
  registerHubCreationRoutes(app, deps); registerHubDeletionRoutes(app, deps); registerHubSettingsRoutes(app, deps);
  registerHubCompactRoutes(app, deps); registerHubQueueRoutes(app, '/api/hub/v1/sessions/:hubSessionId', deps);
  registerHubMessageRoutes(app, '/api/hub/v1/sessions/:hubSessionId', deps);
  const request = (operation: Operation, commandKey = 'key', signal?: AbortSignal, body?: unknown) => {
    const session = encodeURIComponent(sessionId);
    const path = operation === 'create' ? '/api/hub/v1/connections/local/agents/codex/sessions'
      : operation === 'delete' || operation === 'settings' ? `/api/sessions/${session}`
        : `/api/hub/v1/sessions/${session}${operation === 'message' ? '/messages' : operation === 'compact' ? '/compact' : '/queue/queued'}`;
    const method = operation === 'delete' ? 'DELETE' : operation === 'settings' || operation === 'queue' ? 'PATCH' : 'POST';
    return app.request(path, { method, headers: { cookie: `agentopsdeck_session=${cookie}`, 'content-type': 'application/json',
      'idempotency-key': commandKey, 'if-match': '"1:1"' }, ...(signal ? { signal } : {}),
      ...(method === 'DELETE' ? {} : { body: JSON.stringify(body ?? (operation === 'settings' ? { title: 'new title' }
        : operation === 'queue' ? { message: 'text' } : {})) }) });
  };
  const proof = async () => {
    const snapshot = await worker.command('memberSnapshot', { accessKey: key.token }); assert.ok(snapshot);
    return { evidence: { accessKey: key.token }, expectedScope: snapshot.recoveryScope };
  };
  return { calls, originalCalls, upstream, delivered, request, controls, proof, epoch, key, get worker() { return worker; },
    pollMessage: (commandKey = 'key') => app.request(`/api/hub/v1/sessions/${encodeURIComponent(sessionId)}/commands/${commandKey}`,
      { headers: { cookie: `agentopsdeck_session=${cookie}` } }),
    messageResult: (body: Record<string, unknown>, status = 200, unknown = false) => { responseBody = body; responseStatus = status; explicitUnknown = unknown; },
    get cleanupCalls() { return cleanupCalls; },
    corruptReceipt: (fault: 'key' | 'timestamp') => { receiptFault = fault; },
    failCleanup: () => { cleanupFailure = true; },
    afterClaim: (hook: () => Promise<void>) => { afterClaim = hook; },
    afterOriginal: (hook: (kind: string, action?: string) => Promise<void>) => { afterOriginal = hook; },
    loseTransport: () => { transportLoss = true; }, loseClaimAck: () => { claimAckLoss = true; },
    cancelClaim: (controller: AbortController) => { cancelledAfterClaim = controller; },
    restart: async () => { await worker.close(); worker = new AsyncHubMemberOwner({ file, encryptionSecret: 'synthetic-fixture' }, silence); await worker.open(); } };
}

test('real worker message: original scope, large payload/result, duplicate and restart preserve wire receipt', async t => {
  const f = await fixture(t), input = { text: 'message'.repeat(12_000), attachments: [{ data: 'A'.repeat(40_000) }] };
  f.messageResult({ ok: true, metadata: 'R'.repeat(25_000) });
  const first = await f.request('message', 'key', undefined, input);
  assert.equal(first.status, 200); assert.equal(first.headers.get('x-agentopsdeck-command-key'), 'key');
  const body = await first.json(); assert.equal(body.metadata.length, 25_000);
  assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0]!.text, input.text);
  assert.deepEqual(f.delivered[0]!.attachments, input.attachments);
  assert.notEqual(f.delivered[0]!.idempotencyKey, 'key');
  assert.ok(f.originalCalls.includes('ownerControl:claimDigest'));
  assert.deepEqual(await (await f.request('message', 'key', undefined, input)).json(), body);
  await f.restart();
  assert.deepEqual(await (await f.request('message', 'key', undefined, input)).json(), body);
  assert.equal((await f.request('message', 'key', undefined, { text: 'changed' })).status, 409);
  assert.deepEqual(f.calls, ['POST']);
});

test('real worker message: original 2.3.7 no-authority receipt and saved cookie reopen, observation never resends', async t => {
  const f = await fixture(t, 'message');
  assert.equal((await f.request('message', 'saved')).status, 202);
  await f.restart(); assert.equal((await f.request('message', 'saved')).status, 202);
  assert.equal((await f.pollMessage('saved')).status, 200);
  assert.deepEqual(f.calls, ['GET', 'GET', 'GET']);
});

test('real worker message: lost transport ACK stays unknown until read-only receipt recovery', async t => {
  const f = await fixture(t); f.loseTransport();
  assert.equal((await f.request('message')).status, 202); assert.deepEqual(f.calls, ['POST']);
  await f.restart();
  const poll = await f.pollMessage(); assert.equal(poll.status, 200);
  assert.equal((await poll.json()).command.state, 'accepted');
  assert.equal((await f.request('message')).status, 200); assert.deepEqual(f.calls, ['POST', 'GET']);
});

for (const failure of ['ack', 'cancel', 'ack+cancel'] as const)
  test(`real worker message: ${failure} after durable admission never dispatches or replays`, async t => {
    const f = await fixture(t), controller = new AbortController();
    if (failure !== 'cancel') f.loseClaimAck();
    if (failure !== 'ack') f.cancelClaim(controller);
    assert.equal((await f.request('message', 'key', controller.signal)).status, failure === 'cancel' ? 499 : 503);
    assert.deepEqual(f.calls, []);
    await f.restart(); assert.equal((await f.request('message')).status, 202);
    assert.deepEqual(f.calls, ['GET']);
  });

for (const fault of ['key', 'timestamp'] as const)
  test(`real worker message: recovered ${fault} fault remains unknown after restart`, async t => {
    const f = await fixture(t); f.corruptReceipt(fault); f.loseTransport();
    assert.equal((await f.request('message')).status, 202);
    await f.restart(); assert.equal((await f.request('message')).status, 202);
    assert.deepEqual(f.calls, ['POST', 'GET']);
  });

for (const status of [202, 409, 503])
  test(`real worker message: original HTTP ${status} settlement semantics survive duplicate`, async t => {
    const f = await fixture(t); f.messageResult({ ok: true }, status);
    const first = await f.request('message'); assert.equal(first.status, status === 503 ? 202 : status);
    const body = await first.json();
    assert.equal(body.command.state, status === 409 ? 'rejected' : status === 503 ? 'outcome_unknown' : 'accepted');
    await f.request('message'); assert.equal(f.calls.filter(c => c === 'POST').length, 1);
  });

test('real worker message: explicit unknown and oversized response cannot grant redispatch', async t => {
  const f = await fixture(t); f.messageResult({ ok: true }, 202, true);
  assert.equal((await f.request('message')).status, 202);
  assert.equal((await f.request('message')).status, 202);
  f.messageResult({ data: 'R'.repeat(100_000) });
  assert.equal((await f.request('message', 'oversized')).status, 202);
  await f.restart(); assert.equal((await f.request('message', 'oversized')).status, 202);
  assert.equal(f.calls.filter(c => c === 'POST').length, 2);
});

test('real worker message: revoked connection after claim fences outbound effect', async t => {
  const f = await fixture(t), proof = await f.proof();
  f.afterClaim(async () => { await f.worker.command('connectionChange', { ...proof,
    change: { action: 'patch', id: 'local', expectedEpoch: f.epoch, configuration: { enabled: false } } }); });
  assert.equal((await f.request('message')).status, 404); assert.deepEqual(f.calls, []);
});

test('real worker message: lost settlement ACK preserves original accepted row without redispatch', async t => {
  const f = await fixture(t);
  f.afterOriginal(async (kind, action) => {
    if (kind === 'ownerControl' && action === 'settle') throw Error('PRIVATE_lost_settlement_ack');
  });
  assert.equal((await f.request('message')).status, 503); assert.deepEqual(f.calls, ['POST']);
  f.afterOriginal(async () => {}); await f.restart();
  assert.equal((await f.request('message')).status, 200); assert.deepEqual(f.calls, ['POST']);
});

for (const sinkFails of [false, true])
  test(`real worker message: bounded route lifecycle diagnostics, sink failure=${sinkFails}`, async t => {
    const emitted: string[] = [];
    const diagnostics = new PerformanceDiagnostics(line => { emitted.push(line); if (sinkFails) throw Error('PRIVATE_sink'); });
    // Isolate this route's lifecycle budget from internal RPC/persistence traces.
    const f = await fixture(t, undefined, silence, diagnostics), input = { text: 'PRIVATE_message', attachment: 'PRIVATE_attachment' };
    assert.equal((await f.request('message', 'key', undefined, input)).status, 200);
    assert.equal((await f.request('message', 'key', undefined, input)).status, 200);
    f.loseTransport(); assert.equal((await f.request('message', 'PRIVATE_unknown_key', undefined, input)).status, 202);
    // Routine completions are emitted but deliberately not all retained in the
    // bounded recovery ring. Assert the real sink, not scheduler-dependent
    // elapsed time making a routine duplicate count as a slow observation.
    const rows = emitted.map(line => JSON.parse(line)).filter(row => row.operation === 'hub-message-http');
    assert.deepEqual(rows.map(row => [row.step, row.changed, row.unknown]), [[4, 1, 0], [5, 0, 0], [3, 1, 1]]);
    assert.equal(diagnostics.snapshot().totals.sinkFailures, sinkFails ? 3 : 0);
    assert.doesNotMatch(emitted.join('\n'), /PRIVATE_|synthetic|agentopsdeck_session|digest/);
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /PRIVATE_|synthetic|agentopsdeck_session|digest/);
  });

for (const operation of operations) {
  test(`real worker ${operation}: durable receipt before dispatch, duplicate only observes, cookie survives restart`, async t => {
    const f = await fixture(t);
    const first = await f.request(operation); assert.equal(first.status, operation === 'create' ? 201 : 200);
    const body = await first.json();
    if (operation === 'create') {
      assert.equal(body.remoteSessionKey, 'codex:created');
      assert.equal(body.key, encodeHubSessionId('local', 'codex:created'));
      assert.ok(body.sessionRef);
    }
    assert.equal(f.calls.filter(c => c !== 'GET').length, 1);
    const duplicate = await f.request(operation); assert.equal(duplicate.status, first.status);
    await f.restart();
    const reopened = await f.request(operation); assert.equal(reopened.status, first.status);
    assert.deepEqual(await reopened.json(), body); assert.equal(f.calls.filter(c => c !== 'GET').length, 1);
  });

  test(`real worker ${operation}: lost transport ACK recovers original receipt without resending`, async t => {
    const f = await fixture(t); f.loseTransport();
    const response = await f.request(operation); assert.equal(response.status, operation === 'create' ? 201 : 200);
    assert.deepEqual(f.calls.filter(c => c !== 'GET').length, 1); assert.ok(f.calls.includes('GET'));
    await f.request(operation); assert.equal(f.calls.filter(c => c !== 'GET').length, 1);
  });

  test(`real worker ${operation}: lost claim ACK fences delivery and saved unknown is observation-only`, async t => {
    const f = await fixture(t); f.loseClaimAck();
    assert.equal((await f.request(operation)).status, 503); assert.equal(f.calls.length, 0);
    await f.restart(); assert.equal((await f.request(operation)).status, 202);
    assert.deepEqual(f.calls, ['GET']);
  });

  test(`real worker ${operation}: original 2.3.7 scope and cookie reopen without replay`, async t => {
    const f = await fixture(t, operation);
    assert.equal((await f.request(operation, 'saved')).status, 202); assert.deepEqual(f.calls, ['GET']);
    await f.restart(); assert.equal((await f.request(operation, 'saved')).status, 202);
    assert.deepEqual(f.calls, ['GET', 'GET']);
  });

  test(`real worker ${operation}: lost claim ACK plus cancellation remains unknown, never replays`, async t => {
    const f = await fixture(t), controller = new AbortController();
    f.loseClaimAck(); f.cancelClaim(controller);
    assert.equal((await f.request(operation, 'key', controller.signal)).status, 503);
    assert.deepEqual(f.calls, []);
    await f.restart(); assert.equal((await f.request(operation)).status, 202);
    assert.deepEqual(f.calls, ['GET']);
  });

  test(`real worker ${operation}: cancellation after durable claim keeps unknown and never dispatches`, async t => {
    const f = await fixture(t), controller = new AbortController(); f.cancelClaim(controller);
    assert.equal((await f.request(operation, 'key', controller.signal)).status, 499); assert.equal(f.calls.length, 0);
    await f.restart(); assert.equal((await f.request(operation)).status, 202); assert.deepEqual(f.calls, ['GET']);
  });

  for (const fault of ['key', 'timestamp'] as const)
    test(`real worker ${operation}: ${fault} receipt fault remains unknown after restart, never resends`, async t => {
      const f = await fixture(t); f.corruptReceipt(fault);
      assert.equal((await f.request(operation)).status, 202);
      assert.equal(f.calls.filter(c => c !== 'GET').length, 1);
      await f.restart(); assert.equal((await f.request(operation)).status, 202);
      assert.equal(f.calls.filter(c => c !== 'GET').length, 1);
    });

  test(`real worker ${operation}: connection revocation after committed claim fences dispatch`, async t => {
    const f = await fixture(t), proof = await f.proof();
    f.afterClaim(async () => {
      await f.worker.command('connectionChange', { ...proof, change: { action: 'patch', id: 'local', expectedEpoch: f.epoch,
        configuration: { enabled: false } } });
    });
    assert.equal((await f.request(operation)).status, 404);
    assert.equal(f.calls.length, 0);
    const disabled = await f.worker.command('connectionTarget', { ...proof, id: 'local' });
    assert.ok(disabled && 'epoch' in disabled);
    await f.worker.command('connectionChange', { ...proof, change: { action: 'patch', id: 'local', expectedEpoch: disabled.epoch,
      configuration: { enabled: true } } });
    await f.restart(); assert.equal((await f.request(operation)).status, 409);
    assert.equal(f.calls.length, 0);
  });
}

for (const throwingSink of [false, true])
  test(`accepted deletion survives cleanup/log sink fault without duplicate cleanup (${throwingSink})`, async t => {
    const diagnostics = new PerformanceDiagnostics(() => { if (throwingSink) throw Error('PRIVATE_sink'); });
    const f = await fixture(t, undefined, diagnostics); f.failCleanup();
    assert.equal((await f.request('delete')).status, 200); assert.equal(f.cleanupCalls, 1);
    await f.restart(); assert.equal((await f.request('delete')).status, 200);
    assert.equal(f.cleanupCalls, 1); assert.equal(f.calls.filter(c => c !== 'GET').length, 1);
    const logs = diagnostics.snapshot().events;
    assert.equal(logs.filter(row => row.operation === 'hub-deletion-projection' && row.unknown === 1).length, 1);
    assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_|synthetic-local|agentopsdeck_session|hub.sqlite/);
  });

test('worker validates action/key replies and prevents cleanup outside original accepted deletion', async t => {
  const f = await fixture(t), p = await f.proof();
  const command: HubOwnerControlCommand = { target: target('delete'), epoch: f.epoch, action: 'claim', key: 'key', payload: {} };
  const claimed = await f.worker.command('ownerControl', { ...p, command });
  assert.ok(claimed && 'fresh' in claimed);
  assert.equal(validHubOwnerControlReply(command, { ...claimed, receipt: { ...claimed.receipt, key: 'wrong' } }), false);
  assert.equal(validHubOwnerControlReply(command, { ok: true }), false);
  assert.equal(validHubOwnerControlCommand({ ...command, action: 'cleanup', target: target('settings') }), false);
  assert.deepEqual(await f.worker.command('ownerControl', { ...p, command: { target: target('delete'), epoch: f.epoch,
    action: 'cleanup', key: 'key' } }), { error: 409 });
});

test('original receipt never migrates after connection generation changes', async t => {
  const f = await fixture(t, 'delete'), p = await f.proof();
  await f.worker.command('connectionChange', { ...p, change: { action: 'patch', id: 'local', expectedEpoch: f.epoch,
    configuration: { enabled: false } } });
  const disabled = await f.worker.command('connectionTarget', { ...p, id: 'local' }); assert.ok(disabled && 'epoch' in disabled);
  await f.worker.command('connectionChange', { ...p, change: { action: 'patch', id: 'local', expectedEpoch: disabled.epoch,
    configuration: { enabled: true } } });
  assert.equal((await f.request('delete', 'saved')).status, 409); assert.equal(f.calls.length, 0);
});

for (const operation of operations) test(`close waits original ${operation} claim ACK and fences retained controls`, async t => {
  const f = await fixture(t);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.afterClaim(async () => { enter(); await gate; });
  const retained = await f.controls.open(new Request('http://fixture.invalid/', {
    headers: { 'x-agentopsdeck-key': f.key.token },
  }), 'default', target(operation));
  const response = f.request(operation); await entered;
  let closed = false; const closing = f.controls.close(); assert.equal(f.controls.close(), closing);
  void closing.then(() => { closed = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closed, false); assert.equal(f.controls.pendingRequests, 1); assert.equal(f.controls.pending, 1);
    for (const action of [() => retained.check(), () => retained.get('key'), () => retained.claim('key', {}),
      () => retained.recover('key'), () => retained.client(), () => retained.cleanup('key')]) {
      await assert.rejects(async () => { await action(); }, (error: unknown) => error instanceof Error && error.message === 'hub_member_request_unavailable');
    }
    assert.equal(f.calls.length, 0, 'no delivery or recovery dispatch during shutdown');
  } finally { release(); }
  assert.equal((await response).status, 503); await closing;
  assert.equal(f.controls.pendingRequests, 0); assert.equal(f.controls.pending, 0); assert.equal(f.calls.length, 0);
  const saved = await f.worker.command('ownerControl', { ...await f.proof(),
    command: { action: 'get', target: target(operation), epoch: f.epoch, key: 'key' } });
  assert.ok(saved && 'receipt' in saved && saved.receipt?.state === 'outcome_unknown', 'original durable claim is retained for explicit recovery');
});

for (const phase of ['opening-proof', 'opening-target', 'opening-final-proof', 'claim-proof', 'claim-ack', 'claim-final-proof'] as const)
  test(`owner control close at ${phase} prevents all later SQL and remote dispatch`, async t => {
    const f = await fixture(t), operation = 'create';
    const raw = () => new Request('http://fixture.invalid/', { headers: { 'x-agentopsdeck-key': f.key.token } });
    const retained = phase.startsWith('claim-') ? await f.controls.open(raw(), 'default', target(operation)) : undefined;
    let enter!: () => void, release!: () => void, proof = 0, held = false, drained = false;
    const entered = new Promise<void>(yes => { enter = yes; }), gate = new Promise<void>(yes => { release = yes; });
    f.afterOriginal(async (kind, action) => {
      if (kind === 'memberSnapshot') proof++;
      const selected = phase === 'opening-proof' || phase === 'claim-proof' ? kind === 'memberSnapshot' && proof === 1
        : phase === 'opening-target' ? kind === 'connectionTarget' : phase === 'claim-ack' ? kind === 'ownerControl' && action === 'claim'
          : kind === 'memberSnapshot' && proof === 2;
      if (!held && selected) { held = true; enter(); await gate; }
    });
    const pending = assert.rejects(retained ? retained.claim('key', {}) : f.controls.open(raw(), 'default', target(operation)), { status: 503 });
    await entered; const before = f.originalCalls.length;
    const closing = f.controls.close(); void closing.then(() => { drained = true; });
    try {
      await new Promise<void>(yes => setImmediate(yes)); assert.equal(drained, false);
      assert.equal(f.originalCalls.length, before); assert.equal(f.calls.length, 0);
    } finally { release(); }
    await pending; await closing;
    assert.equal(f.originalCalls.length, before, 'close does not start even a final-proof SQL command');
    assert.equal(f.controls.pending, 0); assert.equal(f.controls.pendingRequests, 0); assert.equal(f.calls.length, 0);
  });

test('owner control diagnostic close reentry cannot dispatch retained operations', async t => {
  const diagnostics = new PerformanceDiagnostics(() => {}), f = await fixture(t, undefined, diagnostics);
  const retained = await f.controls.open(new Request('http://fixture.invalid/', { headers: { 'x-agentopsdeck-key': f.key.token } }), 'default', target('delete'));
  const original = diagnostics.start.bind(diagnostics), checks: Promise<void>[] = [];
  let entered = false, nested: Promise<void> | undefined;
  diagnostics.start = (...args) => {
    if (!entered && args[0] === 'hub-route-drain') {
      entered = true;
      for (const run of [() => retained.check(), () => retained.get('key'), () => retained.claim('key', {}), () => retained.client()])
        checks.push(assert.rejects(async () => run(), { status: 503 }));
      nested = f.controls.close();
    }
    return original(...args);
  };
  const before = f.originalCalls.length, closing = f.controls.close(); assert.equal(nested, closing);
  await closing; await Promise.all(checks); assert.equal(entered, true);
  assert.equal(f.originalCalls.length, before); assert.equal(f.calls.length, 0);
});
