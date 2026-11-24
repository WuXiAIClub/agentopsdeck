import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INTERACTION_MAX_TTL_MS, readInteractionAnswer, readInteractionCapabilities, readInteractionRequest,
  type InteractionKind, type InteractionRequest,
} from '@agentopsdeck/shared';
import { answerInteraction, closeInteraction, createInteraction, InteractionConflict } from './agent-interaction.js';

const scope = { ownerId: 'owner', nodeId: 'node', sessionKey: 'codex:session', runId: 'run-1' };
const capabilities = { version: 1, kinds: ['approval', 'text', 'single-select', 'multi-select'], modes: ['automatic', 'interactive'] };
const request = (kind: InteractionKind = 'approval'): InteractionRequest => ({
  ...scope, version: 1, requestId: 'request-1', kind, prompt: 'Review the proposed action', createdAt: 100, expiresAt: 200,
  ...(['single-select', 'multi-select'].includes(kind) ? { options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } : {}),
});
const input = () => ({ scope, requestId: 'request-1', responseId: 'response-1', answer: { kind: 'approval', decision: 'allow-once' }, permissionAllowed: true, now: 150 });
const pending = () => createInteraction(request(), capabilities, scope, 100);
const rejects = (fn: () => unknown, code: InteractionConflict['code']) => assert.throws(fn, (e: unknown) => e instanceof InteractionConflict && e.code === code);

