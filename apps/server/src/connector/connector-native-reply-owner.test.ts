import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { ConnectorUserStore } from './connector-user-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { claimOpenClawOwnerTurn, openClawFixtureKey, seedOpenClawOwnerTurns } from './openclaw-owner-test-fixture.js';
import { AsyncConnectorExecutionSettlements } from './async-execution-settlements.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { connectorOwnerCommandBytes, CONNECTOR_COMMAND_BYTES, CONNECTOR_PENDING_INPUT_BYTES,
  connectorOwnerSteps, encodeConnectorOwnerJson, validConnectorOwnerInput } from './connector-owner-domain.js';
import { CONNECTOR_NATIVE_REPLY_TEXT_BYTES, executeConnectorNativeReply,
  type ConnectorNativeReplyCommands } from './connector-native-reply-domain.js';

const silent = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
type Cli = ConnectorNativeReplyCommands['openClawCliFinalReply']['input'];
type Gateway = ConnectorNativeReplyCommands['openClawGatewayFinalReply']['input'];
const cli = (sessionKey = 'cli', commandId = 'cli-command'): Cli =>
  ({ sessionKey, commandId, phase: 'completed', deliveryMode: 'mirror', replyText: 'original private reply' });
const gateway = (sessionKey = 'gateway', commandId = 'gateway-command'): Gateway =>
  ({ sessionKey, event: { runId: commandId + '-run', gatewayConnectionId: 'original-connection', phase: 'completed',
    reply: { text: 'original private gateway reply', sequence: 1 } } });
function admit(store: ConnectorUserStore, sessionKey: string, commandId: string, origin: 'cli' | 'gateway', mirror = true) {
  if (mirror) store.mirrorOutbox.upsert({ actorId: 'original-actor', sessionKey, after: 1, inputText: 'original private input',
    idempotencyKey: commandId, explicitRoute: { originatingChannel: 'test', originatingTo: 'original', outboundTarget: 'original' } });
  assert.equal(store.openClawExecutions.begin(sessionKey, commandId), true);
  if (origin === 'cli') assert.equal(store.openClawExecutions.useCli(sessionKey, commandId), true);
  if (origin === 'gateway') assert.equal(store.openClawExecutions.bindGatewayConnection(sessionKey, commandId, 'original-connection'), true);
}
function disk(work: (store: ConnectorUserStore, file: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'native-final-reply-')), file = join(root, 'db.sqlite');
  const store = new ConnectorUserStore(file);
  try { work(store, file); } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}

test('native reply envelopes accept original text budget without widening ordinary command admission', () => {
  assert.equal(connectorOwnerSteps.openClawGatewayFinalReply, 62);
  assert.equal(connectorOwnerSteps.openClawCliFinalReply, 63);
  assert.equal(connectorOwnerCommandBytes('userCreate'), CONNECTOR_COMMAND_BYTES);
  assert.equal(connectorOwnerCommandBytes('exec'), CONNECTOR_COMMAND_BYTES);
  const worstEscaping = { ...cli(), replyText: '\0'.repeat(CONNECTOR_NATIVE_REPLY_TEXT_BYTES) };
  const body = encodeConnectorOwnerJson(worstEscaping, connectorOwnerCommandBytes('openClawCliFinalReply'));
  assert.ok(Buffer.byteLength(body) > 6 * CONNECTOR_NATIVE_REPLY_TEXT_BYTES);
  assert.equal(validConnectorOwnerInput('openClawCliFinalReply', JSON.parse(body)), true);
  assert.throws(() => encodeConnectorOwnerJson(worstEscaping));
  for (const input of [ { ...cli(), replyText: 'é'.repeat(CONNECTOR_NATIVE_REPLY_TEXT_BYTES) },
    { ...cli(), mirrorParams: {} }, { ...cli(), authorized: true }, { ...cli(), callback: 'exec' },
    { ...cli(), phase: 'failed' }, { ...cli(), deliveryMode: 'web-only' } ]) {
    assert.equal(validConnectorOwnerInput('openClawCliFinalReply', input), false);
  }
  for (const event of [ { ...gateway().event, phase: 'running' }, { ...gateway().event, replyOnly: false },
    { ...gateway().event, reply: { text: 'x', sequence: -1 } }, { ...gateway().event, gatewayConnectionId: '' } ]) {
    assert.equal(validConnectorOwnerInput('openClawGatewayFinalReply', { sessionKey: 'gateway', event }), false);
  }
});

