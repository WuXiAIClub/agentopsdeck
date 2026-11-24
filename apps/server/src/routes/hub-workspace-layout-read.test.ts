import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { registerHubWorkspaceLayouts, type HubWorkspaceLayoutsPort } from './hub-workspace-layouts.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import type { LayoutDocument } from '../hub/workspace-layouts.js';
const base = '/api/hub/v1/workspace/layouts/';
const empty = { revision: 0, content: null };
const actor = { userId: 'alice', admin: false };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function setup(get: HubWorkspaceLayoutsPort['get'], authority = () => actor) {
  const app = new Hono(); let writes = 0;
  registerHubWorkspaceLayouts(app, { principal: () => actor, synchronousStoreAuthority: authority,
    port: { get, save: (_request, _user, _kind, value) => { writes++; return { ...value, revision: 1 }; } } });
  app.onError((error, c) => error instanceof HTTPException ? c.json({ error: error.message }, error.status) : c.json({ error: 'unexpected' }, 500));
  return { app, writes: () => writes };
}
for (const kind of ['current', 'saved'] as const) {
  test(`${kind} default asynchronous read keeps wire shape, scope and no-store`, async () => {
    const { app, writes } = setup(async (_request, user, collection) => { assert.equal(user, 'alice'); assert.equal(collection, kind); return empty; });
    const response = await app.request(base + kind); assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.deepEqual(await response.json(), empty); assert.equal(writes(), 0);
  });
  for (const status of [401, 403, 409, 499, 503] as const) {
    for (const sync of [true, false]) test(`${kind} ${sync ? 'sync' : 'async'} trusted refusal ${status} preserved`, async () => {
      const get = () => { throw new HubMemberRequestError(status); };
      const { app, writes } = setup(sync ? get : async () => get());
      const response = await app.request(base + kind); assert.equal(response.status, status); assert.equal(writes(), 0);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    });
  }
  test(`${kind} unknown storage failure becomes safe 503 without layout overwrite`, async () => {
    const { app, writes } = setup(async () => { throw Error('PRIVATE-path-or-content'); });
    const response = await app.request(base + kind); assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /PRIVATE/); assert.equal(writes(), 0);
  });
  test(`${kind} post-await authority change refuses buffered layout`, async () => {
    let valid = true, resolve!: (value: LayoutDocument) => void;
    const { app } = setup(() => new Promise(done => { resolve = done; }), () => valid ? actor : { ...actor, userId: 'bob' });
    const response = app.request(base + kind); await turn(); valid = false; resolve(empty);
    assert.equal((await response).status, 401);
  });
  test(`${kind} cancelled response does not release/replay pending owner read`, async () => {
    let resolve!: (value: LayoutDocument) => void, settled = false, calls = 0;
    const { app, writes } = setup(async () => { calls++; const value = await new Promise<LayoutDocument>(done => { resolve = done; }); settled = true; return value; });
    const abort = new AbortController();
    const response = app.request(new Request('http://localhost' + base + kind, { signal: abort.signal }));
    await turn(); abort.abort(); assert.equal((await response).status, 499);
    assert.equal(settled, false); assert.equal(calls, 1); assert.equal(writes(), 0);
    resolve(empty); await turn(); assert.equal(settled, true); assert.equal(calls, 1);
  });
}
test('unknown collection does not touch owner or writer', async () => {
  const { app, writes } = setup(() => { throw Error('forbidden'); });
  assert.equal((await app.request(base + 'private')).status, 404); assert.equal(writes(), 0);
});
