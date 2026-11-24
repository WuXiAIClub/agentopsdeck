import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommandReceipt, SendMessageResponse } from '@agentopsdeck/shared';
import { CommandJournal, CommandNotSubmittedError, CommandOutcomeUnknownError, CommandRejectedError, DeletionOutcomeUnknownError, QueueOutcomeUnknownError, deleteWithJournal, mutateQueueWithJournal, newCommandKey, recoverSavedCommand, sendWithJournal, sendWithReceiptRecovery } from './command-recovery.js';
import { CreationOutcomeUnknownError, createWithJournal, creationPath } from './command-recovery.js';
import { SettingsOutcomeUnknownError, settingsWithJournal, isUnresolvedSettingsFence } from './command-recovery.js';
import { commandKeyIssuedAt, createCommandKey, readSessionSettingsResult } from '@agentopsdeck/shared';
import { MaintenanceOutcomeUnknownError, maintenancePath, maintenanceReceiptState, maintenanceWithJournal } from './command-recovery.js';

const maintenance = { connectionId: 'remote-a', operation: 'apply' as const };
const admissionAccepted = (key: string, state = 'paused', extra = {}): CommandReceipt => ({ id: key, key, state: 'accepted', createdAt: 1, updatedAt: 2,
  result: { status: 200, body: { state, boundary: 'admission_only', nativeQuiescent: false, fenceId: 'a'.repeat(36), ...extra } } });

for (const operation of ['pause', 'resume'] as const) test(`admission ${operation} stores only original recovery identity and never replays after reply loss`, async () => {
  const saved = storage(), journal = new CommandJournal(saved), target = { connectionId: 'remote/a', operation };
  let posts = 0, queries = 0;
  const result = await maintenanceWithJournal(journal, scope, target, 'original', async () => {
    posts++;
    assert.equal(journal.list(scope, undefined, 'maintenance')[0]!.state, 'outcome_unknown');
    throw new Error('lost reply');
  }, async () => { queries++; return admissionAccepted('original', operation === 'pause' ? 'paused' : 'released'); });
  assert.equal(result.state, operation === 'pause' ? 'paused' : 'released');
  const row = new CommandJournal(saved).list(scope, undefined, 'maintenance')[0]!;
  assert.equal(row.state, 'accepted');
  assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'key', 'maintenance', 'scope', 'state']);
  assert.equal(JSON.stringify(row).includes('fenceId'), false);
  assert.equal(maintenancePath(target), `/api/hub/v1/connections/remote%2Fa/maintenance/commands/${operation}`);
  await assert.rejects(maintenanceWithJournal(journal, scope, target, 'original', async () => assert.fail(), async () => assert.fail()), CommandNotSubmittedError);
  assert.equal(posts, 1); assert.equal(queries, 1);
});

test('admission receipt requires original key, operation, explicit admission boundary and valid fence', async () => {
  const target = { connectionId: 'remote', operation: 'pause' as const };
  for (const receipt of [admissionAccepted('wrong'), admissionAccepted('original', 'released'), admissionAccepted('original', 'resuming'),
    admissionAccepted('original', 'paused', { nativeQuiescent: true }), admissionAccepted('original', 'paused', { boundary: 'native_idle' }),
    admissionAccepted('original', 'paused', { fenceId: undefined }), admissionAccepted('original', 'paused', { fenceId: 'other' }),
    admissionAccepted('original', 'paused', { resumeInterrupted: true }), updateAccepted('original')]) {
    const journal = new CommandJournal(storage());
    await assert.rejects(maintenanceWithJournal(journal, scope, target, 'original', async () => receipt, async () => receipt), MaintenanceOutcomeUnknownError);
    const row = journal.list(scope, undefined, 'maintenance')[0]!;
    await assert.rejects(recoverSavedCommand(journal, row, async () => receipt), MaintenanceOutcomeUnknownError);
    await assert.rejects(maintenanceWithJournal(journal, scope, { ...target, operation: 'resume' }, 'new', async () => assert.fail(), async () => assert.fail()), CommandNotSubmittedError);
    assert.equal(row.state, 'outcome_unknown');
  }
});

test('interrupted resume is a known paused result, never a released fence or permission to resend', async () => {
  const journal = new CommandJournal(storage()), target = { connectionId: 'remote', operation: 'resume' as const };
  const receipt = admissionAccepted('original', 'paused', { resumeInterrupted: true });
  const result = await maintenanceWithJournal(journal, scope, target, 'original', async () => receipt, async () => assert.fail());
  assert.equal(result.state, 'paused');
  assert.equal(journal.list(scope, undefined, 'maintenance')[0]!.state, 'accepted');
  assert.equal(maintenanceReceiptState(admissionAccepted('other'), 'other', target), undefined);
  await assert.rejects(maintenanceWithJournal(journal, scope, target, 'original', async () => assert.fail(), async () => assert.fail()), CommandNotSubmittedError);
  journal.beginMaintenance(scope, target, 'explicit-new-resume');
});

const updateAccepted = (key: string, state = 'succeeded'): CommandReceipt => ({ id: key, key, state: 'accepted', createdAt: 1, updatedAt: 2,
  result: { status: 200, body: { supported: true, currentVersion: '1.0', state, rollbackAvailable: true, restartRequired: true, updatedAt: 2 } } });

test('maintenance journal is written before POST, survives reopening, and blocks apply AND rollback while unknown', async () => {
  const store = storage(), journal = new CommandJournal(store); let posts = 0, gets = 0;
  await assert.rejects(maintenanceWithJournal(journal, scope, maintenance, 'original', async () => {
    posts++; assert.equal(new CommandJournal(store).list(scope, undefined, 'maintenance')[0]!.key, 'original'); throw new Error('lost ACK');
  }, async () => { gets++; throw new Error('offline'); }), MaintenanceOutcomeUnknownError);
  assert.equal(journal.list(scope).length, 0); assert.equal(journal.list(scope, undefined, 'creation').length, 0);
  for (const operation of ['apply', 'rollback'] as const) await assert.rejects(maintenanceWithJournal(new CommandJournal(store), scope,
    { ...maintenance, operation }, 'new', async () => { posts++; return undefined; }, async () => { gets++; throw new Error(); }), CommandNotSubmittedError);
  assert.equal(posts, 1); assert.equal(gets, 1);
  const row = journal.list(scope, undefined, 'maintenance')[0]!;
  assert.equal(await recoverSavedCommand(journal, row, async () => updateAccepted('original', 'failed')), 'accepted');
  assert.equal(journal.list(scope, undefined, 'maintenance')[0]!.state, 'accepted');
  assert.equal(store.getItem('agentopsdeck.command-recovery.v1')!.includes('currentVersion'), false);
});

test('maintenance direct final reply needs no GET and preserves failed/restart-required result semantics', async () => {
  for (const state of ['succeeded', 'failed']) {
    const journal = new CommandJournal(storage());
    const result = await maintenanceWithJournal(journal, scope, maintenance, state, async () => updateAccepted(state, state), async () => assert.fail('redundant GET'));
    assert.equal(result.state, state); assert.ok('restartRequired' in result); assert.equal(result.restartRequired, true);
    assert.equal(journal.list(scope, undefined, 'maintenance')[0]!.state, 'accepted');
  }
});