for (const early of [true, false]) test(`CLI final reply and saved original mirror job settle together (${early ? 'before' : 'after'} ACK)`, () => disk(store => {
  admit(store, 'cli', 'cli-command', 'cli');
  const saved = store.mirrorOutbox.get('cli-command')!;
  if (!early) assert.equal(store.openClawExecutions.acknowledgeCli('cli', 'cli-command'), true);
  assert.equal(executeConnectorNativeReply('openClawCliFinalReply', cli(), store), true);
  assert.equal(store.openClawExecutions.get('cli')!.phase, 'completed');
  assert.deepEqual(store.mirrorOutbox.get('cli-command')!.nativeReply,
    { source: 'cli', commandId: 'cli-command', text: cli().replyText });
  const after = store.mirrorOutbox.get('cli-command')!;
  assert.equal(after.actorId, saved.actorId); assert.deepEqual(after.explicitRoute, saved.explicitRoute);
  assert.equal(after.inputText, saved.inputText);
  assert.equal(executeConnectorNativeReply('openClawCliFinalReply', { ...cli(), replyText: 'forged later reply' }, store), false);
  assert.deepEqual(store.mirrorOutbox.get('cli-command'), after, 'duplicate cannot rewrite terminal evidence');
  if (early) assert.equal(store.openClawExecutions.acknowledgeCli('cli', 'cli-command'), true);
  assert.equal(store.openClawExecutions.get('cli')!.phase, 'completed', 'late ACK cannot regress final phase');
}));

test('CLI missing structured reply blocks only original mirror evidence without transcript guessing', () => disk(store => {
  admit(store, 'cli', 'cli-command', 'cli');
  assert.equal(executeConnectorNativeReply('openClawCliFinalReply', { ...cli(), replyText: null }, store), true);
  assert.equal(store.openClawExecutions.get('cli')!.phase, 'completed');
  const job = store.mirrorOutbox.get('cli-command')!;
  assert.equal(job.nativeReply, undefined); assert.equal(job.deliveryState, 'blocked');
  assert.match(job.lastError!, /no structured reply evidence/);
}));

test('web-only, failed and mismatched CLI results never create mirror admission or dispatch', () => disk(store => {
  admit(store, 'cli', 'cli-command', 'cli', false);
  assert.equal(executeConnectorNativeReply('openClawCliFinalReply', { ...cli(), commandId: 'other' }, store), false);
  const before = store.openClawExecutions.get('cli');
  assert.throws(() => executeConnectorNativeReply('openClawCliFinalReply', cli(), store), /unavailable/);
  assert.deepEqual(store.openClawExecutions.get('cli'), before, 'missing saved admission rolls back completion');
  assert.equal(executeConnectorNativeReply('openClawCliFinalReply', { ...cli(), deliveryMode: 'web-only', replyText: null }, store), true);
  assert.equal(store.mirrorOutbox.get('cli-command'), undefined);
  admit(store, 'failed', 'failed-command', 'cli', false);
  assert.equal(executeConnectorNativeReply('openClawCliFinalReply', { ...cli('failed', 'failed-command'), phase: 'failed', replyText: null }, store), true);
  assert.equal(store.openClawExecutions.get('failed')!.phase, 'failed');
  admit(store, 'saved', 'saved-command', 'cli');
  const saved = store.openClawExecutions.get('saved');
  assert.throws(() => executeConnectorNativeReply('openClawCliFinalReply',
    { ...cli('saved', 'saved-command'), deliveryMode: 'web-only', replyText: null }, store), /unavailable/);
  assert.deepEqual(store.openClawExecutions.get('saved'), saved);
}));

for (const early of [true, false]) test(`Gateway final reply retains original connection and run fences (${early ? 'before' : 'after'} ACK)`, () => disk(store => {
  admit(store, 'gateway', 'gateway-command', 'gateway');
  if (!early) assert.equal(store.openClawExecutions.acknowledge('gateway', 'gateway-command', 'gateway-command-run'), true);
  assert.equal(executeConnectorNativeReply('openClawGatewayFinalReply', gateway(), store), true);
  if (early) {
    assert.equal(store.openClawExecutions.get('gateway')!.phase, 'starting');
    assert.equal(store.openClawExecutions.acknowledge('gateway', 'gateway-command', 'gateway-command-run'), true);
  }
  assert.equal(store.openClawExecutions.get('gateway')!.phase, 'completed');
  const saved = store.mirrorOutbox.get('gateway-command');
  assert.deepEqual(saved!.nativeReply, { source: 'gateway', commandId: 'gateway-command', text: gateway().event.reply.text,
    runId: 'gateway-command-run', connectionId: 'original-connection', sequence: 1 });
  assert.equal(executeConnectorNativeReply('openClawGatewayFinalReply',
    { ...gateway(), event: { ...gateway().event, gatewayConnectionId: 'reconnected' } }, store), false);
  assert.deepEqual(store.mirrorOutbox.get('gateway-command'), saved);
}));

