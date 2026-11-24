import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createApplication } from './application.js';
import { loadConfig } from './config.js';
import { HubStore } from './hub/hub-store.js';
import { encodeHubSessionId } from './hub/session-id.js';
import { OriginalHubAdministrativeCommands } from './hub/original-administrative-commands.js';

for (const backend of ['json', 'sqlite'] as const) {
  test(`actual ${backend} application awaits guidance and Quick Chat recovery without replay or clearing UNKNOWN`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'application-recovery-'));
    const administratorKey = 'isolated-recovery-admin';
    const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: administratorKey,
      AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false',
      AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'isolated-recovery-vault',
      AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
      AOD_SESSION_TITLES_FILE: join(root, 'titles.json'), AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
      AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'connector.sqlite'),
      ...(backend === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) });
    const seed = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
    const user = seed.createUser('Original owner');
    const cookie = `agentopsdeck_session=${seed.identities.createSession(seed.identities.issueKey(user.id).token)!}`;
    seed.upsertConnection({ id: 'node', ownerUserId: user.id, kind: 'remote', label: 'Original environment', connectorUrl: 'http://unused.invalid' });
    seed.pinConnectionNode('node', user.id, seed.connectionAuthority('node', user.id)!, 'node_' + randomUUID());
    const sessionId = encodeHubSessionId('node', 'codex:' + randomUUID());
    const target = JSON.stringify([sessionId, seed.getConnection('node', user.id)!.nodeId, seed.connectionAuthority('node', user.id)!]);
    seed.sessionGuidance.save(user.id, target, 0, 'Original guidance', true);
    const capability = { ephemeralRequest: true, noPersistentThread: true, originalLookup: true, maxOutput: 2000, epoch: 'fixed' };
    const p = randomUUID(), q = randomUUID(), completed = randomUUID(), unknown = randomUUID(), admitted = randomUUID();
    for (const id of [p, q]) seed.quickChat.saveProfile(user.id, 0, { id, name: 'Profile', target: 'fixed', model: 'fixed', outputLimit: 2000 }, capability);
    seed.quickChat.admit(user.id, completed, p, 1, 'PRIVATE_PROMPT', capability);
    seed.quickChat.claim(user.id, completed, 'PRIVATE_PROMPT', capability, () => true);
    seed.quickChat.complete(user.id, completed, 'PRIVATE_OUTPUT');
    seed.quickChat.admit(user.id, unknown, q, 1, 'PRIVATE_PROMPT', capability);
    seed.quickChat.claim(user.id, unknown, 'PRIVATE_PROMPT', capability, () => true);
    seed.quickChat.admit(user.id, admitted, p, 1, 'PRIVATE_PROMPT', capability);
    const originalUnknown = (seed as unknown as { db: DatabaseSync }).db.prepare('SELECT * FROM quick_chat_receipts WHERE id=?').get(unknown);
    await seed.close();
    let application = createApplication(config);
    const calls: Array<{ kind: string; action: string | undefined }> = [];
    const original = OriginalHubAdministrativeCommands.prototype.command;
    let loseNext: string | undefined;
    t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
      const action = (input as { command?: { action?: string } }).command?.action;
      calls.push({ kind, action });
      const reply = original.call(this, kind, input);
      if (`${kind}:${action}` === loseNext) {
        loseNext = undefined;
        return reply.then(() => { throw Error('PRIVATE lost recovery ACK'); });
      }
      return reply;
    });
    const request = (path: string, method = 'GET', body?: unknown) => application.app.request(path, {
      method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const expect = async (response: Response | Promise<Response>, status: number) => {
      const value = await response, text = await value.text();
      assert.equal(value.status, status, text);
      assert.equal(value.headers.get('cache-control'), 'no-store');
      return text.length ? JSON.parse(text) : undefined;
    };
    const guidance = `/api/hub/v1/sessions/${sessionId}/guidance`, chat = '/api/hub/v1/quick-chat';
    const effectCount = (kind: string, action: string) => calls.filter(call => call.kind === kind && call.action === action).length;
    try {
      const initial = await expect(request(guidance), 200);
      assert.equal(initial.guidance.config.text, 'Original guidance');
      loseNext = 'sessionGuidance:save';
      await expect(request(guidance, 'PUT', { revision: 1, text: 'Saved guidance', enabled: true }), 503);
      assert.equal(effectCount('sessionGuidance', 'save'), 1);
      const saved = await expect(request(guidance), 200);
      assert.equal(saved.guidance.config.revision, 2); assert.equal(saved.guidance.config.text, 'Saved guidance');
      await expect(request(guidance, 'PUT', { revision: 1, text: 'Stale guidance', enabled: true }), 409);
      const submission = randomUUID(), submissionPath = guidance + '/submissions/' + submission;
      const prepared = await expect(request(guidance + '/submissions', 'POST', { requestId: submission, revision: 2, input: 'Original input' }), 201);
      assert.equal(prepared.receipt.requestId, submission);
      assert.equal((await expect(request(submissionPath), 200)).receipt.state, prepared.receipt.state);
      await expect(request(submissionPath, 'DELETE'), 200);
      assert.equal((await expect(request(submissionPath), 200)).cancelled, true);
      assert.equal(effectCount('sessionGuidance', 'claim'), 0);
      const listing = await expect(request(chat), 200);
      assert.equal(listing.profiles.length, 2); assert.equal(listing.receipts.length, 3);
      const output = await expect(request(chat + '/requests/' + completed), 200);
      assert.equal(output.output, 'PRIVATE_OUTPUT');
      for (const field of ['fingerprint', 'capabilityEpoch', 'resultRef']) assert.equal(Object.hasOwn(output.receipt, field), false);
      for (const action of ['cancel', 'result']) {
        await expect(request(chat + '/requests/' + unknown + '/' + action, action === 'cancel' ? 'POST' : 'DELETE'), 409);
      }
      assert.equal((await expect(request(chat + '/requests/' + unknown), 200)).receipt.state, 'unknown');
      loseNext = 'quickChatCleanup:clear';
      await expect(request(chat + '/requests/' + completed + '/result', 'DELETE'), 503);
      assert.equal(effectCount('quickChatCleanup', 'clear'), 2); // One UNKNOWN rejection and one committed clear.
      const cleared = await expect(request(chat + '/requests/' + completed), 200);
      assert.equal(cleared.receipt.state, 'completed'); assert.equal(cleared.output, null);
      loseNext = 'quickChatCleanup:cancel';
      await expect(request(chat + '/requests/' + admitted + '/cancel', 'POST'), 503);
      assert.equal(effectCount('quickChatCleanup', 'cancel'), 2);
      assert.equal((await expect(request(chat + '/requests/' + admitted), 200)).receipt.state, 'failed');
      await application.close(); application = createApplication(config);
      assert.deepEqual(await expect(request(guidance), 200), saved);
      assert.equal((await expect(request(submissionPath), 200)).cancelled, true);
      assert.deepEqual(await expect(request(chat + '/requests/' + completed), 200), cleared);
      assert.equal((await expect(request(chat + '/requests/' + unknown), 200)).receipt.state, 'unknown');
      assert.equal((await expect(request(chat + '/requests/' + admitted), 200)).receipt.state, 'failed');
      await expect(request('/api/auth/logout', 'POST'), 200);
      assert.equal((await request(guidance)).status, 401);
      assert.equal((await request(chat + '/requests/' + unknown)).status, 401);
      for (const kind of ['sessionGuidance', 'quickChatState', 'quickChatCleanup']) assert.ok(calls.some(call => call.kind === kind));
    } finally { await application.close(); }
    const reopened = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
    try {
      const db = (reopened as unknown as { db: DatabaseSync }).db;
      assert.deepEqual(db.prepare('SELECT * FROM quick_chat_receipts WHERE id=?').get(unknown), originalUnknown);
      assert.equal(reopened.quickChat.claim(user.id, unknown, 'PRIVATE_PROMPT', capability, () => true).claimed, false);
      assert.equal(reopened.quickChat.receipt(user.id, completed)?.state, 'completed');
      assert.equal(reopened.quickChat.receipt(user.id, admitted)?.state, 'failed');
      assert.equal(reopened.quickChat.peekResult(user.id, completed), undefined);
    } finally { await reopened.close(); rmSync(root, { recursive: true, force: true }); }
  });
}