test('maintenance generic ACK, intermediate status, wrong operation/key and malformed results remain unknown', async () => {
  for (const receipt of [queueAccepted('original'), updateAccepted('other'), updateAccepted('original', 'installing'), updateAccepted('original', 'rolled_back'),
    { ...updateAccepted('original'), result: { status: 200, body: { state: 'succeeded' } } }]) {
    const journal = new CommandJournal(storage());
    await assert.rejects(maintenanceWithJournal(journal, scope, maintenance, 'original', async () => receipt, async () => receipt), MaintenanceOutcomeUnknownError);
    const row = journal.list(scope, undefined, 'maintenance')[0]!;
    await assert.rejects(recoverSavedCommand(journal, row, async () => receipt), MaintenanceOutcomeUnknownError);
    assert.equal(row.state, 'outcome_unknown');
  }
  assert.equal(maintenanceReceiptState(updateAccepted('rollback', 'rolled_back'), 'rollback', { ...maintenance, operation: 'rollback' }), 'accepted');
});

test('maintenance storage refusal sends nothing, confirmed rejection does not become unknown, settlement failure retains original key', async () => {
  const blocked = new CommandJournal({ getItem: () => null, setItem: () => { throw new Error('quota'); } });
  await assert.rejects(maintenanceWithJournal(blocked, scope, maintenance, 'no-post', async () => assert.fail(), async () => assert.fail()), CommandNotSubmittedError);
  const journal = new CommandJournal(storage()), rejected: CommandReceipt = { ...updateAccepted('denied'), state: 'rejected', result: { status: 403, body: {} } };
  await assert.rejects(maintenanceWithJournal(journal, scope, maintenance, 'denied', async () => { throw new Error('403'); }, async () => rejected), CommandRejectedError);
  assert.equal(journal.list(scope, undefined, 'maintenance')[0]!.state, 'rejected');
  const store = storage(); let writes = 0;
  const broken = new CommandJournal({ getItem: store.getItem, setItem: (k, v) => { if (++writes > 1) throw new Error('quota'); store.setItem(k, v); } });
  const result = await maintenanceWithJournal(broken, scope, maintenance, 'settled', async () => updateAccepted('settled'), async () => assert.fail());
  assert.equal(result.state, 'succeeded'); assert.equal(broken.list(scope, undefined, 'maintenance')[0]!.key, 'settled');
});

test('maintenance targets and saved records are strict, bounded and partitioned without storing secrets', () => {
  const journal = new CommandJournal(storage());
  const row = journal.beginMaintenance(scope, maintenance, 'same');
  journal.beginMaintenance('b'.repeat(64), maintenance, 'same');
  journal.beginMaintenance(scope, { ...maintenance, connectionId: 'other' }, 'same');
  journal.beginCreation(scope, { connectionId: 'remote-a', agentId: 'codex' }, 'same');
  assert.equal(journal.list(scope, undefined, 'maintenance').length, 2);
  assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'key', 'maintenance', 'scope', 'state']);
  assert.deepEqual(Object.keys(row.maintenance!).sort(), ['connectionId', 'operation']);
  assert.equal(maintenancePath({ connectionId: 'node/a', operation: 'rollback' }), '/api/hub/v1/connections/node%2Fa/update/commands/rollback');
  for (const target of [{ ...maintenance, connectionId: '..' }, { ...maintenance, connectionId: 'a\u0000b' }, { ...maintenance, connectionId: 'x'.repeat(513) },
    { ...maintenance, token: 'never-store' }, { ...maintenance, operation: 'exec' }]) assert.throws(() => maintenancePath(target as typeof maintenance));
  for (const record of [{ ...row, sessionKey: 's' }, { ...row, maintenance: { ...maintenance, token: 'secret' } }, { ...row, key: '' }]) {
    const store = storage(); store.setItem('agentopsdeck.command-recovery.v1', JSON.stringify([record]));
    assert.throws(() => new CommandJournal(store).list(scope), /invalid/);
  }
});

const settingsAccepted = (key: string, sessionKey = 'settings-session'): CommandReceipt => ({ id: 'settings-receipt', key, state: 'accepted', createdAt: 1, updatedAt: 2,
  result: { status: 200, body: { sessionKey, settings: { model: 'synthetic-model', thinkingLevel: null } } } });

test('settings journal is target/account partitioned, with no settings payload or result persisted', async () => {
  const store = storage(), journal = new CommandJournal(store);
  const response = await settingsWithJournal(journal, scope, 'settings-session', 'settings', async () => {
    assert.equal(journal.list(scope).length, 0, 'not a message command');
    assert.equal(journal.list(scope, undefined, 'all')[0]!.settings, true);
    throw new Error('lost ACK');
  }, async () => settingsAccepted('settings'));
  assert.deepEqual(response, settingsAccepted('settings').result!.body);
  assert.equal(journal.list(scope, undefined, 'all').length, 0);
  assert.equal(JSON.stringify([...store.data]).includes('synthetic-model'), false);
});

test('unknown settings survive reload, block duplicate controls but allow ordinary messages', async () => {
  const store = storage(); let writes = 0;
  await assert.rejects(settingsWithJournal(new CommandJournal(store), scope, 'settings-session', 'settings', async () => {
    writes++; throw new Error('lost ACK');
  }, async () => { throw new Error('offline'); }), SettingsOutcomeUnknownError);
  const journal = new CommandJournal(store), row = journal.list(scope, 'settings-session', 'all')[0]!;
  await assert.rejects(settingsWithJournal(journal, scope, 'settings-session', 'duplicate', async () => assert.fail('no write'), async () => assert.fail('no query')), CommandNotSubmittedError);
  journal.begin(scope, 'settings-session', 'message');
  journal.begin(otherScope, 'settings-session', 'other', 'settings');
  assert.equal(await recoverSavedCommand(journal, row, async () => settingsAccepted('settings')), 'accepted');
  assert.equal(writes, 1);
  assert.equal(JSON.stringify([...store.data]).includes('synthetic-model'), false);
});

test('settings recovery rejects wrong target, key, non-ACK success and invalid fields', async () => {
  for (const receipt of [settingsAccepted('wrong'), settingsAccepted('settings', 'wrong'), queueAccepted('settings'),
    { ...settingsAccepted('settings'), result: { status: 200, body: { sessionKey: 'settings-session', settings: { status: 'idle' } } } }]) {
    const journal = new CommandJournal(storage());
    await assert.rejects(settingsWithJournal(journal, scope, 'settings-session', 'settings', async () => ({ command: receipt }), async () => receipt), SettingsOutcomeUnknownError);
    assert.equal(journal.list(scope, undefined, 'all')[0]!.state, 'outcome_unknown');
  }
});

test('settings confirmed rejection and storage failure never become a repeated write', async () => {
  const journal = new CommandJournal(storage());
  await assert.rejects(settingsWithJournal(journal, scope, 'settings-session', 'settings', async () => { throw new Error('HTTP 400'); }, async () => ({
    ...settingsAccepted('settings'), state: 'rejected', result: { status: 400, body: { error: 'denied' } },
  })), CommandRejectedError);
  assert.equal(journal.list(scope, undefined, 'all')[0]!.state, 'rejected');
  const broken = new CommandJournal({ getItem: () => null, setItem: () => { throw new Error('full'); } });
  await assert.rejects(settingsWithJournal(broken, scope, 'settings-session', 'settings', async () => assert.fail('no write'), async () => assert.fail()), CommandNotSubmittedError);
});

