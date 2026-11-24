import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { GatewayRpcError } from '../gateway/rpc-error.js';
import type { GatewayWsClient } from '../gateway/ws-client.js';
import type { startOpenClawAgentFallback } from '../openclaw/cli.js';
import type { OpenClawQueuedPayload } from '../openclaw/turn-queue.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncOpenClawDispatch } from './async-openclaw-dispatch.js';
import { validConnectorOpenClawDispatchInput, validConnectorOpenClawDispatchOutput } from './connector-openclaw-dispatch-domain.js';

const key = 'agent:main:original', token = 'isolated-openclaw-test-token';
const silent = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
type Options = ConstructorParameters<typeof AsyncOpenClawDispatch>[0];
type Complete = NonNullable<Parameters<typeof startOpenClawAgentFallback>[5]>;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'openclaw-dispatch-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), token, silent);
  const actor = tokens.authenticateAuthorization(`Bearer ${token}`)!.tokenId;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const command = createConnectorOwnerCommands(store, tokens);
  let connection: string | undefined = 'original-connection', ready = true, epoch = 'original', sends = 0;
  const gateway: Options['gateway'] = {
    connectionId: () => connection,
    prepareWriteConnection: async () => connection!,
    requestBound: async <T>(_method: Parameters<GatewayWsClient['requestBound']>[0], _params: Record<string, unknown>, expected?: string, before?: () => void) => {
      assert.equal(expected, connection); before?.(); sends++;
      return { connectionId: connection!, payload: { runId: 'original-run' } as T };
    },
  };
  return { directory, store, tokens, actor, command, gateway,
    get sends() { return sends; },
    replace() { connection = 'replacement'; epoch = 'replacement'; },
    disconnect() { ready = false; },
    async enqueue(id = 'original-command', payload: Partial<OpenClawQueuedPayload> = {}) {
      await store.turns.enqueueAsync('openclaw', { sessionKey: key, id, createdAt: 1,
        payload: { actorId: actor, message: 'original private input', media: [], deliveryMode: 'web-only', ...payload } });
    },
    facade(overrides: Partial<Options> = {}) { return new AsyncOpenClawDispatch({ owner: { command }, gateway,
      native: { available: () => ready, epoch: () => epoch }, allowCliFallback: false, message: text => text, ...overrides }); },
    close() { command.dispose(); store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test('strict worker protocol rejects caller authority, content and foreign runtime', () => {
  assert.equal(validConnectorOpenClawDispatchInput('openClawDispatchPlan', { key, authorized: true }), false);
  assert.equal(validConnectorOpenClawDispatchInput('openClawDispatchPlan', { key: 'hermes:other' }), false);
  assert.equal(validConnectorOpenClawDispatchInput('openClawDispatchClaim', { key, id: 'id', digest: 'a'.repeat(64), connectionId: 'c', message: 'forged' }), false);
  assert.equal(validConnectorOpenClawDispatchOutput('openClawDispatchPlan', { turn: {}, digest: 'a'.repeat(64) }), false);
});

for (const broken of ['start', 'add', 'finish'] as const)
  test(`throwing diagnostic ${broken} cannot replace committed ACK or strand close`, async () => {
    const f = fixture();
    try {
      await f.enqueue();
      const diagnostics = new PerformanceDiagnostics(() => {}), start = diagnostics.start.bind(diagnostics);
      diagnostics.start = (...args) => {
        if (broken === 'start') throw Error('diagnostic failure');
        const trace = start(...args);
        return { ...trace, [broken]: () => { throw Error('diagnostic failure'); } };
      };
      const dispatch = f.facade({ diagnostics, settled: () => { throw Error('projection failure'); },
        diagnostic: () => { throw Error('sink failure'); } });
      assert.equal(await dispatch.dispatch(key), 'admitted');
      assert.equal(f.sends, 1);
      assert.equal(f.store.openClawExecutions.get(key)?.phase, 'starting');
      assert.equal(f.store.turns.list('openclaw', key).length, 0);
      await dispatch.close();
    } finally { f.close(); }
  });

for (const boundary of ['prepare', 'beforeSend'] as const)
  test(`native safety changes at ${boundary} veto the original effect synchronously`, async () => {
    const f = fixture();
    try {
      await f.enqueue(); let safe = true;
      const gateway: Options['gateway'] = { ...f.gateway,
        prepareWriteConnection: async () => {
          if (boundary === 'prepare') safe = false;
          return 'original-connection';
        },
        requestBound: async (...args) => {
          if (boundary === 'beforeSend') safe = false;
          return f.gateway.requestBound(...args);
        },
      };
      const dispatch = f.facade({ gateway, canDispatch: () => safe });
      assert.equal(await dispatch.dispatch(key), 'not_started');
      assert.equal(f.sends, 0);
      assert.equal(f.store.turns.list('openclaw', key)[0]?.state, boundary === 'prepare' ? 'queued' : 'blocked');
      if (boundary === 'beforeSend') assert.equal(f.store.openClawExecutions.get(key)?.phase, 'failed');
      await dispatch.close();
    } finally { f.close(); }
  });

test('original queue → atomic claim → one bound Gateway send → atomic ACK removal', async () => {
  const f = fixture();
  try {
    await f.enqueue(); await f.enqueue('successor');
    let projected = 0;
    const dispatch = f.facade({ settled: () => { projected++; } });
    assert.equal(await dispatch.dispatch(key), 'admitted'); assert.equal(f.sends, 1); assert.equal(projected, 1);
    assert.equal(f.store.openClawExecutions.get(key)?.phase, 'starting'); // ACK is not native start proof.
    assert.equal(f.store.turns.list('openclaw', key)[0]?.id, 'successor');
    assert.equal(await dispatch.dispatch(key), 'not_started'); assert.equal(f.sends, 1);
    assert.equal(f.store.openClawExecutions.get(key)?.gatewayConnectionId, 'original-connection');
    await dispatch.close();
  } finally { f.close(); }
});

for (const change of ['revoked', 'maintenance', 'edit', 'ABA'] as const)
  test(`original plan never leases authorization or payload across ${change}`, async () => {
    const f = fixture();
    try {
      await f.enqueue(); const plan = await f.command('openClawDispatchPlan', { key }); assert.ok(plan && plan !== 'blocked');
      if (change === 'revoked') f.tokens.revoke(f.actor);
      if (change === 'maintenance') f.store.pauseTurnStarts();
      if (change === 'edit') f.store.turns.edit<OpenClawQueuedPayload>('openclaw', key, plan.turn.id, p => ({ ...p, message: 'edited' }));
      if (change === 'ABA') { f.store.turns.complete('openclaw', plan.turn.id); await f.enqueue(); }
      assert.equal(await f.command('openClawDispatchClaim', { key, id: plan.turn.id, digest: plan.digest, connectionId: 'connection' }), null);
      assert.equal(f.store.openClawExecutions.get(key), undefined);
    } finally { f.close(); }
  });

test('FIFO cannot skip a blocked head; duplicate original claim grants no second effect', async () => {
  const f = fixture();
  try {
    await f.enqueue(); await f.enqueue('tail');
    const plan = await f.command('openClawDispatchPlan', { key }); assert.ok(plan && plan !== 'blocked');
    assert.equal(await f.command('openClawDispatchClaim', { key, id: 'tail', digest: plan.digest, connectionId: 'c' }), null);
    const input = { key, id: plan.turn.id, digest: plan.digest, connectionId: 'c' };
    assert.ok(await f.command('openClawDispatchClaim', input));
    assert.equal(await f.command('openClawDispatchClaim', input), null);
    assert.equal(await f.command('openClawDispatchPlan', { key }), null);
  } finally { f.close(); }
});

test('claim transaction rolls journal and queue back together on original queue failure', async () => {
  const f = fixture();
  try {
    await f.enqueue(); const plan = await f.command('openClawDispatchPlan', { key }); assert.ok(plan && plan !== 'blocked');
    const start = f.store.turns.startBatchInTransaction.bind(f.store.turns);
    f.store.turns.startBatchInTransaction = (...args) => { start(...args); throw Error('synthetic SQL failure'); };
    await assert.rejects(f.command('openClawDispatchClaim', { key, id: plan.turn.id, digest: plan.digest, connectionId: 'c' }));
    assert.equal(f.store.openClawExecutions.get(key), undefined);
    assert.equal(f.store.turns.list('openclaw', key)[0]?.state, 'queued');
  } finally { f.close(); }
});

test('worker readiness and CLI transition recheck current original authority after claim', async () => {
  const f = fixture();
  try {
    await f.enqueue(); const plan = await f.command('openClawDispatchPlan', { key }); assert.ok(plan && plan !== 'blocked');
    const claim = await f.command('openClawDispatchClaim', { key, id: plan.turn.id, digest: plan.digest, connectionId: 'c' }); assert.ok(claim);
    const ref = { key, id: claim.turn.id, digest: claim.digest, revision: claim.execution.revision! };
    assert.equal(await f.command('openClawDispatchReady', { ...ref, digest: 'a'.repeat(64) }), false);
    assert.equal(await f.command('openClawDispatchReady', ref), true);
    f.tokens.revoke(f.actor);
    assert.equal(await f.command('openClawDispatchReady', ref), false);
    assert.equal(await f.command('openClawDispatchCli', ref), null);
    assert.equal(await f.command('openClawDispatchAbandon', ref), true, 'local no-effect evidence retires original claim even after revocation');
    assert.equal(f.store.turns.list('openclaw', key)[0]?.state, 'blocked');
  } finally { f.close(); }
});

test('attachment preparation failure never claims or dispatches; inline media forbids CLI fallback', async () => {
  const f = fixture();
  try {
    await f.enqueue('original-command', { media: [{ media: { name: 'file', mimeType: 'text/plain', type: 'file', url: 'unused' }, filePath: join(f.directory, 'missing') }] });
    const dispatch = f.facade(); assert.equal(await dispatch.dispatch(key), 'not_started');
    assert.equal(f.store.openClawExecutions.get(key), undefined); assert.equal(f.sends, 0); await dispatch.close();
    f.store.turns.complete('openclaw', 'original-command');
    await f.enqueue('inline', { media: [{ media: { name: 'file', mimeType: 'text/plain', type: 'file', url: 'unused' }, gatewayAttachment: { content: 'Zg==' } }] });
    let cli = 0;
    const gateway: Options['gateway'] = { ...f.gateway, requestBound: async (_m, _p, _c, before) => {
      before?.(); throw new GatewayRpcError('agent', 'INVALID_REQUEST', 'missing scope: operator.write');
    } };
    const inline = f.facade({ gateway, allowCliFallback: true, startCli: async () => { cli++; return { ok: true as const }; } });
    assert.equal(await inline.dispatch(key), 'unknown'); assert.equal(cli, 0); await inline.close();
  } finally { f.close(); }
});

test('lost ACK after an early terminal keeps terminal evidence and protects the unconsumed original queue atomically', async () => {
  const f = fixture();
  try {
    await f.enqueue();
    const gateway: Options['gateway'] = { ...f.gateway, requestBound: async (_m, _p, _c, before) => {
      before?.();
      f.store.openClawExecutions.acknowledge(key, 'original-command', 'run');
      f.store.openClawExecutions.observe(key, { runId: 'run', gatewayConnectionId: 'original-connection', phase: 'completed' });
      throw Error('lost original ACK');
    } };
    const dispatch = f.facade({ gateway }); assert.equal(await dispatch.dispatch(key), 'unknown');
    assert.equal(f.store.openClawExecutions.get(key)?.phase, 'completed');
    assert.equal(f.store.turns.list('openclaw', key)[0]?.state, 'outcome_unknown');
    assert.equal(await dispatch.dispatch(key), 'not_started'); await dispatch.close();
  } finally { f.close(); }
});

test('close keeps the original pending Gateway response and settlement; log sink receives fixed codes only', async () => {
  const f = fixture();
  try {
    await f.enqueue(); const ack = deferred<{ connectionId: string; payload: { runId: string } }>(); let sent = false;
    const logs: unknown[] = [], diagnostics = new PerformanceDiagnostics(line => { logs.push(line); });
    const gateway: Options['gateway'] = { ...f.gateway, requestBound: (async (_m: unknown, _p: unknown, _c: unknown, before: () => void) => {
      before(); sent = true; return ack.promise;
    }) as GatewayWsClient['requestBound'] };
    const dispatch = f.facade({ gateway, diagnostics, settled: () => { throw Error('private projection failure'); } });
    const work = dispatch.dispatch(key); await tick(); assert.equal(sent, true);
    let closed = false; const close = dispatch.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false);
    ack.resolve({ connectionId: 'original-connection', payload: { runId: 'run' } });
    assert.equal(await work, 'admitted'); await close;
    assert.equal(f.store.turns.list('openclaw', key).length, 0);
    const text = JSON.stringify(logs); assert.ok(text.includes('openclaw-dispatch'));
    for (const secret of [key, token, f.directory, 'private projection failure', 'original private input']) assert.equal(text.includes(secret), false);
  } finally { f.close(); }
});

test('pause then resume during physical preparation invalidates the old local generation', async () => {
  const f = fixture();
  try {
    await f.enqueue(); const connection = deferred<string>();
    const dispatch = f.facade({ gateway: { ...f.gateway, prepareWriteConnection: () => connection.promise } });
    const work = dispatch.dispatch(key); await tick(); const pause = dispatch.pause(); assert.equal(pause.resume(), false);
    connection.resolve('original-connection'); assert.equal(await work, 'not_started'); await pause.drained;
    assert.equal(pause.resume(), true); assert.equal(pause.resume(), false);
    assert.equal(f.store.openClawExecutions.get(key), undefined); assert.equal(f.sends, 0); await dispatch.close();
  } finally { f.close(); }
});

for (const change of ['revoked', 'maintenance', 'replace', 'close'] as const)
  test(`${change} while current worker readiness is pending prevents native invocation`, async () => {
    const f = fixture();
    try {
      await f.enqueue(); let dispatch!: AsyncOpenClawDispatch;
      const command: typeof f.command = Object.assign(async (...[kind, input]: Parameters<typeof f.command>) => {
        const value = await f.command(kind, input);
        if (kind === 'openClawDispatchReady') {
          if (change === 'revoked') { f.tokens.revoke(f.actor); return false; }
          if (change === 'maintenance') { f.store.pauseTurnStarts(); return false; }
          if (change === 'replace') f.replace();
          if (change === 'close') void dispatch.close();
        }
        return value;
      }, { dispose: () => {} }) as typeof f.command;
      dispatch = f.facade({ owner: { command } });
      assert.ok(['blocked', 'not_started'].includes(await dispatch.dispatch(key))); assert.equal(f.sends, 0);
      assert.equal(f.store.turns.list('openclaw', key)[0]?.state, 'blocked'); await dispatch.close();
    } finally { f.close(); }
  });

for (const failure of ['transport', 'ACK-loss', 'ACK-false', 'wrong-connection', 'lookalike-rejection'] as const)
  test(`${failure} cannot replay or trigger CLI; original intent remains protected`, async () => {
    const f = fixture();
    try {
      await f.enqueue(); let calls = 0, cli = 0;
      const command = (async (kind: string, input: unknown) => {
        if (kind === 'openClawExecutionAcknowledge' && failure === 'ACK-loss') throw Error('lost worker ACK');
        if (kind === 'openClawExecutionAcknowledge' && failure === 'ACK-false') return false;
        return f.command(kind as never, input as never);
      }) as typeof f.command;
      const gateway: Options['gateway'] = { ...f.gateway, requestBound: async <T>(_m: unknown, _p: unknown, _c?: string, before?: () => void) => {
        before?.(); calls++;
        if (failure === 'transport') throw Error('transport timed out');
        if (failure === 'lookalike-rejection') throw Error('missing scope: operator.write');
        return { connectionId: failure === 'wrong-connection' ? 'wrong' : 'original-connection', payload: { runId: 'run' } as T };
      } };
      const dispatch = f.facade({ owner: { command }, gateway, allowCliFallback: true,
        startCli: async () => { cli++; return { ok: true as const }; } });
      assert.equal(await dispatch.dispatch(key), 'unknown'); assert.equal(calls, 1); assert.equal(cli, 0);
      assert.equal(f.store.turns.list('openclaw', key)[0]?.state, 'outcome_unknown');
      assert.equal(await dispatch.dispatch(key), 'not_started'); assert.equal(calls, 1); await dispatch.close();
    } finally { f.close(); }
  });

test('strict definitive Gateway rejection switches the same intent to CLI, drains original lifetime and late final', async () => {
  const f = fixture();
  try {
    await f.enqueue(); let calls = 0, complete!: Complete;
    const child = deferred<void>();
    const gateway: Options['gateway'] = { ...f.gateway, requestBound: async (_m, _p, _c, before) => {
      before?.(); calls++; throw new GatewayRpcError('agent', 'INVALID_REQUEST', 'missing scope: operator.write');
    } };
    const dispatch = f.facade({ gateway, allowCliFallback: true, startCli: async (_k, _a, display, message, id, callback, own) => {
      assert.equal(display, key); assert.equal(message, 'original private input'); assert.equal(id, 'original-command');
      complete = callback!; own!(child.promise); return { ok: true as const };
    } });
    assert.equal(await dispatch.dispatch(key), 'admitted'); assert.equal(calls, 1);
    assert.equal(f.store.openClawExecutions.get(key)?.origin, 'cli'); assert.equal(f.store.turns.list('openclaw', key).length, 0);
    let drained = false; const closing = dispatch.close().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
    await complete({ ok: true, text: 'answer', messages: [] });
    assert.equal(f.store.openClawExecutions.get(key)?.phase, 'completed');
    child.resolve(); await closing; assert.equal(drained, true); assert.equal(await dispatch.dispatch(key), 'not_started');
  } finally { f.close(); }
});

test('CLI terminal before startup ACK is preserved, including original mirror reply transaction', async () => {
  const f = fixture();
  try {
    const issued = f.tokens.create({ label: 'mirror', scopes: ['messages:send', 'messages:mirror'] });
    const mirrorActor = f.tokens.authenticateAuthorization(`Bearer ${issued.token}`)!.tokenId;
    const explicitRoute = { originatingChannel: 'test', originatingTo: 'target', outboundTarget: 'target' };
    await f.enqueue('original-command', { actorId: mirrorActor, deliveryMode: 'mirror', explicitRoute });
    f.store.mirrorOutbox.upsert({ actorId: mirrorActor, sessionKey: key, idempotencyKey: 'original-command', after: 1, inputText: 'original private input', explicitRoute });
    const gateway: Options['gateway'] = { ...f.gateway, requestBound: async (_m, _p, _c, before) => {
      before?.(); throw new GatewayRpcError('agent', 'INVALID_REQUEST', 'missing scope: operator.write');
    } };
    const dispatch = f.facade({ gateway, allowCliFallback: true, startCli: async (_k, _a, _d, _m, _id, complete, own) => {
      const work = Promise.resolve().then(() => complete!({ ok: true, text: 'summary', replyText: 'exact reply', messages: [] }));
      own!(work); await work; return { ok: true as const };
    } });
    assert.equal(await dispatch.dispatch(key), 'admitted'); assert.equal(f.store.openClawExecutions.get(key)?.phase, 'completed');
    assert.equal(f.store.turns.list('openclaw', key).length, 0);
    assert.ok(JSON.stringify(f.store.mirrorOutbox.get('original-command')).includes('exact reply'));
    await dispatch.close();
  } finally { f.close(); }
});

test('reentrant close retains original worker request; duplicate dispatch and new admissions are fenced', async () => {
  const f = fixture();
  try {
    await f.enqueue(); const pending = deferred<null>(); let dispatch!: AsyncOpenClawDispatch, close!: Promise<void>, entered = false;
    const command = Object.assign(async () => { entered = true; close = dispatch.close(); return pending.promise; }, { dispose: () => {} }) as typeof f.command;
    dispatch = f.facade({ owner: { command } });
    const work = dispatch.dispatch(key); assert.equal(await dispatch.dispatch(key), 'not_started'); await tick(); assert.equal(entered, true);
    let drained = false; void close.then(() => { drained = true; }); await tick(); assert.equal(drained, false);
    pending.resolve(null); assert.equal(await work, 'not_started'); await close;
    assert.equal(await dispatch.dispatch('another'), 'not_started'); assert.equal(f.sends, 0);
  } finally { f.close(); }
});

test('unique real worker restart preserves unknown original intent and never invokes successor', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'openclaw-dispatch-worker-'));
  const file = join(directory, 'original.sqlite'), tokenFile = join(directory, 'tokens.json');
  const tokens = new ConnectorTokenStore(tokenFile, token, silent);
  const actorId = tokens.authenticateAuthorization(`Bearer ${token}`)!.tokenId;
  const seed = new ConnectorUserStore(file);
  await seed.turns.enqueueAsync('openclaw', { sessionKey: key, id: 'original', createdAt: 1, payload: { actorId, message: 'private', deliveryMode: 'web-only', media: [] } });
  seed.close();
  let owner = new AsyncConnectorOwner({ file, tokenFile, bootstrapToken: token }, silent);
  try {
    await owner.open(); let sends = 0;
    const gateway: Options['gateway'] = { connectionId: () => 'connection', prepareWriteConnection: async () => 'connection',
      requestBound: async (_m, _p, _c, before) => { before?.(); sends++; throw Error('lost native ACK'); } };
    const dispatch = new AsyncOpenClawDispatch({ owner, gateway, native: { available: () => true, epoch: () => 'epoch' }, allowCliFallback: true, message: x => x });
    assert.equal(await dispatch.dispatch(key), 'unknown'); await dispatch.close(); await owner.close();
    owner = new AsyncConnectorOwner({ file, tokenFile, bootstrapToken: token }, silent); await owner.open();
    assert.equal(await owner.command('openClawDispatchPlan', { key }), null);
    assert.equal((await owner.command('openClawExecutionRead', { sessionKey: key }))?.phase, 'unknown'); assert.equal(sends, 1);
  } finally { await owner.closeForShutdown(); rmSync(directory, { recursive: true, force: true }); }
});
