import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { InteractionAnswer } from '@agentopsdeck/shared';
import { InteractionStore } from './interaction-store.js';
import { InteractionRuntime } from './interaction-runtime.js';
import { InteractionWorker } from './interaction-worker.js';
import { WorkerInteractionPort } from './interaction-port.js';
import { interactionCapabilitiesFor } from '../connector/sdk-interaction.js';
import { claudeToolPolicy } from '../claude/tool-policy.js';
import { claudeInteractionPolicy } from '../claude/interaction-policy.js';
import { copilotToolPolicy } from '../copilot/tool-policy.js';
import { copilotInteractionPolicy } from '../copilot/interaction-policy.js';
import type { ClaudeConfig } from '../claude/config.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(t: test.TestContext, agent: 'claude-code' | 'ghcp') {
  const db = new DatabaseSync(':memory:'), runtime = new InteractionRuntime(new InteractionStore(db), () => true);
  const scope = { ownerId: 'owner', nodeId: 'node', sessionKey: `${agent}:native`, runId: 'run' };
  let active = true, acknowledgements = 0;
  const worker = new InteractionWorker('run', 'epoch', async frame => {
    if (frame.kind === 'interaction-ack') acknowledgements++;
    port.receive(frame);
  });
  const port = new WorkerInteractionPort({ executionId: 'run', epoch: 'epoch' }, {
    runtime, scope, capabilities: interactionCapabilitiesFor(agent), permitted: async () => active,
    continuation: async () => ({ connectionId: 'epoch', goal: { status: 'absent', version: '1' } }),
  }, frame => { void worker.receive(frame); }, () => active);
  t.after(() => { worker.close(); port.exited(); runtime.close(); db.close(); });
  const pending = async () => {
    for (let i = 0; i < 20; i++) {
      const view = runtime.list(scope).find(v => v.status === 'pending');
      if (view) return view;
      await tick();
    }
    throw new Error('Native adapter did not publish its question');
  };
  const answer = async (value: InteractionAnswer) => {
    const view = await pending();
    return runtime.answer({ scope, requestId: view.request.requestId, responseId: `answer-${view.request.requestId}`,
      expectedRevision: view.revision, answer: value, authorize: () => active });
  };
  return { worker, runtime, scope, pending, answer, alive: () => active,
    stop: () => { active = false; worker.close(); port.exited(); }, acknowledgements: () => acknowledgements };
}

test('Claude native multi-question callback passes durable human choices and freeform back to SDK', async t => {
  const f = fixture(t, 'claude-code');
  const policy = claudeInteractionPolicy(claudeToolPolicy({ workspace: '/unused', toolPolicy: 'none' } as ClaudeConfig), f.worker, f.alive);
  const input = { questions: [
    { question: 'Select features', multiSelect: true, options: [{ label: 'One' }, { label: 'Two' }] },
    { question: 'Explain', options: [{ label: 'Default' }] },
  ] };
  const result = policy.canUseTool('AskUserQuestion', input);
  assert.equal((await f.pending()).request.kind, 'multi-select');
  assert.equal((await f.answer({ kind: 'multi-select', optionIds: ['0', '1'] })).delivery, 'confirmed');
  assert.equal((await f.answer({ kind: 'single-select', optionIds: [], text: 'Custom explanation' })).delivery, 'confirmed');
  assert.deepEqual(await result, { behavior: 'allow', updatedInput: { ...input,
    answers: { 'Select features': 'One, Two', Explain: 'Custom explanation' } } });
  assert.equal(f.acknowledgements(), 2);
  assert.equal('answers' in input, false, 'SDK input is not mutated');
});

