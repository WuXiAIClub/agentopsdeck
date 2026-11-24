import assert from 'node:assert/strict';
import test from 'node:test';
import { DeckStore } from '../projection/deck-store.js';
import { TurnAuthorizationError } from '../commands/turn-queue.js';
import { createOpenClawDispatch } from './dispatch.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { GatewayRpcError } from '../gateway/rpc-error.js';

test('OpenClaw never invokes CLI for ambiguous, quoted, wrong-code or wrong-method failures', async (t) => {
  const db = new ConnectorUserStore(':memory:'); t.after(() => db.close());
  const scope = 'missing scope: operator.write';
  const failures = [new Error(scope), scope, { code: 'INVALID_REQUEST', message: scope },
    new GatewayRpcError('agent', 'UNAVAILABLE', scope),
    new GatewayRpcError('sessions.create', 'INVALID_REQUEST', scope),
    new GatewayRpcError('agent', 'INVALID_REQUEST', `handler failed: ${scope}`),
    new GatewayRpcError('agent', 'INVALID_REQUEST', `${scope}.extra`),
    new GatewayRpcError('agent', 'INVALID_REQUEST', 'missing scope: operator.admin')];
  let cliCalls = 0, gatewayCalls = 0;
  for (const failure of failures) {
    const dispatch = createOpenClawDispatch({ executions: db.openClawExecutions, store: new DeckStore(), allowCliFallback: true,
      message: (text) => text, authorizeTurn: () => true,
      gateway: { requestBound: async () => { gatewayCalls++; throw failure; } } as any,
      startCli: async () => { cliCalls++; return { ok: false, error: 'must not start' }; } });
    await assert.rejects(dispatch({ id: 'one', sessionKey: 'agent:main:test', createdAt: 1, state: 'dispatching',
      payload: { actorId: 'writer', message: 'one', media: [], deliveryMode: 'web-only' } }, []), (error: unknown) => error === failure);
  }
  assert.equal(gatewayCalls, failures.length);
  assert.equal(cliCalls, 0);
});

test('OpenClaw checks revocation between definitive Gateway rejection and CLI fallback', async (t) => {
  const db = new ConnectorUserStore(':memory:'); t.after(() => db.close());
  let authorized = true, calls = 0;
  const dispatch = createOpenClawDispatch({ executions: db.openClawExecutions, store: new DeckStore(), allowCliFallback: true, message: (text) => text,
    authorizeTurn: () => authorized,
    gateway: { requestBound: async () => {
      calls++; authorized = false;
      throw new GatewayRpcError('agent', 'INVALID_REQUEST', 'missing scope: operator.write');
    } } as any });
  await assert.rejects(dispatch({ id: 'one', sessionKey: 'agent:main:test', createdAt: 1, state: 'dispatching',
    payload: { actorId: 'writer', message: 'one', media: [], deliveryMode: 'web-only' } }, []), TurnAuthorizationError);
  assert.equal(calls, 1);
});

test('OpenClaw revoked identity cannot call Gateway', async (t) => {
  const db = new ConnectorUserStore(':memory:'); t.after(() => db.close());
  const dispatch = createOpenClawDispatch({ executions: db.openClawExecutions, store: new DeckStore(), allowCliFallback: true, message: (text) => text,
    authorizeTurn: () => false, gateway: { requestBound: async () => { assert.fail('must not dispatch'); } } as any });
  await assert.rejects(dispatch({ id: 'one', sessionKey: 'agent:main:test', createdAt: 1, state: 'dispatching',
    payload: { message: 'one', media: [], deliveryMode: 'web-only' } }, []), TurnAuthorizationError);
});