test('settings direct ACK retains acceptance even when journal cleanup fails', async () => {
  const store = storage(); let changes = 0;
  const journal = new CommandJournal({ getItem: store.getItem, setItem: (key, value) => {
    if (++changes > 1) throw new Error('disk full'); store.setItem(key, value);
  } });
  const receipt = settingsAccepted('settings');
  const result = await settingsWithJournal(journal, scope, 'settings-session', 'settings', async () => ({
    ...receipt.result!.body, command: receipt,
  }), async () => assert.fail('accepted direct ACK needs no GET'));
  assert.equal(result.settings.model, 'synthetic-model');
});

test('settings result contract distinguishes clearing from omission and strips envelope snapshots', () => {
  const value = { sessionKey: 's', settings: { model: null, thinkingLevel: null }, status: 'idle', recent: 'private' };
  assert.deepEqual(readSessionSettingsResult(value, 's'), { sessionKey: 's', settings: value.settings });
  for (const settings of [{}, { title: null }, { title: 'x'.repeat(121) }, { model: 'x'.repeat(4097) }, { model: [] }, { model: '' }, { status: 'running' }]) {
    assert.equal(readSessionSettingsResult({ sessionKey: 's', settings }, 's'), undefined);
  }
});

const queue = { messageId: 'queued-id', action: 'edit' as const };
const queueAccepted = (key: string): CommandReceipt => ({ id: 'queue-receipt', key, state: 'accepted', createdAt: 1, updatedAt: 2,
  result: { status: 200, body: { ok: true } } });
const deletionAccepted = (key: string): CommandReceipt => ({ ...queueAccepted(key), result: { status: 200, body: { ok: true, status: 'delete_accepted' } } });
const creation = { connectionId: 'local', agentId: 'codex' };
const creationAccepted = (key: string, connection = 'local'): CommandReceipt => ({ ...queueAccepted(key),
  result: { status: 201, body: { key: `${connection}:${Buffer.from('codex:synthetic').toString('base64url')}` } } });

test('failed creation identity preflight leaves no unknown journal or native request', async () => {
  const journal = new CommandJournal(storage());
  await assert.rejects(createWithJournal(journal, scope, creation, 'preflight', async () => assert.fail('must not create'),
    async () => assert.fail('no receipt to query'), async () => { throw new Error('identity unavailable'); }), CommandNotSubmittedError);
  assert.deepEqual(journal.list(scope, undefined, 'creation'), []);
});

test('identity preflight precedes the creation journal and the single native submission', async () => {
  const journal = new CommandJournal(storage()), sequence: string[] = [];
  await createWithJournal(journal, scope, creation, 'prepared', async () => {
    sequence.push('create');
    assert.equal(journal.list(scope, undefined, 'creation')[0]?.state, 'outcome_unknown');
    return { command: creationAccepted('prepared') };
  }, async () => assert.fail(), async () => {
    sequence.push('verify');
    assert.deepEqual(journal.list(scope, undefined, 'creation'), []);
  });
  assert.deepEqual(sequence, ['verify', 'create']);
});

test('creation uses the same bounded journal without inventing a session ID', () => {
  const store = storage(), journal = new CommandJournal(store);
  journal.begin(scope, 's', 'message'); journal.begin(scope, 's', 'delete', 'delete');
  journal.beginCreation(scope, creation, 'create');
  const row = new CommandJournal(store).list(scope, undefined, 'creation')[0]!;
  assert.deepEqual(Object.keys(row).sort(), ['scope', 'creation', 'key', 'createdAt', 'state'].sort());
  assert.equal(journal.list(scope).length, 1); assert.equal(journal.list(scope, 's', 'all').length, 2);
  assert.equal(journal.list(scope, undefined, 'all').length, 3);
  assert.deepEqual(journal.list(otherScope, undefined, 'creation'), []);
});

test('lost creation ACK survives refresh and blocks duplicate creation only for its original target', async () => {
  const store = storage(); let writes = 0;
  await assert.rejects(createWithJournal(new CommandJournal(store), scope, creation, 'create', async () => {
    writes++; throw new Error('lost response');
  }, async () => { throw new Error('offline'); }), CreationOutcomeUnknownError);
  const journal = new CommandJournal(store), row = journal.list(scope, undefined, 'creation')[0]!;
  await assert.rejects(createWithJournal(journal, scope, creation, 'new-key', async () => assert.fail('no create'), async () => assert.fail()), CommandNotSubmittedError);
  for (const [account, target] of [[otherScope, creation], [scope, { ...creation, agentId: 'other' }], [scope, { ...creation, connectionId: 'other' }]] as const) {
    await createWithJournal(journal, account, target, 'isolated', async () => ({ command: creationAccepted('isolated', target.connectionId) }), async () => assert.fail());
  }
  assert.equal(await recoverSavedCommand(journal, row, async () => creationAccepted('create')), 'accepted');
  assert.equal(writes, 1); assert.equal(journal.list(scope, undefined, 'creation')[0]?.state, 'accepted');
});

test('accepted creation keeps a metadata-only recovery address until explicit dismissal', async () => {
  const store = storage(), journal = new CommandJournal(store);
  const result = await createWithJournal(journal, scope, creation, 'create', async () => ({ command: creationAccepted('create') }), async () => assert.fail());
  assert.equal(result.key, creationAccepted('create').result!.body.key);
  const row = new CommandJournal(store).list(scope, undefined, 'creation')[0]!;
  assert.equal(row.state, 'accepted');
  assert.equal(JSON.stringify(row).includes(result.key), false);
  assert.equal(JSON.stringify(row).includes('synthetic'), false);
  journal.forget(row); assert.equal(journal.list(scope, undefined, 'all').length, 0);
});

test('shared creation journals retain owner namespace across reload without blocking other owners', async () => {
  const saved = storage(), shared = { ...creation, ownerUserId: 'owner-a' };
  assert.equal(creationPath(shared), '/api/hub/v1/shared/owner-a/connections/local/agents/codex/sessions');
  for (const invalid of [{ ...shared, ownerUserId: '' }, { ...shared, agentId: 'main' }, { ...shared, token: 'injected' }]) assert.throws(() => creationPath(invalid));
  await assert.rejects(createWithJournal(new CommandJournal(saved), scope, shared, 'unknown', async () => { throw new Error('lost'); }, async () => { throw new Error('offline'); }), CreationOutcomeUnknownError);
  const journal = new CommandJournal(saved), row = journal.list(scope, undefined, 'creation')[0]!;
  assert.deepEqual(row.creation, shared);
  await assert.rejects(createWithJournal(journal, scope, shared, 'duplicate', async () => assert.fail(), async () => assert.fail()), CommandNotSubmittedError);
  for (const target of [creation, { ...shared, ownerUserId: 'owner-b' }]) {
    const key = `new-${'ownerUserId' in target ? target.ownerUserId : 'own'}`;
    await createWithJournal(journal, scope, target, key, async () => ({ command: creationAccepted(key) }), async () => assert.fail());
  }
  assert.equal(await recoverSavedCommand(journal, row, async () => creationAccepted('unknown')), 'accepted');
});

test('an in-flight browser create blocks a concurrent submission before rendering can disable the button', async () => {
  const journal = new CommandJournal(storage());
  let acknowledge!: (response: { command: CommandReceipt }) => void;
  const pending = createWithJournal(journal, scope, creation, 'first', () => new Promise(resolve => { acknowledge = resolve; }), async () => assert.fail());
  await assert.rejects(createWithJournal(journal, scope, creation, 'second', async () => assert.fail('duplicate POST'), async () => assert.fail()), CommandNotSubmittedError);
  acknowledge({ command: creationAccepted('first') });
  assert.equal((await pending).key, creationAccepted('first').result!.body.key);
});

