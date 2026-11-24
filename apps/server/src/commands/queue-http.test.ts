import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { CodexAppServer } from '../codex/app-server.js';
import { OpenClawTurnQueue } from '../openclaw/turn-queue.js';
import { loadConfig } from '../config.js';
import { HubStore } from '../hub/hub-store.js';
import { ConnectorClient, createConnectorClientResolver } from '../hub/connector-client.js';
import { DeckStore } from '../projection/deck-store.js';
import { registerConnectorRoutes } from '../routes/connector.js';
import { encodeHubSessionId, registerHubRoutes } from '../routes/hub.js';
import { createTurnAuthorizer } from '../connector/execution-grants.js';
import { EXECUTION_GRANT_HEADER } from '../connector/execution-authority.js';

for (const transport of ['local', 'http'] as const) for (const runtime of ['codex', 'openclaw'] as const) {
  for (const method of ['PATCH', 'DELETE'] as const) for (const fault of ['none', 'revoked', 'revoked-release', 'lost-release', 'version', 'owner'] as const) {
    test(`${transport}/${runtime}/${method}: async mutation admission ${fault} preserves original queue and receipt`, async () => {
      const f = await fixture(transport, runtime), client = f.direct(f.writer.token);
      const session = `/sessions/${encodeURIComponent(f.sessionKey)}`;
      let release!: () => void, entered!: () => void;
      const wait = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      let pending: Promise<any> | undefined, admissions = 0;
      try {
        const admitted = await client.json<any>(`${session}/messages`, { method: 'POST', body: JSON.stringify({ message: 'original', idempotencyKey: 'seed' }) });
        const id = admitted.idempotencyKey, path = `${session}/queue/${encodeURIComponent(id)}`;
        const version = f.users.turns.version(runtime, f.sessionKey, id)!;
        const receipts = f.users.commands as any;
        receipts.storageAdmission = undefined;
        receipts.asyncStorageAdmission = async (_bytes: number, write: () => Promise<void>) => {
          admissions++; entered(); await wait; await write();
          if (fault === 'revoked-release') f.tokens.revoke(f.writer.record.id);
          if (fault === 'lost-release') throw Error('synthetic private release failure');
        };
        const mutation = { method, headers: { 'if-match': JSON.stringify(version), 'idempotency-key': 'mutation' },
          ...(method === 'PATCH' ? { body: JSON.stringify({ message: 'updated' }) } : {}) };
        pending = client.json<any>(path, mutation).then(value => ({ status: 200, value }), error => ({ status: error.status, error }));
        await started;
        assert.equal(f.users.turns.version(runtime, f.sessionKey, id), version);
        if (fault === 'revoked') f.tokens.revoke(f.writer.record.id);
        if (fault === 'version' || fault === 'owner') {
          assert.equal(f.users.turns.edit<any>(runtime, f.sessionKey, id, payload => fault === 'owner'
            ? { ...payload, actorId: 'different-actor' }
            : { ...payload, [runtime === 'codex' ? 'text' : 'message']: 'concurrent' }, version), true);
        }
        const beforeRelease = f.users.turns.version(runtime, f.sessionKey, id);
        release();
        const result = await pending;
        const receiptScope = JSON.stringify(['queue-mutation-v1', f.writer.record.id, f.sessionKey, id]);
        const receipt = f.users.commands.get(receiptScope, 'mutation');
        const expected = { none: 200, revoked: 403, 'revoked-release': 403, 'lost-release': 503, version: 412, owner: 404 }[fault];
        assert.equal(result.status, expected);
        assert.equal(admissions, 1);
        if (fault === 'none') {
          assert.equal(receipt?.state, 'accepted');
          assert.notEqual(f.users.turns.version(runtime, f.sessionKey, id), beforeRelease);
          assert.deepEqual(await client.json(path, mutation), result.value);
        } else {
          assert.equal(f.users.turns.version(runtime, f.sessionKey, id), beforeRelease, 'waiting mutation must not change the queue');
          assert.equal(receipt?.state, fault === 'revoked' ? undefined : fault === 'lost-release' || fault === 'revoked-release' ? 'outcome_unknown' : 'rejected');
          if (fault === 'lost-release') {
            const recovered = await client.json<any>(`${path}/commands/mutation`);
            assert.equal(recovered.command.id, receipt!.id);
            assert.equal(recovered.command.state, 'outcome_unknown');
            await client.json(path, mutation);
            assert.equal(f.users.turns.version(runtime, f.sessionKey, id), beforeRelease, 'UNKNOWN duplicate never dispatches');
          }
        }
        assert.equal(admissions, 1, 'original receipt bypasses fresh admission');
      } finally { release(); await pending; await f.close(); }
    });
  }
}

for (const runtime of ['codex', 'openclaw'] as const) for (const fault of ['cancelled', 'closed'] as const) {
  test(`${runtime}: queue mutation ${fault} during async admission does not grant work`, { timeout: 15_000 }, async () => {
    const f = await fixture('local', runtime), client = f.direct(f.writer.token);
    const session = `/sessions/${encodeURIComponent(f.sessionKey)}`;
    let release!: () => void, entered!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let pending: Promise<Response> | undefined;
    try {
      const admitted = await client.json<any>(`${session}/messages`, { method: 'POST', body: JSON.stringify({ message: 'original', idempotencyKey: 'seed' }) });
      const id = admitted.idempotencyKey, version = f.users.turns.version(runtime, f.sessionKey, id)!;
      (f.users.commands as any).asyncStorageAdmission = async (_bytes: number, write: () => Promise<void>) => { entered(); await wait; await write(); };
      const controller = new AbortController();
      pending = Promise.resolve(f.connector.request(`/api/connector/v1${session}/queue/${encodeURIComponent(id)}`, { method: 'DELETE', signal: controller.signal,
        headers: { authorization: `Bearer ${f.writer.token}`, 'if-match': JSON.stringify(version), 'idempotency-key': 'cancel' } }));
      await Promise.race([started, pending.then(response => { throw Error(`Mutation returned ${response.status} before entering admission`); })]);
      if (fault === 'cancelled') controller.abort();
      else { f.users.close(); f.users.close = () => {}; }
      release();
      assert.equal((await pending).status, 503);
      if (fault === 'cancelled') {
        assert.equal(f.users.turns.version(runtime, f.sessionKey, id), version);
        assert.equal(f.users.commands.get(JSON.stringify(['queue-mutation-v1', f.writer.record.id, f.sessionKey, id]), 'cancel'), undefined);
      } else {
        const reopened = new ConnectorUserStore(f.config.connector.usersDatabaseFile);
        try {
          assert.equal(reopened.turns.version(runtime, f.sessionKey, id), version);
          assert.equal(reopened.commands.get(JSON.stringify(['queue-mutation-v1', f.writer.record.id, f.sessionKey, id]), 'cancel'), undefined);
        } finally { reopened.close(); }
      }
    } finally { release(); await pending; await f.close(); }
  });
}