for (const agent of ['claude-code', 'ghcp'] as const) {
  for (const decision of ['allow-once', 'deny'] as const) test(`${agent}: native tool approval ${decision} traverses worker/port/store once`, async t => {
    const f = fixture(t, agent);
    const result = agent === 'claude-code'
      ? claudeInteractionPolicy(claudeToolPolicy({ workspace: '/unused', toolPolicy: 'trusted-exec' } as ClaudeConfig, f.alive), f.worker, f.alive)
        .canUseTool('Bash', { command: 'printf fixture' })
      : copilotInteractionPolicy(copilotToolPolicy({ workspace: '/unused', toolPolicy: 'trusted-exec' }, f.alive), f.worker, 'native', f.alive)
        .onPermissionRequest({ kind: 'shell', fullCommandText: 'printf fixture' }, { sessionId: 'native' });
    assert.equal((await f.answer({ kind: 'approval', decision })).delivery, 'confirmed');
    const native = await result;
    assert.equal('behavior' in native ? native.behavior : native.kind,
      agent === 'claude-code' ? decision === 'allow-once' ? 'allow' : 'deny' : decision === 'allow-once' ? 'approve-once' : 'reject');
    assert.equal(f.acknowledgements(), 1);
  });

  test(`${agent}: static denial and stopped execution never become human permission escalation`, async t => {
    const f = fixture(t, agent);
    if (agent === 'claude-code') {
      const policy = claudeInteractionPolicy(claudeToolPolicy({ workspace: '/unused', toolPolicy: 'none' } as ClaudeConfig), f.worker, f.alive);
      assert.equal((await policy.canUseTool('Bash', { command: 'printf fixture' })).behavior, 'deny');
    } else {
      const policy = copilotInteractionPolicy(copilotToolPolicy({ workspace: '/unused', toolPolicy: 'trusted-exec' }), f.worker, 'native', f.alive);
      assert.equal((await policy.onPermissionRequest({ kind: 'shell', fullCommandText: 'printf fixture' }, { sessionId: 'other' })).kind, 'reject');
      assert.equal((await policy.onPermissionRequest({ kind: 'shell', fullCommandText: 'printf fixture' }, { sessionId: 'native', managedSettingsEnabled: true })).kind, 'reject');
    }
    assert.equal(f.runtime.list(f.scope).length, 0);
    const policy = copilotInteractionPolicy(copilotToolPolicy({ workspace: '/unused' }), f.worker, 'native', f.alive);
    const result = policy.onUserInputRequest({ question: 'Continue?' }, { sessionId: 'native' });
    const rejected = assert.rejects(result);
    await f.pending(); f.stop(); await rejected;
    assert.equal(f.acknowledgements(), 0);
    assert.equal(f.runtime.list(f.scope)[0]?.status, 'closed');
  });
}

test('Copilot native choices/freeform responses and ask_user pre-hook preserve exact session', async t => {
  const f = fixture(t, 'ghcp');
  const base = copilotToolPolicy({ workspace: '/unused' }, f.alive, undefined, [], 'native');
  const policy = copilotInteractionPolicy(base, f.worker, 'native', f.alive);
  const input = { question: 'Pick', choices: ['One', 'Two'], allowFreeform: true };
  assert.equal((await base.onPreToolUse({ sessionId: 'native', toolName: 'ask_user', toolArgs: input }, { sessionId: 'native' })).permissionDecision, 'allow');
  assert.equal((await base.onPreToolUse({ sessionId: 'other', toolName: 'ask_user', toolArgs: input }, { sessionId: 'native' })).permissionDecision, 'deny');
  for (const freeform of [false, true]) {
    const result = policy.onUserInputRequest(input, { sessionId: 'native' });
    await f.answer({ kind: 'single-select', optionIds: freeform ? [] : ['1'], ...(freeform ? { text: 'Custom' } : {}) });
    assert.deepEqual(await result, { answer: freeform ? 'Custom' : 'Two', wasFreeform: freeform });
  }
});

test('advertised question kinds match each native adapter', () => {
  assert.equal(interactionCapabilitiesFor('claude-code').kinds.includes('multi-select'), true);
  for (const agent of ['codex', 'ghcp']) assert.equal(interactionCapabilitiesFor(agent).kinds.includes('multi-select'), false);
});
