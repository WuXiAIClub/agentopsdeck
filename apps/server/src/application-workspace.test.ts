import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApplication } from './application.js';
import { loadConfig } from './config.js';
import { HubStore } from './hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from './hub/original-administrative-commands.js';
import { connectionCompletionTarget } from './hub/completion-unread-store.js';
import { encodeHubSessionId } from './hub/session-id.js';

for (const backend of ['json', 'sqlite'] as const) for (const member of [false, true]) {
  test(`actual ${backend} ${member ? 'member' : 'administrator'} saves use original awaited domains, preserve CAS and recover committed state`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'application-workspace-'));
    const administratorKey = 'isolated-workspace-administrator';
    const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: administratorKey,
      AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false', AOD_CONNECTOR_UPDATE_ENABLED: 'false',
      AOD_MEDIA_BRIDGE_ENABLED: 'false',
      AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'isolated-workspace-vault',
      AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
      AOD_SESSION_TITLES_FILE: join(root, 'titles.json'), AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
      AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'connector.sqlite'),
      ...(backend === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) });
    const seed = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
    const userId = member ? seed.createUser('Existing member').id : 'default';
    const loginKey = member ? seed.identities.issueKey(userId).token : administratorKey;
    let cookie: string;
    const nodeId = 'node_' + randomUUID(), remote = 'codex:' + randomUUID();
    const sessionKey = encodeHubSessionId('node', remote);
    seed.upsertConnection({ id: 'node', ownerUserId: userId, kind: 'remote', label: 'Existing node', connectorUrl: 'http://unused.invalid' });
    seed.pinConnectionNode('node', userId, seed.connectionAuthority('node', userId)!, nodeId);
    const target = connectionCompletionTarget(nodeId, 'node', seed.connectionAuthority('node', userId)!, remote);
    seed.completions.baseline(userId, target, 'epoch', 0);
    seed.completions.record({ owner: userId, target, epoch: 'epoch', turnId: 'turn', sourceCursor: 1, provenance: 'live-successful-message' });
    const workspace = '/api/hub/v1/workspace/preferences', layouts = '/api/hub/v1/workspace/layouts/';
    const completions = '/api/hub/v1/completions/';
    const document = { revision: 0, groups: [{ id: 'existing', name: 'Original group' }], sessions: { [sessionKey]: { color: '#123456' } } };
    const oldPreferences = seed.workspace.save(userId, document)!;
    const presentation = (kind: 'current' | 'saved', changed = false) => {
      const item = { id: kind === 'current' ? 'current' : 'saved-layout', name: kind === 'current' ? 'Current' : 'Saved',
        workspace: { version: 2, panes: [], floating: [], extension: { nested: { preserved: 'opaque frontend value' } } },
        collapsedKeys: changed ? ['changed'] : [] };
      return JSON.stringify(kind === 'saved' ? [item] : item);
    };
    const oldLayouts = { current: { ...seed.layouts.save(userId, 'current', { revision: 0, content: presentation('current') })! },
      saved: { ...seed.layouts.save(userId, 'saved', { revision: 0, content: presentation('saved') })! } };
    seed.setSessionPreference(sessionKey, 'hidden', true, userId);
    await seed.close();
    let application = createApplication(config), lost: string | undefined;
    const calls: string[] = [];
    const original = OriginalHubAdministrativeCommands.prototype.command;
    t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
      calls.push(kind);
      const reply = original.call(this, kind, input);
      if (kind !== lost) return reply;
      lost = undefined;
      return reply.then(() => { throw Error('PRIVATE committed original reply'); });
    });
    const request = (path: string, method = 'GET', body?: unknown) => application.app.request(path, {
      method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const expect = async (reply: Response | Promise<Response>, status: number): Promise<any> => {
      const response = await reply, text = await response.text();
      assert.equal(response.status, status, text);
      // Revoked cookies are rejected by the existing global authentication
      // middleware before the domain route can set its response headers.
      if (status !== 401) assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.doesNotMatch(text, /PRIVATE|isolated-workspace-administrator|isolated-workspace-vault/);
      return response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
    };
    const count = (kind: string) => calls.filter(call => call === kind).length;
    let savedPreferences = oldPreferences;
    const savedLayouts = { ...oldLayouts };
    let observation: { token: string; throughSequence: number }, read: { sessionKey: string; token: string; throughSequence: number; requestId: string };
    try {
      const login = await application.app.request('/api/auth/login', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey: loginKey }) });
      assert.equal(login.status, 200);
      const authenticated = /^agentopsdeck_session=(?:hub_session_)?[A-Za-z0-9_-]{43}(?=;)/.exec(login.headers.get('set-cookie') ?? '')?.[0];
      assert.ok(authenticated); cookie = authenticated;
      assert.deepEqual(await expect(request(workspace), 200), oldPreferences);
      const next = { ...oldPreferences, ungroupedCollapsed: true };
      lost = 'workspaceSave'; const before = count(lost);
      await expect(request(workspace, 'PUT', next), 503); assert.equal(count('workspaceSave'), before + 1);
      savedPreferences = await expect(request(workspace), 200);
      assert.deepEqual(savedPreferences, { ...next, revision: 2 });
      await expect(request(workspace, 'PUT', next), 409);
      for (const kind of ['current', 'saved'] as const) {
        assert.deepEqual(await expect(request(layouts + kind), 200), oldLayouts[kind]);
        const change = { revision: 1, content: presentation(kind, true) };
        lost = 'layoutSave'; const before = count(lost);
        await expect(request(layouts + kind, 'PUT', change), 503); assert.equal(count('layoutSave'), before + 1);
        savedLayouts[kind] = await expect(request(layouts + kind), 200);
        assert.deepEqual(savedLayouts[kind], { ...change, revision: 2 });
        // Original frontend lost-reply reconciliation, not an automatic replay.
        assert.deepEqual(await expect(request(layouts + kind, 'PUT', change), 200), savedLayouts[kind]);
        await expect(request(layouts + kind, 'PUT', oldLayouts[kind]), 409);
      }
      const summary = await expect(request(completions + 'summary', 'POST', { sessions: [sessionKey] }), 200);
      assert.equal(summary.items[0].unread, true);
      assert.equal(count('completionSummary'), 1); // The fixed async domain now owns the display query.
      lost = 'completionObserve'; const observes = count(lost);
      await expect(request(completions + 'observe', 'POST', { sessionKey }), 503);
      assert.equal(count('completionObserve'), observes + 1);
      observation = await expect(request(completions + 'observe', 'POST', { sessionKey }), 200);
      read = { sessionKey, token: observation.token, throughSequence: observation.throughSequence, requestId: randomUUID() };
      lost = 'completionRead'; const reads = count(lost);
      await expect(request(completions + 'read', 'POST', read), 503); assert.equal(count('completionRead'), reads + 1);
      assert.equal((await expect(request(completions + 'summary', 'POST', { sessions: [sessionKey] }), 200)).items[0].unread, false);
      assert.deepEqual(await expect(request(completions + 'read', 'POST', read), 200), { throughSequence: 1 });
      await expect(request(completions + 'read', 'POST', { ...read, token: randomUUID() }), 409);
      lost = 'sessionPreferenceSet'; const preferences = count(lost);
      await expect(request(`/api/sessions/${sessionKey}/pin`, 'PATCH', { pinned: true }), 503);
      assert.equal(count('sessionPreferenceSet'), preferences + 1);
      const visible = await expect(request(`/api/sessions/${sessionKey}/visibility`, 'PATCH', { hidden: false }), 200);
      assert.equal(visible.hidden, false);
      const archived = await expect(request(`/api/sessions/${sessionKey}/archive`, 'PATCH', {}), 200);
      assert.equal(archived.archived, true); // Original false-only opt-out.
      await application.close();
      application = createApplication(config);
      assert.deepEqual(await expect(request(workspace), 200), savedPreferences);
      for (const kind of ['current', 'saved'] as const) assert.deepEqual(await expect(request(layouts + kind), 200), savedLayouts[kind]);
      assert.deepEqual(await expect(request(completions + 'read', 'POST', read), 200), { throughSequence: 1 });
      assert.equal((await expect(request(completions + 'summary', 'POST', { sessions: [sessionKey] }), 200)).items[0].readThrough, 1);
      await expect(request('/api/auth/logout', 'POST'), 200);
      await expect(request(workspace, 'PUT', savedPreferences), 401);
      await expect(request(layouts + 'current', 'PUT', savedLayouts.current), 401);
      await expect(request(completions + 'observe', 'POST', { sessionKey }), 401);
      await expect(request(`/api/sessions/${sessionKey}/pin`, 'PATCH', { pinned: false }), 401);
      await application.close();
      const reopened = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
      try {
        assert.deepEqual(reopened.sessionPreferences(userId).get(sessionKey), { hidden: false, archived: true, pinned: true });
        assert.deepEqual(reopened.workspace.get(userId), savedPreferences);
      } finally { await reopened.close(); }
    } finally { await application.close(); rmSync(root, { recursive: true, force: true }); }
  });
}
