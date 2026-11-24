import assert from 'node:assert/strict';
import test from 'node:test';
import { readAutomationRule, nextAutomationTimer, evaluateAutomation, type AutomationRule, type AutomationLedger, type AutomationObservation, type CompletionTrigger } from './automation-policy.js';
const start = 1_000_000;
const rule: AutomationRule = { id: 'rule', revision: 1, authorityEpoch: 1,
  target: { ownerId: 'owner', connectionId: 'connector', runtime: 'codex', sessionId: 'session' }, enabled: true,
  startsAt: start, expiresAt: start + 86_400_000, maxSends: 3, maxPerHour: 3, minIntervalMs: 60_000, mode: { kind: 'interval', intervalMs: 60_000 } };
const view: AutomationObservation = { now: start + 60_000, connectedSince: start - 1, target: rule.target,
  revision: 1, authorityEpoch: 1, online: true, idle: true, queueEmpty: true, admissionAllowed: true };
const ledger = (): AutomationLedger => ({ occupied: 0, reservedAt: [], consumedTriggers: new Set() });
const tick = { kind: 'timer', at: view.now, slot: 1 } as const;
const completed: CompletionTrigger = { kind: 'completion', turnId: 'turn', startedAt: start + 1, completedAt: view.now,
  outcome: 'completed', operation: 'message', authoritative: true, historical: false, origin: 'manual' };
const completionRule: AutomationRule = { ...rule, mode: { kind: 'completion', allowOwnTurns: false } };

