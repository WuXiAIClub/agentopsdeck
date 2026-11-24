import assert from 'node:assert/strict';
import test from 'node:test';
import { InteractionWorker } from './interaction-worker.js';
import { readInteractionFrame } from './interaction-wire.js';
import { codexQuestions, copilotQuestion, claudeQuestions } from './native-questions.js';

function fixture(t: test.TestContext) {
  const frames: unknown[] = [], worker = new InteractionWorker('run', 'epoch', async frame => { frames.push(frame); });
  t.after(() => worker.close());
  const answer = (value: unknown) => ({ ...frames.find(f => (f as { kind: string }).kind === 'interaction-request') as object,
    kind: 'interaction-answer', answer: value });
  const reply = (value: unknown) => { const frame = answer(value) as Record<string, unknown>; delete frame.question; return frame; };
  return { frames, worker, reply };
}
test('worker validates identity, typed answer and one-shot delivery', async t => {
  const f = fixture(t), asked = f.worker.ask({ kind: 'text', prompt: 'Question' });
  assert.equal(await f.worker.receive({ ...f.reply({ kind: 'text', text: 'reply' }), epoch: 'foreign' }), false);
  assert.equal(await f.worker.receive(f.reply({ kind: 'approval', decision: 'allow-once' })), false);
  assert.equal(await f.worker.receive(f.reply({ kind: 'text', text: 'reply' })), true);
  assert.deepEqual(await asked, { kind: 'text', text: 'reply' });
  await f.worker.receive(f.reply({ kind: 'text', text: 'changed' }));
  assert.equal(f.frames.length, 2);
});
test('worker close during async policy cannot ACK or resolve native answer', async t => {
  const f = fixture(t); let release!: (v: boolean) => void;
  const asked = f.worker.ask({ kind: 'approval', prompt: 'Tool' }, undefined, () => new Promise(r => { release = r; }));
  const rejected = assert.rejects(asked);
  const answering = f.worker.receive(f.reply({ kind: 'approval', decision: 'allow-once' }));
  f.worker.close(); release(true); await answering; await rejected;
  assert.equal(f.frames.length, 1);
});
test('native AbortSignal cancels parent request; invalid frame cannot cancel another request', async t => {
  const f = fixture(t), controller = new AbortController();
  const asked = f.worker.ask({ kind: 'text', prompt: 'Question' }, controller.signal), rejected = assert.rejects(asked);
  assert.equal(await f.worker.receive({ kind: 'interaction-cancel', executionId: 'run', epoch: 'epoch', requestId: 'wrong', injected: true }), false);
  controller.abort(); await rejected;
  assert.equal((f.frames[1] as { kind: string }).kind, 'interaction-cancelled');
});
test('worker request and answer frames reject extra fields and overlong identity', () => {
  for (const value of [null, {}, { kind: 'interaction-ack', executionId: 'a'.repeat(257), epoch: 'e', requestId: 'r' },
    { kind: 'interaction-ack', executionId: 'r', epoch: 'e', requestId: 'r', nativeKey: 'secret' }]) assert.equal(readInteractionFrame(value, 'worker'), undefined);
});
test('native adapters preserve choices/freeform/multiselect without inventing option identities', () => {
  const copilot = copilotQuestion({ question: 'Pick', choices: ['A', 'B'] });
  assert.deepEqual(copilot.decode({ kind: 'single-select', optionIds: ['1'] }), ['B']);
  assert.deepEqual(copilot.decode({ kind: 'single-select', optionIds: [], text: 'Other' }), ['Other']);
  assert.throws(() => copilotQuestion({ question: 'Pick', choices: ['A'], allowFreeform: false }).decode({ kind: 'single-select', optionIds: [], text: 'Other' }));
  const claude = claudeQuestions({ questions: [{ question: 'Pick', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }] });
  assert.deepEqual(claude[0]!.decode({ kind: 'multi-select', optionIds: ['1', '0'] }), ['A', 'B']);
  const codex = codexQuestions({ questions: [{ id: 'q1', question: 'Pick', options: [{ label: 'A' }] }] });
  assert.equal(codex[0]!.id, 'q1'); assert.equal(codex[0]!.question.allowFreeform, false);
  assert.throws(() => codexQuestions({ questions: [{ id: 'q', question: 'Secret', isSecret: true }] }));
  assert.throws(() => claudeQuestions({ questions: [{ question: 'Pick', options: [] }, { question: 'Pick', options: [] }] }));
  assert.throws(() => copilotQuestion({ question: 'Pick', choices: ['same', 'same'] }));
});