for (const runtime of ['codex', 'openclaw'] as const) {
  test(`${runtime}: queue release loss recovers original receipt by GET without replay`, async () => {
    const f = await fixture('local', runtime);
    let writes = 0, wakes = 0;
    const queue = f.users.turns as any;
    queue.asyncStorageAdmission = async (_bytes: number, write: () => Promise<void>) => {
      writes++; await write(); throw Error('private-release-loss');
    };
    f.users.turns.onAdmission(() => { wakes++; });
    const client = f.direct(f.writer.token), path = `/sessions/${encodeURIComponent(f.sessionKey)}`;
    const post = { method: 'POST', body: JSON.stringify({ message: 'original', idempotencyKey: 'release-loss' }) };
    try {
      const original = await client.json<any>(`${path}/messages`, post);
      assert.equal(original.command.state, 'accepted');
      const receipt = await client.json<any>(`${path}/commands/release-loss`);
      assert.equal(receipt.command.state, 'accepted');
      assert.equal(receipt.command.result.body.idempotencyKey, original.idempotencyKey);
      assert.equal((await client.json<any>(`${path}/messages`, post)).idempotencyKey, original.idempotencyKey);
      assert.equal(writes, 1); assert.equal(wakes, 1); assert.equal(f.users.turns.maintenanceCount(), 1);
    } finally { await f.close(); }
  });

  test(`${runtime}: revocation while queue space waits rejects without committed work`, async () => {
    const f = await fixture('local', runtime);
    let release!: () => void, entered!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    (f.users.turns as any).asyncStorageAdmission = async (_bytes: number, write: () => Promise<void>) => {
      entered(); await wait; await write();
    };
    const client = f.direct(f.writer.token), path = `/sessions/${encodeURIComponent(f.sessionKey)}`;
    const pending = client.json(`${path}/messages`, { method: 'POST', body: JSON.stringify({ message: 'not admitted', idempotencyKey: 'wait-revoke' }) });
    const rejected = assert.rejects(pending, { status: 403 });
    try {
      await started; f.tokens.revoke(f.writer.record.id); release(); await rejected;
      assert.equal(f.users.turns.maintenanceCount(), 0);
      assert.equal(f.users.commands.get(JSON.stringify([f.writer.record.id, f.sessionKey]), 'wait-revoke')?.state, 'rejected');
    } finally { release(); await pending.catch(() => {}); await f.close(); }
  });
}

for (const transport of ['local', 'http'] as const) for (const runtime of ['codex', 'openclaw'] as const) {
  test(`${transport}/${runtime}: delegated admission isolates users, receipts and queue ownership under one issuer`, async () => {
    const f = await fixture(transport, runtime);
    const issuer = f.tokens.create({ label: 'synthetic Hub', delegationHubId: 'hub-fixture',
      scopes: ['execution:delegate', 'messages:read', 'messages:send', 'queue:manage'] });
    const client = f.direct(issuer.token), path = `/sessions/${encodeURIComponent(f.sessionKey)}`;
    const issue = (principalId: string) => client.json<any>('/execution-grants', { method: 'POST', body: JSON.stringify({
      principalId, grantKey: 'policy', version: 1, runtime, sessionKey: f.sessionKey, actions: ['messages:send'], expiresAt: Date.now() + 30_000 }) });
    const command = (id: string, key = 'same-key') => ({ method: 'POST', headers: { [EXECUTION_GRANT_HEADER]: id },
      body: JSON.stringify({ message: 'queued', idempotencyKey: key, actorId: 'forged', executionGrant: { id: 'forged' } }) });
    const page = (id: string) => client.json<any>(`${path}/queue`, { headers: { [EXECUTION_GRANT_HEADER]: id } });
    try {
      const alice = (await issue('alice')).grant, bob = (await issue('bob')).grant;
      assert.notEqual(alice.actorId, bob.actorId);
      const a = await client.json<any>(`${path}/messages`, command(alice.id));
      const b = await client.json<any>(`${path}/messages`, command(bob.id));
      assert.equal(a.status, 'queued'); assert.equal(b.status, 'queued');
      assert.notEqual(a.idempotencyKey, b.idempotencyKey, 'same key is not shared across Hub members');
      assert.deepEqual((await page(alice.id)).items.map((item: any) => item.id), [a.idempotencyKey]);
      assert.deepEqual((await page(bob.id)).items.map((item: any) => item.id), [b.idempotencyKey], 'issuer queue:manage does not widen delegated access');
      const commandQueue = (grant: string, key = 'same-key') => client.json<any>(`${path}/commands/${key}/queue`, { headers: { [EXECUTION_GRANT_HEADER]: grant } });
      const observation = await commandQueue(alice.id);
      assert.equal(observation.commandKey, 'same-key');
      assert.deepEqual(observation.queue, { presence: 'present', state: 'queued', createdAt: f.users.turns.head<any>(runtime, f.sessionKey)!.createdAt,
        version: f.users.turns.version(runtime, f.sessionKey, a.idempotencyKey) });
      assert.equal((await commandQueue(bob.id)).queue.presence, 'present');
      await assert.rejects(commandQueue(alice.id, 'missing-key'), { status: 404 });
      await assert.rejects(client.json(`${path}/commands/same-key/queue`), { status: 403 });
      const head = f.users.turns.head<any>(runtime, f.sessionKey)!;
      assert.equal(head.payload.actorId, alice.actorId);
      assert.deepEqual(head.payload.executionGrant, { ...alice, issuerTokenId: issuer.record.id });
      assert.equal((await client.json<any>(`${path}/messages`, command(alice.id))).idempotencyKey, a.idempotencyKey);
      await assert.rejects(client.json(`${path}/queue/${encodeURIComponent(a.idempotencyKey)}`, { method: 'DELETE', headers: { [EXECUTION_GRANT_HEADER]: bob.id } }), { status: 404 });
      await assert.rejects(client.json(`${path}/messages`, { ...command(alice.id, 'missing'), headers: {} }), { status: 403 });
      await assert.rejects(client.json(`${path}/messages`, command('malformed', 'bad-ref')), { status: 403 });
      await assert.rejects(client.json(`/sessions/${encodeURIComponent(`${f.sessionKey}:other`)}/messages`, command(alice.id)), { status: 403 });
      await assert.rejects(f.direct(f.writer.token).json(`${path}/messages`, command(alice.id)), { status: 403 });

      await client.json('/execution-grants/revoke', { method: 'POST', body: JSON.stringify({ principalId: 'alice', grantKey: 'policy', version: 1, runtime, sessionKey: f.sessionKey }) });
      // Accepted work remains observable after the execution lease is revoked.
      const receipt = await client.json<any>(`${path}/commands/same-key`, { headers: { [EXECUTION_GRANT_HEADER]: alice.id } });
      assert.equal(receipt.command.state, 'accepted');
      assert.equal(receipt.command.result.body.idempotencyKey, a.idempotencyKey);
      await assert.rejects(client.json(`${path}/messages`, command(alice.id, 'new-key')), { status: 403 });
      const rejected = await client.json<any>(`${path}/commands/new-key`, { headers: { [EXECUTION_GRANT_HEADER]: alice.id } });
      assert.equal(rejected.command.state, 'rejected', 'known authorization denial must not become outcome_unknown');
      assert.deepEqual((await page(alice.id)).items.map((item: any) => item.id), [a.idempotencyKey]);
      assert.equal((await commandQueue(alice.id)).queue.presence, 'present', 'original authority still reads accepted work after revoke');
      await assert.rejects(client.json(`${path}/queue/${encodeURIComponent(a.idempotencyKey)}`, { method: 'PATCH', headers: { [EXECUTION_GRANT_HEADER]: alice.id }, body: JSON.stringify({ message: 'edit' }) }), { status: 403 });
      await client.json(`${path}/queue/${encodeURIComponent(a.idempotencyKey)}`, { method: 'DELETE', headers: { [EXECUTION_GRANT_HEADER]: alice.id,
        'if-match': JSON.stringify((await page(alice.id)).items[0].version) } });
      assert.deepEqual((await page(alice.id)).items, [], 'revoked actor may clean up its own not-started work');
      assert.deepEqual((await page(bob.id)).items.map((item: any) => item.id), [b.idempotencyKey]);
    } finally { await f.close(); }
  });
}