test('config defaults disabled, clones identity and rejects unbounded/unknown options', () => {
  const { enabled: _, ...draft } = rule;
  assert.equal(readAutomationRule(draft)?.enabled, false);
  const copy = readAutomationRule(rule)!; copy.target.ownerId = 'other'; assert.equal(rule.target.ownerId, 'owner');
  for (const patch of [{ maxSends: 0 }, { maxSends: Infinity }, { maxSends: 1001 }, { maxPerHour: 61 },
    { minIntervalMs: 0 }, { expiresAt: start }, { revision: 0 }, { authorityEpoch: 0 }, { enabled: 'true' },
    { costCap: 10 }, { mode: { kind: 'daily', at: '12:00' } }, { mode: { kind: 'interval', intervalMs: 1 } },
    { mode: { kind: 'completion' } }, { target: { ...rule.target, tag: 'work' } }]) assert.equal(readAutomationRule({ ...rule, ...patch }), undefined);
});
test('interval restart skips thousands of missed slots and never emits a backlog', () => {
  assert.deepEqual(nextAutomationTimer(rule, start - 1), { kind: 'timer', at: start, slot: 0 });
  assert.deepEqual(nextAutomationTimer(rule, start), tick);
  assert.deepEqual(nextAutomationTimer(rule, start + 1000 * 60_000 + 1), { kind: 'timer', at: start + 1001 * 60_000, slot: 1001 });
  assert.equal(nextAutomationTimer(rule, rule.expiresAt), undefined);
  assert.equal(nextAutomationTimer({ ...rule, enabled: false }, start), undefined);
});
test('one-off UTC schedule is strictly future and does not pretend to implement daily DST', () => {
  const once: AutomationRule = { ...rule, mode: { kind: 'once', at: view.now } };
  assert.deepEqual(nextAutomationTimer(once, start), { kind: 'timer', at: view.now, slot: 0 });
  assert.equal(nextAutomationTimer(once, view.now), undefined);
  assert.equal(evaluateAutomation(once, { ...tick, slot: 0 }, ledger(), view).eligible, true);
  assert.deepEqual(evaluateAutomation(once, tick, ledger(), view), { eligible: false, reason: 'trigger' });
});
test('valid tick is deterministic and calculation does not consume or mutate a budget', () => {
  const state = ledger(), before = JSON.stringify(state);
  assert.equal(evaluateAutomation(rule, tick, state, view).eligible, true);
  assert.deepEqual(evaluateAutomation(rule, tick, state, view), evaluateAutomation(rule, tick, state, view));
  assert.equal(JSON.stringify(state), before);
});
test('pause, expiry, changed revision/epoch and exact target fail closed', () => {
  for (const [patch, reason] of [[{ enabled: false }, 'disabled'], [{ expiresAt: view.now }, 'expired']] as const)
    assert.deepEqual(evaluateAutomation({ ...rule, ...patch }, tick, ledger(), view), { eligible: false, reason });
  for (const patch of [{ revision: 2 }, { authorityEpoch: 2 }, { target: { ...rule.target, ownerId: 'other' } },
    { target: { ...rule.target, connectionId: 'other' } }, { target: { ...rule.target, sessionId: 'other' } }])
    assert.deepEqual(evaluateAutomation(rule, tick, ledger(), { ...view, ...patch }), { eligible: false, reason: 'authority' });
});
test('offline, maintenance/settings gate, busy and user queue block eligibility', () => {
  for (const [patch, reason] of [[{ online: false }, 'offline'], [{ admissionAllowed: false }, 'admission'],
    [{ idle: false }, 'busy'], [{ queueEmpty: false }, 'busy']] as const)
    assert.deepEqual(evaluateAutomation(rule, tick, ledger(), { ...view, ...patch }), { eligible: false, reason });
});
test('missed and forged slots, future trigger and backward clock are rejected', () => {
  assert.deepEqual(evaluateAutomation(rule, tick, ledger(), { ...view, connectedSince: view.now + 1, now: view.now + 2 }), { eligible: false, reason: 'missed' });
  assert.deepEqual(evaluateAutomation(rule, tick, ledger(), { ...view, now: view.now + 5001 }), { eligible: false, reason: 'missed' });
  for (const patch of [{ slot: 2 }, { at: view.now + 1 }, { slot: -1 }])
    assert.deepEqual(evaluateAutomation(rule, { ...tick, ...patch }, ledger(), view), { eligible: false, reason: 'trigger' });
  assert.deepEqual(evaluateAutomation(rule, tick, { ...ledger(), lastReservedAt: view.now + 1 }, view), { eligible: false, reason: 'clock' });
});
test('unknown and reserved requests count against total and rate limits', () => {
  assert.deepEqual(evaluateAutomation(rule, tick, { ...ledger(), occupied: 3 }, view), { eligible: false, reason: 'limit' });
  assert.deepEqual(evaluateAutomation(rule, tick, { ...ledger(), lastReservedAt: view.now - 59_999 }, view), { eligible: false, reason: 'rate' });
  assert.deepEqual(evaluateAutomation(rule, tick, { ...ledger(), reservedAt: [start, start + 1, start + 2] }, view), { eligible: false, reason: 'rate' });
  assert.equal(evaluateAutomation(rule, tick, { ...ledger(), lastReservedAt: view.now - 60_000 }, view).eligible, true);
});
test('consumed trigger remains deduplicated even when proven prewrite rejection released quota', () => {
  const decision = evaluateAutomation(rule, tick, ledger(), view); assert.ok(decision.eligible);
  assert.deepEqual(evaluateAutomation(rule, tick, { ...ledger(), consumedTriggers: new Set([decision.triggerKey]) }, view), { eligible: false, reason: 'duplicate' });
});
test('only authoritative new successful message turn can trigger completion', () => {
  assert.equal(evaluateAutomation(completionRule, completed, ledger(), view).eligible, true);
  for (const patch of [{ historical: true }, { authoritative: false }, { outcome: 'failed' }, { outcome: 'interrupted' },
    { operation: 'compact' }, { origin: 'unknown' }, { originRuleId: 'contradiction' }, { kind: 'idle' },
    { authoritative: 'true' }, { historical: undefined }, { startedAt: start - 1 }, { turnId: '' }, { completedAt: view.now + 1 }])
    assert.deepEqual(evaluateAutomation(completionRule, { ...completed, ...patch } as CompletionTrigger, ledger(), view), { eligible: false, reason: 'trigger' });
});
test('automated turns do not recurse by default or cross-trigger another rule', () => {
  const own: CompletionTrigger = { ...completed, origin: 'automation', originRuleId: rule.id };
  assert.equal(evaluateAutomation(completionRule, own, ledger(), view).eligible, false);
  const explicit: AutomationRule = { ...completionRule, mode: { kind: 'completion', allowOwnTurns: true } };
  assert.equal(evaluateAutomation(explicit, own, ledger(), view).eligible, true);
  assert.equal(evaluateAutomation(explicit, { ...own, originRuleId: 'other' }, ledger(), view).eligible, false);
  assert.equal(evaluateAutomation(explicit, own, { ...ledger(), occupied: 3 }, view).eligible, false);
});
test('completion before reconnect is missed, not recovered as an automatic message', () => {
  assert.deepEqual(evaluateAutomation(completionRule, completed, ledger(), { ...view, now: view.now + 2, connectedSince: view.now + 1 }), { eligible: false, reason: 'missed' });
});
