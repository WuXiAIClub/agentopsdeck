import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { HubStore } from '../hub/hub-store.js';
import { AsyncHubMemberOwner } from '../hub/async-member-owner.js';
import { AsyncHubCompletions } from '../hub/async-completions.js';
import { connectionCompletionTarget } from '../hub/completion-unread-store.js';
import { encodeHubSessionId } from '../hub/session-id.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubCompletionRoutes } from './hub-completions.js';

test('complete-owner completion HTTP keeps original cookie/body/wire, ACK recovery and no-store without a second writer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-completion-http-owner-')), file = join(root, 'hub.sqlite');
  const hub = new HubStore(file, 'http-fixture'), member = hub.createUser('Original member');
  const key = hub.identities.issueKey(member.id), cookie = hub.identities.createSession(key.token)!;
  const conn = 'original-connection', remote = 'codex:original-long-session';
  hub.upsertConnection({ id: conn, ownerUserId: member.id, label: 'Original connection', connectorUrl: 'http://fixture.invalid',
    credentialToken: 'synthetic', capabilities: ['events'] });
  hub.pinConnectionNode(conn, member.id, hub.connectionAuthority(conn, member.id)!, 'node_00000000-0000-4000-8000-000000000001');
  const sessionKey = encodeHubSessionId(conn, remote), target = connectionCompletionTarget(hub.getConnection(conn, member.id)!.nodeId!,
    conn, hub.connectionAuthority(conn, member.id)!, remote);
  hub.completions.baseline(member.id, target, 'original-epoch', 10);
  hub.completions.record({ owner: member.id, target, epoch: 'original-epoch', turnId: 'original-turn', sourceCursor: 11, provenance: 'live-successful-message' });
  await hub.close();
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'http-fixture' }, diagnostics);
  const service = new AsyncHubCompletions(owner, diagnostics);
  const app = new Hono();
  registerHubCompletionRoutes(app, { port: service, principal: c => service.principal(c.req.raw) });
  const send = async (action: string, body: unknown, signal?: AbortSignal) => app.request(`/api/hub/v1/completions/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: 'agentopsdeck_session=' + cookie },
    body: JSON.stringify(body), ...(signal ? { signal } : {}),
  });
  try {
    const summary = await send('summary', { sessions: [sessionKey, sessionKey, 'missing:YQ'] });
    assert.equal(summary.status, 200); assert.equal(summary.headers.get('cache-control'), 'no-store');
    const rows = await summary.json() as { items: Array<Record<string, unknown>> };
    assert.equal(rows.items.length, 1); assert.equal(rows.items[0]!.unread, true); assert.equal(rows.items[0]!.coverage, 'gap');
    assert.deepEqual(Object.keys(rows.items[0]!).sort(), ['coverage', 'displayTarget', 'generation', 'latestSequence', 'readThrough', 'sessionKey', 'unread']);
    const observe = await send('observe', { sessionKey }); assert.equal(observe.status, 200);
    const observation = await observe.json() as { token: string; generation: string; throughSequence: number; expiresAt: number; turnId: string };
    assert.deepEqual(Object.keys(observation).sort(), ['expiresAt', 'generation', 'throughSequence', 'token', 'turnId']);
    assert.equal(observation.turnId, 'original-turn'); assert.equal(observation.throughSequence, 1);
    const input = { sessionKey, requestId: 'original-receipt', token: observation.token, throughSequence: 1 };
    for (let i = 0; i < 2; i++) {
      const read = await send('read', input); assert.equal(read.status, 200); assert.deepEqual(await read.json(), { throughSequence: 1 });
      assert.equal(read.headers.get('cache-control'), 'no-store');
    }
    const conflict = await send('read', { ...input, throughSequence: 0 });
    assert.equal(conflict.status, 409); assert.deepEqual(await conflict.json(), { error: 'request-reused' });
    const sequence = await send('read', { ...input, requestId: 'invalid-sequence', throughSequence: -1 });
    assert.equal(sequence.status, 409); assert.deepEqual(await sequence.json(), { error: 'sequence' });
    assert.equal((await send('observe', { sessionKey: 'missing:YQ' })).status, 404);
    assert.equal((await send('summary', { sessions: [], authorized: true })).status, 400);
    const controller = new AbortController(); controller.abort();
    const cancelled = await send('summary', { sessions: [sessionKey] }, controller.signal);
    assert.equal(cancelled.status, 499); assert.deepEqual(await cancelled.json(), { error: 'request_cancelled' });
    assert.equal(cancelled.headers.get('cache-control'), 'no-store');
    for (const secret of [cookie, sessionKey, observation.token, input.requestId]) assert.equal(logs.join('').includes(secret), false);
  } finally { await owner.close(); }
  const reopen = new HubStore(file, 'http-fixture');
  try { assert.equal(reopen.completions.summary(member.id, [target])[0]!.readThrough, 1); }
  finally { await reopen.close(); rmSync(root, { recursive: true, force: true }); }
});