for (const transport of ['local', 'http'] as const) for (const runtime of ['codex', 'openclaw'] as const) {
  test(`${transport}/${runtime}: delegated controls require their own action and supported protocol`, async () => {
    const f = await fixture(transport, runtime);
    const issuer = f.tokens.create({ label: 'control issuer', delegationHubId: 'hub-control',
      scopes: ['execution:delegate', 'messages:read', 'messages:send'] });
    const client = f.direct(issuer.token), path = `/sessions/${encodeURIComponent(f.sessionKey)}`;
    const issue = async (grantKey: string, actions: string[]) => (await client.json<any>('/execution-grants', {
      method: 'POST', body: JSON.stringify({ principalId: 'alice', grantKey, version: 1, runtime,
        sessionKey: f.sessionKey, actions, expiresAt: Date.now() + 30_000 }) })).grant;
    const send = (id: string, message: string, idempotencyKey: string, expectedRunId?: string) => client.json<any>(`${path}/messages`, {
      method: 'POST', headers: { [EXECUTION_GRANT_HEADER]: id }, body: JSON.stringify({ message, idempotencyKey, expectedRunId }) });
    try {
      const ordinary = await issue('send-only', ['messages:send']);
      await assert.rejects(send(ordinary.id, '/stop', 'no-control', 'run-fixture'), { status: 403 });
      const control = await issue('control', ['messages:send', 'runs:interrupt', 'runs:compact']);
      await assert.rejects(send(control.id, '/compact', 'compact'), { status: 409 });
      await assert.rejects(send(control.id, '/status', 'status'), { status: 409 });
      if (runtime === 'openclaw') {
        await assert.rejects(send(control.id, '/stop', 'stop', 'run-fixture'), { status: 409 });
      } else {
        let calls = 0;
        f.codex.interrupt = async (key, run, actor, grant) => {
          calls++; assert.equal(key, f.sessionKey); assert.equal(run, 'run-fixture');
          assert.equal(actor, control.actorId); assert.equal(grant?.id, control.id);
        };
        await assert.rejects(send(control.id, '/stop', 'no-run'), { status: 409 });
        assert.equal((await send(control.id, '/stop', 'stop', 'run-fixture')).status, 'interrupt_requested');
        await send(control.id, '/stop', 'stop', 'run-fixture');
        assert.equal(calls, 1, 'receipt replay must not repeat interrupt');
      }
      assert.equal(f.users.turns.head(runtime, f.sessionKey), undefined);
    } finally { await f.close(); }
  });
}

for (const runtime of ['codex', 'openclaw'] as const) for (const method of ['POST', 'PATCH'] as const) {
  test(`${runtime}/${method}: delegated authority is rechecked after a slow body`, async () => {
    const f = await fixture('local', runtime);
    const issuer = f.tokens.create({ label: 'slow body issuer', delegationHubId: 'hub-slow',
      scopes: ['execution:delegate', 'messages:read', 'messages:send'] });
    const binding = { principalId: 'alice', grantKey: 'slow', version: 1, runtime, sessionKey: f.sessionKey };
    const client = f.direct(issuer.token), path = `/sessions/${encodeURIComponent(f.sessionKey)}`;
    try {
      const { grant } = await client.json<any>('/execution-grants', { method: 'POST', body: JSON.stringify({ ...binding,
        actions: ['messages:send'], expiresAt: Date.now() + 30_000 }) });
      const headers = { [EXECUTION_GRANT_HEADER]: grant.id };
      const accepted = await client.json<any>(`${path}/messages`, { method: 'POST', headers,
        body: JSON.stringify({ message: 'original', idempotencyKey: 'original' }) });
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
      const suffix = method === 'POST' ? '/messages' : `/queue/${encodeURIComponent(accepted.idempotencyKey)}`;
      const pending = client.json(`${path}${suffix}`, { method, headers, body, duplex: 'half' } as any);
      // Observe rejection immediately so the harness never sees an unhandled promise.
      const rejected = assert.rejects(pending, { status: 403 });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await client.json('/execution-grants/revoke', { method: 'POST', body: JSON.stringify(binding) });
      controller.enqueue(Buffer.from(JSON.stringify({ message: 'changed', idempotencyKey: 'late' }))); controller.close();
      await rejected;
      const entry = f.users.turns.head<any>(runtime, f.sessionKey)!;
      assert.equal(entry.payload[runtime === 'codex' ? 'text' : 'message'], 'original');
      const page = await client.json<any>(`${path}/queue`, { headers });
      assert.deepEqual(page.items.map((item: any) => item.id), [accepted.idempotencyKey]);
      if (method === 'POST') {
        const receipt = await client.json<any>(`${path}/commands/late`, { headers });
        assert.equal(receipt.command.state, 'rejected');
      }
    } finally { await f.close(); }
  });
}

for (const runtime of ['codex', 'openclaw'] as const) test(`${runtime}: final queue authorization denial produces a rejected receipt`, async () => {
  const f = await fixture('local', runtime);
  const issuer = f.tokens.create({ label: 'final boundary issuer', delegationHubId: 'hub-final',
    scopes: ['execution:delegate', 'messages:read', 'messages:send'] });
  const client = f.direct(issuer.token), path = `/sessions/${encodeURIComponent(f.sessionKey)}`;
  try {
    const { grant } = await client.json<any>('/execution-grants', { method: 'POST', body: JSON.stringify({ principalId: 'alice',
      grantKey: 'final', version: 1, runtime, sessionKey: f.sessionKey, actions: ['messages:send'], expiresAt: Date.now() + 30_000 }) });
    const revoke = () => f.users.executionGrants.revoke(issuer.record.id, grant.id);
    if (runtime === 'codex') {
      const send = f.codex.send.bind(f.codex);
      f.codex.send = (...args) => { revoke(); return send(...args); };
    } else {
      const enqueue = f.openclaw.enqueueAsync.bind(f.openclaw);
      f.openclaw.enqueueAsync = (...args) => { revoke(); return enqueue(...args); };
    }
    const headers = { [EXECUTION_GRANT_HEADER]: grant.id };
    await assert.rejects(client.json(`${path}/messages`, { method: 'POST', headers,
      body: JSON.stringify({ message: 'no admission', idempotencyKey: 'boundary' }) }), { status: 403 });
    const receipt = await client.json<any>(`${path}/commands/boundary`, { headers });
    assert.equal(receipt.command.state, 'rejected');
    assert.equal(f.users.turns.head(runtime, f.sessionKey), undefined);
  } finally { await f.close(); }
});

