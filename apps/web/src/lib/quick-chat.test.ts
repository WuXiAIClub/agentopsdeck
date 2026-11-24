import assert from 'node:assert/strict';
import test from 'node:test';
import { quickConfig, quickHistory, quickModels, quickResult, type QuickTurn } from './quick-chat.js';
const id = '12345678-1234-1234-1234-123456789abc';
const profile = { id, revision: 1, name: 'Heavy', target: 'hub-standalone', model: 'fixture', outputLimit: 2000 };
const receipt = { requestId: id, profile, state: 'completed', createdAt: 1, resultExpiresAt: 2 };
test('temporary conversation includes completed pairs only, in order, without cleared or unknown output', () => {
  const turns: QuickTurn[] = [
    { requestId: id, question: 'First', result: { receipt: { ...receipt, state: 'completed' }, output: 'Answer' } },
    { requestId: id, question: 'Unknown', result: { receipt: { ...receipt, state: 'unknown' }, output: null } },
    { requestId: id, question: 'Cleared', result: { receipt: { ...receipt, state: 'completed' }, output: null } },
    { requestId: id, question: '', result: { receipt: { ...receipt, state: 'completed' }, output: 'Recovered without question' } },
    { requestId: id, question: 'Follow up', result: { receipt: { ...receipt, state: 'completed' }, output: 'Second answer' } },
  ];
  assert.deepEqual(quickHistory(turns, 'Next'), [{ role: 'user', content: 'First' }, { role: 'assistant', content: 'Answer' },
    { role: 'user', content: 'Follow up' }, { role: 'assistant', content: 'Second answer' }]);
});
test('temporary conversation retains the newest complete pairs within count and text bounds', () => {
  const turns: QuickTurn[] = Array.from({ length: 20 }, (_, i) => ({ requestId: id, question: `Q${i}`,
    result: { receipt: { ...receipt, state: 'completed' }, output: 'a' } }));
  const history = quickHistory(turns, 'next');
  assert.equal(history.length, 32); assert.equal(history[0]?.content, 'Q4'); assert.equal(history.at(-2)?.content, 'Q19');
  const large: QuickTurn = { requestId: id, question: 'q'.repeat(8000), result: { receipt: { ...receipt, state: 'completed' }, output: 'a'.repeat(32000) } };
  assert.equal(quickHistory([large, large], 'n'.repeat(8000)).length, 2);
  assert.equal(quickHistory([large], 'n'.repeat(8000)).reduce((n, m) => n + m.content.length, 8000), 48000);
  assert.deepEqual(quickHistory([], 'first'), []);
});
test('quick config validates bounds and only local receipt recovery', () => {
  const config = { target: { id: 'hub-standalone', label: 'Fixture', provider: 'https://fixture.invalid', model: 'fixture', maxOutput: 2000, recovery: 'local-receipt-only' }, profiles: [profile], receipts: [receipt] };
  assert.ok(quickConfig(config));
  for (const change of [{ profiles: Array(33).fill(profile) }, { profiles: [{ ...profile, outputLimit: 2001 }] }, { target: { ...config.target, recovery: 'provider-replay' } }]) assert.equal(quickConfig({ ...config, ...change }), false);
});
test('model catalogs are bounded, unique and contain the advertised default; legacy configurations remain usable', () => {
  const target = { id: 'hub-standalone', label: 'Fixture', provider: 'https://fixture.invalid', model: 'sol', maxOutput: 2000, recovery: 'local-receipt-only' as const };
  const valid = { target: { ...target, catalogState: 'ready', models: [{ id: 'sol', label: 'Sol' }, { id: 'luna', label: 'Luna' }] }, profiles: [], receipts: [] };
  assert.ok(quickConfig(valid)); assert.deepEqual(quickModels(valid.target), valid.target.models);
  assert.ok(quickConfig({ ...valid, target })); assert.deepEqual(quickModels(target), [{ id: 'sol', label: 'sol' }]);
  assert.deepEqual(quickModels(null), []);
  for (const models of [[], [{ id: 'luna', label: 'Luna' }], [{ id: 'sol', label: 'Sol' }, { id: 'sol', label: 'duplicate' }],
    [{ id: ' sol', label: 'Sol' }], Array(513).fill({ id: 'sol', label: 'Sol' }), [{ id: 'sol', label: '' }]]) {
    assert.equal(quickConfig({ ...valid, target: { ...valid.target, models } }), false);
  }
  assert.equal(quickConfig({ ...valid, target: { ...valid.target, catalogState: 'arbitrary' } }), false);
});
test('quick results require the exact original ID and completed state', () => {
  assert.ok(quickResult({ receipt, output: '<script>plain text</script>' }, id));
  assert.equal(quickResult({ receipt, output: 'answer' }, 'other'), false);
  assert.equal(quickResult({ receipt: { ...receipt, state: 'unknown' }, output: 'answer' }, id), false);
  assert.ok(quickResult({ receipt: { ...receipt, state: 'unknown' }, output: null }, id));
  assert.equal(quickResult({ receipt, output: 'x'.repeat(32001) }, id), false);
});
