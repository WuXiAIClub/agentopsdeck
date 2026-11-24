import assert from 'node:assert/strict';
import test from 'node:test';
import { api, setRecoveryScope, ApiResponseError, type HubNodeGrant } from '../api.js';
const grant: HubNodeGrant = { id: 'grant', userId: 'recipient', version: 2, nodeVersion: 1, revoked: false,
  policy: { runtime: 'codex', sessionKey: 'codex:fixture', actions: ['messages:read'] } };

for (const shared of [false, true]) for (const operation of ['create', 'update', 'delete'] as const) for (const status of [409, 503, 'network'] as const) {
  test(`${shared ? 'shared' : 'owned'} ${operation} ${status}: sharing sends once and recovery only reads`, async t => {
    const originalWindow = globalThis.window, originalFetch = globalThis.fetch, storage = new Map<string, string>();
    Object.assign(globalThis, { window: { setTimeout, clearTimeout, dispatchEvent() {},
      location: { hostname: 'example.invalid', protocol: 'https:' },
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
      sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } } });
    t.after(() => { setRecoveryScope(undefined); globalThis.fetch = originalFetch; Object.assign(globalThis, { window: originalWindow }); });
    setRecoveryScope('d'.repeat(64));
    const calls: Array<{ url: string; method: string; body: BodyInit | null | undefined }> = [];
    const target = shared ? { ownerUserId: 'owner', sessionId: 'node:session' } : 'node:session';
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body });
      if ((init?.method ?? 'GET') === 'GET') return Response.json({ collaborators: [grant], candidates: [{ id: 'recipient', label: 'Recipient', canChat: true }] });
      if (status === 'network') throw Error('response confirmation lost');
      return Response.json({ error: 'Could not confirm whether access was saved. Reload sharing before deciding what to do; do not automatically resubmit.' }, { status });
    };
    const work = () => operation === 'create' ? api.shareSession(target, 'recipient', 'observer') : operation === 'update'
      ? api.updateSessionCollaborator(target, grant, { role: 'observer', live: true, queue: false, media: false })
      : api.revokeSessionCollaborator(target, grant);
    await assert.rejects(work(), error => status === 'network' ? error instanceof Error : error instanceof ApiResponseError && error.status === status);
    assert.equal(calls.length, 1); assert.equal(calls[0]!.method, operation === 'create' ? 'POST' : operation === 'update' ? 'PUT' : 'DELETE');
    if (operation !== 'create') assert.equal(JSON.parse(String(calls[0]!.body)).version, grant.version);
    const refreshed = await api.sessionCollaborators(target);
    assert.deepEqual(refreshed.collaborators, [grant]); assert.equal(calls.length, 2);
    assert.equal(calls[1]!.method, 'GET'); assert.equal(calls.filter(call => call.method !== 'GET').length, 1);
    assert.ok(calls.every(call => call.url.includes(shared ? '/shared/owner/sessions/' : '/sessions/')));
  });
}
