import test from 'node:test';
import assert from 'node:assert/strict';
import { draftAdmission, placeSessionDraft, placeNotebookReading, sessionDraftTargetLabel, type RemoteDraft, type NotebookReadingTransfer } from './remote-draft.js';

test('notebook transfer never falls through to a session composer or a generic remote draft', () => {
  const selectors: string[] = [], events: string[] = [];
  let reply: NotebookReadingTransfer['result'] | undefined;
  const pane = { querySelector(selector: string) {
    selectors.push(selector);
    return reply ? { dispatchEvent(event: CustomEvent<NotebookReadingTransfer>) { events.push(event.type); event.detail.result = reply!; } } : null;
  } } as unknown as HTMLElement;
  assert.equal(placeNotebookReading(pane, 'source'), 'unavailable');
  for (const result of ['applied', 'busy', 'too-large', 'unavailable'] as const) {
    reply = result; assert.equal(placeNotebookReading(pane, 'source'), result);
  }
  assert.ok(selectors.every(value => value === '.session-notebook'));
  assert.ok(events.every(value => value === 'agentopsdeck:notebook-reading'));
});

test('draft target labels distinguish identical sessions without exposing native identifiers', () => {
  assert.equal(sessionDraftTargetLabel('Same', 'codex', 'desktop', 0), '#1 · Same · codex · desktop');
  assert.notEqual(sessionDraftTargetLabel('Same', 'codex', 'desktop', 0), sessionDraftTargetLabel('Same', 'codex', 'desktop', 1));
  assert.equal(sessionDraftTargetLabel('A\u202eB\nC', 'codex\u0000', undefined, 1), '#2 · A B C · codex');
  assert.ok(sessionDraftTargetLabel('X'.repeat(1000), 'Y'.repeat(1000), 'Z'.repeat(1000), 0).length < 380);
});

test('draft admission preserves occupied text/attachments and blocks disabled or oversized input', () => {
  const empty = { disabled: false, occupied: false, maxChars: 4 };
  assert.equal(draftAdmission('test', empty), 'applied');
  assert.equal(draftAdmission('😀😀', empty), 'applied');
  assert.equal(draftAdmission('😀😀x', empty), 'too-large');
  assert.equal(draftAdmission(' ', empty), 'unavailable');
  assert.equal(draftAdmission('test', { ...empty, occupied: true }), 'occupied');
  assert.equal(draftAdmission('test', { ...empty, disabled: true }), 'unavailable');
  assert.equal(draftAdmission('long text', { ...empty, occupied: true }), 'occupied');
});

test('session transfer is fail-closed and never selects a notebook or sends a message', () => {
  const selectors: string[] = [], events: string[] = [];
  let reply: Partial<RemoteDraft> | undefined;
  const pane = { querySelector(selector: string) {
    selectors.push(selector);
    return reply ? { dispatchEvent(event: CustomEvent<RemoteDraft>) { events.push(event.type); Object.assign(event.detail, reply); } } : null;
  } } as unknown as HTMLElement;
  assert.equal(placeSessionDraft(pane, 'source'), 'unavailable');
  for (const result of ['applied', 'occupied', 'unknown', 'unavailable'] as const) {
    reply = { result }; assert.equal(placeSessionDraft(pane, 'source'), result === 'unknown' ? 'unavailable' : result);
  }
  reply = { reason: 'too-large' }; assert.equal(placeSessionDraft(pane, 'source'), 'too-large');
  assert.ok(selectors.every(value => value === '.desktop-composer-textarea'));
  assert.ok(events.every(value => value === 'agentopsdeck:remote-draft'));
});
