import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { registerHubSessionPreferences } from './hub-session-preferences.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import type { HubPrincipal } from '../hub/identity.js';
for (const [path, field] of [['visibility', 'hidden'], ['archive', 'archived'], ['pin', 'pinned']] as const) {
  test(`preference ${path} preserves false-only default and exact frontend result`, async () => {
    const app = new Hono(), changes: unknown[] = [];
    registerHubSessionPreferences(app, { principal: () => ({ userId: 'member', admin: false }), port: {
      set: (_request, userId, change) => { assert.equal(userId, 'member'); changes.push(change); },
    } });
    for (const [body, value] of [[{}, true], [{ [field]: false }, false], [{ [field]: 0 }, true], [null, true]] as const) {
      const response = await app.request('/api/sessions/connection:b2xk/' + path, { method: 'PATCH', body: JSON.stringify(body) });
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const result = await response.json() as Record<string, unknown>;
      assert.deepEqual(Object.keys(result).sort(), [field, 'ok', 'sessionKey', 'updatedAt'].sort());
      assert.equal(result[field], value); assert.equal(result.sessionKey, 'connection:b2xk');
      assert.deepEqual(changes.at(-1), { sessionKey: 'connection:b2xk', field, value });
    }
    assert.equal((await app.request('/api/sessions/local/' + path, { method: 'PATCH' })).status, 404);
  });
  test(`preference ${path} denies revoked synchronous authority at final await gap`, async () => {
    const app = new Hono(); let calls = 0, current: HubPrincipal | undefined = { userId: 'member', admin: false }, writes = 0;
    registerHubSessionPreferences(app, { principal: async () => {
      const result = current!; if (++calls === 2) current = undefined; return result;
    }, synchronousStoreAuthority: () => current!, port: { set: () => { writes++; } } });
    const response = await app.request('/api/sessions/connection:b2xk/' + path, { method: 'PATCH', body: '{}' });
    assert.equal(response.status, 401); assert.equal(writes, 1, 'already committed write is not replayed/undone');
  });
}
test('preference unknown/cancelled outcomes preserve JSON 499, 503 and no-store', async () => {
  for (const code of [499, 503, 404, 401] as const) {
    const app = new Hono(); registerHubSessionPreferences(app, { principal: () => ({ userId: 'member', admin: false }), port: {
      set: () => { throw new HubMemberRequestError(code); },
    } });
    const response = await app.request('/api/sessions/connection:b2xk/pin', { method: 'PATCH', body: '{}' });
    assert.equal(response.status, code); assert.equal(response.headers.get('cache-control'), 'no-store');
    if (code === 499) assert.deepEqual(await response.json(), { error: 'request_cancelled' });
  }
});
