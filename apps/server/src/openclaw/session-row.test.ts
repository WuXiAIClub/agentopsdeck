import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOpenClawSessionRow } from './session-row.js';

test('systemSent alone does not mark a historical OpenClaw session running', () => {
  const row = normalizeOpenClawSessionRow({
    key: 'agent:ops-pm:dashboard:old',
    systemSent: true,
    updatedAt: 1_800_000_000_000,
  });
  assert.equal(row?.status, 'idle');
});

test('explicit OpenClaw runtime status is preserved', () => {
  assert.equal(normalizeOpenClawSessionRow({ key: 'agent:ops-pm:dashboard:live', status: 'running', systemSent: true })?.status, 'running');
  assert.equal(normalizeOpenClawSessionRow({ key: 'agent:ops-pm:dashboard:failed', abortedLastRun: true })?.status, 'failed');
});

test('unlabeled OpenClaw session rows do not synthesize raw session key labels', () => {
  const key = 'agent:ops-pm:dashboard:01901ed1-b997-470b-a76f-87ba65700deb';
  const row = normalizeOpenClawSessionRow({ key, derivedTitle: 'Readable from OpenClaw' });
  assert.equal(row?.label, undefined);
  assert.equal(row?.subject, undefined);
  assert.equal(row?.derivedTitle, 'Readable from OpenClaw');
});
