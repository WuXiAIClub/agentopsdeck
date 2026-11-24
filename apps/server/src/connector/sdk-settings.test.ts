import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ConnectorUserStore } from './connector-user-store.js';
import { SdkCommands } from './sdk-commands.js';
import { registerSessionSettingsRoutes } from './session-settings-http.js';
import { DeckStore } from '../projection/deck-store.js';
import type { GatewayWsClient } from '../gateway/ws-client.js';

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: SDK savepoint rolls back model, dispatch phase and ACK; exclusive startup rejects only prewrite without replay`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-settings-rollback-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, 'connector.sqlite'), key = `${runtime}:rollback-fixture`;
    const scope = JSON.stringify(['settings', JSON.stringify(['owner', key])]);
    const payload = { model: 'other' };
    let failAfterAck = true, attempts = 0, acknowledgements = 0, changes = 0;
    const open = (runtimeOwner: boolean) => {
      const store = new ConnectorUserStore(file, undefined, { runtimeOwner });
      const db = (store as unknown as { db: DatabaseSync }).db;
      const journal = runtime === 'claude-code' ? store.claudeJournal : store.copilotJournal;
      const phase = (receiptKey: string, receiptScope = scope) => (db.prepare(`SELECT settings_dispatch_phase AS phase
        FROM command_receipts WHERE scope = ? AND command_key = ?`).get(receiptScope, receiptKey) as { phase: string | null }).phase;
      const deck = new DeckStore();
      deck.upsertSession({ sessionKey: key, source: runtime, agentId: runtime, title: 'Fixture', status: 'idle' });
      const commands = new SdkCommands({ runtime, journal, store, models: { model: 'default', modelChoices: ['other'] },
        driver: { wake: async () => assert.fail('Settings recovery must not launch native work'),
          interrupt: async () => assert.fail('Settings recovery must not interrupt native work') },
        assertAvailable: () => {}, authorize: () => true, changed: () => { changes++; } });
      const app = new Hono();
      registerSessionSettingsRoutes(app, '/sessions/:sessionKey', {
        store: deck, receipts: store.commands,
        gateway: { requestBound: () => assert.fail('SDK settings must not reach Gateway') } as unknown as GatewayWsClient,
        actor: () => 'owner', sessionKey: c => c.req.param('sessionKey')!, refreshSessions: async () => {},
        settingsAdmission: target => store.canChangeSettings(target),
        sdkSettingsAdmission: target => commands.assertSettingsAvailable(target),
        sdkModelUpdate: (target, model, authorize, ack) => {
          attempts++;
          commands.updateModel(target, model, authorize, applied => {
            ack(applied);
            acknowledgements++;
            if (failAfterAck) {
              assert.equal(db.isTransaction, true, 'Injected failure must occur inside the real SDK savepoint');
              assert.equal(journal.session(key)?.model, 'other');
              assert.equal(phase('rollback'), 'dispatch_may_have_started');
              assert.equal(store.commands.get(scope, 'rollback')?.state, 'accepted');
              throw new Error('Synthetic failure after transactional settings ACK');
            }
          });
        },
      });
      const path = `/sessions/${encodeURIComponent(key)}`;
      let closed = false;
      return { store, journal, db, phase,
        patch: (id = 'rollback') => app.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json',
          'idempotency-key': id }, body: JSON.stringify(payload) }),
        receipt: () => app.request(`${path}/settings-commands/rollback`),
        close: () => { if (!closed) { closed = true; store.close(); } },
      };
    };
    let current = open(true);
    t.after(() => current.close());
    current.journal.create({ key, nativeSessionId: 'native-rollback-id', title: 'Fixture', createdAt: 1 });
    const failed = await current.patch();
    assert.equal(failed.status, 202);
    const original = (await failed.json()).command;
    assert.equal(original.state, 'outcome_unknown');
    assert.equal(current.db.isTransaction, false);
    assert.equal(current.journal.session(key)?.model, undefined, 'Model mutation rolled back with ACK');
    assert.equal(current.phase('rollback'), 'prewrite', 'Dispatch marker must roll back with the local mutation');
    assert.equal(current.store.commands.get(scope, 'rollback')?.result, undefined, 'No transactional ACK leaked');
    assert.equal(current.store.commands.sessionSettingsPending(key), true);
    assert.equal(changes, 0, 'Rolled-back settings must not publish a change');
    assert.equal((await current.patch()).status, 202);
    assert.equal(attempts, 1, 'Same-key unknown never retries the SDK mutation');

    const siblingScope = JSON.stringify(['settings', JSON.stringify(['owner', `${runtime}:uncertain-sibling`])]);
    (await current.store.commands.claimAsync(siblingScope, 'dispatched', payload, false, undefined, undefined, undefined, true));
    current.store.commands.beginSettingsWrite(siblingScope, 'dispatched');
    (await current.store.commands.claimAsync(siblingScope, 'legacy', payload));
    current.close();
    current = open(false);
    assert.equal(current.store.commands.get(scope, 'rollback')?.state, 'outcome_unknown', 'Management-only open must not recover');
    assert.equal(current.phase('rollback'), 'prewrite');
    assert.equal(current.journal.session(key)?.model, undefined);
    current.close();
    current = open(true);
    const recovered = (await (await current.receipt()).json()).command;
    assert.equal(recovered.id, original.id, 'Recovery preserves the original receipt identity');
    assert.equal(recovered.state, 'rejected');
    assert.equal(recovered.result.status, 409);
    assert.equal(current.phase('rollback'), 'prewrite');
    assert.equal(current.journal.session(key)?.model, undefined);
    assert.equal(current.store.commands.sessionSettingsPending(key), false);
    assert.equal(current.store.commands.get(siblingScope, 'dispatched')?.state, 'outcome_unknown');
    assert.equal(current.phase('dispatched', siblingScope), 'dispatch_may_have_started');
    assert.equal(current.store.commands.get(siblingScope, 'legacy')?.state, 'outcome_unknown');
    assert.equal(current.phase('legacy', siblingScope), null);
    assert.equal((await current.patch()).status, 409, 'Recovered intent remains rejected instead of replaying');
    assert.equal(attempts, 1);
    assert.equal(acknowledgements, 1);
    failAfterAck = false;
    assert.equal((await current.patch('explicit-new-action')).status, 200);
    assert.equal(current.journal.session(key)?.model, 'other');
    assert.equal(current.phase('explicit-new-action'), 'dispatch_may_have_started');
    assert.equal(attempts, 2, 'Only a new explicit action may update settings');
    assert.equal(changes, 1);
  });

  test(`${runtime}: settings receipts, lifecycle fencing, model persistence and no gateway fallback`, async t => {
    const store = new ConnectorUserStore(':memory:'); t.after(() => store.close());
    const journal = runtime === 'claude-code' ? store.claudeJournal : store.copilotJournal;
    const key = `${runtime}:fixture`, deck = new DeckStore();
    journal.create({ key, nativeSessionId: 'native-id', title: 'Fixture', createdAt: 1 });
    deck.upsertSession({ sessionKey: key, source: runtime, agentId: runtime, title: 'Fixture', status: 'idle' });
    let ready = true, authorized = true, changes = 0;
    const models = { model: 'default', modelChoices: ['other'] };
    const commands = new SdkCommands({ runtime, journal, store, models,
      driver: { wake: async () => {}, interrupt: async () => 'not_started' },
      assertAvailable: () => { if (!ready) throw new HTTPException(503); }, authorize: () => authorized,
      changed: () => { changes++; } });
    const app = new Hono();
    registerSessionSettingsRoutes(app, '/sessions/:sessionKey', {
      store: deck, receipts: store.commands,
      gateway: { requestBound: () => assert.fail('SDK model change must never reach Gateway') } as unknown as GatewayWsClient,
      actor: () => { if (!authorized) throw new HTTPException(403); return 'owner'; }, sessionKey: c => c.req.param('sessionKey')!,
      refreshSessions: async () => {}, settingsAdmission: target => store.canChangeSettings(target),
      sdkSettingsAdmission: target => commands.assertSettingsAvailable(target),
      sdkModelUpdate: (target, model, authorize, ack) => {
        if (model !== null && !['default', 'other'].includes(model)) throw new HTTPException(400);
        commands.updateModel(target, model, authorize, ack);
      },
    });
    const path = `/sessions/${encodeURIComponent(key)}`;
    const patch = (id: string, model: string | null, extra = {}) => app.request(path, { method: 'PATCH',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idempotencyKey: id, model, ...extra }) });
    const first = await patch('change', 'other');
    assert.equal(first.status, 200);
    assert.equal((await first.json()).command.state, 'accepted');
    assert.equal(journal.session(key)?.model, 'other'); assert.equal(changes, 1);
    models.modelChoices = [];
    assert.throws(() => commands.send(key, 'not admitted', { actorId: 'owner',
      accept: () => assert.fail('Retired model must never admit a message') }), /no longer allowed/);
    models.modelChoices = ['other'];
    ready = false;
    assert.equal((await patch('change', 'other')).status, 200, 'Known acceptance survives startup/maintenance');
    assert.equal(changes, 1);
    assert.equal((await app.request(`${path}/settings-commands/change`)).status, 200);
    const denied = await patch('not-ready', null);
    assert.equal(denied.status, 409);
    assert.equal((await denied.json()).command.state, 'rejected');
    assert.equal(store.canChangeSettings(key), true, 'Prewrite denial must not leave an unknown settings fence');
    const rename = (id: string) => app.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: id, title: 'Renamed' }) });
    assert.equal((await rename('paused-rename')).status, 409);
    assert.equal(deck.getSession(key)?.title, 'Fixture');
    ready = true;
    assert.equal((await rename('rename')).status, 200);
    assert.equal(deck.getSession(key)?.title, 'Renamed');
    assert.equal((await patch('thinking', 'other', { thinking: 'high' })).status, 400);
    assert.equal((await patch('unknown-model', 'unconfigured')).status, 400);
    assert.equal(journal.session(key)?.model, 'other');
    store.turns.enqueue(runtime, { id: 'queued', sessionKey: key, createdAt: 1, payload: {} });
    assert.equal((await patch('busy', null)).status, 409);
    const ref = { id: 'run', epoch: 'epoch', key };
    assert.equal(journal.begin(ref, ['queued'], store.turns)?.model, 'other');
    assert.equal((await patch('running', null)).status, 409);
    journal.observeTerminal(ref, 'completed', store.turns); journal.confirmSettled(ref);
    const reset = await patch('reset', null);
    assert.equal(reset.status, 200); assert.equal((await reset.json()).settings.model, 'default');
    assert.equal(journal.session(key)?.model, undefined); assert.equal(journal.current(key)?.model, 'other');
    authorized = false;
    assert.equal((await patch('change', 'other')).status, 403, 'Revocation precedes receipt lookup');
    assert.equal((await app.request(`${path}/settings-commands/change`)).status, 403);
  });
}
