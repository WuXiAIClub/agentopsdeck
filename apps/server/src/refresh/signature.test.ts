import assert from 'node:assert/strict';
import test from 'node:test';
import { stableGatewayRowsRevision } from './signature.js';

test('stable gateway row revision is unchanged for identical structural rows without exposing message text', () => {
  const rows = [{ id: 'm1', role: 'assistant', text: 'secret user content', createdAt: 1, updatedAt: 2 }];
  const revision = stableGatewayRowsRevision(rows);

  assert.equal(revision, stableGatewayRowsRevision([{ id: 'm1', role: 'assistant', text: 'secret user content', createdAt: 1, updatedAt: 2 }]));
  assert.equal(revision.includes('secret'), false);
  assert.equal(revision.includes('user content'), false);
});

test('stable gateway row revision changes when non-content freshness metadata, payload, or failure reason changes', () => {
  const base = stableGatewayRowsRevision([{ id: 'm1', role: 'assistant', text: 'same size', createdAt: 1, updatedAt: 2 }]);

  assert.notEqual(base, stableGatewayRowsRevision([{ id: 'm1', role: 'assistant', text: 'same size', createdAt: 1, updatedAt: 3 }]));
  assert.notEqual(base, stableGatewayRowsRevision([{ id: 'm1', role: 'assistant', text: 'larger text payload', createdAt: 1, updatedAt: 2 }]));
  assert.notEqual(base, stableGatewayRowsRevision([{ id: 'm1', role: 'assistant', text: 'SAME SIZE', createdAt: 1, updatedAt: 2 }]));
  assert.notEqual(base, stableGatewayRowsRevision([{ id: 'm1', role: 'assistant', text: 'same size', createdAt: 1, updatedAt: 2, failureReason: 'provider 400' }]));
});

test('stable gateway row revision changes for session list status and nested group updates', () => {
  const base = stableGatewayRowsRevision([{ agentId: 'main', sessions: [{ sessionKey: 's1', status: 'idle', lastActiveAt: 1 }] }]);

  assert.notEqual(base, stableGatewayRowsRevision([{ agentId: 'main', sessions: [{ sessionKey: 's1', status: 'running', lastActiveAt: 1 }] }]));
  assert.notEqual(base, stableGatewayRowsRevision([{ agentId: 'main', sessions: [{ sessionKey: 's1', status: 'idle', lastActiveAt: 2 }] }]));
});

test('same queued text with a different observed queue version invalidates the snapshot', () => {
  const message = { id: 'queued', text: 'same', updatedAt: 1, status: 'queued', queueVersion: '1:1' };
  assert.notEqual(stableGatewayRowsRevision([message]), stableGatewayRowsRevision([{ ...message, queueVersion: '1:2' }]));
});

test('runtime-only execution protection changes invalidate nested session snapshots', () => {
  const runtime = { phase: 'completed', sync: 'syncing', connection: 'connected',
    executionProtection: { state: 'blocked', reason: 'unconfirmed' } };
  const revision = (value: typeof runtime) => stableGatewayRowsRevision([{ agentId: 'codex',
    sessions: [{ sessionKey: 'codex:session', status: 'idle', lastActiveAt: 1, runtime: value }] }]);
  const base = revision(runtime);
  assert.notEqual(base, revision({ ...runtime, sync: 'current' }));
  assert.notEqual(base, revision({ ...runtime, executionProtection: { state: 'verified', reason: 'settled' } }));
  assert.equal(base, revision({ ...runtime, executionProtection: { ...runtime.executionProtection } }));
});

test('tool summary metadata invalidates the bounded snapshot without full output', () => {
  const message = { id: 'tool', role: 'tool', text: 'summary', toolDetailAvailable: false, toolLineCount: 1 };
  assert.notEqual(stableGatewayRowsRevision([message]), stableGatewayRowsRevision([{ ...message, toolDetailAvailable: true }]));
  assert.notEqual(stableGatewayRowsRevision([message]), stableGatewayRowsRevision([{ ...message, toolLineCount: 2 }]));
});

test('runtime hashing preserves legacy message revisions and absent runtime semantics', () => {
  const row = { id: 'm1', role: 'assistant', text: 'unchanged', createdAt: 1 };
  assert.equal(stableGatewayRowsRevision([row]), 'r:4bv6gp90wdxu', 'captured before the runtime fix');
  assert.equal(stableGatewayRowsRevision([{ ...row, runtime: undefined }]), stableGatewayRowsRevision([row]));
});

test('runtime key ordering does not cause spurious invalidations or expose protection reasons', () => {
  const revision = (runtime: unknown) => stableGatewayRowsRevision([{ sessionKey: 'codex:a', runtime }]);
  const protection = { state: 'blocked', reason: 'private protection reason', nativeTurnId: 'turn-1' };
  const base = revision({ phase: 'completed', sync: 'syncing', executionProtection: protection });
  assert.equal(base, revision({ executionProtection: { nativeTurnId: 'turn-1', reason: protection.reason, state: 'blocked' }, sync: 'syncing', phase: 'completed' }));
  assert.equal(base.includes('private'), false);
  assert.notEqual(base, revision(undefined), 'removing runtime must invalidate stale state');
});

test('each execution runtime field participates even when flat session status stays unchanged', () => {
  const runtime = { phase: 'running', sync: 'current', connection: 'connected', turnId: 'run-1',
    operation: 'message', stopRequested: false, threadActivity: 'running', lastEventAt: 100,
    executionProtection: { state: 'blocked', nativeTurnId: 'native-1', reason: 'pending' } };
  const revision = (value: unknown) => stableGatewayRowsRevision([{ sessionKey: 's1', status: 'running', runtime: value }]);
  const base = revision(runtime);
  for (const patch of [{ phase: 'waiting' }, { sync: 'syncing' }, { connection: 'disconnected' },
    { turnId: 'run-2' }, { operation: 'compact' }, { stopRequested: true }, { threadActivity: 'waiting' },
    { lastEventAt: 101 }, { executionProtection: { ...runtime.executionProtection, nativeTurnId: 'native-2' } }]) {
    assert.notEqual(base, revision({ ...runtime, ...patch }), `must invalidate ${Object.keys(patch)[0]}`);
  }
});
