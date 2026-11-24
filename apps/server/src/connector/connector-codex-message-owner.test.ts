import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncCodexMessages } from './async-codex-messages.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { persistUploadedMedia } from '../messages/send-message.js';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';
import { codexMessageAdmission, validConnectorCodexMessageInput, validConnectorCodexMessageOutput,
  type CodexMessageScope } from './connector-codex-message-domain.js';

const token = 'isolated-codex-message-token', authorization = `Bearer ${token}`, key = 'codex:original';
const silent = new PerformanceDiagnostics(() => {}), wait = { timeoutMs: 10_000 };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function converge(predicate: () => boolean) {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await tick(); }
  assert.fail('expected physical phase did not begin');
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'codex-message-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), token, silent);
  const store = new ConnectorUserStore(':memory:', id => !!tokens.delegationHubId(id), { runtimeOwner: true });
  const command = createConnectorOwnerCommands(store, tokens);
  const scope = { key, authorization, commandKey: 'original' };
  let effects = 0, publications = 0, ready = true, exists = true, blocked = false;
  const messages = new AsyncCodexMessages({ owner: { command }, ready: () => ready, sessionExists: () => exists,
    displayBlocked: () => blocked, admitted: () => { publications++; }, persist: async items => {
      effects++;
      return (items ?? []).map(() => ({ filePath: '/isolated/original.png', media: {
        type: 'image' as const, name: 'original.png', url: '/api/media/inbound/original.png', size: 1, mimeType: 'image/png' } }));
    } });
  const claim = async (payload: unknown = { message: 'original' }, s = scope) => {
    const result = await command('codexMessageClaim', { ...s, payloadJson: JSON.stringify(payload) });
    assert.ok('intent' in result && result.intent); return result.intent;
  };
  return { directory, tokens, store, command, scope, messages, claim,
    effects: () => effects, publications: () => publications, ready: (v: boolean) => { ready = v; },
    exists: (v: boolean) => { exists = v; }, blocked: (v: boolean) => { blocked = v; },
    async close() { await messages.close(); command.dispose(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('Codex fixed protocol rejects forged authority, foreign runtime and malformed media/results', () => {
  const scope = { key, authorization, commandKey: 'original' }, intent = { key, id: 'id', receiptId: 'receipt' };
  for (const extra of [{ actorId: 'forged' }, { authorized: true }, { key: 'hermes:foreign' }, { commandKey: '../bad' }])
    assert.equal(validConnectorCodexMessageInput('codexMessageClaim', { ...scope, payloadJson: '{"message":"x"}', ...extra }), false);
  for (const images of [[{ filePath: '/private', media: { type: 'file', name: 'file', url: '/file' } }],
    [{ filePath: '/private', media: { type: 'image', name: 'image', url: '/file', size: 12 * 1024 * 1024 + 1 } }]])
    assert.equal(validConnectorCodexMessageInput('codexMessageCommit', { ...scope, intent, images, displayBlocked: false }), false);
  assert.equal(validConnectorCodexMessageInput('codexMessageClaim', { ...scope, payloadJson: '{"idempotencyKey":"hidden"}' }), false);
  assert.equal(validConnectorCodexMessageOutput('codexMessageReady', { error: '403' }), false);
  assert.equal(codexMessageAdmission({ runId: 'x', idempotencyKey: 'x', status: 'queued', media: [],
    admission: { createdAt: 1, queueVersion: '0:0', disposition: 'preparing' } }), false);
});

test('original immutable receipt atomically admits queue/version/frontend fields; duplicates never repeat files', async () => {
  const f = fixture();
  try {
    const request = { ...f.scope, payloadJson: JSON.stringify({ message: ' original ', metadata: 'private-fingerprint' }) };
    const result = await f.messages.send(request, wait); assert.ok('receipt' in result); assert.equal(result.receipt?.state, 'accepted');
    assert.equal(result.admitted, true); assert.equal(f.effects(), 1); assert.equal(f.publications(), 1);
    const turn = f.store.turns.list<{ text: string; images: unknown[]; actorId: string }>('codex', key)[0]!;
    assert.equal(turn.payload.text, 'original'); assert.deepEqual(turn.payload.images, []);
    assert.equal(turn.payload.actorId, f.tokens.authenticateAuthorization(authorization)!.tokenId);
    const body = result.receipt.result!.body; assert.ok(codexMessageAdmission(body));
    assert.equal(body.runId, turn.id); assert.equal(body.idempotencyKey, turn.id); assert.equal(body.status, 'queued');
    assert.deepEqual(body.admission, { createdAt: turn.createdAt, queueVersion: f.store.turns.version('codex', key, turn.id), disposition: 'preparing' });
    f.ready(false); f.store.pauseTurnStarts();
    const duplicate = await f.messages.send(request, wait); assert.ok('receipt' in duplicate);
    assert.deepEqual(duplicate.receipt, result.receipt); assert.equal(duplicate.intent, null); assert.equal(duplicate.admitted, false);
    assert.equal(f.effects(), 1); assert.equal(f.publications(), 1); assert.equal(f.store.turns.list('codex', key).length, 1);
    assert.deepEqual(await f.messages.send({ ...request, payloadJson: '{"message":"changed"}' }, wait), { error: 409 });
  } finally { await f.close(); }
});

for (const blocked of [false, true]) test(`display-only active snapshot and queue order preserve original disposition (${blocked})`, async () => {
  const f = fixture();
  try {
    f.blocked(blocked);
    for (const commandKey of ['first', 'second']) {
      const result = await f.messages.send({ ...f.scope, commandKey, payloadJson: '{"message":"original"}' }, wait);
      assert.ok('receipt' in result); const body = result.receipt?.result?.body; assert.ok(codexMessageAdmission(body));
      assert.equal(body.admission.disposition, blocked || commandKey === 'second' ? 'waiting' : 'preparing');
    }
    assert.equal(f.store.codexExecutions.get(key), undefined); // DISPLAY cannot claim execution.
    assert.ok(f.store.turns.list('codex', key).every(t => t.state === 'queued'));
  } finally { await f.close(); }
});

test('image-only input stores references, never base64; invalid/control/mirror requests cannot obtain file capability', async () => {
  const f = fixture();
  try {
    const payload = { media: [{ dataUrl: 'data:image/png;base64,YQ==', name: 'private.png' }] };
    const result = await f.messages.send({ ...f.scope, payloadJson: JSON.stringify(payload) }, wait);
    assert.ok('receipt' in result); assert.equal(result.receipt?.state, 'accepted');
    const row = f.store.turns.list<{ text: string; images: unknown[] }>('codex', key)[0]!;
    assert.equal(row.payload.text, ''); assert.equal(row.payload.images.length, 1);
    assert.doesNotMatch(JSON.stringify(row), /base64|private.png/);
    for (const [index, payload] of [{ message: '' }, { message: 'file', media: [{ dataUrl: 'data:text/plain;base64,YQ==' }] },
      { message: '/stop' }, { message: ' /stop ' }, { message: 'mirror', deliveryMode: 'mirror' }].entries()) {
      const rejected = await f.messages.send({ ...f.scope, commandKey: `reject-${index}`, payloadJson: JSON.stringify(payload) }, wait);
      assert.ok('receipt' in rejected); assert.equal(rejected.receipt?.state, 'rejected'); assert.equal(rejected.intent, null);
    }
    const long = await f.messages.send({ ...f.scope, key: `codex:${'x'.repeat(500)}`, payloadJson: '{"message":"original"}' }, wait);
    assert.ok('receipt' in long); assert.equal(long.receipt?.result?.status, 400);
    assert.equal(f.effects(), 1);
  } finally { await f.close(); }
});

test('original application revoke held at second physical file prevents that write and native queue commit', async () => {
  const f = fixture(), inboundDir = join(f.directory, 'physical-files');
  let finish!: () => void, checks = 0, revoked = false;
  const commands: string[] = [];
  const authority: ApplicationCommandScope = {
    intent: { action: 'message', runtime: 'codex', resource: key, commandKey: f.scope.commandKey, payloadDigest: 'a'.repeat(64) },
    local() { if (revoked) throw Error('original application revoked'); },
    async authorize(stage) {
      if (stage === 'effect' && ++checks === 4) await new Promise<void>(resolve => { finish = resolve; });
      if (revoked) throw Error('original application revoked');
    },
  };
  const messages = new AsyncCodexMessages({ owner: { command: async (kind, input) => {
    commands.push(kind); return f.command(kind, input);
  } }, ready: () => true, sessionExists: () => true, displayBlocked: () => false,
    admitted() { assert.fail('revoked physical chain cannot publish'); },
    persist: (items, options) => persistUploadedMedia(items, { ...options, inboundDir }) });
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
  const media = ['first.png', 'second.png'].map(name => ({ type: 'image', name, mimeType: 'image/png',
    size: Buffer.from(dataUrl.split(',')[1]!, 'base64').length, dataUrl }));
  try {
    const original = messages.sendPhysical({ ...f.scope, payloadJson: JSON.stringify({ message: '', media }) }, authority);
    const rejected = assert.rejects(original, /original application revoked/);
    await converge(() => !!finish);
    assert.equal(readdirSync(inboundDir).length, 1, 'first authorized artifact exists before second file gate');
    revoked = true; finish(); await rejected;
    assert.equal(readdirSync(inboundDir).length, 1, 'no second artifact after revoke');
    assert.equal(commands.includes('codexMessageCommit'), false);
    assert.equal(f.store.turns.list('codex', key).length, 0);
    const saved = await f.messages.readReceipt(f.scope, wait); assert.ok('receipt' in saved);
    assert.equal(saved.receipt?.state, 'outcome_unknown', 'no fabricated rejection or successful delivery');
  } finally { finish?.(); await messages.close(); await f.close(); }
});

for (const change of ['maintenance', 'revoke', 'missing', 'closed'] as const) test(`attachment await preserves current ${change} fence without replay`, async () => {
  const f = fixture(); let finish!: () => void, entered = false;
  const messages = new AsyncCodexMessages({ owner: { command: f.command }, ready: () => change !== 'closed' || !entered,
    sessionExists: () => change !== 'missing' || !entered, displayBlocked: () => false,
    admitted() { assert.fail('rejected admission cannot publish'); }, persist: async () => {
      await new Promise<void>(resolve => { finish = resolve; entered = true; }); return [];
    } });
  try {
    const task = messages.send({ ...f.scope, payloadJson: '{"message":"original"}' }, wait);
    await converge(() => !!finish);
    if (change === 'maintenance') f.store.pauseTurnStarts();
    if (change === 'revoke') f.tokens.revoke(f.tokens.authenticateAuthorization(authorization)!.tokenId);
    finish();
    if (change === 'missing' || change === 'closed') await assert.rejects(task);
    else { const result = await task; assert.ok('error' in result); assert.equal(result.error, change === 'revoke' ? 401 : 409); }
    assert.equal(f.store.turns.list('codex', key).length, 0);
    // Unknown physical work is not freed or turned into a fresh attachment intent.
    if (change !== 'revoke') {
      const saved = await f.messages.readReceipt(f.scope, wait); assert.ok('receipt' in saved);
      assert.equal(saved.receipt?.state, change === 'maintenance' ? 'rejected' : 'outcome_unknown');
    }
  } finally { finish?.(); await messages.close(); await f.close(); }
});

test('one-shot ready and concurrent commit cannot reuse attachment or admission authority', async () => {
  const f = fixture();
  try {
    const intent = await f.claim();
    assert.deepEqual(await f.command('codexMessageCommit', { ...f.scope, intent, images: [], displayBlocked: false }), { error: 409 });
    assert.equal(await f.command('codexMessageReady', { ...f.scope, intent }), true);
    assert.equal(await f.command('codexMessageReady', { ...f.scope, intent }), false);
    const results = await Promise.all([0, 1].map(() => f.command('codexMessageCommit', { ...f.scope, intent, images: [], displayBlocked: false })));
    assert.equal(results.filter(r => 'admitted' in r && r.admitted).length, 1);
    assert.equal(f.store.turns.list('codex', key).length, 1);
    const again = await f.command('codexMessageCommit', { ...f.scope, intent, images: [], displayBlocked: false });
    assert.ok('receipt' in again); assert.equal(again.receipt?.state, 'accepted'); assert.equal(again.admitted, false);
  } finally { await f.close(); }
});

for (const boundary of ['codexMessageClaim', 'codexMessageReady', 'codexMessageCommit', 'codexMessageRelease'] as const)
 for (const after of [false, true]) test(`lost ${boundary} ACK ${after ? 'after' : 'before'} delivery never replays business work`, async () => {
  const f = fixture(); let files = 0, publications = 0;
  const messages = new AsyncCodexMessages({ owner: { command: async (kind, input) => {
    if (!after && kind === boundary) throw Error('delivery failed');
    const result = await f.command(kind, input); if (after && kind === boundary) throw Error('ACK lost'); return result;
  } }, ready: () => true, sessionExists: () => true, displayBlocked: () => false,
    persist: async () => { files++; return []; }, admitted: () => { publications++; } });
  try {
    const request = { ...f.scope, payloadJson: '{"message":"original"}' };
    if (boundary === 'codexMessageRelease') await messages.send(request, wait);
    else await assert.rejects(messages.send(request, wait));
    const saved = await f.messages.readReceipt(f.scope, wait); assert.ok('receipt' in saved);
    const committed = boundary === 'codexMessageRelease' || boundary === 'codexMessageCommit' && after;
    assert.equal(saved.receipt?.state, committed ? 'accepted' : boundary === 'codexMessageClaim' && !after ? undefined : 'outcome_unknown');
    assert.equal(f.store.turns.list('codex', key).length, committed ? 1 : 0);
    if (saved.receipt) {
      // Recover over a healthy transport; the injected transport deliberately
      // loses every ACK at this boundary, including a duplicate read response.
      const duplicate = await f.messages.send(request, wait); assert.ok('receipt' in duplicate); assert.equal(duplicate.intent, null);
    }
    assert.equal(files, ['codexMessageClaim', 'codexMessageReady'].includes(boundary) ? 0 : 1);
    assert.equal(publications, boundary === 'codexMessageRelease' ? 1 : 0);
  } finally { await messages.close(); await f.close(); }
});

test('receipt participant fault rolls back queue and version; post-commit storage error preserves original acceptance', async t => {
  for (const after of [false, true]) await t.test(after ? 'post-commit' : 'participant', async t => {
    const f = fixture();
    try {
      if (after) {
        const enqueue = f.store.turns.enqueueAsync.bind(f.store.turns);
        t.mock.method(f.store.turns, 'enqueueAsync', async (...args: Parameters<typeof enqueue>) => { await enqueue(...args); throw Error('lost return'); });
      } else {
        const commit = f.store.commands.queueCommit.bind(f.store.commands);
        t.mock.method(f.store.commands, 'queueCommit', (...args: Parameters<typeof commit>) => {
          const original = commit(...args);
          return (...args: Parameters<typeof original>) => { original(...args); throw Error('receipt participant failed'); };
        });
      }
      const task = f.messages.send({ ...f.scope, payloadJson: '{"message":"original"}' }, wait);
      if (after) { const r = await task; assert.ok('receipt' in r); assert.equal(r.receipt?.state, 'accepted'); }
      else await assert.rejects(task);
      assert.equal(f.store.turns.list('codex', key).length, after ? 1 : 0);
      const read = await f.messages.readReceipt(f.scope, wait); assert.ok('receipt' in read);
      assert.equal(read.receipt?.state, after ? 'accepted' : 'outcome_unknown');
      const duplicate = await f.messages.send({ ...f.scope, payloadJson: '{"message":"original"}' }, wait);
      assert.ok('receipt' in duplicate); assert.equal(duplicate.intent, null); assert.equal(f.effects(), 1);
    } finally { await f.close(); }
  });
});

test('delegated original actor, node and grant are checked; read-only recovery survives grant revocation', async () => {
  const f = fixture();
  try {
    const issuer = f.tokens.create({ label: 'issuer', scopes: ['execution:delegate', 'messages:send', 'messages:read'], delegationHubId: 'hub' });
    const ref = f.store.executionGrants.issue({ principalId: 'member', grantKey: 'policy', version: 1,
      runtime: 'codex', sessionKey: key, issuerTokenId: issuer.record.id, hubId: 'hub' }, ['messages:send'], Date.now() + 30_000);
    const scope: CodexMessageScope = { ...f.scope, authorization: `Bearer ${issuer.token}`, grantId: ref.id, expectedNode: f.store.nodeId };
    const { grantId: _grant, ...withoutGrant } = scope;
    for (const invalid of [withoutGrant, { ...scope, expectedNode: 'foreign' }, { ...scope, grantId: 'foreign' }])
      assert.deepEqual(await f.command('codexMessageClaim', { ...invalid, payloadJson: '{"message":"original"}' }), { error: 403 });
    const result = await f.messages.send({ ...scope, payloadJson: '{"message":"original"}' }, wait);
    assert.ok('receipt' in result); assert.equal(result.receipt?.state, 'accepted');
    const row = f.store.turns.list<{ actorId: string; executionGrant: { id: string } }>('codex', key)[0]!;
    assert.equal(row.payload.actorId, ref.actorId); assert.equal(row.payload.executionGrant.id, ref.id);
    f.store.executionGrants.revoke(issuer.record.id, ref.id);
    const read = await f.messages.readReceipt(scope, wait); assert.ok('receipt' in read); assert.equal(read.receipt?.state, 'accepted');
    assert.deepEqual(await f.messages.readSendReceipt(scope, wait), { error: 403 });
  } finally { await f.close(); }
});

test('delivery timeout does not release physical attachment, SQL or postcommit publication; close drains all', async () => {
  const f = fixture(); let finish!: () => void, notified!: () => void, drained = false;
  const messages = new AsyncCodexMessages({ owner: { command: f.command }, ready: () => true, sessionExists: () => true,
    displayBlocked: () => false, persist: async () => { await new Promise<void>(resolve => { finish = resolve; }); return []; },
    admitted: () => new Promise<void>(resolve => { notified = resolve; }) });
  try {
    await assert.rejects(messages.send({ ...f.scope, payloadJson: '{"message":"original"}' }, { timeoutMs: 30 }));
    assert.ok(finish);
    const close = messages.close().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
    finish(); await converge(() => !!notified); assert.equal(drained, false);
    notified(); await close; assert.equal(f.store.turns.list('codex', key).length, 1);
    await assert.rejects(messages.send({ ...f.scope, commandKey: 'late', payloadJson: '{"message":"late"}' }, wait));
  } finally { finish?.(); notified?.(); await messages.close(); await f.close(); }
});

for (const accepted of [false, true]) test(`real file worker restart preserves ${accepted ? 'accepted' : 'unknown'} original receipt, never old volatile permission`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-message-worker-'));
  const file = join(directory, 'original.sqlite'), tokenFile = join(directory, 'tokens.json');
  new ConnectorTokenStore(tokenFile, token, silent);
  let owner = new AsyncConnectorOwner({ file, tokenFile, bootstrapToken: token }, silent);
  const scope = { key, authorization, commandKey: 'worker-original' }, input = { ...scope, payloadJson: '{"message":"original"}' };
  try {
    await owner.open(); const claim = await owner.command('codexMessageClaim', input); assert.ok('intent' in claim && claim.intent);
    assert.equal(await owner.command('codexMessageReady', { ...scope, intent: claim.intent }), true);
    if (accepted) {
      const commit = await owner.command('codexMessageCommit', { ...scope, intent: claim.intent, images: [], displayBlocked: false });
      assert.ok('receipt' in commit); assert.equal(commit.receipt?.state, 'accepted');
    }
    await owner.close(); owner = new AsyncConnectorOwner({ file, tokenFile, bootstrapToken: token }, silent); await owner.open();
    const duplicate = await owner.command('codexMessageClaim', input); assert.ok('receipt' in duplicate);
    assert.equal(duplicate.receipt?.id, claim.receipt?.id); assert.equal(duplicate.receipt?.state, accepted ? 'accepted' : 'outcome_unknown');
    assert.equal(duplicate.intent, null); assert.equal(duplicate.admitted, false);
    assert.equal(await owner.command('codexMessageReady', { ...scope, intent: claim.intent }), false);
    const late = await owner.command('codexMessageCommit', { ...scope, intent: claim.intent, images: [], displayBlocked: false });
    assert.ok('receipt' in late); assert.equal(late.receipt?.state, accepted ? 'accepted' : 'outcome_unknown'); assert.equal(late.admitted, false);
  } finally { await owner.closeForShutdown(); rmSync(directory, { recursive: true, force: true }); }
});
