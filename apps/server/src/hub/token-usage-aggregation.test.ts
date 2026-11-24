import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { NativeTokenUsageStore } from '../connector/native-token-usage.js';
import { aggregateTokenSnapshots, type UsageMember } from './token-usage-aggregation.js';
function fixture() {
  const db = new DatabaseSync(':memory:'), ledger = new NativeTokenUsageStore(db, () => 1000);
  ledger.record('codex', 'codex:a', 'one', { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 });
  ledger.record('codex', 'codex:b', 'two', { inputTokens: 20, outputTokens: 4 });
  const members: UsageMember[] = ['a', 'b'].map((target, index) => ({ target, authorityEpoch: 1, groups: index ? ['two'] : ['one', 'two'],
    snapshot: ledger.snapshot('codex', `codex:${target}`, `10000000-0000-4000-8000-00000000000${index}`, 0, 60000, 60000) }));
  return { db, input: { owner: 'alice', directoryRevision: 'revision1', complete: true, members } };
}
test('overlapping groups use independent event unions, and null cache is not zero', () => {
  const f = fixture(); try {
    const value = aggregateTokenSnapshots(f.input, () => 1);
    assert.equal(value.total.events, 2); assert.equal(value.total.metrics.inputTokens.knownSubtotal, 30);
    assert.equal(value.groups[0]!.metrics.inputTokens.knownSubtotal, 10); assert.equal(value.groups[1]!.metrics.inputTokens.knownSubtotal, 30);
    assert.equal(value.total.metrics.cacheReadTokens.knownSubtotal, 0);
    assert.equal(value.total.metrics.cacheReadTokens.knownSampleCount, 1); assert.equal(value.total.metrics.cacheReadTokens.unknownSampleCount, 1);
    assert.equal(value.creditEstimate.status, 'unavailable');
  } finally { f.db.close(); }
});
test('frozen manifests are canonical and remain unchanged when external tags mutate', () => {
  const f = fixture(); try {
    const one = aggregateTokenSnapshots(f.input, () => 1);
    f.input.members.reverse(); assert.deepEqual(aggregateTokenSnapshots(f.input, () => 1), one);
    f.input.members[0]!.groups.push('new'); assert.equal(one.manifest.some(m => m.groups.includes('new')), false);
    assert.notEqual(aggregateTokenSnapshots(f.input, () => 1).manifestDigest, one.manifestDigest);
  } finally { f.db.close(); }
});
test('revocation rejects an entire result both before and after aggregation', () => {
  const f = fixture(); try {
    assert.throws(() => aggregateTokenSnapshots(f.input, (_, target) => target === 'a' ? 2 : 1), /authority/);
    let reads = 0; assert.throws(() => aggregateTokenSnapshots(f.input, () => ++reads > 2 ? undefined : 1), /authority/);
  } finally { f.db.close(); }
});
test('incomplete membership cannot masquerade as empty; duplicates and range mismatch reject', () => {
  const f = fixture(); try {
    assert.throws(() => aggregateTokenSnapshots({ ...f.input, complete: false, members: [] }, () => 1), /selection/);
    assert.equal(aggregateTokenSnapshots({ ...f.input, members: [] }, () => 1).memberCount, 0);
    assert.throws(() => aggregateTokenSnapshots({ ...f.input, members: [f.input.members[0]!, f.input.members[0]!] }, () => 1), /member/);
    f.input.members[1]!.snapshot.memberDigest = '0'.repeat(64);
    assert.throws(() => aggregateTokenSnapshots(f.input, () => 1), /digest/);
  } finally { f.db.close(); }
});
