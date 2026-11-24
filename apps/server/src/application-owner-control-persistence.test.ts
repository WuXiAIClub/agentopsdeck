import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { createApplication } from './application.js';
import { loadConfig } from './config.js';
import { HubStore } from './hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from './hub/original-administrative-commands.js';
import { NODE_ID_HEADER, EXPECTED_NODE_HEADER } from './connector/node-identity.js';
import { encodeHubSessionId } from './hub/session-id.js';
import type { OwnerControlTarget } from './hub/member-owner-control-domain.js';
import type { CommandReceipt } from './commands/receipts.js';

const operations = ['create', 'delete', 'settings', 'compact', 'queue'] as const;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
for (const backend of ['json', 'sqlite'] as const) for (const member of [false, true])
  for (const operation of operations) for (const outcome of ['normal', 'lost', 'cancel', 'cancel-lost', 'close', 'transport'] as const) {
    test(`application owner control ${backend}/${member ? 'member' : 'administrator'}/${operation}/${outcome} retains durable original receipt`, async t => {
      const root = mkdtempSync(join(tmpdir(), 'application-owner-control-'));
      const administratorKey = 'isolated-owner-administrator';
      const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: administratorKey,
        AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'isolated-owner-vault',
        AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
        AOD_SESSION_TITLES_FILE: join(root, 'titles.json'), AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
        AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'connector.sqlite'),
        ...(backend === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) });
      const seed = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
      const userId = member ? seed.createUser('Control member').id : 'default';
      const key = seed.identities.issueKey(userId), cookie = `agentopsdeck_session=${seed.identities.createSession(key.token)!}`;
      const node = 'node_' + randomUUID(), sessionId = encodeHubSessionId('node', 'codex:fixture');
      const target: OwnerControlTarget = operation === 'create' ? { operation, connectionId: 'node', agentId: 'codex' }
        : { operation, connectionId: 'node', sessionId, ...(operation === 'queue' ? { messageId: 'queued' } : {}) };
      seed.upsertConnection({ id: 'node', ownerUserId: userId, kind: 'remote', label: 'Original node',
        connectorUrl: 'http://owner-control-fixture.invalid', credentialToken: 'PRIVATE_OWNER_TOKEN' });
      seed.pinConnectionNode('node', userId, seed.connectionAuthority('node', userId)!, node);
      const epoch = seed.connectionAuthority('node', userId)!;
      await seed.close(); // Only one original writer exists at any point.
      let application = createApplication(config), mutations = 0, lookups = 0, claims = 0, drained = false;
      let hold = outcome === 'lost' || outcome === 'cancel' || outcome === 'cancel-lost' || outcome === 'close';
      let release!: () => void, entered!: () => void, port: OriginalHubAdministrativeCommands | undefined;
      const gate = new Promise<void>(yes => { release = yes; }), admission = new Promise<void>(yes => { entered = yes; });
      const original = OriginalHubAdministrativeCommands.prototype.command, upstream = new Map<string, CommandReceipt>();
      t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
        port = this;
        const payload = input as { command?: { action?: string } };
        const reply = original.call(this, kind, input);
        if (kind === 'ownerControl' && payload.command?.action === 'claim') {
          claims++;
          if (hold) { hold = false; return reply.then(async value => { entered(); await gate;
            if (outcome === 'lost' || outcome === 'cancel-lost') throw Error('PRIVATE original control reply lost'); return value;
          }); }
        }
        return reply;
      });
      t.mock.method(globalThis, 'fetch', async (raw: Request | string | URL, init?: RequestInit) => {
        const request = raw instanceof Request ? raw : new Request(raw, init), url = new URL(request.url);
        assert.equal(url.origin, 'http://owner-control-fixture.invalid');
        assert.equal(request.headers.get(EXPECTED_NODE_HEADER), node);
        assert.equal(request.headers.get('authorization'), 'Bearer PRIVATE_OWNER_TOKEN');
        const headers = { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max), [NODE_ID_HEADER]: node };
        if (request.method === 'GET') { lookups++; return Response.json({ command: upstream.get(decodeURIComponent(url.pathname.split('/').at(-1)!)) }, { headers }); }
        // Verify the real original receipt, not just a mocked admission flag,
        // before any outbound mutation (including the transport-loss case).
        const snapshot = await port!.command('memberSnapshot', { accessKey: key.token }); assert.ok(snapshot);
        const saved = await port!.command('ownerControl', { evidence: { accessKey: key.token }, expectedScope: snapshot.recoveryScope,
          command: { action: 'get', target, epoch, key: 'saved' } });
        assert.ok(saved && 'receipt' in saved && saved.receipt?.state === 'outcome_unknown');
        mutations++;
        const body = operation === 'create' ? { key: 'codex:created' } : operation === 'settings'
          ? { sessionKey: 'codex:fixture', settings: { title: 'new title' } } : operation === 'compact'
            ? { ok: true, status: 'compacting', runId: randomUUID() } : { ok: true };
        const status = operation === 'create' ? 201 : 200, delivery = request.headers.get('idempotency-key')!;
        const command: CommandReceipt = { id: randomUUID(), key: delivery, state: 'accepted', createdAt: 1, updatedAt: 2, result: { status, body } };
        upstream.set(delivery, command);
        if (outcome === 'transport') throw Error('PRIVATE transport reply lost');
        return Response.json({ ...body, command }, { status, headers });
      });
      const session = encodeURIComponent(sessionId);
      const path = operation === 'create' ? '/api/hub/v1/connections/node/agents/codex/sessions'
        : operation === 'delete' || operation === 'settings' ? `/api/sessions/${session}`
          : `/api/hub/v1/sessions/${session}${operation === 'compact' ? '/compact' : '/queue/queued'}`;
      const method = operation === 'delete' ? 'DELETE' : operation === 'settings' || operation === 'queue' ? 'PATCH' : 'POST';
      const send = (signal?: AbortSignal) => application.app.request(path, { method, headers: { cookie,
        'content-type': 'application/json', 'idempotency-key': 'saved', 'if-match': '"1:1"' }, ...(signal ? { signal } : {}),
        ...(method === 'DELETE' ? {} : { body: JSON.stringify(operation === 'settings' ? { title: 'new title' }
          : operation === 'queue' ? { message: 'text' } : {}) }) });
      const expect = async (response: Response | Promise<Response>, status: number) => {
        const value = await response, text = await value.text(); assert.equal(value.status, status, text);
        assert.doesNotMatch(text, /PRIVATE|Bearer|credentialToken|reply lost/);
        assert.equal(value.headers.get('set-cookie'), null); return text;
      };
      try {
        const controller = new AbortController(), pending = send(controller.signal);
        const successful = outcome === 'normal' || outcome === 'transport';
        if (!successful) {
          await admission; assert.equal(mutations, 0); assert.equal(lookups, 0); assert.equal(claims, 1);
          if (outcome === 'cancel' || outcome === 'cancel-lost') controller.abort();
          if (outcome === 'close') {
            const closing = application.close(); void closing.then(() => { drained = true; });
            await tick(); assert.equal(drained, false); release();
            // The enclosing route drain rejects delivery during shutdown.
            await expect(pending, 503); await closing; assert.equal(drained, true);
          } else {
            if (outcome === 'cancel' || outcome === 'cancel-lost') {
              let settled = false; void Promise.resolve(pending).then(() => { settled = true; });
              await tick(); assert.equal(settled, false, 'cancel does not time out an admitted original write');
            }
            release(); await expect(pending, outcome === 'cancel' ? 499 : 503);
          }
          assert.equal(mutations, 0); assert.equal(lookups, 0);
        } else {
          await expect(pending, operation === 'create' ? 201 : 200); assert.equal(mutations, 1);
          await expect(send(), operation === 'create' ? 201 : 200); assert.equal(mutations, 1);
        }
        await application.close(); application = createApplication(config);
        await expect(send(), successful ? operation === 'create' ? 201 : 200 : 202);
        assert.equal(mutations, successful ? 1 : 0, 'reopen only observes original receipts; never resends');
        if (!successful) assert.equal(lookups, 1, 'explicit duplicate performs receipt lookup only');
      } finally { release(); await application.close(); rmSync(root, { recursive: true, force: true }); }
    });
  }