test('legacy, unknown version, and malformed capability claims fail closed', () => {
  for (const value of [undefined, null, {}, { ...capabilities, version: 2 }, { ...capabilities, modes: ['interactive'] },
    { ...capabilities, kinds: ['approval', 'approval'] }, { ...capabilities, kinds: ['execute'] },
    { ...capabilities, modes: ['automatic', 'automatic'] }, { ...capabilities, extra: true }]) {
    assert.deepEqual(readInteractionCapabilities(value), { version: 1, kinds: [], modes: ['automatic'] });
    rejects(() => createInteraction(request(), value, scope, 100), 'unsupported');
  }
});
test('capabilities are detached copies, not mutable configuration references', () => {
  const parsed = readInteractionCapabilities(capabilities);
  parsed.kinds.length = 0;
  assert.equal(capabilities.kinds.length, 4);
});
for (const kind of capabilities.kinds as InteractionKind[]) {
  test(`${kind} request roundtrips without retaining caller references`, () => {
    const source = request(kind);
    assert.deepEqual(readInteractionRequest(source), source);
    const state = createInteraction(source, capabilities, scope, 100);
    source.prompt = 'changed';
    if (source.options) source.options[0]!.label = 'changed';
    assert.equal(state.request.prompt, 'Review the proposed action');
    if (state.request.options) assert.equal(state.request.options[0]!.label, 'A');
  });
}
test('request parser rejects ambiguous, oversized and unbounded inputs', () => {
  for (const patch of [{ version: 2 }, { ownerId: '' }, { runId: 'run\n2' }, { sessionKey: 'x'.repeat(257) },
    { requestId: '' }, { kind: 'shell' }, { prompt: 'x'.repeat(8001) }, { prompt: ' ' },
    { expiresAt: Infinity }, { expiresAt: 100 }, { expiresAt: 101.1 }, { createdAt: -1 },
    { expiresAt: 101 + INTERACTION_MAX_TTL_MS }, { options: [] }, { extra: true }]) {
    assert.equal(readInteractionRequest({ ...request(), ...patch }), undefined);
  }
  assert.ok(readInteractionRequest({ ...request(), expiresAt: 100 + INTERACTION_MAX_TTL_MS }));
});
test('choice definitions are bounded, unique and explicit', () => {
  for (const options of [undefined, [], [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }],
    [{ id: 'a', label: '' }], [{ id: 'a', label: 'A', command: 'hidden' }],
    Array.from({ length: 33 }, (_, i) => ({ id: String(i), label: 'A' }))]) {
    assert.equal(readInteractionRequest({ ...request('single-select'), options }), undefined);
  }
});
test('creation requires current authenticated scope, live TTL, valid clock and explicit interactive support', () => {
  rejects(() => createInteraction(request(), capabilities, { ...scope, ownerId: 'other' }, 100), 'scope');
  for (const now of [99, 200, NaN, Infinity, -1, 100.1]) rejects(() => createInteraction(request(), capabilities, scope, now), 'invalid');
  rejects(() => createInteraction(request(), { ...capabilities, modes: ['automatic'] }, scope, 100), 'unsupported');
  rejects(() => createInteraction(request(), { ...capabilities, kinds: ['text'] }, scope, 100), 'unsupported');
});
test('approval only supports allow-once/deny, never persistent grants or extra payload', () => {
  for (const decision of ['allow-once', 'deny']) assert.deepEqual(readInteractionAnswer(request(), { kind: 'approval', decision }), { kind: 'approval', decision });
  for (const value of [{ kind: 'approval', decision: 'allow-always' }, { kind: 'approval', decision: 'deny', shell: 'x' }, { kind: 'text', text: 'allow' }]) {
    assert.equal(readInteractionAnswer(request(), value), undefined);
  }
});
test('text answer bounds preserve user content and reject empty answers', () => {
  for (const text of ['', '  ', 'x'.repeat(8001)]) assert.equal(readInteractionAnswer(request('text'), { kind: 'text', text }), undefined);
  assert.deepEqual(readInteractionAnswer(request('text'), { kind: 'text', text: ' a\nb ' }), { kind: 'text', text: ' a\nb ' });
});
test('choice answers cannot inject unknown IDs, duplicates or multiple single-select answers', () => {
  for (const optionIds of [[], ['unknown'], ['a', 'a'], ['a', 'b']]) {
    assert.equal(readInteractionAnswer(request('single-select'), { kind: 'single-select', optionIds }), undefined);
  }
  assert.deepEqual(readInteractionAnswer(request('multi-select'), { kind: 'multi-select', optionIds: ['b', 'a'] }), { kind: 'multi-select', optionIds: ['a', 'b'] });
});
test('answers require full owner/node/session/run/request identity and current permission', () => {
  for (const key of Object.keys(scope)) rejects(() => answerInteraction(pending(), { ...input(), scope: { ...scope, [key]: 'other' } }), 'scope');
  rejects(() => answerInteraction(pending(), { ...input(), requestId: 'other' }), 'scope');
  rejects(() => answerInteraction(pending(), { ...input(), permissionAllowed: false }), 'permission');
});
test('same answer retry is a no-op; a second client or different answer cannot win', () => {
  const original = pending();
  const accepted = answerInteraction(original, input());
  assert.equal(original.status, 'pending');
  assert.equal(accepted.state.status, 'answered');
  assert.equal(accepted.changed, true);
  assert.deepEqual(answerInteraction(accepted.state, input()), { state: accepted.state, changed: false });
  rejects(() => answerInteraction(accepted.state, { ...input(), responseId: 'response-2' }), 'answered');
  rejects(() => answerInteraction(accepted.state, { ...input(), answer: { kind: 'approval', decision: 'deny' } }), 'answered');
  rejects(() => answerInteraction(accepted.state, { ...input(), permissionAllowed: false }), 'permission');
  rejects(() => answerInteraction(accepted.state, { ...input(), scope: { ...scope, runId: 'run-2' } }), 'scope');
});
test('reordered multiselect retry has the same canonical identity', () => {
  const state = createInteraction(request('multi-select'), capabilities, scope, 100);
  const accepted = answerInteraction(state, { ...input(), answer: { kind: 'multi-select', optionIds: ['b', 'a'] } });
  assert.equal(answerInteraction(accepted.state, { ...input(), answer: { kind: 'multi-select', optionIds: ['a', 'b'] } }).changed, false);
});
test('expiry boundary produces a closed record, never an answer', () => {
  const expired = answerInteraction(pending(), { ...input(), now: 200 });
  assert.equal(expired.state.status, 'closed');
  if (expired.state.status === 'closed') assert.equal(expired.state.reason, 'expired');
  rejects(() => answerInteraction(expired.state, input()), 'closed');
  rejects(() => closeInteraction(pending(), 'expired', 199), 'invalid');
});
for (const reason of ['stopped', 'disconnected', 'revoked', 'restarted'] as const) {
  test(`${reason} never resumes or replays a pending native request`, () => {
    const closed = closeInteraction(pending(), reason, 150);
    assert.equal(closed.status, 'closed');
    assert.equal(closeInteraction(closed, reason, 151), closed);
    rejects(() => answerInteraction(closed, input()), 'closed');
  });
}
test('invalid response identity/clock cannot consume a pending request', () => {
  for (const patch of [{ responseId: '' }, { responseId: '\n' }, { responseId: 'x'.repeat(257) }, { now: 99 }, { now: NaN }]) {
    rejects(() => answerInteraction(pending(), { ...input(), ...patch }), 'invalid');
  }
});
test('closing an accepted answer preserves its receipt, without claiming native execution', () => {
  const { state } = answerInteraction(pending(), input());
  assert.equal(closeInteraction(state, 'restarted', 160), state);
  assert.equal(answerInteraction(state, { ...input(), now: 300 }).changed, false);
});
