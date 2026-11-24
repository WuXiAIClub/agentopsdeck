import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplicationHttpShell } from './application-http-shell.js';
import { loadConfig } from './config.js';
import { registerApplicationAuthorization } from './auth/application-authorization.js';
import { AuthAuditLog } from './auth/security.js';
import { HubStore } from './hub/hub-store.js';
import { encodeHubSessionId } from './hub/session-id.js';
import { AsyncHubSharedCommands } from './hub/async-shared-commands.js';
import { AsyncHubMemberOwner } from './hub/async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './hub/original-administrative-commands.js';
import { hubMemberEvidence } from './hub/member-owner-domain.js';
import { registerHubSharedCommandRoutes } from './routes/hub-shared-commands.js';
import { isAsyncHubSharedSessionRequest } from './routes/hub-shared-sessions-async.js';
import { PerformanceDiagnostics } from './diagnostics/performance.js';

for (const mode of ['legacy', 'original', 'worker'] as const) {
  for (const scenario of ['read-only', 'wrong-session', 'mirror-denied', 'revoked', 'allowed'] as const) {
    test(`${mode} shared voice ${scenario} uses current session message policy before transcription`, async context => {
      const root = await mkdtemp(join(tmpdir(), 'aod-voice-admission-'));
      const file = join(root, 'hub.sqlite'), directory = join(root, 'receipts');
      const store = new HubStore(file, 'synthetic-voice-vault');
      const alice = store.createUser('Synthetic owner'), bob = store.createUser('Synthetic reader');
      const login = store.identities.issueKey(bob.id), ownerLogin = store.identities.issueKey(alice.id);
      const sessionKey = 'agent:main:dashboard:synthetic-voice';
      const nodeId = `node_${randomUUID()}`;
      store.upsertConnection({ id: 'node', ownerUserId: alice.id, kind: 'local', label: 'Synthetic', connectorUrl: 'http://unused.invalid' });
      store.pinConnectionNode('node', alice.id, store.connectionAuthority('node', alice.id)!, nodeId);
      const nodeVersion = store.connectionAuthority('node', alice.id)!;
      const policy = { ownerUserId: alice.id, connectionId: 'node', userId: bob.id };
      store.grants.create(policy, { runtime: 'openclaw', sessionKey, actions: ['messages:read'] });
      const send = scenario === 'read-only' ? undefined : store.grants.create(policy, {
        runtime: 'openclaw', sessionKey: scenario === 'wrong-session' ? 'agent:main:dashboard:other' : sessionKey, actions: ['messages:send'],
      });
      const diagnostics = new PerformanceDiagnostics(() => {});
      if (mode === 'worker') await store.close();
      const owner = mode === 'worker' ? new AsyncHubMemberOwner({ file, encryptionSecret: 'synthetic-voice-vault' }, diagnostics)
        : mode === 'original' ? new OriginalHubAdministrativeCommands(store, diagnostics) : undefined;
      if (mode === 'worker') await (owner as AsyncHubMemberOwner).open();
      const commands = owner ? new AsyncHubSharedCommands(owner, undefined, undefined, diagnostics) : undefined;
      const revoke = async () => {
        if (!owner) { store.grants.revoke(policy, send!.id, send!.version); return; }
        const evidence = hubMemberEvidence(new Request('http://localhost', { headers: { authorization: `Bearer ${ownerLogin.token}` } }));
        const snapshot = await owner.command('memberSnapshot', evidence);
        assert.ok(snapshot);
        const result = await owner.command('grantChange', { evidence, expectedScope: snapshot.recoveryScope,
          command: { action: 'revoke', target: { ownerUserId: alice.id, connectionId: 'node' },
            id: send!.id, version: send!.version, nodeVersion } });
        assert.ok(result && !('error' in result), JSON.stringify(result));
      };
      let transcriptions = 0, messages = 0, audioReads = 0;
      const shell = createApplicationHttpShell(loadConfig({ AOD_ACCESS_KEY: 'synthetic-shell-key' }), {
        directory, transcribe: async () => { transcriptions++; if (scenario === 'revoked') await revoke(); return 'Synthetic transcript'; },
      });
      const authorization = registerApplicationAuthorization(shell.app, { hasHub: true,
        principal: () => ({ userId: bob.id, admin: false }), authorize: () => false, recordActivity: () => {},
        audit: new AuthAuditLog(), signedStream: () => false, allowedBrowserOrigin: shell.allowedBrowserOrigin });
      context.after(async () => {
        await authorization.close(); await commands?.close(); await owner?.close(); await store.close();
        await rm(root, { recursive: true, force: true });
      });
      const base = `/api/hub/v1/shared/${alice.id}/sessions/${encodeURIComponent(encodeHubSessionId('node', sessionKey))}`;
      shell.app.get(`${base}/messages`, current => current.json({ messages: [] }));
      shell.app.post(`${base}/messages`, current => { messages++; return current.json({ status: 'queued' }); });
      registerHubSharedCommandRoutes(shell.app, commands ? { mode: 'async', asyncSharedCommands: commands }
        : { hubStore: store, principal: () => ({ userId: bob.id, admin: false }), sync: undefined, local: undefined });
      const request = () => shell.app.request('http://localhost' + base + '/voice', { method: 'POST',
        headers: { authorization: `Bearer ${login.token}`, origin: 'http://localhost', 'content-type': 'application/json' },
        body: new ReadableStream<Uint8Array>({ pull(controller) {
          audioReads++;
          controller.enqueue(new TextEncoder().encode(JSON.stringify({
            audio: { contentBase64: Buffer.alloc(128, 7).toString('base64'), mimeType: 'audio/wav' },
            idempotencyKey: 'synthetic-voice-key', deliveryMode: scenario === 'mirror-denied' ? 'mirror' : 'web-only',
          })));
          controller.close();
        } }, { highWaterMark: 0 }), duplex: 'half' } as RequestInit);
      const response = await request();
      assert.equal(response.status, scenario === 'allowed' ? 200 : 403, await response.text());
      assert.equal(transcriptions, scenario === 'allowed' || scenario === 'revoked' ? 1 : 0);
      assert.equal(audioReads, scenario === 'read-only' || scenario === 'wrong-session' ? 0 : 1);
      assert.equal(messages, scenario === 'allowed' ? 1 : 0);
      const records = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      assert.equal(records.length, scenario === 'allowed' ? 1 : 0);
      if (scenario === 'allowed') { assert.equal((await request()).status, 200); assert.equal(transcriptions, 1); }
    });
  }
}

test('async shared dispatch admits only the exact side-effect-free voice permission suffix', () => {
  const base = '/api/hub/v1/shared/owner/sessions/session/';
  assert.equal(isAsyncHubSharedSessionRequest('POST', base + 'voice/admission'), true);
  for (const suffix of ['voice', 'voice/admission/extra', 'voice/admissions']) {
    assert.equal(isAsyncHubSharedSessionRequest('POST', base + suffix), false);
  }
  assert.equal(isAsyncHubSharedSessionRequest('GET', base + 'voice/admission'), false);
});
