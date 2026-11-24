import test from 'node:test';
import assert from 'node:assert/strict';
import { linkageSamples } from './all-card-linkage-probe.mjs';
import { verifyAllCardEvidence } from './all-card-linkage-evidence.mjs';
const fixture = () => ({ passed: true, candidate: { manifestSha256: 'candidate' },
  scope: 'isolated-real-agent-13-kind-bidirectional-cards', cardLinkage: {
    passed: true, productionSessionsTouched: false, restarts: 1,
    commands: [1, 2].map(phase => ({ runtime: 'codex', phase, idempotencyKey: String(phase) })),
    cases: linkageSamples().flatMap(({ kind }) => [
      ...[1, 2].map(phase => ({ runtime: 'codex', kind, phase, agentToHub: true, schemaPreserved: true })),
      { runtime: 'codex', kind, hubToFile: true, receiptVerified: true },
    ]),
  } });
test('complete two-turn/restart 13-kind evidence is accepted', () => {
  verifyAllCardEvidence(fixture(), ['codex'], 'candidate');
});

test('business-content evidence rejects title-only or incomplete fresh-human-content proof', () => {
  const options = { businessContent: true };
  assert.throws(() => verifyAllCardEvidence(fixture(), ['codex'], 'candidate', options));
  const result = fixture(); result.cardLinkage.coverage = 'business-content';
  for (const row of result.cardLinkage.cases) {
    row.businessContentVerified = true;
    if (row.phase === 2) row.freshHumanContentPreserved = true;
  }
  verifyAllCardEvidence(result, ['codex'], 'candidate', options);
  for (const change of [r => { r.cardLinkage.coverage = 'title-only'; },
    r => { delete r.cardLinkage.cases[0].businessContentVerified; },
    r => { delete r.cardLinkage.cases.find(c => c.phase === 2).freshHumanContentPreserved; },
    r => { delete r.cardLinkage.cases.find(c => c.hubToFile).businessContentVerified; }]) {
    const bad = structuredClone(result); change(bad);
    assert.throws(() => verifyAllCardEvidence(bad, ['codex'], 'candidate', options));
  }
});
test('partial, duplicated, wrong candidate or production evidence fails closed', () => {
  for (const mutate of [r => { r.passed = false; }, r => { r.candidate.manifestSha256 = 'other'; },
    r => { r.cardLinkage.restarts = 0; }, r => { r.cardLinkage.productionSessionsTouched = true; },
    r => { r.cardLinkage.cases.pop(); }, r => { r.cardLinkage.cases[0] = r.cardLinkage.cases[1]; },
    r => { r.cardLinkage.commands[1].idempotencyKey = '1'; },
    r => { r.cardLinkage.cases.at(-1).receiptVerified = false; }]) {
    const result = fixture(); mutate(result);
    assert.throws(() => verifyAllCardEvidence(result, ['codex'], 'candidate'));
  }
});
