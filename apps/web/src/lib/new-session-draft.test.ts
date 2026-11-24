import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentCreationNotice,
  shouldRefreshAgentReadiness,
  closeNewSessionDraft,
  editNewSessionGroup,
  editNewSessionTitle,
  openNewSessionDraft,
  refreshNewSessionDefaults,
  resolveNewSessionSelection,
} from './new-session-draft.js';

const initialOptions = [{ id: 'default' }, { id: 'pigbro' }];

test('creation readiness is backward compatible but never treats a known unavailable runtime as ready', () => {
  assert.equal(agentCreationNotice(undefined), null);
  assert.equal(agentCreationNotice('ready'), null);
  for (const state of ['starting', 'maintenance', 'failed', 'disabled', 'closed', 'future-state', null, true]) {
    assert.ok(agentCreationNotice(state));
  }
  assert.equal(shouldRefreshAgentReadiness('starting'), true);
  assert.equal(shouldRefreshAgentReadiness('maintenance'), true);
  for (const state of ['ready', 'failed', 'disabled', 'closed', undefined]) assert.equal(shouldRefreshAgentReadiness(state), false);
});

test('readiness refresh retains selected runtime and the typed title', () => {
  const starting = [{ id: 'ghcp', readiness: 'starting' }];
  const draft = editNewSessionTitle(editNewSessionGroup(openNewSessionDraft('ghcp', starting), 'ghcp'), 'My draft');
  const ready = [{ id: 'ghcp', readiness: 'ready' }];
  const refreshed = refreshNewSessionDefaults(draft, 'ghcp', ready);
  assert.equal(refreshed, draft);
  assert.equal(resolveNewSessionSelection(refreshed, 'ghcp', ready).selectedOption?.readiness, 'ready');
  assert.equal(refreshed.title, 'My draft');
});
const refreshedOptions = [{ id: 'main' }, { id: 'pigbro' }, { id: 'cod' }];

test('unavailable initial local default selects the actual connection agent', () => {
  const options = [{ id: 'codex' }];
  const draft = openNewSessionDraft('main', options);
  assert.equal(draft.groupId, 'codex');
  assert.equal(resolveNewSessionSelection(draft, 'main', options).groupId, 'codex');
});

test('untouched loading default follows available agents without clearing typed title', () => {
  const draft = editNewSessionTitle(openNewSessionDraft('main', []), 'Keep typed title');
  const options = [{ id: 'codex' }];
  const selection = resolveNewSessionSelection(draft, 'main', options);
  assert.equal(selection.groupId, 'codex');
  assert.equal(selection.missingSelectedOption, false);
  const refreshed = refreshNewSessionDefaults(draft, 'main', options);
  assert.equal(refreshed.groupId, 'codex');
  assert.equal(refreshed.title, 'Keep typed title');
});

test('new session draft keeps typed title and selected group during refresh/default recomputation', () => {
  let draft = openNewSessionDraft('default', initialOptions);
  draft = editNewSessionTitle(draft, 'Slow typed custom name');
  draft = editNewSessionGroup(draft, 'pigbro');

  const refreshed = refreshNewSessionDefaults(draft, 'main', refreshedOptions);

  assert.equal(refreshed.title, 'Slow typed custom name');
  assert.equal(refreshed.groupId, 'pigbro');
  assert.equal(refreshed.titleDirty, true);
  assert.equal(refreshed.groupDirty, true);
});

test('new session draft reapplies latest defaults only after close and reopen', () => {
  let draft = openNewSessionDraft('default', initialOptions);
  draft = editNewSessionTitle(draft, 'Discard me on close');
  draft = editNewSessionGroup(draft, 'pigbro');
  draft = closeNewSessionDraft(draft);

  const reopened = openNewSessionDraft('main', refreshedOptions);

  assert.equal(reopened.title, '');
  assert.equal(reopened.groupId, 'main');
  assert.equal(reopened.titleDirty, false);
  assert.equal(reopened.groupDirty, false);
});

test('new session draft can fill a missing group without clearing title', () => {
  const draft = editNewSessionTitle({ ...openNewSessionDraft('', []), groupId: '' }, 'Name survives');

  const refreshed = refreshNewSessionDefaults(draft, 'cod', refreshedOptions);

  assert.equal(refreshed.title, 'Name survives');
  assert.equal(refreshed.groupId, 'cod');
});

test('new session selection keeps a dirty group renderable when refreshed options temporarily remove it', () => {
  let draft = openNewSessionDraft('default', initialOptions);
  draft = editNewSessionTitle(draft, 'Name survives option churn');
  draft = editNewSessionGroup(draft, 'pigbro');

  const refreshed = refreshNewSessionDefaults(draft, 'main', [{ id: 'main' }, { id: 'cod' }]);
  const selection = resolveNewSessionSelection(refreshed, 'main', [{ id: 'main' }, { id: 'cod' }]);

  assert.equal(refreshed.title, 'Name survives option churn');
  assert.equal(selection.groupId, 'pigbro');
  assert.equal(selection.selectedOption?.id, 'main');
  assert.equal(selection.missingSelectedOption, true);
});

test('new session selection recovers when the dirty group returns in refreshed options', () => {
  const draft = editNewSessionGroup(openNewSessionDraft('default', initialOptions), 'pigbro');

  const selection = resolveNewSessionSelection(draft, 'main', refreshedOptions);

  assert.equal(selection.groupId, 'pigbro');
  assert.equal(selection.selectedOption?.id, 'pigbro');
  assert.equal(selection.missingSelectedOption, false);
});
