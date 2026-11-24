import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionSummary } from '@agentopsdeck/shared';
import { sessionRuntimeDraft, applySessionEdit, reconcileRuntimeDraft } from './session-runtime-overrides.js';

const baseSession: SessionSummary = {
  sessionKey: 'local:agent%3Aops-pm%3Adashboard%3As1',
  agentId: 'ops-pm',
  title: 'Runtime',
  status: 'idle',
};

test('session runtime draft reflects per-session thinkingLevel from refreshed selected session', () => {
  assert.deepEqual(sessionRuntimeDraft({ ...baseSession, model: 'gpt-5.5', modelProvider: 'github-copilot', thinkingLevel: 'high' }), {
    model: 'github-copilot/gpt-5.5',
    thinking: 'high',
  });
});

test('session runtime draft falls back to defaults after reset removes thinkingLevel', () => {
  assert.deepEqual(sessionRuntimeDraft(baseSession), {
    model: '',
    thinking: '',
  });
});

test('Codex model IDs are not prefixed with the separately configured provider', () => {
  for (const model of ['gpt-6-astra', 'vendor/custom-model']) {
    assert.equal(sessionRuntimeDraft({ ...baseSession, source: 'codex', modelProvider: 'litellm', model }).model, model);
  }
});

test('runtime polling preserves edited fields and advances untouched fields', () => {
  assert.deepEqual(reconcileRuntimeDraft({ model: 'typing', thinking: 'high' }, { model: 'old', thinking: 'high' }, { model: 'new', thinking: 'low' }), { model: 'typing', thinking: 'low' });
  assert.deepEqual(reconcileRuntimeDraft({ model: 'old', thinking: 'high' }, { model: 'old', thinking: 'high' }, { model: 'new', thinking: 'low' }), { model: 'new', thinking: 'low' });
});

test('late settings ACK cannot overwrite current title, model, runtime, messages or cache identity', () => {
  const session = { ...baseSession, status: 'running' as const, hasActiveRun: true, recent: 'new reply', model: 'new', thinkingLevel: 'high' };
  assert.equal(applySessionEdit(session, { sessionKey: session.sessionKey, settings: { title: 'Old title', model: 'old' } }), session);
});

test('historical reset ACK cannot clear newer settings or legacy thinking aliases', () => {
  const session = { ...baseSession, thinkingLevel: 'high', thinking: 'old', modelProvider: 'provider' };
  assert.equal(applySessionEdit(session, { sessionKey: session.sessionKey, settings: { thinkingLevel: null, modelProvider: null } }), session);
  assert.equal(applySessionEdit(session, { sessionKey: 'other', settings: { title: 'wrong' } }), session);
});

test('legacy pin edit retains its isolated local behavior', () => {
  assert.deepEqual(applySessionEdit(baseSession, { sessionKey: baseSession.sessionKey, pinned: true }), { ...baseSession, pinned: true });
  assert.equal(applySessionEdit(baseSession, { sessionKey: 'other', pinned: false }), baseSession);
});
