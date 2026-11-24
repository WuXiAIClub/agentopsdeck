import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { SharedCommandPort } from '../hub/shared-command-port.js';
import { registerHubSharedCommandRoutes } from './hub-shared-commands.js';

for (const phase of ['post-body-read', 'send', 'delivery-read'] as const) {
  test(`shared body reservations retain parsed payload through ${phase} and HTTP abort`, async t => {
    let release!: () => void, ready!: () => void, waiting = 0, sends = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = new Promise<void>(resolve => { ready = resolve; });
    t.after(release);
    const wait = async () => { if (++waiting === 2) ready(); await gate; };
    const app = new Hono();
    registerHubSharedCommandRoutes(app, { mode: 'async', asyncSharedCommands: {
      async open() {
        let reads = 0;
        const unused = async (): Promise<never> => { throw Error('Unexpected shared command operation'); };
        return {
          ref: { nodeId: 'isolated-node', runtimeId: 'codex', nativeSessionKey: 'codex:isolated' },
          async read() {
            reads++;
            if (phase === 'post-body-read' && reads === 1 || phase === 'delivery-read' && reads === 2) await wait();
          },
          async send(key) {
            sends++;
            if (phase === 'send') await wait();
            return { id: key, key, state: 'accepted', createdAt: 1, updatedAt: 1,
              result: { status: 200, body: { ok: true, status: 'queued' } } };
          },
          recover: unused, queue: unused, queuePage: unused, mutateQueue: unused, recoverQueueMutation: unused,
        } satisfies SharedCommandPort;
      },
      async close() {},
    } });
    const request = (key: string, signal?: AbortSignal, message: unknown = 'bounded payload') => app.request(
      '/api/hub/v1/shared/owner/sessions/session/messages', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, idempotencyKey: key }), ...(signal ? { signal } : {}),
      });
    const controller = new AbortController();
    const first = request('original-first', controller.signal), second = request('original-second');
    await held;
    controller.abort();
    assert.equal((await request('excess')).status, 503, 'aborting a waiter cannot free original body ownership');
    assert.equal(waiting, 2);
    assert.equal(sends, phase === 'post-body-read' ? 0 : 2);
    release();
    assert.deepEqual((await Promise.all([first, second])).map(response => response.status), [200, 200]);
    assert.equal((await request('invalid', undefined, {})).status, 400);
    assert.equal((await request('after-original-settlement')).status, 200, 'settled and rejected bodies release reservations');
    assert.equal(sends, 3, 'capacity denial and invalid input never dispatch');
  });
}

test('post-body authority rejection releases its reservation without dispatch', async () => {
  let deny = true, sends = 0;
  const unused = async (): Promise<never> => { throw Error('Unexpected shared command operation'); };
  const app = new Hono();
  registerHubSharedCommandRoutes(app, { mode: 'async', asyncSharedCommands: {
    async open() {
      return {
        ref: { nodeId: 'isolated-node', runtimeId: 'codex', nativeSessionKey: 'codex:isolated' },
        read() { if (deny) throw new HTTPException(403); },
        async send(key) { sends++; return { id: key, key, state: 'outcome_unknown', createdAt: 1, updatedAt: 1 }; },
        recover: unused, queue: unused, queuePage: unused, mutateQueue: unused, recoverQueueMutation: unused,
      } satisfies SharedCommandPort;
    }, async close() {},
  } });
  const request = () => app.request('/api/hub/v1/shared/owner/sessions/session/messages', {
    method: 'POST', body: JSON.stringify({ message: 'bounded payload', idempotencyKey: 'original' }),
  });
  for (let attempt = 0; attempt < 3; attempt++) assert.equal((await request()).status, 403);
  assert.equal(sends, 0);
  deny = false;
  assert.equal((await request()).status, 202);
  assert.equal(sends, 1);
});
