import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { InteractionStore } from './interaction-store.js';
import { InteractionRuntime } from './interaction-runtime.js';
import { WorkerInteractionPort } from './interaction-port.js';
import { sdkInteractionCapabilities } from '../connector/sdk-interaction.js';
import type { InteractionParentFrame } from './interaction-wire.js';

const tick = () => new Promise<void>(r => setImmediate(r));
function fixture(t: test.TestContext) {
  const db = new DatabaseSync(':memory:'), store = new InteractionStore(db);
  const runtime = new InteractionRuntime(store, () => true, undefined, Date.now, 20);
  const scope = { ownerId: 'owner', nodeId: 'node', sessionKey: 'claude-code:thread', runId: 'run' };
  const identity = { executionId: 'run', epoch: 'epoch' }, frames: InteractionParentFrame[] = [];
  let permission = true;
  const port = new WorkerInteractionPort(identity, { runtime, scope, capabilities: sdkInteractionCapabilities,
    continuation: async () => ({ connectionId: 'epoch', goal: { status: 'absent', version: '1' } }),
    permitted: async () => permission }, frame => frames.push(frame), () => true);
  const request = (requestId = 'private') => port.receive({ ...identity, requestId, kind: 'interaction-request', question: { kind: 'text', prompt: 'Question' } });
  const answer = () => { const view = runtime.list(scope).find(v => v.status === 'pending')!;
    return runtime.answer({ scope, requestId: view.request.requestId, responseId: 'browser-answer', expectedRevision: view.revision,
      answer: { kind: 'text', text: 'Response' }, authorize: () => permission }); };
  t.after(() => { port.close(); runtime.close(); db.close(); });
  return { port, request, answer, runtime, scope, frames, identity, revoke: () => { permission = false; } };
}
test('private worker identity, duplicate request, exact ACK, and public receipt', async t => {
  const f = fixture(t);
  assert.equal(f.port.receive({ ...f.identity, epoch: 'other', requestId: 'private', kind: 'interaction-ack' }), false);
  f.request(); f.request(); await tick();
  assert.equal(f.runtime.list(f.scope).length, 1);
  assert.equal(f.port.receive({ ...f.identity, requestId: 'private', kind: 'interaction-ack' }), false);
  const result = f.answer(); await tick();
  assert.equal(f.frames[0]?.kind, 'interaction-answer');
  f.port.receive({ ...f.identity, requestId: 'private', kind: 'interaction-ack' });
  assert.equal((await result).delivery, 'confirmed');
  f.request(); await tick(); assert.equal(f.runtime.list(f.scope).length, 1);
});
test('worker exit during delivery preserves unknown and late ACK cannot change it', async t => {
  const f = fixture(t); f.request(); await tick(); const answer = f.answer(); await tick(); f.port.close();
  f.port.receive({ ...f.identity, requestId: 'private', kind: 'interaction-ack' });
  assert.equal((await answer).delivery, 'unknown');
});

test('only actual worker exit releases unknown gate; IPC close does not', async t => {
  const f = fixture(t); f.request(); await tick();
  assert.equal((await f.answer()).delivery, 'unknown');
  f.port.close(); assert.equal(f.runtime.store.hasUnresolvedSession(f.scope), true);
  f.port.exited(); assert.equal(f.runtime.store.hasUnresolvedSession(f.scope), false);
  assert.equal(f.runtime.list(f.scope)[0]?.delivery, 'unknown');
  assert.equal(f.frames.filter(v => v.kind === 'interaction-answer').length, 1);
});
test('close during asynchronous open leaves no orphaned prompt', async t => {
  const f = fixture(t); f.request(); f.port.close(); await tick();
  assert.equal(f.runtime.list(f.scope).filter(v => v.status === 'pending').length, 0);
});
test('revocation never sends an answer', async t => {
  const f = fixture(t); f.request(); await tick(); f.revoke(); await assert.rejects(f.answer());
  assert.equal(f.frames.filter(v => v.kind === 'interaction-answer').length, 0);
});
test('cancel one of two pending questions does not cancel its sibling', async t => {
  const f = fixture(t); f.request('first'); f.request('second'); await tick();
  f.port.receive({ ...f.identity, requestId: 'first', kind: 'interaction-cancelled' });
  assert.equal(f.runtime.list(f.scope).filter(v => v.status === 'pending').length, 1);
});