test('Gateway reply-only evidence never completes a running native run', () => disk(store => {
  admit(store, 'gateway', 'gateway-command', 'gateway');
  store.openClawExecutions.acknowledge('gateway', 'gateway-command', 'gateway-command-run');
  store.openClawExecutions.observe('gateway', { runId: 'gateway-command-run', phase: 'running', gatewayConnectionId: 'original-connection' });
  assert.equal(executeConnectorNativeReply('openClawGatewayFinalReply', { ...gateway(), event: { ...gateway().event, replyOnly: true } }, store), true);
  assert.equal(store.openClawExecutions.get('gateway')!.phase, 'running');
  assert.equal(store.mirrorOutbox.get('gateway-command')!.gatewayRun!.state, 'pending');
  assert.equal(executeConnectorNativeReply('openClawGatewayFinalReply', gateway(), store), true);
  assert.equal(store.openClawExecutions.get('gateway')!.phase, 'completed');
}));

for (const origin of ['cli', 'gateway'] as const) test(`${origin} final journal, mirror job and event sink roll back together`, () => disk(store => {
  const sessionKey = origin, commandId = origin + '-command';
  admit(store, sessionKey, commandId, origin);
  if (origin === 'gateway') store.openClawExecutions.acknowledge(sessionKey, commandId, commandId + '-run');
  const fact = store.openClawExecutions.get(sessionKey), job = store.mirrorOutbox.get(commandId), cursor = store.events.latestEventId();
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.exec("CREATE TEMP TRIGGER fail_final_reply BEFORE UPDATE ON connector_mirror_outbox BEGIN SELECT RAISE(ABORT, 'injected final reply failure'); END");
  const invoke = () => origin === 'cli' ? executeConnectorNativeReply('openClawCliFinalReply', cli(), store)
    : executeConnectorNativeReply('openClawGatewayFinalReply', gateway(), store);
  assert.throws(invoke, /injected final reply failure/);
  assert.deepEqual(store.openClawExecutions.get(sessionKey), fact); assert.deepEqual(store.mirrorOutbox.get(commandId), job);
  assert.equal(store.events.latestEventId(), cursor); assert.equal(db.isTransaction, false);
  db.exec('DROP TRIGGER fail_final_reply'); assert.equal(invoke(), true);
}));

test('restarted original CLI and Gateway cannot be completed by matching stale final identities', () => disk(store => {
  admit(store, 'cli', 'cli-command', 'cli'); admit(store, 'gateway', 'gateway-command', 'gateway');
  store.openClawExecutions.recoverInterrupted();
  const cliBefore = store.openClawExecutions.get('cli'), gatewayBefore = store.openClawExecutions.get('gateway');
  assert.equal(executeConnectorNativeReply('openClawCliFinalReply', cli(), store), false);
  assert.equal(executeConnectorNativeReply('openClawGatewayFinalReply', gateway(), store), false);
  assert.deepEqual(store.openClawExecutions.get('cli'), cliBefore); assert.deepEqual(store.openClawExecutions.get('gateway'), gatewayBefore);
  assert.equal(store.mirrorOutbox.get('cli-command')!.nativeReply, undefined);
}));

