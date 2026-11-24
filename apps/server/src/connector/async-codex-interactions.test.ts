import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { CodexAppServer } from '../codex/app-server.js';
import { codexAdmissionProof } from '../codex/dispatch-admission.js';
import { DeckStore } from '../projection/deck-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncCodexProjection } from './async-codex-projection.js';
import { AsyncCodexStartup, codexStartupDeckPublisher } from './async-codex-startup.js';
import { AsyncCodexScheduling } from './async-codex-scheduling.js';
import { AsyncCodexQueue } from './async-codex-queue.js';
import { AsyncCodexHistory } from './async-codex-history.js';
import { AsyncConnectorExecutionReads } from './async-execution-reads.js';
import { AsyncCodexDispatch } from './async-codex-dispatch.js';
import { AsyncCodexInteractions } from './async-codex-interactions.js';
import { registerCodexInteractionsHttp } from './codex-interactions-http.js';
import type { InteractionView } from '../commands/interaction-runtime.js';
import type { NativeInteractionRuntime } from '../commands/interaction-port.js';
import { applicationInteractionTestSupport, type InteractionApplicationOptions } from './application-interaction-test-support.js';

const silence = new PerformanceDiagnostics(() => {});
const key = 'codex:original', connectionId = 'original-connection';
function gate() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) { if (await check()) return; await delay(5); }
  assert.fail('original interaction boundary not reached');
}
async function fixture(t: test.TestContext, acknowledgementMs = 100, application?: InteractionApplicationOptions) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-owned-interaction-'));
  // Register each cleanup as soon as its resource exists: setup failures must
  // not leave a worker alive and hide the actual assertion behind a hung file.
  const cleanup: Array<() => unknown | Promise<unknown>> = [];
  t.after(async () => {
    const errors: unknown[] = [];
    try { for (const close of cleanup.reverse()) try { await close(); } catch (error) { errors.push(error); } }
    finally { rmSync(directory, { recursive: true, force: true }); }
    if (errors.length) throw new AggregateError(errors, 'Isolated interaction cleanup failed');
  });
  const config = { file: join(directory, 'connector.sqlite'), tokenFile: join(directory, 'tokens.json'), bootstrapToken: 'isolated-interaction' };
  const tokens = new ConnectorTokenStore(config.tokenFile, config.bootstrapToken);
  const credential = tokens.create({ label: 'original', scopes: ['messages:read', 'messages:send'] });
  const actor = credential.record.id, authorization = `Bearer ${credential.token}`;
  const appSupport = application && await applicationInteractionTestSupport(directory, application, silence, credential.token);
  if (appSupport) cleanup.push(() => appSupport.close());
  const seed = new ConnectorUserStore(config.file, undefined, { runtimeOwner: true });
  const nodeId = seed.nodeId;
  await seed.turns.enqueueAsync('codex', { id: 'original-command', sessionKey: key, createdAt: 1,
    payload: { text: 'PRIVATE original request', images: [], actorId: actor } });
  const proof = codexAdmissionProof(seed.turns, seed.turns.list<{ text: string; images: []; actorId: string }>('codex', key));
  seed.close();
  const owner = new AsyncConnectorOwner(config, silence, undefined, 30_000, appSupport?.endpoint);
  cleanup.push(() => owner.close());
  await owner.open();
  let runtime: any, hook: ((kind: string, run: () => Promise<any>) => Promise<any>) | undefined;
  const port = { command: (async (kind: any, input: any) => {
    const run = () => owner.command(kind, input); return hook ? hook(kind, run) : run();
  }) as AsyncConnectorOwner['command'] };
  const deck = new DeckStore(); deck.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Original', status: 'idle' });
  const projection = new AsyncCodexProjection({ owner: port, deck, bind: false, connectionId: () => runtime?.connectionId, diagnostics: silence });
  cleanup.push(() => projection.close());
  await projection.open();
  const startup = new AsyncCodexStartup({ owner: port, projection, publish: codexStartupDeckPublisher(deck), diagnostics: silence });
  const journal = projection.nativeJournal();
  const scheduling = new AsyncCodexScheduling(port);
  const queuedConsumer = new AsyncCodexQueue({ owner: port, diagnostics: silence, local() {},
    dispatch: { async dispatch() { assert.fail('interaction fixture uses explicit original dispatch'); } },
    async prepare() { assert.fail('interaction fixture does not activate the scheduler'); } });
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: 'C:\\isolated\\cwd',
    defaultModel: 'test', approvalPolicy: 'never', store: deck,
    nativeJournal: journal, startup, scheduling, queuedConsumer, historyReader: new AsyncCodexHistory(port, silence),
    credentialExecutionReader: new AsyncConnectorExecutionReads(owner).codex,
    ownedInteractions: { nodeId }, authorizeTurn() { assert.fail('host permission is not authority'); }, requestTimeoutMs: 100 });
  cleanup.push(async () => { if (runtime) runtime.child = undefined; await codex.close(); });
  await codex.ready();
  runtime = codex as any; runtime.connectionId = connectionId; runtime.nativeQuestionsSupported = true;
  // These answer/permission tests begin after original native loading. The
  // cold-load protocol and its refusal cases live in async-codex-dispatch.test.
  runtime.loadedThreadIds.add('original');
  let delivered: (() => Promise<void>) | undefined;
  const install = codex.installOwnedInteractions.bind(codex);
  codex.installOwnedInteractions = (binding, native, permitted) => {
    const observed: NativeInteractionRuntime = { ...native, open: (question, capabilities, handle, ttl) => native.open(question, capabilities,
      { ...handle, deliver: async answer => { const result = await handle.deliver(answer); await delivered?.(); return result; } }, ttl) };
    return install(binding, observed, permitted);
  };
  const writes: any[] = []; let acknowledge = true, goal: unknown = null;
  runtime.child = { stdin: { writable: true, write(line: string) {
    const row = JSON.parse(line); writes.push(row);
    if (row.method) runtime.receive(JSON.stringify({ id: row.id, result: row.method === 'turn/start'
      ? { turn: { id: 'original-run' } } : row.method === 'thread/goal/get' ? { goal } : {} }));
    else if (row.id === 'original-rpc' && row.result?.decision === 'accept' && acknowledge)
      runtime.receive(JSON.stringify({ method: 'serverRequest/resolved', params: { threadId: 'original', requestId: 'original-rpc' } }));
    return true;
  } } };
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const interactions = new AsyncCodexInteractions({ owner: port, runtime: codex, acknowledgementMs, diagnostics });
  cleanup.push(() => interactions.close());
  const dispatch = new AsyncCodexDispatch({ owner: port, runtime: codex, interactions, local() {},
    settled: async () => { await projection.project(key); }, diagnostics: silence });
  cleanup.push(() => dispatch.close());
  const app = new Hono();
  if (appSupport) appSupport.register(app, { codex: { interactions, ready: () => codex.interactionReady, diagnostics } });
  else registerCodexInteractionsHttp(app, '/sessions/:sessionKey', { interactions, ready: () => codex.interactionReady, diagnostics });
  const http = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => app.request(`${appSupport ? '/api' : ''}/sessions/${key}/${path}`,
    { method, headers: { ...(appSupport ? appSupport.headers : { authorization }), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const views = async () => { const result = await interactions.observe({ key, authorization }); assert.ok(result.ok); return result.value.requests; };
  const start = async (mode: 'interactive' | 'automatic' = 'interactive') => {
    const response = await http('interaction-mode', 'PATCH', { mode }); assert.equal(response.status, 200);
    assert.equal(await dispatch.dispatch({ claim: { sessionKey: key, commandId: 'original-command', connectionId, proof,
      preparing: false, blockedGoalInput: false }, input: [{ type: 'text', text: 'PRIVATE original request' }], interactive: false }), 'admitted');
  };
  const question = async (runId = 'original-run') => {
    runtime.receive(JSON.stringify({ id: 'original-rpc', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'original', turnId: runId, itemId: 'original-item', command: 'PRIVATE command', cwd: 'C:\\private' } }));
    await until(async () => (await views()).some(v => v.status === 'pending'));
    return (await views()).find(v => v.status === 'pending')!;
  };
  const submission = (view: InteractionView) => ({ runId: view.request.runId, responseId: view.request.requestId,
    expectedRevision: view.revision, answer: { kind: 'approval', decision: 'allow-once' } });
  const answer = (view: InteractionView) => http(`interactions/${view.request.requestId}/answer`, 'POST', submission(view));
  return { owner, config, interactions, dispatch, runtime, writes, logs, actor, authorization, tokens, start, question, views, http, answer, submission, appSupport,
    acknowledge(value: boolean) { acknowledge = value; }, goal(value: unknown) { goal = value; },
    hook(value: NonNullable<typeof hook>) { hook = value; }, delivered(value: () => Promise<void>) { delivered = value; } };
}

for (const role of ['hub', 'standalone'] as const) for (const mode of ['json', 'sqlite'] as const) for (const withKey of [true, false])
  test(`Codex/${role}/${mode}/${withKey ? 'Key' : 'no Key'}: application mode and answer use original native receipt`, { timeout: 30_000 }, async t => {
    const f = await fixture(t, 1000, { role, mode, withKey }); await f.start(); const view = await f.question();
    const response = await f.answer(view); assert.equal(response.status, 200); assert.equal((await response.json()).delivery, 'confirmed');
    const duplicate = await f.answer(view); assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).delivery, 'confirmed');
    assert.equal(f.writes.filter(v => v.result?.decision === 'accept').length, 1);
    assert.equal((await f.http('interactions', 'GET', undefined, { 'x-agentopsdeck-execution-grant': '' })).status, 403);
    assert.equal((await f.http('interaction-mode', 'PATCH', { mode: 'interactive', application: {} })).status, 400);
  });