test('confirmed creation survives journal settlement failure', async () => {
  const store = storage(); let fail = false;
  const journal = new CommandJournal({ getItem: store.getItem, setItem(key, value) { if (fail) throw new Error('storage denied'); store.setItem(key, value); } });
  const result = await createWithJournal(journal, scope, creation, 'create', async () => { fail = true; return { command: creationAccepted('create') }; }, async () => assert.fail());
  assert.equal(result.key, creationAccepted('create').result!.body.key);
  assert.equal(journal.list(scope, undefined, 'creation')[0]?.state, 'outcome_unknown');
});

test('creation rejects malformed receipts, wrong identities and bare errors without resubmission', async () => {
  const good = creationAccepted('create'), { result: _result, ...missing } = good;
  for (const receipt of [creationAccepted('other'), creationAccepted('create', 'foreign'), missing,
    { ...good, result: { status: 202, body: good.result!.body } },
    { ...good, state: 'rejected' as const, result: { status: 500, body: {} } },
    ...['local:', 'local:@@', 'local:YQ=', 'local:YQx', 'local:wA', 'local:AA', `local:${Buffer.from('codex:').toString('base64url')}`, `local:${'Y'.repeat(5000)}`]
      .map(key => ({ ...good, result: { status: 201, body: { key } } })),
  ]) {
    const journal = new CommandJournal(storage()); let writes = 0, reads = 0;
    await assert.rejects(createWithJournal(journal, scope, creation, 'create', async () => { writes++; return { command: receipt }; }, async () => { reads++; return receipt; }), CreationOutcomeUnknownError);
    const row = journal.list(scope, undefined, 'creation')[0]!;
    await assert.rejects(recoverSavedCommand(journal, row, async () => receipt));
    assert.equal(writes, 1); assert.equal(reads, 1); assert.equal(row.state, 'outcome_unknown');
  }
});

test('creation rejection requires a matching receipt and allows an explicitly new command', async () => {
  const journal = new CommandJournal(storage()); let reads = 0;
  await assert.rejects(createWithJournal(journal, scope, creation, 'create', async () => { throw new Error('403'); }, async () => {
    reads++; return { ...creationAccepted('create'), state: 'rejected', result: { status: 403, body: {} } };
  }), CommandRejectedError);
  assert.equal(reads, 1); assert.equal(journal.list(scope, undefined, 'creation')[0]?.state, 'rejected');
  await createWithJournal(journal, scope, creation, 'reviewed-new', async () => ({ command: creationAccepted('reviewed-new') }), async () => assert.fail());
});

test('unavailable, damaged and full journals prevent creation before any HTTP request', async () => {
  const full = storage(), journal = new CommandJournal(full);
  for (let i = 0; i < 128; i++) journal.begin(scope, 's', `entry-${i}`);
  for (const store of [full, { getItem: () => '{broken', setItem() {} }, { getItem: () => null, setItem() { throw new Error('denied'); } }]) {
    await assert.rejects(createWithJournal(new CommandJournal(store), scope, creation, 'create', async () => assert.fail(), async () => assert.fail()), CommandNotSubmittedError);
  }
});

test('creation target validation preserves exact encoded routing and rejects damaged saved records', () => {
  assert.equal(creationPath({ connectionId: 'node/一', agentId: 'agent / two' }), '/api/hub/v1/connections/node%2F%E4%B8%80/agents/agent%20%2F%20two/sessions');
  for (const target of [null, {}, { ...creation, title: 'secret' }, ...['', '.', '..', '\u0000', '\ud800', 'x'.repeat(513)].map(agentId => ({ ...creation, agentId }))]) {
    const raw = JSON.stringify([{ scope, creation: target, key: 'create', createdAt: 1, state: 'outcome_unknown' }]);
    assert.throws(() => new CommandJournal({ getItem: () => raw, setItem() {} }).list(scope), /invalid/);
  }
  for (const extra of [{ sessionKey: 'fake' }, { queue }, { deletion: true }, { title: 'secret' }]) {
    const raw = JSON.stringify([{ scope, creation, key: 'create', createdAt: 1, state: 'outcome_unknown', ...extra }]);
    assert.throws(() => new CommandJournal({ getItem: () => raw, setItem() {} }).list(scope), /invalid/);
  }
});

test('deletion reuses the bounded journal without becoming a pending message or queue command', () => {
  const store = storage(), journal = new CommandJournal(store);
  journal.begin(scope, 's', 'message'); journal.begin(scope, 's', 'queue', queue); journal.begin(scope, 's', 'delete', 'delete');
  assert.deepEqual(new CommandJournal(store).list(scope, 's').map(row => row.key), ['message']);
  assert.equal(journal.list(scope, 's', 'all').length, 3);
  assert.deepEqual(journal.list(otherScope, 's', 'all'), []);
  for (const extra of [{ deletion: false }, { deletion: null }, { deletion: 'true' }, { deletion: true, queue }, { deletion: true, text: 'secret' }]) {
    const raw = JSON.stringify([{ scope, sessionKey: 's', key: 'delete', createdAt: 1, state: 'outcome_unknown', ...extra }]);
    assert.throws(() => new CommandJournal({ getItem: () => raw, setItem() {} }).list(scope), /invalid/);
  }
});

test('deletion journals before its sole dispatch and preserves ACK despite journal cleanup failure', async () => {
  const store = storage(), journal = new CommandJournal(store);
  await deleteWithJournal(journal, scope, 's', 'delete', async () => {
    assert.equal(journal.list(scope, 's', 'all')[0]?.deletion, true);
    store.setItem = () => { throw new Error('synthetic quota'); };
    return { ok: true, status: 'delete_accepted', command: deletionAccepted('delete') };
  }, async () => assert.fail('ACK needs no GET'));
  assert.equal(journal.list(scope, 's', 'all')[0]?.state, 'outcome_unknown', 'saved record can still be recovered by GET');
});

test('unknown deletion survives refresh and prevents another delete, not other owner/session operations', async () => {
  const store = storage(); let writes = 0;
  await assert.rejects(deleteWithJournal(new CommandJournal(store), scope, 's', 'delete', async () => {
    writes++; throw new Error('synthetic lost response');
  }, async () => { throw new Error('synthetic offline'); }), DeletionOutcomeUnknownError);
  const journal = new CommandJournal(store), row = journal.list(scope, 's', 'all')[0]!;
  await assert.rejects(deleteWithJournal(journal, scope, 's', 'another', async () => assert.fail('must not delete again'), async () => assert.fail()), CommandNotSubmittedError);
  for (const [account, session] of [[otherScope, 's'], [scope, 'other']] as const) {
    await deleteWithJournal(journal, account, session, 'isolated', async () => ({ ok: true, status: 'delete_accepted', command: deletionAccepted('isolated') }), async () => assert.fail());
  }
  await recoverSavedCommand(journal, row, async () => deletionAccepted('delete'));
  assert.equal(journal.list(scope, 's', 'all')[0]?.state, 'accepted');
  assert.equal(writes, 1);
});

test('deletion ambiguity uses one GET and preserves matching durable rejection', async () => {
  for (const rejected of [false, true]) {
    const journal = new CommandJournal(storage()); let writes = 0, reads = 0;
    const promise = deleteWithJournal(journal, scope, 's', 'delete', async () => {
      writes++; throw new Error('synthetic 403 after dispatch');
    }, async () => {
      reads++; return rejected ? { ...deletionAccepted('delete'), state: 'rejected', result: { status: 403, body: {} } } : deletionAccepted('delete');
    });
    if (rejected) await assert.rejects(promise, CommandRejectedError); else await promise;
    assert.equal(writes, 1); assert.equal(reads, 1);
    assert.equal(journal.list(scope, 's', 'all')[0]?.state, rejected ? 'rejected' : undefined);
  }
});