for (const transport of ['local', 'http'] as const) for (const runtime of ['codex', 'openclaw'] as const) {
  test(`${transport}/${runtime}: Hub queue mutations reach the owning Connector with identity and state checks`, async () => {
    const f = await fixture(transport, runtime);
    const { hub, connector, prefix, sessionKey, writer, tokens, users, store, direct } = f;
    let observedVersion = '';
    const mutation = (method: string, message: unknown = 'edited') => ({ method,
      headers: { 'content-type': 'application/json', 'if-match': JSON.stringify(observedVersion) },
      ...(method === 'PATCH' ? { body: JSON.stringify({ message, actorId: 'forged' }) } : {}) });
    const post = async (message: string) => {
      const response = await hub.request(`${prefix}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) });
      assert.equal(response.status, 200); return (await response.json() as any).idempotencyKey as string;
    };
    try {
      const id = await post('original'), path = `${prefix}/queue/${encodeURIComponent(id)}`;
      let page = await (await hub.request(`${prefix}/queue`)).json() as any;
      assert.deepEqual(page.items.map((item: any) => [item.id, item.state]), [[id, 'queued']]);
      assert.equal(page.nextCursor, null);
      observedVersion = page.items[0].version;
      assert.equal(store.getMessages(sessionKey).find((message) => message.id === id)?.queueVersion, observedVersion);
      for (const method of ['PATCH', 'DELETE']) {
        const request = mutation(method);
        assert.equal((await hub.request(path, { ...request, headers: {} })).status, 428);
        for (const match of ['*', 'W/"1:1"', '1:1', '"1:1", "1:2"', '"0:1"']) {
          assert.equal((await hub.request(path, { ...request, headers: { 'if-match': match } })).status, 400);
        }
      }
      assert.equal((await hub.request(path, mutation('PATCH'))).status, 200);
      assert.equal((await hub.request(path, mutation('PATCH', 'stale overwrite'))).status, 412);
      assert.equal((await hub.request(path, mutation('DELETE'))).status, 412);
      page = await (await hub.request(`${prefix}/queue`)).json() as any;
      assert.notEqual(page.items[0].version, observedVersion);
      observedVersion = page.items[0].version;
      assert.equal(store.getMessages(sessionKey).find((message) => message.id === id)?.queueVersion, observedVersion);
      const payload = users.turns.head<any>(runtime, sessionKey)!.payload;
      assert.equal(payload[runtime === 'codex' ? 'text' : 'message'], 'edited');
      assert.equal(payload.actorId, writer.record.id, 'edit cannot change execution identity');
      assert.equal(store.getMessages(sessionKey).find((message) => message.id === id)?.text, 'edited');
      for (const message of [null, {}, 1, '', 'x'.repeat(100_001)]) assert.equal((await hub.request(path, mutation('PATCH', message))).status, 400);
      assert.equal((await hub.request(`${prefix}/queue?cursor=nan`)).status, 400);
      const other = tokens.create({ label: 'other', scopes: ['messages:read', 'messages:send'] });
      const otherClient = direct(other.token);
      assert.deepEqual((await otherClient.json<any>(`/sessions/${encodeURIComponent(sessionKey)}/queue`)).items, []);
      await assert.rejects(otherClient.json(`/sessions/${encodeURIComponent(sessionKey)}/queue/${encodeURIComponent(id)}`, mutation('DELETE')), { status: 404 });
      await assert.rejects(direct(writer.token).json(`/sessions/${encodeURIComponent(`${sessionKey}:wrong`)}/queue/${encodeURIComponent(id)}`, mutation('DELETE')), { status: 404 });
      const reader = tokens.create({ label: 'reader', scopes: ['messages:read'] });
      await assert.rejects(direct(reader.token).json(`/sessions/${encodeURIComponent(sessionKey)}/queue/${encodeURIComponent(id)}`, mutation('DELETE')), { status: 403 });
      assert.equal((await hub.request(path, mutation('DELETE'))).status, 200);
      assert.equal(users.turns.hasPending(runtime, sessionKey), false);
      assert.equal(store.getMessages(sessionKey).some((message) => message.id === id), false);

      const unknown = await post('uncertain'), unknownPath = `${prefix}/queue/${encodeURIComponent(unknown)}`;
      observedVersion = users.turns.version(runtime, sessionKey, unknown)!;
      users.turns.start(runtime, sessionKey, unknown);
      assert.equal((await hub.request(unknownPath, mutation('DELETE'))).status, 412);
      observedVersion = users.turns.version(runtime, sessionKey, unknown)!;
      assert.equal((await hub.request(unknownPath, mutation('DELETE'))).status, 409);
      users.turns.uncertain(runtime, unknown);
      observedVersion = users.turns.version(runtime, sessionKey, unknown)!;
      assert.equal((await hub.request(unknownPath, mutation('PATCH'))).status, 409);
      const blocked = await post('blocked'); users.turns.block(runtime, blocked);
      observedVersion = users.turns.version(runtime, sessionKey, blocked)!;
      assert.equal((await hub.request(`${prefix}/queue/${encodeURIComponent(blocked)}`, mutation('PATCH'))).status, 409);
      tokens.revoke(writer.record.id);
      assert.equal((await hub.request(`${prefix}/queue/${encodeURIComponent(blocked)}`, mutation('DELETE'))).status, 403);
      const manager = tokens.create({ label: 'operator', scopes: ['queue:manage'] });
      const managerClient = direct(manager.token), raw = `/sessions/${encodeURIComponent(sessionKey)}/queue`;
      await assert.rejects(managerClient.json(`${raw}/${encodeURIComponent(blocked)}`, mutation('PATCH')), { status: 403 }, 'queue management cannot rewrite another actor input');
      page = await managerClient.json<any>(raw);
      assert.deepEqual(page.items.map((item: any) => item.state), ['outcome_unknown', 'blocked']);
      assert.deepEqual(await managerClient.json(`${raw}/${encodeURIComponent(blocked)}`, mutation('DELETE')), { ok: true });
      observedVersion = users.turns.version(runtime, sessionKey, unknown)!;
      await assert.rejects(managerClient.json(`${raw}/${encodeURIComponent(unknown)}`, mutation('DELETE')), { status: 409 });
      assert.equal(users.turns.head(runtime, sessionKey)?.id, unknown);
      const revokedBody = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from('{"message":"after"}')); controller.close(); } });
      const denied = await connector.request(`/api/connector/v1${raw}/${encodeURIComponent(unknown)}`, {
        method: 'PATCH', headers: { authorization: `Bearer ${writer.token}` }, body: revokedBody, duplex: 'half',
      } as any);
      assert.equal(denied.status, 403);
    } finally { await f.close(); }
  });
}

for (const transport of ['local', 'http'] as const) for (const runtime of ['codex', 'openclaw'] as const) {
  test(`${transport}/${runtime}: a failed projection never pairs old queued text with the committed new version`, async () => {
    const f = await fixture(transport, runtime);
    try {
      const accepted = await (await f.hub.request(`${f.prefix}/messages`, {
        method: 'POST', body: JSON.stringify({ message: 'observed text' }),
      })).json() as any;
      const original = f.store.getMessages(f.sessionKey)[0]!;
      const path = `${f.prefix}/queue/${encodeURIComponent(accepted.idempotencyKey)}`;
      const headers = { 'if-match': JSON.stringify(original.queueVersion) };
      const addMessage = f.store.addMessage;
      f.store.addMessage = () => { throw new Error('synthetic projection failure'); };
      try {
        assert.equal((await f.hub.request(path, { method: 'PATCH', headers, body: JSON.stringify({ message: 'committed text' }) })).status, 503);
      } finally { f.store.addMessage = addMessage; }
      const snapshot = await (await f.hub.request(`${f.prefix}/messages`)).json() as any;
      const row = snapshot.messages.find((message: any) => message.id === original.id);
      assert.equal(row.text, 'observed text'); assert.equal(row.queueVersion, original.queueVersion);
      assert.notEqual(f.users.turns.version(runtime, f.sessionKey, original.id), original.queueVersion);
      const pending = f.users.turns.head<any>(runtime, f.sessionKey)!;
      assert.equal(pending.payload[runtime === 'codex' ? 'text' : 'message'], 'committed text');
      assert.equal((await f.hub.request(path, { method: 'DELETE', headers })).status, 412);
      assert.equal((await f.hub.request(path, { method: 'PATCH', headers, body: JSON.stringify({ message: 'unseen overwrite' }) })).status, 412);
      assert.equal(f.users.turns.version(runtime, f.sessionKey, original.id), (await (await f.hub.request(`${f.prefix}/queue`)).json() as any).items[0].version);
    } finally { await f.close(); }
  });
}

for (const transport of ['local', 'http'] as const) for (const runtime of ['codex', 'openclaw'] as const) {
  test(`${transport}/${runtime}: keyed queue mutations replay durable results without repeating side effects`, async () => {
    const f = await fixture(transport, runtime), client = f.direct(f.writer.token);
    const session = `/sessions/${encodeURIComponent(f.sessionKey)}`;
    try {
      const admitted = await client.json<any>(`${session}/messages`, { method: 'POST', body: JSON.stringify({ message: 'original', idempotencyKey: 'admit' }) });
      const id = admitted.idempotencyKey, path = `${session}/queue/${encodeURIComponent(id)}`;
      const version = f.users.turns.version(runtime, f.sessionKey, id)!;
      const edit = { method: 'PATCH', headers: { 'if-match': JSON.stringify(version), 'idempotency-key': 'edit' }, body: JSON.stringify({ message: '  updated  ' }) };
      const first = await client.json<any>(path, edit);
      assert.equal(first.command.state, 'accepted'); assert.equal(first.ok, true);
      const changed = f.users.turns.version(runtime, f.sessionKey, id);
      assert.notEqual(changed, version);
      assert.deepEqual(await client.json(path, edit), first);
      assert.deepEqual(await client.json(path, { ...edit, body: JSON.stringify({ message: 'updated' }) }), first);
      assert.equal(f.users.turns.version(runtime, f.sessionKey, id), changed);
      for (const request of [{ ...edit, body: JSON.stringify({ message: 'different' }) }, { method: 'DELETE', headers: edit.headers },
        { ...edit, headers: { ...edit.headers, 'if-match': JSON.stringify(changed) } }]) await assert.rejects(client.json(path, request), { status: 409 });
      const recovered = await client.json<any>(`${path}/commands/edit`);
      assert.equal(recovered.command.id, first.command.id); assert.deepEqual(recovered.command.result, { status: 200, body: { ok: true } });
      const other = f.tokens.create({ label: 'other actor', scopes: ['messages:read', 'messages:send', 'queue:manage'] });
      await assert.rejects(f.direct(other.token).json(`${path}/commands/edit`), { status: 404 });
      await assert.rejects(client.json(`${path.replace(encodeURIComponent(f.sessionKey), encodeURIComponent(`${f.sessionKey}:other`))}/commands/edit`), { status: 404 });
      await assert.rejects(client.json(`${path}/commands/missing`), { status: 404 });
      await assert.rejects(client.json(path, { ...edit, headers: { ...edit.headers, 'idempotency-key': 'bad key' } }), { status: 409 });
      const cancel = { method: 'DELETE', headers: { 'if-match': JSON.stringify(changed), 'idempotency-key': 'cancel' } };
      const removed = await client.json<any>(path, cancel);
      assert.equal(removed.command.state, 'accepted');
      assert.equal(f.users.turns.hasPending(runtime, f.sessionKey), false);
      assert.deepEqual(await client.json(path, cancel), removed, 'deleted row does not prevent replay');
      assert.equal((await client.json<any>(`${path}/commands/cancel`)).command.state, 'accepted');
      f.tokens.revoke(f.writer.record.id);
      await assert.rejects(client.json(`${path}/commands/cancel`), { status: 403 });
    } finally { await f.close(); }
  });

  for (const method of ['PATCH', 'DELETE'] as const) test(`${transport}/${runtime}/${method}: mutation receipt survives projection failure; unknown never redispatches`, async () => {
    const f = await fixture(transport, runtime), client = f.direct(f.writer.token);
    const session = `/sessions/${encodeURIComponent(f.sessionKey)}`;
    try {
      const admitted = await client.json<any>(`${session}/messages`, { method: 'POST', body: JSON.stringify({ message: 'original' }) });
      const id = admitted.idempotencyKey, path = `${session}/queue/${encodeURIComponent(id)}`;
      const version = f.users.turns.version(runtime, f.sessionKey, id)!;
      const request = { method, headers: { 'if-match': JSON.stringify(version), 'idempotency-key': 'unknown' },
        ...(method === 'PATCH' ? { body: JSON.stringify({ message: 'changed' }) } : {}) };
      const queueMethod = method === 'PATCH' ? 'edit' : 'cancel', original = { edit: f.users.turns.edit, cancel: f.users.turns.cancel };
      f.users.turns[queueMethod] = () => { throw new Error('synthetic precommit failure'); };
      try { assert.equal((await client.json<any>(path, request)).command.state, 'outcome_unknown'); }
      finally { Object.assign(f.users.turns, original); }
      assert.equal((await client.json<any>(path, request)).command.state, 'outcome_unknown');
      assert.equal(f.users.turns.version(runtime, f.sessionKey, id), version, 'retry must not execute after precommit uncertainty');
      assert.equal((await client.json<any>(`${path}/commands/unknown`)).command.state, 'outcome_unknown');
      const projection = method === 'PATCH' ? 'addMessage' : 'removeMessage', project = { addMessage: f.store.addMessage, removeMessage: f.store.removeMessage };
      f.store[projection] = () => { throw new Error('synthetic postcommit projection failure'); };
      const explicit = { ...request, headers: { ...request.headers, 'idempotency-key': 'explicit-new-action' } };
      try { assert.equal((await client.json<any>(path, explicit)).command.state, 'accepted'); }
      finally { Object.assign(f.store, project); }
      const newVersion = f.users.turns.version(runtime, f.sessionKey, id);
      assert.notEqual(newVersion, version);
      assert.equal((await client.json<any>(path, explicit)).command.state, 'accepted');
      assert.equal(f.users.turns.version(runtime, f.sessionKey, id), newVersion);
      assert.equal((await client.json<any>(`${path}/commands/explicit-new-action`)).command.state, 'accepted');
    } finally { await f.close(); }
  });
}

for (const runtime of ['codex', 'openclaw'] as const) test(`${runtime}: delegated mutation receipts remain actor-bound across revocation and grant versions`, async () => {
  const f = await fixture('local', runtime);
  const issuer = f.tokens.create({ label: 'synthetic issuer', delegationHubId: 'hub-fixture', scopes: ['execution:delegate', 'messages:send', 'messages:read', 'queue:manage'] });
  const client = f.direct(issuer.token), session = `/sessions/${encodeURIComponent(f.sessionKey)}`;
  const policy = { grantKey: 'policy', runtime, sessionKey: f.sessionKey, actions: ['messages:send'], expiresAt: Date.now() + 30_000 };
  const issue = (principalId: string, version = 1) => client.json<any>('/execution-grants', { method: 'POST', body: JSON.stringify({ ...policy, principalId, version }) });
  try {
    const alice = (await issue('alice')).grant, bob = (await issue('bob')).grant;
    const headers = { [EXECUTION_GRANT_HEADER]: alice.id };
    const admitted = await client.json<any>(`${session}/messages`, { method: 'POST', headers, body: JSON.stringify({ message: 'original' }) });
    const id = admitted.idempotencyKey, path = `${session}/queue/${encodeURIComponent(id)}`;
    const edit = { method: 'PATCH', headers: { ...headers, 'if-match': JSON.stringify(f.users.turns.version(runtime, f.sessionKey, id)), 'idempotency-key': 'same-key' }, body: JSON.stringify({ message: 'edited' }) };
    const edited = await client.json<any>(path, edit);
    await assert.rejects(client.json(path, { ...edit, headers: { ...edit.headers, [EXECUTION_GRANT_HEADER]: bob.id } }), { status: 404 });
    assert.equal((await client.json<any>(`${path}/commands/same-key`, { headers: { [EXECUTION_GRANT_HEADER]: bob.id } })).command.state, 'rejected');
    assert.equal((await client.json<any>(`${path}/commands/same-key`, { headers })).command.id, edited.command.id);
    await client.json('/execution-grants/revoke', { method: 'POST', body: JSON.stringify({ grantKey: policy.grantKey, runtime, sessionKey: f.sessionKey, principalId: 'alice', version: 1 }) });
    await assert.rejects(client.json(path, edit), { status: 403 }, 'revocation forbids new edits and write-path replay');
    assert.equal((await client.json<any>(`${path}/commands/same-key`, { headers })).command.state, 'accepted', 'historical read is not a new execution lease');
    const renewed = (await issue('alice', 2)).grant;
    assert.equal(renewed.actorId, alice.actorId);
    assert.equal((await client.json<any>(`${path}/commands/same-key`, { headers: { [EXECUTION_GRANT_HEADER]: renewed.id } })).command.id, edited.command.id);
    const cancel = { method: 'DELETE', headers: { ...headers, 'if-match': JSON.stringify(f.users.turns.version(runtime, f.sessionKey, id)), 'idempotency-key': 'cancel' } };
    assert.equal((await client.json<any>(path, cancel)).command.state, 'accepted', 'original actor may cancel unstarted work after revoke');
    assert.equal((await client.json<any>(`${path}/commands/cancel`, { headers })).command.state, 'accepted');
    f.tokens.revoke(issuer.record.id);
    await assert.rejects(client.json(`${path}/commands/cancel`, { headers }), { status: 403 });
  } finally { await f.close(); }
});

for (const transport of ['local', 'http'] as const) for (const runtime of ['codex', 'openclaw'] as const) {
  test(`${transport}/${runtime}: Hub mutation recovery is GET-only after dropped acknowledgements and restart`, async () => {
    let lost = true, mutations = 0;
    const deliveries: string[] = [];
    const f = await fixture(transport, runtime, async (request, response) => {
      if (['PATCH', 'DELETE'].includes(request.method)) { mutations++; deliveries.push(request.headers.get('idempotency-key')!); }
      if (lost && new URL(request.url).pathname.includes('/queue/')) return Response.json({}, { status: 502 });
      return response;
    });
    try {
      f.hubStore.pinConnectionNode('node', 'default', f.hubStore.connectionAuthority('node')!, f.users.nodeId);
      const admitted = await (await f.hub.request(`${f.prefix}/messages`, { method: 'POST', body: JSON.stringify({ message: 'before' }) })).json() as any;
      const id = admitted.idempotencyKey, path = `${f.prefix}/queue/${encodeURIComponent(id)}`;
      const version = f.users.turns.version(runtime, f.sessionKey, id)!;
      const edit = { method: 'PATCH', headers: { 'idempotency-key': 'browser-key', 'if-match': JSON.stringify(version) }, body: JSON.stringify({ message: 'after' }) };
      const pending = await f.hub.request(path, edit);
      assert.equal(pending.status, 202); assert.equal((await pending.json() as any).command.state, 'outcome_unknown');
      assert.equal(mutations, 1); assert.notEqual(deliveries[0], 'browser-key');
      assert.notEqual(f.users.turns.version(runtime, f.sessionKey, id), version);
      assert.equal((await f.hub.request(path, edit)).status, 202); assert.equal(mutations, 1);
      const reopened = new HubStore(f.config.hub.databaseFile, f.config.hub.vaultSecret), app = new Hono();
      const routes = registerHubRoutes(app, { config: f.config, hubStore: reopened, normalizeError: () => 'test error',
        connectorClient: createConnectorClientResolver(reopened, { connectionId: 'node', token: f.writer.token, dispatch: f.connector.fetch }) });
      try {
        lost = false;
        const recoveredResponse = await app.request(`${path}/commands/browser-key`);
        assert.equal(recoveredResponse.headers.get('cache-control'), 'no-store');
        const recovered = await recoveredResponse.json() as any;
        assert.equal(recovered.command.key, 'browser-key'); assert.equal(recovered.command.state, 'accepted');
        assert.deepEqual(recovered.command.result, { status: 200, body: { ok: true } });
        assert.equal((await app.request(path, edit)).status, 200); assert.equal(mutations, 1);
        assert.equal((await app.request(path, { ...edit, body: JSON.stringify({ message: 'different' }) })).status, 409);
        const stale = await app.request(path, { ...edit, headers: { ...edit.headers, 'idempotency-key': 'stale' } });
        assert.equal(stale.status, 412, 'rejection comes from original Connector receipt, not a speculative local error');
        assert.equal((await (await app.request(`${path}/commands/stale`)).json() as any).command.state, 'rejected');
        lost = true;
        const cancel = { method: 'DELETE', headers: { 'idempotency-key': 'cancel', 'if-match': JSON.stringify(f.users.turns.version(runtime, f.sessionKey, id)) } };
        assert.equal((await app.request(path, cancel)).status, 202);
        assert.equal(f.users.turns.hasPending(runtime, f.sessionKey), false);
        const sent = mutations;
        lost = false;
        assert.equal((await (await app.request(`${path}/commands/cancel`)).json() as any).command.state, 'accepted');
        assert.equal((await app.request(path, cancel)).status, 200); assert.equal(mutations, sent);
      } finally { routes?.close(); reopened.close(); }
    } finally { await f.close(); }
  });
}

test('Connector queue edit rechecks permission after a slow request body', async () => {
  const f = await fixture('local', 'codex');
  try {
    const result = await f.codex.send(f.sessionKey, 'original', [], { actorId: f.writer.record.id });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const pending = f.connector.request(`/api/connector/v1/sessions/${encodeURIComponent(f.sessionKey)}/queue/${encodeURIComponent(result.idempotencyKey)}`, {
      method: 'PATCH', headers: { authorization: `Bearer ${f.writer.token}` }, body, duplex: 'half',
    } as any);
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.tokens.revoke(f.writer.record.id);
    controller.enqueue(Buffer.from('{"message":"changed"}')); controller.close();
    assert.equal((await pending).status, 403);
    assert.equal(f.users.turns.head<any>('codex', f.sessionKey)?.payload.text, 'original');
  } finally { await f.close(); }
});

for (const transport of ['local', 'http'] as const) for (const runtime of ['codex', 'openclaw'] as const) {
  test(`${transport}/${runtime}: original delegated command binds edits/cancel and post-deletion mutation reads`, async () => {
    const f = await fixture(transport, runtime);
    const issuer = f.tokens.create({ label: 'synthetic', delegationHubId: 'hub-fixture', scopes: ['execution:delegate', 'messages:read', 'messages:send', 'queue:manage'] });
    const client = f.direct(issuer.token), path = `/sessions/${encodeURIComponent(f.sessionKey)}`;
    const issue = async (principalId: string) => (await client.json<any>('/execution-grants', { method: 'POST', body: JSON.stringify({
      principalId, grantKey: 'policy', version: 1, runtime, sessionKey: f.sessionKey, actions: ['messages:send'], expiresAt: Date.now() + 30_000 }) })).grant;
    try {
      const alice = await issue('alice'), bob = await issue('bob');
      const post = (ref: string, key: string) => client.json<any>(`${path}/messages`, { method: 'POST', headers: { [EXECUTION_GRANT_HEADER]: ref },
        body: JSON.stringify({ message: 'original', idempotencyKey: key }) });
      const a = await post(alice.id, 'original'), b = await post(bob.id, 'original');
      const pagePath = `${path}/queue/commands`;
      const list = (ref?: string, cursor?: string) => client.json<any>(`${pagePath}${cursor === undefined ? '' : `?cursor=${cursor}`}`,
        { headers: ref ? { [EXECUTION_GRANT_HEADER]: ref } : {} });
      const firstPage = await list(alice.id);
      assert.deepEqual(firstPage, { items: [{ commandKey: 'original', state: 'queued', createdAt: firstPage.items[0].createdAt, version: '1:1' }], nextCursor: null });
      assert.equal((await list(bob.id)).items[0].version, '2:1');
      await assert.rejects(list(), { status: 403 }, 'issuer without delegated actor must fail closed');
      const manager = f.tokens.create({ label: 'manager', scopes: ['messages:read', 'queue:manage'] });
      assert.deepEqual(await f.direct(manager.token).json(pagePath), { items: [], nextCursor: null }, 'management scope cannot enumerate other actors');
      for (const cursor of ['-1', '1.5', '9007199254740992']) await assert.rejects(list(alice.id, cursor), { status: 400 });
      const mutation = (ref: string, key: string, version: string, method = 'PATCH') => ({ method,
        headers: { [EXECUTION_GRANT_HEADER]: ref, 'idempotency-key': key, 'if-match': JSON.stringify(version) },
        ...(method === 'PATCH' ? { body: JSON.stringify({ message: 'edited', messageId: b.idempotencyKey }) } : {}) });
      const exact = `${path}/commands/original/queue`, av = f.users.turns.version(runtime, f.sessionKey, a.idempotencyKey)!;
      await assert.rejects(client.json(exact, { method: 'DELETE', headers: { [EXECUTION_GRANT_HEADER]: alice.id, 'if-match': JSON.stringify(av) } }), { status: 400 });
      const edited = await client.json<any>(exact, mutation(alice.id, 'edit', av));
      assert.equal(edited.command.state, 'accepted');
      assert.equal(f.users.turns.version(runtime, f.sessionKey, b.idempotencyKey), '2:1', 'same caller key cannot address another actor');
      const changed = f.users.turns.list<any>(runtime, f.sessionKey).find(row => row.id === a.idempotencyKey)!;
      assert.equal(changed.payload[runtime === 'codex' ? 'text' : 'message'], 'edited');
      await assert.rejects(client.json(`${path}/commands/${encodeURIComponent(a.idempotencyKey)}/queue`, mutation(alice.id, 'forged', av)),
        { status: /^[A-Za-z0-9._:-]{1,200}$/.test(a.idempotencyKey) ? 404 : 400 }, 'runtime ID is not a command mapping');
      const lookup = `${exact}/commands/edit`;
      assert.equal((await client.json<any>(lookup, { headers: { [EXECUTION_GRANT_HEADER]: alice.id } })).command.state, 'accepted');
      await assert.rejects(client.json(lookup, { headers: { [EXECUTION_GRANT_HEADER]: bob.id } }), { status: 404 });
      const current = f.users.turns.version(runtime, f.sessionKey, a.idempotencyKey)!;
      assert.equal((await client.json<any>(exact, mutation(alice.id, 'edit', av))).command.state, 'accepted');
      assert.equal(f.users.turns.version(runtime, f.sessionKey, a.idempotencyKey), current, 'replay never re-edits');
      await client.json('/execution-grants/revoke', { method: 'POST', body: JSON.stringify({ principalId: 'alice', grantKey: 'policy', version: 1, runtime, sessionKey: f.sessionKey }) });
      assert.equal((await list(alice.id)).items[0].commandKey, 'original', 'send revoke does not hide actor queue history');
      await assert.rejects(client.json(exact, mutation(alice.id, 'revoked-edit', current)), { status: 403 });
      assert.equal((await client.json<any>(exact, mutation(alice.id, 'cancel', current, 'DELETE'))).command.state, 'accepted');
      assert.equal((await client.json<any>(`${exact}/commands/cancel`, { headers: { [EXECUTION_GRANT_HEADER]: alice.id } })).command.state, 'accepted');
      assert.equal((await client.json<any>(exact, mutation(alice.id, 'cancel', current, 'DELETE'))).command.state, 'accepted');
      assert.equal(f.users.turns.ownedEntry(runtime, f.sessionKey, a.idempotencyKey, alice.actorId), undefined);
      assert.deepEqual(await list(alice.id), { items: [], nextCursor: null });
      for (let index = 0; index < 65; index++) {
        const id = `runtime-${index}`, scope = JSON.stringify([alice.actorId, f.sessionKey]);
        await f.users.turns.enqueueAsync(runtime, { id, sessionKey: f.sessionKey, createdAt: index, payload: { actorId: alice.actorId, text: 'private body' } });
        // One legacy/unmapped queue row stays visible but is never given an invented key.
        if (index) { (await f.users.commands.claimAsync(scope, `page-${index}`, {})); f.users.commands.settle(scope, `page-${index}`, { status: 200, body: { idempotencyKey: id } }); }
        // Real admissions arrive on separate turns. Seeding 65 durable rows in
        // one synchronous turn starves both loopback HTTP peers past keep-alive
        // expiry and tests a stale socket instead of delegated pagination.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      const page = await list(alice.id), next = await list(alice.id, page.nextCursor);
      assert.equal(page.items.length, 64); assert.equal(page.items[0].commandKey, null);
      assert.equal(page.items[63].commandKey, 'page-63'); assert.equal(next.items.length, 1);
      assert.equal(next.items[0].commandKey, 'page-64'); assert.equal(next.nextCursor, null);
      assert.doesNotMatch(JSON.stringify(page), /private body|runtime-|actorId|"id"/);
      const unknownScope = JSON.stringify([bob.actorId, f.sessionKey]);
      (await f.users.commands.claimAsync(unknownScope, 'unknown', {}, true));
      await assert.rejects(client.json(`${path}/commands/unknown/queue`, mutation(bob.id, 'no-target', '2:1')), { status: 409 });
      assert.equal(f.users.turns.version(runtime, f.sessionKey, b.idempotencyKey), '2:1');
      f.tokens.revoke(issuer.record.id);
      await assert.rejects(list(alice.id), { status: 403 });
      await assert.rejects(client.json(`${exact}/commands/cancel`, { headers: { [EXECUTION_GRANT_HEADER]: alice.id } }), { status: 403 });
    } finally { await f.close(); }
  });
}

async function fixture(transport: 'local' | 'http', runtime: 'codex' | 'openclaw', after?: (request: Request, response: Response) => Promise<Response>) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-queue-http-'));
  const config = loadConfig({ HOME: dir, AOD_SERVER_ROLE: 'all',
    AOD_HUB_DATABASE_FILE: join(dir, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'test-vault',
    AOD_SESSION_TITLES_FILE: join(dir, 'titles.json'), AOD_CONNECTOR_USERS_DATABASE_FILE: join(dir, 'connector.sqlite'),
    AOD_CONNECTOR_TOKENS_FILE: join(dir, 'tokens.json') });
  const tokens = new ConnectorTokenStore(config.connector.tokenFile);
  const users = new ConnectorUserStore(config.connector.usersDatabaseFile, id => !!tokens.delegationHubId(id));
  const writer = tokens.create({ label: 'writer', scopes: ['messages:read', 'messages:send'] });
  const store = new DeckStore(), sessionKey = runtime === 'codex' ? 'codex:queue/空 格' : 'agent:main:dashboard:queue/空 格';
  store.upsertSession({ sessionKey, agentId: runtime === 'codex' ? 'codex' : 'main', title: 'Queue', status: 'idle' });
  const authorizeTurn = createTurnAuthorizer(users.executionGrants, (id, scope) => tokens.hasScope(id, scope));
  const codex = new CodexAppServer({ authorizeTurn, enabled: true, command: 'must-not-launch', defaultCwd: dir,
    defaultModel: 'test', approvalPolicy: 'never', turnQueue: users.turns, executions: users.codexExecutions, store });
  (codex as any).connectionId = "synthetic-connection";
  (codex as any).ensureStarted = async () => { assert.fail('queue HTTP must not start runtime'); };
  const openclaw = new OpenClawTurnQueue({ authorizeTurn, turns: users.turns, executions: users.openClawExecutions, store, refreshSessions: async () => {},
    refreshMessages: async () => {}, mirror: async () => {}, send: async () => { assert.fail('queue HTTP must not dispatch'); } });
  const connector = new Hono();
  if (after) connector.use('*', async (c, next) => { await next(); c.res = await after(c.req.raw, c.res); });
  registerConnectorRoutes(connector, { config, tokens, connectorUsers: users, store, codex, openclawQueue: openclaw, sessionSnapshotReady: () => true, historySnapshotReady: () => true,
    gateway: { request: async () => { assert.fail('no Gateway calls'); } } as any, refreshSessions: async () => {},
    refreshMessages: async () => {}, fallbackAgents: () => [], isAuthorizedRequest: () => false, normalizeError: () => 'test error' });
  const server = transport === 'http' ? serve({ fetch: connector.fetch, hostname: '127.0.0.1', port: 0 }) : undefined;
  if (server && !server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server?.address(), origin = address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : 'http://connector.example.invalid';
  const hubStore = new HubStore(config.hub.databaseFile, config.hub.vaultSecret);
  hubStore.upsertConnection({ id: 'node', kind: transport === 'local' ? 'local' : 'remote', label: 'node', status: 'enabled',
    capabilities: ['messages'], connectorUrl: origin, ...(transport === 'http' ? { credentialToken: writer.token } : {}) });
  const hub = new Hono();
  const routes = registerHubRoutes(hub, { config, hubStore, normalizeError: () => 'test error',
    connectorClient: createConnectorClientResolver(hubStore, { connectionId: 'node', token: writer.token, dispatch: connector.fetch }) });
  return { hub, connector, codex, openclaw, sessionKey, tokens, writer, users, store, config, hubStore,
    prefix: `/api/hub/v1/sessions/${encodeURIComponent(encodeHubSessionId('node', sessionKey))}`,
    direct: (token: string) => new ConnectorClient(origin, token, transport === 'local' ? connector.fetch : undefined,
      // This fixture tests command ownership, not a shortened transport deadline.
      // Use the normal bounded client deadline, including under full-suite IO load.
      undefined, 8 * 1024 * 1024, { nodeId: users.nodeId }),
    close: async () => {
      routes?.close(); hubStore.close(); await codex.close(); await openclaw.close(); users.close();
      if (server) { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
    } };
}