for (const stage of ['codexInteractionAnswer', 'codexInteractionClaim', 'codexInteractionDeliverable'] as const)
  test(`Codex: application logout after ${stage} prevents original native delivery`, { timeout: 30_000 }, async t => {
    const f = await fixture(t, 1000, { role: 'hub', mode: 'sqlite' }); await f.start(); const view = await f.question(); let calls = 0;
    f.hook(async (kind, run) => { const result = await run();
      if (kind === stage && ++calls === (stage === 'codexInteractionAnswer' ? 2 : 1)) await f.appSupport!.revoke(); return result; });
    assert.notEqual((await f.answer(view)).status, 200);
    assert.equal(f.writes.filter(v => v.result?.decision === 'accept').length, 0);
  });

test('Codex: ACK then application logout cannot erase confirmed receipt', { timeout: 30_000 }, async t => {
  const f = await fixture(t, 1000, { role: 'standalone', mode: 'json' }); await f.start(); const view = await f.question();
  f.hook(async (kind, run) => { const result = await run(); if (kind === 'codexInteractionSettle') await f.appSupport!.revoke(); return result; });
  assert.notEqual((await f.answer(view)).status, 200);
  const receipt = await f.owner.command('codexInteractionAnswer', { key, authorization: f.authorization, requestId: view.request.requestId, submission: f.submission(view) });
  assert.ok(receipt.ok); assert.equal(receipt.value.delivery, 'confirmed'); assert.equal(f.writes.filter(v => v.result?.decision === 'accept').length, 1);
});