test('malformed deletion receipts cannot remove the saved uncertainty barrier', async () => {
  const { result: _result, ...withoutResult } = deletionAccepted('delete');
  for (const receipt of [deletionAccepted('other'), queueAccepted('delete'),
    withoutResult,
    { ...deletionAccepted('delete'), result: { status: 202, body: { ok: true, status: 'delete_accepted' } } },
    { ...deletionAccepted('delete'), state: 'rejected' as const, result: { status: 500, body: {} } }]) {
    const journal = new CommandJournal(storage());
    await assert.rejects(deleteWithJournal(journal, scope, 's', 'delete', async () => ({ ok: true, command: receipt }), async () => receipt), DeletionOutcomeUnknownError);
    const row = journal.list(scope, 's', 'all')[0]!;
    await assert.rejects(recoverSavedCommand(journal, row, async () => receipt));
    assert.equal(journal.list(scope, 's', 'all')[0]?.state, 'outcome_unknown');
  }
});

test('broken, unavailable or full recovery storage prevents deletion dispatch', async () => {
  const full = storage(), journal = new CommandJournal(full);
  for (let i = 0; i < 128; i++) journal.begin(scope, 'other', `entry-${i}`, 'delete');
  for (const store of [full, { getItem: () => '{broken', setItem() {} },
    { getItem: () => null, setItem() { throw new Error('synthetic denied'); } }]) {
    await assert.rejects(deleteWithJournal(new CommandJournal(store), scope, 's', 'delete', async () => assert.fail('no DELETE'), async () => assert.fail('no GET')), CommandNotSubmittedError);
  }
});

test('queue recovery shares bounded storage, preserves old records and excludes mutations from message queries', () => {
  const store = storage(), journal = new CommandJournal(store);
  journal.begin(scope, 's', 'old'); journal.begin(scope, 's', 'edit', queue);
  assert.equal(new CommandJournal(store).list(scope, 's').length, 1);
  assert.equal(journal.list(scope, 's', 'all').length, 2);
  for (let i = 2; i < 128; i++) journal.begin(scope, 's', `entry-${i}`, queue);
  assert.throws(() => journal.begin(scope, 's', 'overflow', queue), /full/);
  for (const target of [{ ...queue, text: 'secret' }, { ...queue, messageId: '' }, { ...queue, messageId: 'x'.repeat(513) }, { ...queue, action: 'send' }, null]) {
    const raw = JSON.stringify([{ scope, sessionKey: 's', key: 'bad', createdAt: 1, state: 'outcome_unknown', queue: target }]);
    assert.throws(() => new CommandJournal({ getItem: () => raw, setItem() {} }).list(scope), /invalid/);
  }
});

test('queue mutation records before the sole write; accepted ACK requires no lookup and stores no text', async () => {
  const store = storage(), journal = new CommandJournal(store);
  await mutateQueueWithJournal(journal, scope, 's', 'edit', queue, async () => {
    assert.deepEqual(journal.list(scope, 's', 'all')[0]?.queue, queue);
    assert.equal([...store.data.values()].join('').includes('sensitive edited text'), false);
    return { ok: true, command: queueAccepted('edit') };
  }, async () => assert.fail('accepted ACK requires no GET'));
  assert.deepEqual(journal.list(scope, 's', 'all'), []);
});

test('queue lost ACK recovers acceptance or conflict by one exact GET, never a second mutation', async () => {
  for (const rejected of [false, true]) {
    const journal = new CommandJournal(storage()); let writes = 0, reads = 0;
    const promise = mutateQueueWithJournal(journal, scope, 's', 'edit', queue, async () => { writes++; throw new Error('lost ACK'); }, async () => {
      reads++; return rejected ? { ...queueAccepted('edit'), state: 'rejected', result: { status: 412, body: { error: 'conflict' } } } : queueAccepted('edit');
    });
    if (rejected) await assert.rejects(promise, /Queue version changed/); else await promise;
    assert.equal(writes, 1); assert.equal(reads, 1);
    assert.equal(journal.list(scope, 's', 'all')[0]?.state, rejected ? 'rejected' : undefined);
  }
});

test('unknown queue modification survives reload, blocks same target but not another account/session/target', async () => {
  const store = storage(); let writes = 0;
  await assert.rejects(mutateQueueWithJournal(new CommandJournal(store), scope, 's', 'edit', queue,
    async () => { writes++; throw new Error('lost'); }, async () => { throw new Error('offline'); }), QueueOutcomeUnknownError);
  const journal = new CommandJournal(store), row = journal.list(scope, 's', 'all')[0]!;
  await assert.rejects(mutateQueueWithJournal(journal, scope, 's', 'cancel', { ...queue, action: 'cancel' },
    async () => assert.fail('unknown target cannot be modified again'), async () => assert.fail('no second lookup')), CommandNotSubmittedError);
  for (const [account, session, id] of [[otherScope, 's', queue.messageId], [scope, 'other', queue.messageId], [scope, 's', 'other']]) {
    await mutateQueueWithJournal(journal, account!, session!, 'isolated', { ...queue, messageId: id! },
      async () => ({ ok: true, command: queueAccepted('isolated') }), async () => assert.fail());
  }
  await recoverSavedCommand(journal, row, async () => queueAccepted('edit'));
  assert.equal(writes, 1); assert.equal(journal.list(scope, 's', 'all')[0]?.state, 'accepted');
});

test('queue malformed and wrong-key receipts never clear the uncertainty barrier', async () => {
  const { result: _result, ...missingResult } = queueAccepted('edit');
  const invalid = [queueAccepted('wrong'), missingResult,
    { ...queueAccepted('edit'), result: { status: 202, body: { ok: true } } },
    { ...queueAccepted('edit'), state: 'rejected' as const, result: { status: 500, body: {} } }];
  for (const receipt of invalid) {
    const journal = new CommandJournal(storage());
    await assert.rejects(mutateQueueWithJournal(journal, scope, 's', 'edit', queue, async () => ({ ok: true }), async () => receipt), QueueOutcomeUnknownError);
    await assert.rejects(recoverSavedCommand(journal, journal.list(scope, 's', 'all')[0]!, async () => receipt));
    assert.equal(journal.list(scope, 's', 'all')[0]?.state, 'outcome_unknown');
  }
});

test('queue storage failures prevent writes, but failed cleanup cannot turn acceptance into failure', async () => {
  for (const store of [{ getItem() { throw new Error('disabled'); }, setItem() {} },
    { getItem: () => null, setItem() { throw new Error('quota'); } }, { getItem: () => 'x'.repeat(524289), setItem() {} }]) {
    await assert.rejects(mutateQueueWithJournal(new CommandJournal(store), scope, 's', 'edit', queue,
      async () => assert.fail('no write'), async () => assert.fail('no lookup')), CommandNotSubmittedError);
  }
  for (const lost of [false, true]) {
    const store = storage(); let count = 0;
    const journal = new CommandJournal({ ...store, setItem(k, v) { if (++count > 1) throw new Error('cleanup failed'); store.setItem(k, v); } });
    await mutateQueueWithJournal(journal, scope, 's', 'edit', queue,
      async () => { if (lost) throw new Error('lost'); return { ok: true, command: queueAccepted('edit') }; }, async () => queueAccepted('edit'));
    assert.equal(journal.list(scope, 's', 'all').length, 1);
  }
});

