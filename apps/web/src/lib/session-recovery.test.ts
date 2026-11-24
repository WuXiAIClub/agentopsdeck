import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionSummary } from '@agentopsdeck/shared';
import { canRequestSessionRecovery, createSessionRecoveryRequest } from './session-recovery.js';

function session(): SessionSummary {
  return { sessionKey: 'connection:session', title: 'Synthetic', status: 'failed',
    sessionRef: { nodeId: 'node', runtimeId: 'codex', nativeSessionKey: 'codex:synthetic' },
    runtime: { turnId: 'turn', phase: 'failed', threadActivity: 'idle', connection: 'connected', sync: 'current', lastEventAt: 1 } };
}

test('recovery is visible for incomplete owner Codex sessions, not verified-ready failures', () => {
  const value = session();
  assert.equal(canRequestSessionRecovery(value), false);
  for (const runtime of [{ ...value.runtime!, sync: 'error' as const }, { ...value.runtime!, threadActivity: 'unknown' as const },
    { ...value.runtime!, connection: 'disconnected' as const }, { ...value.runtime!, phase: 'unknown' as const },
    { ...value.runtime!, executionProtection: { state: 'blocked' as const, nativeTurnId: 'turn', reason: 'background-work' } }]) {
    assert.equal(canRequestSessionRecovery({ ...value, runtime }), true);
  }
});

test('shared sessions, other runtimes and missing execution identity have no owner recovery button', () => {
  const value = session();
  value.runtime!.sync = 'error';
  assert.equal(canRequestSessionRecovery({ ...value, sessionKey: JSON.stringify(['shared-session-v1', 'owner', 'session']) }), false);
  assert.equal(canRequestSessionRecovery({ ...value, sessionKey: '[broken' }), false);
  assert.equal(canRequestSessionRecovery({ ...value, sessionRef: { ...value.sessionRef!, runtimeId: 'openclaw' } }), false);
  const withoutIdentity = { ...value.runtime! };
  delete withoutIdentity.turnId;
  assert.equal(canRequestSessionRecovery({ ...value, runtime: withoutIdentity }), false);
});

test('healthy running, waiting, finalizing and syncing sessions never show recovery', () => {
  for (const phase of ['starting', 'running', 'waiting', 'finalizing'] as const) {
    for (const sync of ['current', 'syncing'] as const) {
      const value = session();
      value.status = 'running';
      value.runtime = { ...value.runtime!, phase, sync, threadActivity: phase === 'waiting' ? 'waiting' : 'running' };
      assert.equal(canRequestSessionRecovery(value), false, `${phase}/${sync}`);
    }
  }
  const syncing = session();
  syncing.runtime!.sync = 'syncing';
  assert.equal(canRequestSessionRecovery(syncing), false);
});

test('live successor work and automatic retries do not offer recovery for previous errors', () => {
  const value = session();
  for (const sync of ['current', 'syncing', 'error'] as const) {
    assert.equal(canRequestSessionRecovery({ ...value, runtime: { ...value.runtime!, threadActivity: 'running', sync } }), false);
  }
  assert.equal(canRequestSessionRecovery({ ...value, runtime: { ...value.runtime!, phase: 'running', threadActivity: 'running',
    reason: 'Model connection interrupted · Codex is retrying…' } }), false);
});

test('reported execution error offers bounded recovery without treating it as stopped', () => {
  const value = session();
  value.runtime = { ...value.runtime!, phase: 'running', threadActivity: 'running',
    reason: 'Codex reported an error · waiting for final run status' };
  const before = JSON.stringify(value);
  assert.equal(canRequestSessionRecovery(value), true);
  assert.equal(JSON.stringify(value), before);
});

test('double click shares one request and cancellation rejects late responses', () => {
  const owner = createSessionRecoveryRequest(), first = owner.begin()!;
  assert.equal(owner.begin(), undefined);
  assert.equal(owner.current(first), true);
  owner.cancel();
  assert.equal(first.signal.aborted, true);
  assert.equal(owner.current(first), false);
  const successor = owner.begin()!;
  owner.finish(first);
  assert.equal(owner.current(successor), true);
  owner.finish(successor);
  assert.equal(owner.current(successor), false);
  assert.ok(owner.begin());
  owner.cancel();
});