test('real sole owner persists final native replies across actual shutdown and database reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-final-owner-')), file = join(root, 'db.sqlite');
  const seed = new ConnectorUserStore(file);
  const keys = { cli: openClawFixtureKey('cli'), gateway: openClawFixtureKey('gateway') };
  const config = await seedOpenClawOwnerTurns(seed, root, [
    { key: keys.cli, id: 'cli-command', mirror: true }, { key: keys.gateway, id: 'gateway-command', mirror: true },
  ]);
  seed.close();
  const owner = new AsyncConnectorOwner({ file, ...config }, silent), port = new AsyncConnectorExecutionSettlements(owner);
  let originalActor: string | undefined;
  try {
    await owner.open();
    const cliClaim = await claimOpenClawOwnerTurn(owner, keys.cli, 'original-connection', true);
    const gatewayClaim = await claimOpenClawOwnerTurn(owner, keys.gateway, 'original-connection');
    originalActor = cliClaim.turn.payload.actorId;
    assert.ok(originalActor);
    assert.equal(gatewayClaim.turn.payload.actorId, originalActor);
    assert.deepEqual(gatewayClaim.turn.payload.explicitRoute, cliClaim.turn.payload.explicitRoute);
    assert.equal(await port.openclaw.acknowledge({ sessionKey: keys.gateway, commandId: 'gateway-command',
      transport: 'gateway', connectionId: 'original-connection', runId: 'gateway-command-run' }), true);
    assert.equal(await port.openclaw.finishCliReply(cli(keys.cli)), true);
    assert.equal(await port.openclaw.observeFinalReply(gateway(keys.gateway)), true);
    assert.equal((await port.openclaw.get(keys.cli))!.phase, 'completed');
    assert.equal((await port.openclaw.get(keys.gateway))!.phase, 'completed');
  } finally { await owner.closeForShutdown(); }
  const reopened = new ConnectorUserStore(file);
  try {
    assert.equal(reopened.mirrorOutbox.get('cli-command')!.nativeReply!.text, cli().replyText);
    assert.equal(reopened.mirrorOutbox.get('gateway-command')!.nativeReply!.text, gateway().event.reply.text);
    for (const [name, sessionKey] of Object.entries(keys)) {
      const job = reopened.mirrorOutbox.get(name + '-command')!;
      assert.equal(job.actorId, originalActor);
      assert.equal(job.sessionKey, sessionKey);
      assert.equal(job.inputText, 'original fixture input');
      assert.deepEqual(job.explicitRoute, { originatingChannel: 'test', originatingTo: 'original', outboundTarget: 'original' });
      assert.equal(job.attempts, 0, 'reply persistence cannot send outbound effects');
    }
    assert.equal(owner.snapshot().ownerExitConfirmed, true);
  } finally { reopened.close(); rmSync(root, { recursive: true, force: true }); }
});

class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = [];
  postMessage(value: { id: number; kind: string; body: string }) { this.messages.push(value); }
  terminate() { return Promise.resolve(1); }
  reply(index: number) { const request = this.messages[index]!; this.emit('message', { id: request.id, kind: request.kind, ok: true, body: 'true' }); }
}
test('aggregate large reply input is reserved before send, retained while pending and released only on original settlement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-final-budget-')), fake = new FakeWorker(), lines: string[] = [];
  let clock = 0;
  const diagnostics = new PerformanceDiagnostics(line => lines.push(line), () => clock += 1000);
  const owner = new AsyncConnectorOwner({ file: join(root, 'db.sqlite') }, diagnostics, () => fake as unknown as Worker, 1);
  const input = { ...cli(), replyText: '\0'.repeat(CONNECTOR_NATIVE_REPLY_TEXT_BYTES) };
  try {
    fake.emit('message', { kind: 'ready' }); await owner.open();
    const first = owner.command('openClawCliFinalReply', input); void first.catch(() => {});
    const second = owner.command('openClawCliFinalReply', input);
    assert.ok(2 * Buffer.byteLength(encodeConnectorOwnerJson(input, connectorOwnerCommandBytes('openClawCliFinalReply'))) > CONNECTOR_PENDING_INPUT_BYTES);
    await assert.rejects(second, /unavailable/); await tick(); assert.equal(fake.messages.length, 1);
    await new Promise(resolve => setTimeout(resolve, 5));
    await assert.rejects(owner.command('openClawCliFinalReply', input), /unavailable/);
    assert.equal(fake.messages.length, 1, 'warning does not release byte budget');
    fake.reply(0); assert.equal(await first, true);
    const next = owner.command('openClawCliFinalReply', input); await tick(); assert.equal(fake.messages.length, 2);
    fake.reply(1); assert.equal(await next, true);
    assert.ok(lines.some(line => line.includes('"sourceBytes":')));
    assert.ok(lines.every(line => !/original private|cli-command|original-actor/.test(line)));
  } finally {
    const close = owner.close(); await tick(); const request = fake.messages.at(-1)!;
    fake.emit('message', { id: request.id, kind: 'close', ok: true, body: 'null' }); fake.emit('exit', 0);
    await close; rmSync(root, { recursive: true, force: true });
  }
});

test('lost final reply ACK fences original owner without replay, replacement or premature file release', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-final-lost-')), fake = new FakeWorker();
  const owner = new AsyncConnectorOwner({ file: join(root, 'db.sqlite') }, silent, () => fake as unknown as Worker);
  try {
    fake.emit('message', { kind: 'ready' }); await owner.open();
    const work = owner.command('openClawCliFinalReply', cli()); void work.catch(() => {}); await tick();
    fake.emit('error', Error('private error after native reply committed'));
    await assert.rejects(work, /unavailable/);
    await assert.rejects(owner.command('openClawCliFinalReply', cli()), /unavailable/);
    assert.equal(fake.messages.length, 1); assert.equal(owner.snapshot().ownerExitConfirmed, false);
  } finally { fake.emit('exit', 1); rmSync(root, { recursive: true, force: true }); }
});