const scope = 'a'.repeat(64), otherScope = 'b'.repeat(64);
function storage() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}

test('audited settings release preserves unknown original identity while permitting a new explicit intent', async () => {
  const saved = storage(), journal = new CommandJournal(saved);
  const row = journal.begin(scope, 'session', 'old-settings', 'settings');
  assert.equal(isUnresolvedSettingsFence(row), true);
  const receipt: CommandReceipt = { id: 'original', key: row.key, state: 'outcome_unknown', createdAt: 1, updatedAt: 2, settingsStartReleased: true };
  assert.equal(await recoverSavedCommand(journal, row, async () => receipt), 'outcome_unknown');
  const reloaded = new CommandJournal(saved).list(scope, 'session', 'all')[0]!;
  assert.equal(reloaded.key, row.key); assert.equal(reloaded.state, 'outcome_unknown');
  assert.equal(isUnresolvedSettingsFence(reloaded), false);
  assert.throws(() => journal.begin(scope, 'session', row.key, 'settings'), /already recorded/);
  let writes = 0;
  await settingsWithJournal(journal, scope, 'session', 'new-explicit-intent', async () => {
    writes++;
    return { sessionKey: 'session', settings: { model: 'model' }, command: { id: 'new', key: 'new-explicit-intent', state: 'accepted', createdAt: 1, updatedAt: 2 } };
  }, async () => assert.fail('known acceptance'));
  assert.equal(writes, 1);
  journal.settle(reloaded, 'rejected');
  assert.equal(journal.list(scope, 'session', 'all')[0]!.settingsStartReleased, undefined);
});

for (const invalid of [{ settingsStartReleased: 'true' }, { key: 'wrong' }, { id: '' }, { createdAt: -1 }, { updatedAt: NaN }]) {
  test(`malformed settings release cannot remove local fence: ${JSON.stringify(invalid)}`, async () => {
    const journal = new CommandJournal(storage()), row = journal.begin(scope, 'session', 'settings', 'settings');
    await assert.rejects(recoverSavedCommand(journal, row, async () => ({ id: 'id', key: row.key, state: 'outcome_unknown',
      createdAt: 1, updatedAt: 2, settingsStartReleased: true, ...invalid }) as CommandReceipt));
    assert.equal(isUnresolvedSettingsFence(journal.list(scope, 'session', 'all')[0]!), true);
  });
}

for (const state of ['accepted', 'rejected'] as const) test(`receipt ${state} survives browser persistence failure with explicit warning`, async () => {
  const saved = storage(), journal = new CommandJournal(saved), row = journal.begin(scope, 'session', 'settings', 'settings');
  saved.setItem = () => { throw new Error('quota'); };
  let warning = '';
  const receipt: CommandReceipt = { id: 'id', key: row.key, state, createdAt: 1, updatedAt: 2,
    result: state === 'accepted' ? { status: 200, body: { sessionKey: 'session', settings: { model: 'model' } } }
      : { status: 409, body: { error: 'rejected' } } };
  assert.equal(await recoverSavedCommand(journal, row, async () => receipt, outcome => { warning = outcome; }), state);
  assert.equal(warning, state);
  assert.equal(journal.list(scope, 'session', 'all')[0]!.state, 'outcome_unknown', 'must not claim local durability');
});

test('interrupt acknowledgement is preserved as requested, never rewritten to stopped', async () => {
  const journal = new CommandJournal(storage());
  let sends = 0;
  const response = await sendWithJournal(journal, scope, 'session', 'interrupt-key', async () => {
    sends++;
    return { status: 'interrupt_requested', runId: 'observed-turn' };
  }, async () => assert.fail('known control acknowledgement needs no recovery query'));
  assert.equal(response.status, 'interrupt_requested');
  assert.equal(response.runId, 'observed-turn');
  assert.equal(sends, 1);
});

test('refresh recovers the original scoped command by GET without storing the payload', async () => {
  const store = storage(), journal = new CommandJournal(store);
  let posts = 0, queries = 0;
  await assert.rejects(sendWithJournal(journal, scope, 'session', key, async () => {
    posts++;
    assert.equal(new CommandJournal(store).list(scope)[0]?.key, key, 'record must be durable before POST');
    throw new Error('lost response for a sensitive payload');
  }, async () => { throw new Error('offline'); }), CommandOutcomeUnknownError);
  const reloaded = new CommandJournal(store), row = reloaded.list(scope, 'session')[0]!;
  assert.deepEqual(Object.keys(row).sort(), ['scope', 'sessionKey', 'key', 'createdAt', 'state'].sort());
  assert.equal([...store.data.values()].join('').includes('sensitive payload'), false);
  await recoverSavedCommand(reloaded, row, async () => { queries++; return accepted; });
  assert.equal(posts, 1); assert.equal(queries, 1);
  assert.equal(new CommandJournal(store).list(scope).length, 0, 'confirmed delivery retires its temporary warning');
  assert.deepEqual(reloaded.list(otherScope), []);
  assert.deepEqual(reloaded.list(scope, 'another-session'), []);
  reloaded.forget(row);
  assert.deepEqual(new CommandJournal(store).list(scope), []);
});

test('unknown and missing refresh receipts survive repeated reloads; duplicate POST is blocked', async () => {
  const store = storage(), journal = new CommandJournal(store), row = journal.begin(scope, 's', key);
  for (const query of [async () => { throw new Error('404'); }, async () => ({ ...accepted, key: 'wrong' })]) {
    await assert.rejects(recoverSavedCommand(new CommandJournal(store), row, query));
    assert.equal(new CommandJournal(store).list(scope)[0]?.state, 'outcome_unknown');
  }
  await assert.rejects(sendWithJournal(journal, scope, 's', key, async () => assert.fail('no second POST'), async () => accepted));
  const second = journal.begin(otherScope, 's', key);
  journal.forget(row);
  assert.equal(journal.list(otherScope)[0]?.key, second.key);
});

test('storage denial, corruption, oversize and quota failure prevent submission', async () => {
  const stores = [
    { getItem: () => { throw new Error('storage disabled'); }, setItem: () => {} },
    { getItem: () => null, setItem: () => { throw new Error('quota'); } },
    { getItem: () => '{', setItem: () => {} },
    { getItem: () => 'x'.repeat(524289), setItem: () => {} },
    { getItem: () => JSON.stringify([{ scope, key, sessionKey: 's', state: 'outcome_unknown', createdAt: 1, text: 'must not accept extra payload' }]), setItem: () => {} },
  ];
  for (const store of stores) await assert.rejects(sendWithJournal(new CommandJournal(store), scope, 's', key,
    async () => assert.fail('storage must succeed before POST'), async () => accepted), CommandNotSubmittedError);
  const journal = new CommandJournal(storage());
  for (let i = 0; i < 128; i++) journal.begin(scope, 's', `key-${i}`);
  assert.throws(() => journal.begin(scope, 's', 'over-limit'), /full/);
  assert.equal(journal.list(scope).length, 128, 'never evict unresolved records to make room');
});

