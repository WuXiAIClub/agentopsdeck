import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { registerAsyncLocalPreferences } from './local-preference-http.js';
import { validLocalPreferenceInput, validLocalPreferenceOutput } from './local-preference-domain.js';

test('preference RPC is a fixed domain, never a supplied path, actor or authorization boolean', () => {
  const input = { field: 'pinned', key: 'original', enabled: true, evidence: {} };
  assert.equal(validLocalPreferenceInput(input, false), true);
  for (const invalid of [{ ...input, path: '/private' }, { ...input, evidence: { authorized: true } },
    { ...input, field: 'arbitrary' }, { ...input, key: '' }, { ...input, enabled: 'true' },
    { ...input, evidence: { actorId: 'local:daily' } }]) {
    assert.equal(validLocalPreferenceInput(invalid, false), false);
    assert.equal(validLocalPreferenceInput(invalid, true), false);
  }
  assert.equal(validLocalPreferenceOutput({ field: 'pinned', key: ' space ', enabled: true, values: [' space '] }), true);
  assert.equal(validLocalPreferenceOutput({ field: 'pinned', key: 'x', enabled: true, values: [] }), false);
  assert.equal(validLocalPreferenceOutput({ denied: true, values: [] }), false);
});

for (const failure of ['lost-ack', 'mismatched', 'denied'] as const) {
  test(`preference ${failure} never projects or automatically repeats an owner write`, async () => {
    const app = new Hono(); let writes = 0, projects = 0;
    const routes = registerAsyncLocalPreferences(app, { originalJson: false, assertAvailable() {}, project() { projects++; },
      async change() {
        writes++;
        if (failure === 'lost-ack') throw Error('private-file-path');
        if (failure === 'denied') return { denied: true };
        return { field: 'pinned', key: 'other', enabled: true, values: ['other'] };
      },
    });
    const response = await app.request('http://local/api/sessions/original/pin', { method: 'PATCH', body: '{}' });
    assert.equal(response.status, failure === 'denied' ? 403 : 503);
    assert.doesNotMatch(await response.text(), /private-file/);
    await routes.close(); assert.equal(writes, 1); assert.equal(projects, 0);
    assert.equal((await app.request('http://local/api/sessions/late/pin', { method: 'PATCH', body: '{}' })).status, 503);
    assert.equal(writes, 1);
  });
}

test('close retains the original outstanding physical acknowledgement before releasing the route', async () => {
  const app = new Hono(); let entered!: () => void, finish!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { finish = resolve; });
  let projected = false;
  const routes = registerAsyncLocalPreferences(app, { originalJson: false, assertAvailable() {}, project() { projected = true; },
    async change(input) {
      entered(); await held;
      return { field: input.field, key: input.key, enabled: input.enabled, values: [input.key] };
    },
  });
  const request = app.request('http://local/api/sessions/held/pin', { method: 'PATCH', body: '{}' });
  await began;
  let closed = false; const closing = routes.close().then(() => { closed = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(closed, false); assert.equal(projected, false);
  finish(); assert.equal((await request).status, 200);
  await closing; assert.equal(projected, true); assert.equal(closed, true);
});
