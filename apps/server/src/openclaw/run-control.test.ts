import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { RunControlConflict } from '../commands/run-control.js';
import { OpenClawExecutions } from './executions.js';
import { interruptOpenClawRun } from './run-control.js';
import type { GatewayWsClient } from '../gateway/ws-client.js';

function fixture(t: test.TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const executions = new OpenClawExecutions(db);
  executions.begin('session', 'command');
  executions.bindGatewayConnection('session', 'command', 'connection');
  executions.acknowledge('session', 'command', 'native');
  let calls = 0;
  const gateway: Pick<GatewayWsClient, 'connectionId' | 'requestBound'> = {
    connectionId: () => 'connection',
    requestBound: async <T>() => {
      calls++;
      return { connectionId: 'connection', payload: { ok: true, aborted: true, runIds: ['native'] } as T };
    },
  };
  const options = { sessionKey: 'session', expectedRunId: 'command', executions, gateway, authorize: () => {} };
  return { executions, gateway, options, calls: () => calls };
}

test('OpenClaw control rejects missing, unbound, CLI, fenced and restarted identities without RPC', async (t) => {
  for (const scenario of ['missing-session', 'missing-id', 'native-id', 'unbound', 'cli', 'fenced', 'restarted', 'completed', 'failed'] as const) {
    await t.test(scenario, async (t) => {
      const f = fixture(t);
      if (scenario === 'missing-session') f.options.sessionKey = 'unknown';
      if (scenario === 'missing-id') f.options.expectedRunId = '';
      if (scenario === 'native-id') f.options.expectedRunId = 'native';
      if (scenario === 'unbound' || scenario === 'cli') {
        f.options.sessionKey = 'unbound';
        f.executions.begin('unbound', 'command');
        if (scenario === 'cli') f.executions.useCli('unbound', 'command');
      }
      if (scenario === 'fenced') f.executions.observe('session', { runId: 'external', phase: 'running', gatewayConnectionId: 'connection' });
      if (scenario === 'restarted') {
        f.executions.recoverInterrupted();
        f.gateway.connectionId = () => 'new-process-connection';
      }
      if (scenario === 'completed' || scenario === 'failed') f.executions.observe('session', { runId: 'native', phase: scenario, gatewayConnectionId: 'connection' });
      const before = f.executions.get(f.options.sessionKey);
      await assert.rejects(interruptOpenClawRun(f.options), RunControlConflict);
      assert.equal(f.calls(), 0);
      assert.deepEqual(f.executions.get(f.options.sessionKey), before);
    });
  }
});

test('OpenClaw control revalidates authority and execution before dispatch', async (t) => {
  const f = fixture(t);
  await assert.rejects(interruptOpenClawRun({ ...f.options, authorize: () => { throw new Error('revoked'); } }), /revoked/);
  await assert.rejects(interruptOpenClawRun({ ...f.options, authorize: () => {
    f.executions.observe('session', { runId: 'native', phase: 'completed', gatewayConnectionId: 'connection' });
    f.executions.begin('session', 'successor');
    f.executions.bindGatewayConnection('session', 'successor', 'connection');
    f.executions.acknowledge('session', 'successor', 'next-native');
  } }), RunControlConflict);
  assert.equal(f.calls(), 0);
});

test('OpenClaw abort replies never fabricate completion or accept ambiguous ACKs', async (t) => {
  const f = fixture(t);
  const before = f.executions.get('session');
  for (const payload of [null, {}, [], { ok: true }, { ok: false, aborted: true, runIds: ['native'] },
    { ok: true, aborted: 'true', runIds: ['native'] }, { ok: true, aborted: true, runIds: [] },
    { ok: true, aborted: true, runIds: ['other'] }, { ok: true, aborted: true, runIds: ['native', 'other'] },
    { ok: true, aborted: false, runIds: ['native'] }]) {
    f.gateway.requestBound = async <T>() => ({ connectionId: 'connection', payload: payload as T });
    await assert.rejects(interruptOpenClawRun(f.options), /Unconfirmed/);
    assert.deepEqual(f.executions.get('session'), before);
  }
  f.gateway.requestBound = async <T>() => ({ connectionId: 'connection', payload: { ok: true, aborted: false, runIds: [] } as T });
  await assert.rejects(interruptOpenClawRun(f.options), RunControlConflict);
  f.gateway.requestBound = async <T>() => ({ connectionId: 'other', payload: { ok: true, aborted: true, runIds: ['native'] } as T });
  await assert.rejects(interruptOpenClawRun(f.options), /Unconfirmed/);
  f.gateway.requestBound = async <T>() => ({ connectionId: 'connection', payload: { ok: true, aborted: true, runIds: ['native'] } as T });
  assert.equal(await interruptOpenClawRun(f.options), 'command');
  assert.deepEqual(f.executions.get('session'), before, 'ACK cannot complete starting execution');
});
