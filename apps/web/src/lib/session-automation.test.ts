import assert from 'node:assert/strict';
import test from 'node:test';
import { automationDraft, pauseAutomation, scopedAutomationReceipt, validAutomationView } from './session-automation.js';
const view = { ownerId: 'owner', connectionId: 'node', sessionId: 'codex:one', rules: [] };
const draft = { template: 'Synthetic', enabled: false, kind: 'once' as const, minutes: 5, hours: 1, maxSends: 1, maxPerHour: 1 };
test('bounded draft defaults off, pins target, and never enables own-turn loops', () => {
  const result = automationDraft(view, draft, 'rule', 1000)!;
  assert.equal(result.kind, 'save'); if (result.kind !== 'save') return;
  assert.equal(result.rule.enabled, false); assert.equal(result.confirmEnable, false);
  assert.equal(result.rule.target.sessionId, 'codex:one'); assert.equal(result.rule.expiresAt, 3601000);
  const completion = automationDraft(view, { ...draft, enabled: true, kind: 'completion' }, 'new', 1000)!;
  if (completion.kind !== 'save') assert.fail();
  assert.deepEqual(completion.rule.mode, { kind: 'completion', allowOwnTurns: false });
  assert.equal(completion.confirmEnable, true);
});
for (const bad of [{ minutes: 0 }, { hours: 0 }, { hours: 169 }, { maxSends: 0 }, { maxPerHour: 61 }, { template: '' }, { minutes: NaN }, { template: 'a\0b' }]) {
  test(`reject unsafe draft ${JSON.stringify(bad)}`, () => assert.equal(automationDraft(view, { ...draft, ...bad }, 'rule', 1000), undefined));
}
test('receipt exact request and owner/node/runtime/session fences; pause advances both epochs', () => {
  const config = automationDraft(view, draft, 'rule', 1000)!; if (config.kind !== 'save') assert.fail();
  const stored = { rule: config.rule, template: config.template, templateHash: 'a'.repeat(64), revoked: false };
  const receipt = { requestId: 'request', fingerprint: 'b'.repeat(64), result: stored };
  assert.equal(scopedAutomationReceipt(receipt, 'request', view), true);
  assert.equal(scopedAutomationReceipt(receipt, 'different', view), false);
  for (const key of ['ownerId', 'connectionId', 'sessionId', 'runtime']) {
    const changed = structuredClone(receipt); Object.assign(changed.result.rule.target, { [key]: 'other' });
    assert.equal(scopedAutomationReceipt(changed, 'request', view), false);
  }
  assert.equal(validAutomationView({ ...view, rules: [stored] }), true);
  assert.equal(validAutomationView({ ...view, sessionId: 'codex:other', rules: [stored] }), false);
  const paused = pauseAutomation(stored); if (paused.kind !== 'save') assert.fail();
  assert.equal(paused.rule.enabled, false); assert.equal(paused.rule.revision, 2); assert.equal(paused.rule.authorityEpoch, 2);
});
