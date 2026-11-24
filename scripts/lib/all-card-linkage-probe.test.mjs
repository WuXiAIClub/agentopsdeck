import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkageSamples, cardLinkagePrompt, verifyCompletedCardFiles } from './all-card-linkage-probe.mjs';

test('prompt pairs each exact file identity with its kind and preserves native reads', () => {
  const entries = linkageSamples().map((sample, index) => ({ ...sample, file: `/fixture/${13 - index}/card.json` }));
  for (const phase of [1, 2]) {
    const prompt = cardLinkagePrompt(entries, phase);
    assert.ok(prompt.includes('ONE file at a time'));
    assert.ok(prompt.includes('tool_use_id'));
    assert.ok(prompt.includes(`ALL_CARDS_${phase}_OK`));
    for (const entry of entries) assert.ok(prompt.includes(JSON.stringify({ path: entry.file, kind: entry.kind })));
    assert.equal(prompt.includes('starts with UI2|'), phase === 2);
  }
});

test('all 13 completed files must preserve exact schema and unrelated fields', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-card-integrity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = linkageSamples().map(before => ({ kind: before.kind, before, file: join(root, `${before.kind}.json`) }));
  const value = entry => ({ version: 1, ...entry.before, content: { ...entry.before.content, title: `AGENT1|${entry.before.content.title}` } });
  for (const entry of entries) await writeFile(entry.file, JSON.stringify(value(entry)));
  await verifyCompletedCardFiles(entries, 'AGENT1|');
  await writeFile(entries[0].file, JSON.stringify(value(entries[8])));
  await assert.rejects(verifyCompletedCardFiles(entries, 'AGENT1|'), /wrong file kind/);
  for (const change of [v => { v.content.title = 'Wrong'; }, v => { v.content.tasks.push({ injected: true }); },
    v => { v.extra = true; }, v => { v.version = 2; }]) {
    const changed = structuredClone(value(entries[0])); change(changed);
    await writeFile(entries[0].file, JSON.stringify(changed));
    await assert.rejects(verifyCompletedCardFiles(entries, 'AGENT1|'));
  }
});