test('definite rejection persists, known admission clears, cleanup failure does not change admission', async () => {
  const store = storage(), journal = new CommandJournal(store);
  await assert.rejects(sendWithJournal(journal, scope, 's', key, async () => { throw new CommandRejectedError('denied'); },
    async () => assert.fail('no query')), CommandRejectedError);
  assert.equal(journal.list(scope)[0]?.state, 'rejected');
  const row = journal.begin(scope, 'other', key);
  await recoverSavedCommand(journal, row, async () => ({ ...accepted, state: 'rejected', result: { status: 400, body: { error: 'denied' } } }));
  assert.equal(journal.list(scope, 'other')[0]?.state, 'rejected');
  await sendWithJournal(journal, scope, 'admitted', key, async () => accepted.result!.body as SendMessageResponse, async () => accepted);
  assert.deepEqual(journal.list(scope, 'admitted'), []);
  let writes = 0;
  const flaky = new CommandJournal({ getItem: store.getItem, setItem: (key, value) => {
    if (++writes > 1) throw new Error('quota');
    store.setItem(key, value);
  } });
  const result = await sendWithJournal(flaky, scope, 'cleanup-failure', key, async () => accepted.result!.body as SendMessageResponse, async () => accepted);
  assert.equal(result.status, 'queued');
  assert.equal(journal.list(scope, 'cleanup-failure').length, 1);
});

const key = 'local:stable-command';
const accepted: CommandReceipt = { id: 'receipt', key, state: 'accepted', createdAt: 1, updatedAt: 2,
  result: { status: 200, body: { ok: true, status: 'queued', idempotencyKey: 'runtime-queue-id' } } };

const malformedMessageResults = [
  undefined,
  { status: 500, body: { status: 'outcome_unknown' } },
  { status: 500, body: { status: 'queued' } },
  { status: 200, body: { status: 'outcome_unknown' } },
  { status: 200, body: { status: 'unsupported' } },
  { status: 200, body: null },
  { status: 200, body: [] },
  { status: 200, body: {} },
  { status: NaN, body: { status: 'queued' } },
  { status: 200.5, body: { status: 'queued' } },
];

test('malformed final accepted receipts preserve the exact unknown journal without redispatch', async () => {
  for (const result of malformedMessageResults) {
    const store = storage(), journal = new CommandJournal(store);
    let original = '', posts = 0, reads = 0;
    const receipt = { ...accepted, result } as CommandReceipt;
    await assert.rejects(sendWithJournal(journal, scope, 'session', key, async actual => {
      assert.equal(actual, key); posts++;
      original = store.getItem('agentopsdeck.command-recovery.v1')!;
      throw new Error('lost acknowledgement');
    }, async actual => { assert.equal(actual, key); reads++; return receipt; }), CommandOutcomeUnknownError);
    assert.equal(store.getItem('agentopsdeck.command-recovery.v1'), original);
    assert.equal(new CommandJournal(store).list(scope, 'session')[0]?.state, 'outcome_unknown');
    assert.equal(posts, 1); assert.equal(reads, 1);
  }
});

test('malformed early accepted receipts cannot clear a pending POST journal', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  for (const result of malformedMessageResults) {
    const store = storage(), journal = new CommandJournal(store);
    let original = '', posts = 0, reads = 0;
    const post = new Promise<SendMessageResponse>(() => {});
    const pending = sendWithJournal(journal, scope, 'session', key, actual => {
      assert.equal(actual, key); posts++;
      original = store.getItem('agentopsdeck.command-recovery.v1')!;
      return post;
    }, async actual => { assert.equal(actual, key); reads++; return { ...accepted, result } as CommandReceipt; });
    const rejection = assert.rejects(pending, CommandOutcomeUnknownError);
    await new Promise(resolve => setImmediate(resolve));
    context.mock.timers.tick(1_500);
    await rejection;
    assert.equal(store.getItem('agentopsdeck.command-recovery.v1'), original);
    assert.equal(posts, 1); assert.equal(reads, 2);
  }
});

test('refresh recovery keeps malformed accepted message receipts byte-for-byte unknown', async () => {
  for (const result of malformedMessageResults) {
    const store = storage(), journal = new CommandJournal(store), row = journal.begin(scope, 'session', key);
    const original = store.getItem('agentopsdeck.command-recovery.v1');
    await assert.rejects(recoverSavedCommand(journal, row, async () => ({ ...accepted, result } as CommandReceipt)), CommandOutcomeUnknownError);
    assert.equal(store.getItem('agentopsdeck.command-recovery.v1'), original);
  }
});

const malformedRejectedMessageResults = [
  undefined,
  { status: 200, body: { ok: true, status: 'queued' } },
  { status: 500, body: { error: 'upstream_failed' } },
  { status: 400, body: null },
  { status: 400, body: [] },
  { status: NaN, body: { error: 'denied' } },
  { status: 400.5, body: { error: 'denied' } },
];

test('malformed rejected message receipts stay byte-for-byte unknown across refresh, early, and final recovery', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  for (const result of malformedRejectedMessageResults) {
    const rejectedReceipt = { ...accepted, state: 'rejected', result } as CommandReceipt;

    const refreshStore = storage(), refreshJournal = new CommandJournal(refreshStore);
    const refreshRow = refreshJournal.begin(scope, 'session', key);
    const refreshOriginal = refreshStore.getItem('agentopsdeck.command-recovery.v1');
    await assert.rejects(recoverSavedCommand(refreshJournal, refreshRow, async () => rejectedReceipt), CommandOutcomeUnknownError);
    assert.equal(refreshStore.getItem('agentopsdeck.command-recovery.v1'), refreshOriginal);

    const finalStore = storage(), finalJournal = new CommandJournal(finalStore);
    let finalOriginal = '', finalPosts = 0, finalReads = 0;
    await assert.rejects(sendWithJournal(finalJournal, scope, 'session', key, async actual => {
      assert.equal(actual, key); finalPosts++;
      finalOriginal = finalStore.getItem('agentopsdeck.command-recovery.v1')!;
      throw new Error('lost acknowledgement');
    }, async actual => { assert.equal(actual, key); finalReads++; return rejectedReceipt; }), CommandOutcomeUnknownError);
    assert.equal(finalStore.getItem('agentopsdeck.command-recovery.v1'), finalOriginal);
    assert.equal(finalPosts, 1); assert.equal(finalReads, 1);

    const earlyStore = storage(), earlyJournal = new CommandJournal(earlyStore);
    let earlyOriginal = '', earlyPosts = 0, earlyReads = 0;
    const pending = sendWithJournal(earlyJournal, scope, 'session', key, actual => {
      assert.equal(actual, key); earlyPosts++;
      earlyOriginal = earlyStore.getItem('agentopsdeck.command-recovery.v1')!;
      return new Promise<SendMessageResponse>(() => {});
    }, async actual => { assert.equal(actual, key); earlyReads++; return rejectedReceipt; });
    const earlyOutcome = assert.rejects(pending, CommandOutcomeUnknownError);
    await new Promise(resolve => setImmediate(resolve));
    context.mock.timers.tick(1_500);
    await earlyOutcome;
    assert.equal(earlyStore.getItem('agentopsdeck.command-recovery.v1'), earlyOriginal);
    assert.equal(earlyPosts, 1); assert.equal(earlyReads, 2);
  }
});

for (const status of ['started', 'queued', 'stopped', 'interrupt_requested']) test(`late ${status} receipt retires delivery hint without replay`, async () => {
  const journal = new CommandJournal(storage()), row = journal.begin(scope, 'session', key);
  let reads = 0;
  assert.equal(await recoverSavedCommand(journal, row, async () => {
    reads++; return { ...accepted, result: { status: 200, body: { status } } };
  }), 'accepted');
  assert.equal(reads, 1);
  assert.deepEqual(journal.list(scope, 'session'), []);
});

