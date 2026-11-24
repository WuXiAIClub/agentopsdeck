import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { businessSamples, businessEdit, humanBusinessEdit, businessPrompt } from './all-card-content-fixtures.mjs';
import { linkageSamples, verifyCompletedCardFiles } from './all-card-linkage-probe.mjs';

test('business fixtures cover all 13 kinds and change content without changing titles', () => {
  assert.deepEqual(businessSamples().map(s => s.kind).sort(), linkageSamples().map(s => s.kind).sort());
  for (const original of businessSamples()) {
    const phase1 = businessEdit(original, 'AGENT1', 1), human = humanBusinessEdit(phase1, 'opaque-user-value');
    const phase2 = businessEdit(human, 'AGENT2', 2);
    assert.notDeepEqual(original, phase1); assert.notDeepEqual(phase1, human); assert.notDeepEqual(human, phase2);
    assert.equal(original.content.title, phase2.content.title);
    assert.ok(JSON.stringify(phase2).includes('opaque-user-value'));
    assert.ok(JSON.stringify(phase2).includes('AGENT1'));
    assert.ok(JSON.stringify(phase2).includes('AGENT2'));
    assert.ok(!JSON.stringify(original).includes('AGENT1'), 'Pure fixture transformation');
  }
});

test('business prompts demand fresh reads but never reveal user state or expected documents', () => {
  const entries = businessSamples().map(before => ({ kind: before.kind, file: `/test/${before.kind}.json`, before: humanBusinessEdit(before, 'secret-sentinel') }));
  const prompt = businessPrompt(entries, 2);
  assert.ok(prompt.includes('freshly read')); assert.ok(prompt.includes('tool_use_id'));
  assert.ok(prompt.includes('nodes[1]')); assert.ok(prompt.includes('strokes[0]'));
  assert.ok(prompt.includes('ALL_CARDS_2_OK')); assert.ok(!prompt.includes('secret-sentinel'));
  for (const e of entries) assert.ok(prompt.includes(JSON.stringify({ path: e.file, kind: e.kind })));
});

for (const sample of businessSamples()) test(`${sample.kind}: actual content accepted; title-only/stale/deleted content rejected`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-business-integrity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = humanBusinessEdit(businessEdit(sample, 'AGENT1', 1), 'unpredictable-user-edit');
  const entry = { kind: sample.kind, before, file: join(root, 'card.json') };
  const expected = businessEdit(before, 'AGENT2', 2);
  await writeFile(entry.file, JSON.stringify({ version: 1, ...expected }));
  await verifyCompletedCardFiles([entry], '', 2);
  const wrong = [
    { ...before, content: { ...before.content, title: `AGENT2|${before.content.title}` } },
    businessEdit(sample, 'AGENT2', 2),
    { ...expected, content: { title: expected.content.title } },
    { ...expected, kind: 'wrong-kind' },
  ];
  for (const value of wrong) {
    await writeFile(entry.file, JSON.stringify({ version: 1, ...value }));
    await assert.rejects(verifyCompletedCardFiles([entry], '', 2));
  }
});
