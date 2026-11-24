import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HubStore } from './hub-store.js';
import { HubEventBrokers } from './event-broker.js';
import { hubEventResponse } from './event-stream.js';
import { emptyDrawing, emptyNativeDrawio } from '@agentopsdeck/shared';

for (const kind of ['drawing', 'native-drawio', 'metric-card'] as const) test(`${kind} revisions use owner SSE with no private bodies, reconnect and revoke safely`, { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drawing-resource-stream-'));
  const store = new HubStore(join(directory, 'hub.sqlite'), 'test');
  const brokers = new HubEventBrokers(store, () => { throw Error('No Connector access'); });
  const app = new Hono(); let authorized = true;
  const id = kind === 'metric-card' ? randomUUID() : 'default';
  const save = (user: string, revision: number) => kind === 'metric-card'
    ? store.cards.save(user, id, { title: 'PRIVATE card', value: 'PRIVATE value', detail: '', tone: 'blue', progress: null, revision, mutationId: randomUUID() })
    : kind === 'drawing' ? store.drawings.save(user, 'default', { ...emptyDrawing(), title: 'PRIVATE drawing', revision, mutationId: randomUUID() })
    : store.nativeDrawio.save(user, 'default', { ...emptyNativeDrawio(), title: 'PRIVATE drawing', revision, mutationId: randomUUID() });
  app.get('/:owner', c => {
    const ownerUserId = c.req.param('owner');
    return hubEventResponse(c, { store, ownerUserId, workspaceResources: true, subscription: brokers.acquire(ownerUserId),
      authorize() { if (!authorized) throw Error('SECRET proof'); } });
  });
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const open = async (owner = 'alice') => { const reader = (await app.request(`/${owner}`)).body!.getReader(); readers.push(reader); return reader; };
  const next = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    let buffer = '';
    for (;;) {
      const value = await reader.read(); assert.equal(value.done, false);
      buffer += new TextDecoder().decode(value.value);
      const match = /event: workspace\.revisions\ndata: (.*)\n/.exec(buffer);
      if (match) { assert.ok(!/PRIVATE|mxfile|nodes|SECRET/.test(buffer)); return JSON.parse(match[1]!); }
    }
  };
  try {
    save('alice', 0); save('bob', 0); save('bob', 1);
    const a = await open(), b = await open(), bob = await open('bob');
    const expected = (revision: number) => ({ type: 'workspace.revisions', resourceType: kind, resources: [{ resourceId: id, revision }] });
    assert.deepEqual(await next(a), expected(1)); assert.deepEqual(await next(b), expected(1)); assert.deepEqual(await next(bob), expected(2));
    save('alice', 1); assert.deepEqual(await next(a), expected(2)); assert.deepEqual(await next(b), expected(2));
    const reconnect = await open(); assert.deepEqual(await next(reconnect), expected(2));
    authorized = false;
    for (const reader of readers) while (!(await reader.read()).done) { /* authorization fence */ }
    assert.equal(store.latestDeliveryCursor('alice'), undefined);
  } finally {
    brokers.close(); await Promise.all(readers.map(reader => reader.cancel().catch(() => {})));
    await store.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('owner resource snapshots catch up two clients/reconnect without Connector events, bodies or cursor dependence', { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-resource-stream-'));
  const store = new HubStore(join(directory, 'hub.sqlite'), 'test');
  const brokers = new HubEventBrokers(store, () => { throw new Error('No Connector access'); });
  const app = new Hono();
  let authorized = true, active = 0;
  app.get('/:owner/:view', c => {
    const owner = c.req.param('owner'), handle = brokers.acquire(owner);
    active++;
    return hubEventResponse(c, { store, ownerUserId: owner, workspaceResources: true,
      ...(c.req.param('view') === 'shared' ? { project: () => undefined } : {}),
      authorize() { if (!authorized) throw new Error('private auth proof'); },
      subscription: { events: handle.events, release() { active--; handle.release(); } } });
  });
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const open = async (owner = 'alice', view = 'owner') => {
    const reader = (await app.request(`/${owner}/${view}?lastEventId=expired-chat-cursor`)).body!.getReader();
    readers.push(reader); return reader;
  };
  const next = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    let buffer = '';
    for (;;) {
      const chunk = await reader.read(); assert.equal(chunk.done, false, 'stream still authorized');
      buffer += new TextDecoder().decode(chunk.value);
      const match = /event: workspace\.revisions\ndata: (.*)\n/.exec(buffer);
      if (match) {
        assert.ok(!buffer.includes('PRIVATE TASK') && !buffer.includes('aod_board_'));
        return JSON.parse(match[1]!);
      }
    }
  };
  try {
    const task = { id: randomUUID(), title: 'PRIVATE TASK', detail: 'PRIVATE TASK body', status: 'todo' as const };
    const body = { title: 'PRIVATE TASK board', tasks: [task], mutationId: randomUUID(), revision: 0 };
    store.boards.save('alice', 'default', body);
    const bobId = randomUUID(); store.boards.save('bob', bobId, body);
    const a = await open(), b = await open(), bob = await open('bob');
    const expected = (revision: number, resourceId = 'default') => ({ type: 'workspace.revisions', resourceType: 'taskboard', resources: [{ resourceId, revision }] });
    assert.deepEqual(await next(a), expected(1)); assert.deepEqual(await next(b), expected(1));
    assert.deepEqual(await next(bob), expected(1, bobId), 'owner isolation');
    const grant = store.boardCapabilities.issue('alice', 'default', { taskIds: [task.id], fields: ['status'], expiresAt: Date.now() + 60_000 });
    assert.ok(grant);
    // A real capability mutation (not a model invocation) shares the same committed revision authority.
    const update = { revision: 1, mutationId: randomUUID(), tasks: [{ id: task.id, status: 'done' as const }] };
    const result = store.boardCapabilities.update(grant.token, update);
    assert.equal(result.status, 'saved');
    assert.deepEqual(store.boardCapabilities.update(grant.token, update), result, 'retry does not advance revision');
    assert.deepEqual(await next(a), expected(2)); assert.deepEqual(await next(b), expected(2));
    const reconnect = await open(); assert.deepEqual(await next(reconnect), expected(2));
    store.drawings.save('alice', 'default', { ...emptyDrawing(), revision: 0, mutationId: randomUUID() });
    store.nativeDrawio.save('alice', 'default', { ...emptyNativeDrawio(), revision: 0, mutationId: randomUUID() });
    const shared = await open('alice', 'shared');
    const sharedText = (async () => { let text = ''; for (;;) { const chunk = await shared.read(); if (chunk.done) return text; text += new TextDecoder().decode(chunk.value); } })();
    // Revocation closes even a resource-only stream; projected shared views cannot see resources.
    authorized = false;
    for (const reader of [a, b, bob, reconnect]) while (!(await reader.read()).done) { /* drain */ }
    const text = await sharedText;
    assert.ok(!text.includes('workspace.revisions') && !text.includes('private auth proof'));
    assert.equal(active, 0);
    assert.equal(store.latestDeliveryCursor('alice'), undefined, 'resources do not occupy chat journal');
  } finally {
    brokers.close(); await Promise.all(readers.map(reader => reader.cancel().catch(() => {})));
    await store.close(); rmSync(directory, { recursive: true, force: true });
  }
});