test('unknown delivery remains protected; late acceptance with failed storage is not silently dismissed', async () => {
  const saved = storage(), journal = new CommandJournal(saved), row = journal.begin(scope, 'session', key);
  const { result: _result, ...unknown } = accepted;
  await recoverSavedCommand(journal, row, async () => ({ ...unknown, state: 'outcome_unknown' }));
  assert.equal(journal.list(scope, 'session')[0]?.state, 'outcome_unknown');
  saved.setItem = () => { throw new Error('quota'); };
  let warning = '';
  assert.equal(await recoverSavedCommand(journal, row, async () => accepted, state => { warning = state; }), 'accepted');
  assert.equal(warning, 'accepted');
  assert.equal(journal.list(scope, 'session')[0]?.state, 'outcome_unknown');
});

test('known admission makes one POST with the original key and does not query', async () => {
  let posts = 0;
  const result = await sendWithReceiptRecovery(key, async (actual) => {
    posts++; assert.equal(actual, key); return { ok: true, status: 'started' } as SendMessageResponse;
  }, async () => { assert.fail('unexpected query'); });
  assert.equal(result.status, 'started'); assert.equal(posts, 1);
});

test('slow POST settles from one accepted receipt without redispatch; late rejection is handled', async () => {
  let posts = 0, reads = 0, rejectPost!: (error: Error) => void;
  const post = new Promise<SendMessageResponse>((_, reject) => { rejectPost = reject; });
  const result = await sendWithReceiptRecovery(key, () => { posts++; return post; }, async actual => {
    reads++; assert.equal(actual, key); return accepted;
  }, 1);
  assert.equal(result.status, 'queued'); assert.equal(result.idempotencyKey, 'runtime-queue-id');
  assert.equal(posts, 1); assert.equal(reads, 1);
  rejectPost(new Error('late network failure'));
  await new Promise(resolve => setImmediate(resolve));
});

test('early pending, mismatched and unavailable receipts wait for the original POST', async () => {
  for (const receipt of ['pending', 'mismatch', 'unavailable']) {
    let finishPost!: (value: SendMessageResponse) => void, observed!: () => void, settled = false;
    const post = new Promise<SendMessageResponse>(resolve => { finishPost = resolve; });
    const probe = new Promise<void>(resolve => { observed = resolve; });
    let reads = 0, posts = 0;
    const result = sendWithReceiptRecovery(key, () => { posts++; return post; }, async () => {
      reads++; observed();
      if (receipt === 'unavailable') throw new Error('offline');
      return receipt === 'mismatch' ? { ...accepted, key: 'different' } : { ...accepted, state: 'pending' as CommandReceipt['state'] };
    }, 1).then(value => { settled = true; return value; });
    await probe; await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    finishPost({ ok: true, status: 'started' } as SendMessageResponse);
    assert.equal((await result).status, 'started'); assert.equal(reads, 1); assert.equal(posts, 1);
  }
});

test('early definitive rejection remains rejected while the original POST is pending', async () => {
  await assert.rejects(sendWithReceiptRecovery(key, () => new Promise(() => {}),
    async () => ({ ...accepted, state: 'rejected', result: { status: 400, body: { error: 'denied' } } }), 1), CommandRejectedError);
});

test('lost acknowledgement recovers queue identity by GET, never a second POST', async () => {
  let posts = 0, queries = 0;
  const result = await sendWithReceiptRecovery(key, async () => { posts++; throw new Error('disconnected'); }, async (actual) => {
    queries++; assert.equal(actual, key); return accepted;
  });
  assert.equal(result.idempotencyKey, 'runtime-queue-id'); assert.equal(result.status, 'queued');
  assert.equal(posts, 1); assert.equal(queries, 1);
});

test('unknown, missing, mismatched and unavailable receipts never authorize redispatch', async () => {
  for (const query of [
    async () => { const { result: _, ...receipt } = accepted; return { ...receipt, state: 'outcome_unknown' as const }; },
    async () => ({ ...accepted, key: 'someone-else' }),
    async () => { throw new Error('404'); },
    async () => { throw new Error('timeout'); },
  ]) {
    let posts = 0;
    await assert.rejects(sendWithReceiptRecovery(key, async () => {
      posts++; return { ok: false, status: 'outcome_unknown' } as SendMessageResponse;
    }, query), (error: unknown) => error instanceof CommandOutcomeUnknownError && error.commandKey === key);
    assert.equal(posts, 1);
  }
});

test('definitive rejection stays rejection, whether received directly or recovered', async () => {
  await assert.rejects(sendWithReceiptRecovery(key, async () => { throw new CommandRejectedError('denied'); },
    async () => { assert.fail('unexpected query'); }), CommandRejectedError);
  await assert.rejects(sendWithReceiptRecovery(key, async () => { throw new Error('lost response'); },
    async () => ({ ...accepted, state: 'rejected', result: { status: 403, body: { error: 'denied' } } })), CommandRejectedError);
});

test('command keys are unique and accepted by the wire protocol', () => {
  const startedAt = Date.now();
  const keys = Array.from({ length: 100 }, () => newCommandKey());
  assert.equal(new Set(keys).size, keys.length);
  for (const value of keys) {
    assert.match(value, /^[A-Za-z0-9._:-]{1,200}$/);
    const issuedAt = commandKeyIssuedAt(value);
    assert.ok(issuedAt !== undefined && issuedAt >= startedAt && issuedAt <= Date.now());
  }
});

test('command key fallback keeps cryptographic nonce and canonical issue time', context => {
  const timestamp = Date.UTC(2026, 8, 16);
  context.mock.method(Date, 'now', () => timestamp);
  context.mock.method(globalThis.crypto, 'randomUUID', () => undefined);
  const keys = Array.from({ length: 100 }, () => newCommandKey());
  assert.equal(new Set(keys).size, keys.length);
  for (const key of keys) {
    assert.match(key, new RegExp(`^cp1:${timestamp}:[a-f0-9]{32}$`));
    assert.equal(commandKeyIssuedAt(key), timestamp);
  }
});

test('command key formatting rejects invalid time or nonce instead of falling back to legacy', () => {
  for (const timestamp of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createCommandKey('a'.repeat(32), timestamp));
  }
  for (const nonce of ['', 'a'.repeat(31), 'g'.repeat(32), 'A'.repeat(32)]) {
    assert.throws(() => createCommandKey(nonce));
  }
  assert.equal(commandKeyIssuedAt('legacy-key'), undefined);
  assert.equal(commandKeyIssuedAt(createCommandKey('a'.repeat(32), 0)), 0);
});

test('expired versioned keys remain original unknown journal entries across reload without resubmission', async () => {
  const key = createCommandKey('a'.repeat(32), 1), saved = storage(), journal = new CommandJournal(saved);
  let posts = 0;
  await assert.rejects(sendWithJournal(journal, scope, 'session', key,
    async () => { posts++; throw new Error('Command key expired; original outcome not established'); },
    async () => { throw new Error('404'); }), CommandOutcomeUnknownError);
  for (const status of [404, 410]) {
    const reloaded = new CommandJournal(saved), row = reloaded.list(scope)[0]!;
    assert.equal(row.key, key);
    assert.equal(row.state, 'outcome_unknown');
    await assert.rejects(recoverSavedCommand(reloaded, row, async () => { throw new Error(String(status)); }));
    await assert.rejects(sendWithJournal(reloaded, scope, 'session', key,
      async () => assert.fail('must not POST again'), async () => assert.fail('must not replace key')));
  }
  assert.equal(posts, 1);
  assert.equal(new CommandJournal(saved).list(scope)[0]?.state, 'outcome_unknown');
});
