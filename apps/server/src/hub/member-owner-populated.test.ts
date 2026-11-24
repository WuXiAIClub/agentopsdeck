import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { encodeHubSessionId } from './session-id.js';

test('whole Hub member worker retains populated business domains, original cookies and CAS receipts across original reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-hub-populated-r38-'));
  const file = join(root, 'hub.sqlite'), secret = 'isolated-fixture-vault';
  let store: HubStore | undefined = new HubStore(file, secret);
  let worker: AsyncHubMemberOwner | undefined;
  try {
    const user = store.createUser('Existing account');
    const key = store.identities.issueKey(user.id);
    const cookie = store.identities.createSession(key.token)!;
    const connectionId = randomUUID();
    store.upsertConnection({ id: connectionId, ownerUserId: user.id, label: 'Existing connector',
      connectorUrl: 'http://connector.invalid', credentialToken: 'isolated-fixture-connector-credential',
      capabilities: ['history'] });
    const session = encodeHubSessionId(connectionId, 'existing-native-session');
    store.setSessionPreference(session, 'pinned', true, user.id);
    store.setSessionPreference(session, 'hidden', false, user.id);
    const preferences = store.workspace.save(user.id, { revision: 0, groups: [{ id: 'existing', name: 'Existing group' }],
      sessions: { [session]: { color: '#123456', groupId: 'existing', order: 7, tags: ['keep'] } } });
    assert.ok(preferences);
    const hot = store.notebooks.save(user.id, { resourceId: session, revision: 0, text: 'Existing hot notes\n' });
    const cold = store.notebooks.saveArchive(user.id, { resourceId: session, revision: 0, text: 'Existing cold archive\n' });
    assert.ok(hot); assert.ok(cold);
    const boardInput = { revision: 0, mutationId: randomUUID(), title: 'Existing tasks',
      tasks: [{ id: randomUUID(), title: 'Existing task', detail: 'Keep state', status: 'doing' as const,
        tags: ['recovery'], priority: 'high' as const, dueDate: '2026-10-20' }] };
    const board = store.boards.save(user.id, 'default', boardInput);
    assert.equal(board.status, 'saved');
    const guidance = store.sessionGuidance.save(user.id, session, 0, 'Keep original guidance', true);
    assert.equal(store.appendDelivery({ envConnectionId: connectionId, sessionKey: 'existing-native-session',
      type: 'message.created', ts: 1, payload: { message: 'Existing history' } }, 'existing-domain', 'original-cursor', user.id), true);
    const authority = store.connectionAuthority(connectionId, user.id);
    assert.ok(authority);
    await store.close(); store = undefined;

    const snapshot = () => {
      const db = new DatabaseSync(file);
      try {
        const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
        return names.filter(({ name }) => !['hub_login_sessions', 'hub_key_usage', 'hub_user_usage'].includes(name))
          .map(({ name }) => ({ name, rows: db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '" ORDER BY rowid').all() }));
      } finally { db.close(); }
    };
    const before = snapshot();
    assert.ok(before.length >= 60);
    assert.ok(before.filter(table => table.rows.length > 0).length >= 12, 'real populated domain data, not only empty schema');
    // Compare to a legitimate original reopen before claiming worker equivalence.
    store = new HubStore(file, secret); await store.close(); store = undefined;
    assert.deepEqual(snapshot(), before);

    worker = new AsyncHubMemberOwner({ file, encryptionSecret: secret }, new PerformanceDiagnostics(() => {}));
    await worker.open();
    const initial = await worker.command('memberSnapshot', { sessionToken: cookie });
    assert.ok(initial); assert.equal(initial.principal.userId, user.id);
    const next = await worker.command('memberSessionCreate', { key: key.token });
    assert.ok(next);
    await worker.close();
    assert.equal(worker.snapshot().ownerExitConfirmed, true); worker = undefined;
    assert.deepEqual(snapshot(), before);

    store = new HubStore(file, secret);
    const request = (token: string) => new Request('http://fixture.invalid/', { headers: { cookie: 'agentopsdeck_session=' + token } });
    assert.equal(store.identities.requestPrincipal(request(cookie), () => false)?.userId, user.id);
    assert.equal(store.identities.requestPrincipal(request(next.token), () => false)?.userId, user.id);
    assert.equal(store.identities.recoveryScope(initial.principal), initial.recoveryScope);
    assert.equal(store.connectionAuthority(connectionId, user.id), authority);
    assert.equal(store.getCredentialToken(connectionId, user.id), 'isolated-fixture-connector-credential');
    assert.deepEqual(store.sessionPreferences(user.id).get(session), { hidden: false, pinned: true });
    assert.deepEqual(store.workspace.get(user.id), preferences);
    assert.deepEqual(store.notebooks.get(user.id, session), hot);
    assert.deepEqual(store.notebooks.getArchive(user.id, session), cold);
    assert.deepEqual(store.boards.save(user.id, 'default', boardInput), board, 'original mutation receipt remains idempotent');
    assert.equal(store.boards.save(user.id, 'default', { ...boardInput, title: 'Conflicting replay' }).status, 'mutation-reused');
    assert.deepEqual(store.sessionGuidance.config(user.id, session), guidance);
    assert.equal(store.upstreamCursor(connectionId, 'existing-domain', user.id), 'original-cursor');
    const events = store.deliveryPage(undefined, new Map([[connectionId, 'existing-domain']]), user.id).events;
    assert.equal(events.length, 1); assert.equal(events[0]!.sessionKey, 'existing-native-session');
  } finally {
    if (worker) await worker.close();
    if (store) await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
