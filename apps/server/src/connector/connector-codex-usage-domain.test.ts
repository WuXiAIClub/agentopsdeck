import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { ConnectorUserStore } from './connector-user-store.js';
import { executeConnectorCodexUsage, validConnectorCodexUsageInput, type CodexCumulativeUsageInput } from './connector-codex-usage-domain.js';

const key = 'codex:usage', connectionId = 'connection', runId = 'run';
const input = (owner: ConnectorUserStore): CodexCumulativeUsageInput => ({ sessionKey: key, connectionId, runId,
  expected: owner.codexExecutions.get(key) ?? null, counts: { inputTokens: 100, outputTokens: 10 } });
const execute = (owner: ConnectorUserStore, value = input(owner)) => executeConnectorCodexUsage('codexCumulativeUsage', value, owner);

test('usage DTO rejects payload, authority, noncanonical counters and incomplete execution before SQL', () => {
  const value: CodexCumulativeUsageInput = { sessionKey: key, connectionId, runId, expected: null, counts: { inputTokens: 1, outputTokens: 0 } };
  const forbidden = new Proxy({}, { get() { assert.fail('invalid DTO touched owner'); } }) as ConnectorUserStore;
  assert.equal(validConnectorCodexUsageInput('codexCumulativeUsage', value), true);
  for (const forged of [
    { ...value, authorized: true }, { ...value, sql: 'select 1' }, { ...value, sessionKey: 'codex:' },
    { ...value, runId: 'bad\n' }, { ...value, expected: {} }, { ...value, counts: null },
    { ...value, counts: { ...value.counts, payload: 'secret' } }, { ...value, counts: { inputTokens: -1, outputTokens: 0 } },
    { ...value, counts: { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 0 } },
    { ...value, counts: { ...value.counts, cacheReadTokens: undefined } },
    { ...value, counts: Object.assign([], value.counts) },
  ]) {
    assert.equal(validConnectorCodexUsageInput('codexCumulativeUsage', forged), false);
    assert.throws(() => execute(forbidden, forged as any), /unavailable/);
  }
});

test('usage CAS checks full original fact, run, connection and legal stage without changing journal', () => {
  const owner = new ConnectorUserStore(':memory:');
  try {
    owner.codexExecutions.begin(key, 'command', connectionId);
    assert.equal(execute(owner), false, 'pre-ACK cannot establish baseline');
    owner.codexExecutions.acknowledge(key, 'command', connectionId, runId, () => {});
    const first = input(owner), before = structuredClone(first.expected);
    assert.equal(execute(owner, first), true);
    assert.deepEqual(owner.codexExecutions.get(key), before, 'usage never transitions execution');
    for (const mutation of [ { runId: 'old-run' }, { connectionId: 'old-connection' },
      { expected: { ...first.expected!, updatedAt: first.expected!.updatedAt + 1 } }, { expected: null } ]) {
      assert.equal(execute(owner, { ...first, ...mutation }), false);
    }
    owner.codexExecutions.observeCommandTool(key, connectionId, runId, 'tool', false);
    assert.equal(execute(owner, first), false, 'same run but changed full fact loses CAS');
    owner.codexExecutions.observeCommandTool(key, connectionId, runId, 'tool', true);
    owner.codexExecutions.observe(key, connectionId, runId, 'completed');
    assert.equal(execute(owner), false, 'unverified terminal cannot record');
    owner.codexExecutions.settleHistory(owner.codexExecutions.get(key)!, 'current');
    assert.equal(execute(owner), true, 'original synchronized terminal remains eligible');
    owner.codexExecutions.recoverInterrupted();
  } finally { owner.close(); }
});

test('missing execution observation is conditional, unknown and deletion are not recording authority', () => {
  const owner = new ConnectorUserStore(':memory:');
  try {
    const external = input(owner);
    assert.equal(execute(owner, external), true);
    owner.codexExecutions.begin(key, 'command', connectionId);
    assert.equal(execute(owner, external), false);
    owner.codexExecutions.uncertain(key, 'command');
    assert.equal(execute(owner), false);
    owner.commands.sessionDeletion = () => 'accepted';
    assert.equal(execute(owner, { ...external, sessionKey: 'codex:deleted' }), false);
  } finally { owner.close(); }
});

test('original cumulative transaction rolls back delta and baseline together on write failure', () => {
  const owner = new ConnectorUserStore(':memory:');
  try {
    execute(owner);
    const db: DatabaseSync = (owner as any).db;
    db.exec("CREATE TRIGGER reject_usage BEFORE INSERT ON native_token_samples BEGIN SELECT RAISE(ABORT, 'usage failed'); END");
    const next = { ...input(owner), counts: { inputTokens: 150, outputTokens: 20 } };
    assert.throws(() => execute(owner, next), /usage failed/);
    db.exec('DROP TRIGGER reject_usage');
    assert.equal(execute(owner, next), true);
    const rows = db.prepare('SELECT input_tokens, output_tokens FROM native_token_samples').all();
    assert.deepEqual(rows.map(r => [r.input_tokens, r.output_tokens]), [[50, 10]]);
  } finally { owner.close(); }
});