for (const kind of ['codexInteractionObserve', 'codexInteractionMode', 'codexInteractionAnswer', 'codexInteractionCheck'] as const) {
  test(`${kind}: close retains original worker operation without native binding even if public then is replaced`, async t => {
    const f = await fixture(t), hold = gate(); let entered = false, closed = false;
    f.hook(async (command, run) => {
      const result = await run();
      if (command === kind) { entered = true; await hold.promise; }
      return result;
    });
    const ref = { sessionKey: key, commandId: 'absent', connectionId, bindingId: 'absent' };
    const input = { key, authorization: f.authorization };
    const operation = kind === 'codexInteractionObserve' ? f.interactions.observe(input)
      : kind === 'codexInteractionMode' ? f.interactions.mode({ ...input, mode: 'automatic', nativeReady: true })
      : kind === 'codexInteractionCheck' ? f.interactions.permitted(ref)
      : f.interactions.answer({ ...input, requestId: 'absent', submission: { runId: 'absent', responseId: 'absent',
        expectedRevision: 1, answer: { kind: 'approval', decision: 'allow-once' } } });
    const observed = Promise.prototype.then.call(operation, (result: unknown) => result);
    Object.defineProperty(operation, 'then', { value: (done: (value: unknown) => unknown) => Promise.resolve(done(undefined)) });
    try {
      await until(() => entered);
      const closing = f.interactions.close(); assert.equal(f.interactions.close(), closing);
      void closing.then(() => { closed = true; });
      assert.deepEqual(await f.interactions.observe(input), { ok: false, error: 503 });
      assert.deepEqual(await f.interactions.mode({ ...input, mode: 'interactive', nativeReady: true }), { ok: false, error: 503 });
      assert.equal(await f.interactions.permitted(ref), false);
      await delay(10); assert.equal(closed, false);
      hold.release(); await observed; await closing; assert.equal(closed, true);
    } finally { hold.release(); await observed; }
  });
}

