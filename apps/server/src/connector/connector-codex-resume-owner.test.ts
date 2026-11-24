import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { NativeResumeInput, NativeResumeReceipt } from '../codex/native-resume.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { executeConnectorCodexResume, validConnectorCodexResumeInput, validConnectorCodexResumeOutput } from './connector-codex-resume-domain.js';

const key = 'codex:resume-original';
async function fixture(t: import('node:test').TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-resume-owner-'));
  const config = { file: join(directory, 'connector.sqlite'), tokenFile: join(directory, 'tokens.json'), bootstrapToken: 'synthetic-resume-token' };
  const tokens = new ConnectorTokenStore(config.tokenFile, config.bootstrapToken);
  const actor = tokens.authenticateAuthorization(`Bearer ${config.bootstrapToken}`)!.tokenId;
  const seed = new ConnectorUserStore(config.file, () => true, { runtimeOwner: true });
  seed.codexExecutions.begin(key, 'command', 'connection');
  seed.codexExecutions.acknowledge(key, 'command', 'connection', 'run', () => {});
  seed.codexExecutions.observe(key, 'connection', 'run', 'completed');
  seed.codexExecutions.settleHistory(seed.codexExecutions.get(key)!, 'error');
  await seed.turns.enqueueAsync('codex', { id: 'head', sessionKey: key, createdAt: 1,
    payload: { text: 'PRIVATE original input', images: [], actorId: actor } });
  const fact = seed.codexExecutions.get(key)!;
  assert.ok(fact.runId);
  const input: NativeResumeInput = { expected: { sessionKey: key, commandId: fact.commandId,
    connectionId: fact.connectionId, runId: fact.runId, revision: fact.revision }, nativeConnectionId: 'current-native',
    threadId: 'resume-original', fingerprint: 'a'.repeat(64), continuation: { headId: 'head', headVersion: seed.turns.version('codex', key, 'head')! } };
  seed.close();
  const logs: any[] = [], owner = new AsyncConnectorOwner(config, new PerformanceDiagnostics(line => logs.push(JSON.parse(line))));
  t.after(async () => { await owner.close(); rmSync(directory, { recursive: true, force: true }); });
  await owner.open();
  return { owner, input, actor, logs, config };
}

test('fixed resume commands reject caller authority, malformed receipts and coercible outcomes before owner access', () => {
  const input: NativeResumeInput = { expected: { sessionKey: key, commandId: 'c', connectionId: 'n', runId: 'r', revision: 1 },
    nativeConnectionId: 'native', threadId: 'thread', fingerprint: 'a'.repeat(64), continuation: null };
  const receipt: NativeResumeReceipt = { sessionKey: key, intentId: '00000000-0000-0000-0000-000000000001', nativeConnectionId: 'native' };
  const unavailable = new Proxy({}, { get() { throw Error('must not access original owner'); } }) as ConnectorUserStore;
  for (const [kind, value] of [['codexResumePrepare', input], ['codexResumeBegin', receipt],
    ['codexResumeFinish', { receipt, outcome: 'acknowledged' }]] as const) {
    assert.equal(validConnectorCodexResumeInput(kind, value), true);
    for (const field of ['actorId', 'authorized', 'grant', 'sql', 'callback', 'release', 'replay']) {
      const forged = { ...value, [field]: true };
      assert.equal(validConnectorCodexResumeInput(kind, forged), false);
      assert.throws(() => executeConnectorCodexResume(kind, forged as any, unavailable), /unavailable/);
    }
  }
  assert.equal(validConnectorCodexResumeInput('codexResumeFinish', { receipt,
    outcome: { toString() { assert.fail('protocol must not coerce untrusted input'); } } }), false);
  assert.equal(validConnectorCodexResumeOutput('codexResumePrepare', { ...receipt, payload: 'private' }), false);
  assert.equal(validConnectorCodexResumeOutput('codexResumeBegin', receipt), false);
});

for (const mutation of ['none', 'revoke', 'pause', 'revision'] as const)
test(`same file worker rechecks original continuation at begin: ${mutation}`, async t => {
  const f = await fixture(t);
  const receipt = await f.owner.command('codexResumePrepare', f.input); assert.ok(receipt);
  const observation = await f.owner.command('codexSchedulingObservation', { sessionKey: key });
  assert.equal(observation.outcomeUnknown, true); assert.equal(observation.head?.authorized, false);
  assert.equal((await f.owner.command('codexHistoryObservation', { sessionKey: key })).outcomeUnknown, true);
  if (mutation === 'revoke') await f.owner.command('tokenRevoke', { tokenId: f.actor });
  if (mutation === 'pause') await f.owner.command('maintenancePause', {});
  if (mutation === 'revision') await f.owner.command('codexExecutionTool', { sessionKey: key, connectionId: 'connection',
    runId: 'run', itemId: 'racing-tool', completed: false });
  assert.equal(await f.owner.command('codexResumeBegin', receipt), mutation === 'none');
  assert.equal(await f.owner.command('codexResumeFinish', { receipt, outcome: mutation === 'none' ? 'acknowledged' : 'not_dispatched' }), true);
  assert.equal((await f.owner.command('codexHistoryObservation', { sessionKey: key })).outcomeUnknown, false);
  assert.ok(f.logs.some(row => row.step === 252)); assert.ok(f.logs.some(row => row.step === 253));
  assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE|synthetic-resume-token|resume-original|current-native/);
});

test('unauthorized queued successor does not suppress predecessor read-only recovery, but cannot authorize continuation', async t => {
  const f = await fixture(t);
  await f.owner.command('tokenRevoke', { tokenId: f.actor });
  assert.equal(await f.owner.command('codexResumePrepare', f.input), null);
  const receipt = await f.owner.command('codexResumePrepare', { ...f.input, continuation: null }); assert.ok(receipt);
  assert.equal(await f.owner.command('codexResumeBegin', receipt), true);
  assert.equal(await f.owner.command('codexResumeFinish', { receipt, outcome: 'acknowledged' }), true);
});

test('unknown physical resume survives worker reopen, stays visible and is never treated as an execution lease', async t => {
  const f = await fixture(t), receipt = await f.owner.command('codexResumePrepare', f.input); assert.ok(receipt);
  assert.equal(await f.owner.command('codexResumeBegin', receipt), true);
  await f.owner.close();
  const reopened = new AsyncConnectorOwner(f.config); await reopened.open();
  try {
    const observation = await reopened.command('codexHistoryObservation', { sessionKey: key });
    assert.equal(observation.outcomeUnknown, true); assert.equal(observation.execution?.runId, 'run');
    assert.equal(await reopened.command('codexResumePrepare', f.input), null);
    assert.equal(await reopened.command('codexResumeBegin', receipt), false);
    assert.equal(await reopened.command('codexResumeFinish', { receipt: { ...receipt, nativeConnectionId: 'replacement' }, outcome: 'acknowledged' }), false);
  } finally { await reopened.close(); }
});