test('interaction admission bounds physical reads without dropping accepted work or calling the worker after freeze', async t => {
  const f = await fixture(t), hold = gate(); let calls = 0;
  // Hold delivered replies, not 128 concurrent worker result reservations:
  // the worker independently bounds those to its original 16 MiB budget.
  // Every accepted read still executes against the real original owner.
  let tail: Promise<unknown> = Promise.resolve();
  f.hook(async (kind, run) => {
    if (kind !== 'codexInteractionObserve') return run();
    const physical = tail.then(run); tail = physical;
    const result = await physical; calls++; await hold.promise; return result;
  });
  const input = { key, authorization: f.authorization };
  const reads = Array.from({ length: 128 }, () => f.interactions.observe(input));
  try {
    await assert.rejects(f.interactions.observe(input));
    await until(() => calls === 128);
    f.interactions.freeze(); assert.deepEqual(await f.interactions.observe(input), { ok: false, error: 503 });
    hold.release(); assert.equal((await Promise.all(reads)).every(result => result.ok), true);
    await f.interactions.close(); assert.equal(calls, 128);
  } finally { hold.release(); await Promise.allSettled(reads); }
});

test('original FIFO -> worker identity/mode -> native question -> HTTP answer -> resolved ACK; duplicate is receipt only', async t => {
  const f = await fixture(t); await f.start(); const view = await f.question();
  const response = await f.answer(view); assert.equal(response.status, 200); assert.equal((await response.json()).delivery, 'confirmed');
  const duplicate = await f.answer(view); assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).delivery, 'confirmed');
  assert.equal(f.writes.filter(v => v.id === 'original-rpc' && v.result?.decision === 'accept').length, 1);
  const observed = await f.http('interactions'); assert.equal(observed.headers.get('cache-control'), 'no-store');
  const json = await observed.json(); assert.equal(json.version, 1); assert.equal(json.mode, 'interactive'); assert.ok(json.capabilities.kinds.length);
  assert.doesNotMatch(f.logs.join('\n'), /PRIVATE|original-rpc|original-connection|isolated|original-run/);
});

test('native ACK timeout is durable unknown; late resolved ACK and repeated HTTP answer never resend', async t => {
  const f = await fixture(t, 5); await f.start(); const view = await f.question(); f.acknowledge(false);
  const response = await f.answer(view); assert.equal(response.status, 200); assert.equal((await response.json()).delivery, 'unknown');
  f.runtime.receive(JSON.stringify({ method: 'serverRequest/resolved', params: { threadId: 'original', requestId: 'original-rpc' } }));
  const duplicate = await f.answer(view); assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).delivery, 'unknown');
  assert.equal(f.writes.filter(v => v.id === 'original-rpc' && v.result?.decision === 'accept').length, 1);
});

test('current worker permission revoked after question prevents a native answer', async t => {
  const f = await fixture(t); await f.start(); const view = await f.question(); f.tokens.revoke(f.actor);
  assert.equal((await f.answer(view)).status, 401);
  assert.equal(f.writes.filter(v => v.result?.decision === 'accept').length, 0);
});

test('Goal version changes invalidate a live native question without replay', async t => {
  const f = await fixture(t); await f.start(); const view = await f.question();
  f.goal({ threadId: 'original', status: 'active', objective: 'Changed', createdAt: 1, updatedAt: 2,
    tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 });
  assert.equal((await f.answer(view)).status, 503);
  assert.equal(f.writes.filter(v => v.result?.decision === 'accept').length, 0);
});

test('HTTP input cannot supply binding/scope, delegate authority or bypass automatic mode', async t => {
  const f = await fixture(t); await f.start('automatic');
  assert.equal((await f.http('interaction-mode', 'PATCH', { mode: 'interactive', ownerId: f.actor })).status, 400);
  assert.equal((await f.http('interactions', 'GET', undefined, { 'x-agentopsdeck-execution-grant': 'forged' })).status, 403);
  assert.equal((await f.http('interactions', 'GET', undefined, { authorization: '' })).status, 401);
  f.runtime.receive(JSON.stringify({ id: 'foreign', method: 'item/commandExecution/requestApproval', params: {
    threadId: 'original', turnId: 'original-run', itemId: 'item', command: 'private', cwd: '/private' } }));
  await delay(10); assert.deepEqual(await f.views(), []);
  assert.ok(f.writes.some(v => v.id === 'foreign' && v.result.decision === 'cancel'));
});

test('permission revoked after durable claim is checked again before physical native delivery', async t => {
  const f = await fixture(t); await f.start(); const view = await f.question();
  f.hook(async (kind, run) => { const result = await run(); if (kind === 'codexInteractionClaim') f.tokens.revoke(f.actor); return result; });
  const response = await f.answer(view); assert.equal(response.status, 200); assert.equal((await response.json()).delivery, 'unknown');
  assert.equal(f.writes.filter(v => v.result?.decision === 'accept').length, 0);
});

test('disconnect after deliverable reply cannot release an answer to the old native child', async t => {
  const f = await fixture(t); await f.start(); const view = await f.question();
  f.hook(async (kind, run) => { const result = await run(); if (kind === 'codexInteractionDeliverable') f.runtime.connectionId = undefined; return result; });
  const response = await f.answer(view); assert.equal(response.status, 200); assert.equal((await response.json()).delivery, 'unknown');
  assert.equal(f.writes.filter(v => v.result?.decision === 'accept').length, 0);
});

test('ACK waiter timeout does not let close release a still-running original physical delivery', async t => {
  const f = await fixture(t, 5), hold = gate(); let entered = false;
  try {
    await f.start(); const view = await f.question();
    f.delivered(async () => { entered = true; await hold.promise; });
    const response = await f.answer(view); assert.equal(response.status, 200); assert.equal((await response.json()).delivery, 'unknown');
    assert.equal(entered, true);
    let closed = false; const closing = f.interactions.close().then(() => { closed = true; });
    await delay(10); assert.equal(closed, false);
    hold.release(); await closing;
    assert.equal((await f.http('interactions')).status, 503);
    assert.equal(f.writes.filter(v => v.result?.decision === 'accept').length, 1);
  } finally { hold.release(); }
});

test('worker reopen preserves unknown receipt but cannot reconstruct a native interaction binding', async t => {
  const f = await fixture(t, 5); await f.start(); const view = await f.question(); f.acknowledge(false);
  assert.equal((await (await f.answer(view)).json()).delivery, 'unknown');
  await f.dispatch.close(); await f.interactions.close(); await f.owner.close();
  const reopened = new AsyncConnectorOwner(f.config, silence);
  try {
    await reopened.open();
    const result = await reopened.command('codexInteractionAnswer', { key, authorization: f.authorization,
      requestId: view.request.requestId, submission: f.submission(view) });
    assert.ok(result.ok); assert.equal(result.value.delivery, 'unknown');
    assert.equal(f.writes.filter(v => v.result?.decision === 'accept').length, 1);
  } finally { await reopened.close(); }
});
