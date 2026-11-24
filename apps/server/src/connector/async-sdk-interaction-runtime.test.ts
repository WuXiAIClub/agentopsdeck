import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncSdkInteractionRuntime } from './async-sdk-interaction-runtime.js';
import { AsyncSdkInteractions } from './async-sdk-interaction.js';
import { WorkerInteractionPort } from '../commands/interaction-port.js';
import type { InteractionParentFrame } from '../commands/interaction-wire.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerSdkInteractionsHttp } from './sdk-interactions-http.js';
import type { SdkAgentId } from './sdk-execution-journal.js';
import type { InteractionView } from '../commands/interaction-runtime.js';
import { applicationInteractionTestSupport, type InteractionApplicationOptions } from './application-interaction-test-support.js';

const authorization = 'Bearer isolated-original-interaction';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const gate = () => { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; };
async function until(predicate: () => boolean | Promise<boolean>) {
  const end = Date.now() + 5_000;
  while (!await predicate()) { assert.ok(Date.now() < end, 'original interaction did not converge'); await tick(); }
}
async function fixture(runtime: SdkAgentId, acknowledgementMs = 1000, application?: InteractionApplicationOptions) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-owned-interaction-')), logs: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const config = { file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json'), bootstrapToken: authorization.slice(7),
    sdkModels: { [runtime]: { model: 'default' } } };
  const appSupport = application && await applicationInteractionTestSupport(root, application, diagnostics, authorization.slice(7));
  let owner = new AsyncConnectorOwner(config, diagnostics, undefined, 30_000, appSupport?.endpoint); await owner.open();
  const created = await owner.command('sdkSessionCreate', { runtime, authorization, commandKey: 'create', payloadJson: '{}' });
  assert.ok('receipt' in created && created.key); const key = created.key, scope = { runtime, key, authorization };
  let after: ((kind: string) => Promise<void>) | undefined, ready = true;
  const port: Pick<AsyncConnectorOwner, 'command'> = { command: (async (kind, input) => {
    const result = await owner.command(kind, input); await after?.(kind); return result;
  }) as AsyncConnectorOwner['command'] };
  const interactions = new AsyncSdkInteractionRuntime(port, () => {}, diagnostics, acknowledgementMs);
  assert.deepEqual(await interactions.mode({ ...scope, mode: 'interactive', nativeReady: true }), { ok: true, value: 'interactive' });
  const sent = await owner.command('sdkMessageSend', { ...scope, commandKey: 'message', payloadJson: '{"message":"original input"}' });
  assert.ok('admitted' in sent && sent.admitted);
  const plan = await owner.command('sdkDispatchPlan', { runtime, key }); assert.ok(plan && plan !== 'blocked');
  const execution = await owner.command('sdkDispatchClaim', { runtime, key, id: 'original-run', epoch: 'original-epoch', digest: plan.digest }); assert.ok(execution);
  const ref = { key, id: execution.id, epoch: execution.epoch, nativeSessionId: execution.nativeSessionId };
  const manager = new AsyncSdkInteractions({ owner, runtime, interactions }), context = await manager.prepare(ref); assert.ok(context);
  assert.equal(await owner.command('sdkExecutionAcknowledge', { runtime, ref, nativeRequestId: 'native-ack' }), true);
  const frames: InteractionParentFrame[] = [], identity = { executionId: ref.id, epoch: ref.epoch };
  const native = new WorkerInteractionPort(identity, context, frame => frames.push(frame), () => true);
  const app = new Hono();
  if (appSupport) appSupport.register(app, { sdk: { interactions, ready: () => ready, diagnostics } });
  else registerSdkInteractionsHttp(app, '/sessions/:sessionKey', { interactions, ready: () => ready, diagnostics, timeoutMs: 2000 });
  const request = (suffix: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => app.request(`${appSupport ? '/api' : ''}/sessions/${key}/${suffix}`, {
    method, headers: { ...(appSupport ? appSupport.headers : { authorization }), 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const views = async () => { const result = await interactions.observe(scope); assert.ok(result.ok); return result.value.requests; };
  const open = async (id = 'private-request') => {
    assert.equal(native.receive({ ...identity, requestId: id, kind: 'interaction-request', question: { kind: 'text', prompt: 'Original prompt' } }), true);
    await until(async () => (await views()).some(v => v.status === 'pending'));
    return (await views()).find(v => v.status === 'pending')!;
  };
  const submission = (view: InteractionView) => ({ runId: ref.id, responseId: `response-${view.request.requestId}`,
    expectedRevision: view.revision, answer: { kind: 'text', text: 'Original answer' } });
  const answer = (view: InteractionView) => interactions.answer({ ...scope, requestId: view.request.requestId, submission: submission(view) });
  return { owner, interactions, manager, context, native, frames, identity, key, scope, ref, config, diagnostics, logs, request, views, open, submission, answer, appSupport,
    hook: (value: typeof after) => { after = value; }, readiness: (value: boolean) => { ready = value; },
    restart: async () => { native.close(); await manager.close(); await interactions.close(); await owner.close(); owner = new AsyncConnectorOwner(config, diagnostics); await owner.open(); return owner; },
    close: async () => { after = undefined; native.close(); try { await manager.close(); await interactions.close(); } finally { await owner.close(); await appSupport?.close(); rmSync(root, { recursive: true, force: true }); } } };
}

for (const runtime of ['claude-code', 'ghcp'] as const) for (const role of ['hub', 'standalone'] as const)
  for (const mode of ['json', 'sqlite'] as const) for (const withKey of [true, false])
    test(`${runtime}/${role}/${mode}/${withKey ? 'Key' : 'no Key'}: application HTTP to original native ACK and immutable receipt`, { timeout: 30_000 }, async () => {
      const f = await fixture(runtime, 1000, { role, mode, withKey });
      try {
        assert.equal((await f.request('interactions')).status, 200);
        assert.equal((await f.request('interaction-mode', 'PATCH', { mode: 'interactive' })).status, 200);
        const view = await f.open(), suffix = `interactions/${view.request.requestId}/answer`;
        const response = f.request(suffix, 'POST', f.submission(view));
        await until(() => f.frames.some(v => v.kind === 'interaction-answer'));
        const duplicate = await f.request(suffix, 'POST', f.submission(view)); assert.equal(duplicate.status, 200);
        assert.equal((await duplicate.json()).delivery, 'claimed');
        f.native.receive({ ...f.identity, requestId: 'private-request', kind: 'interaction-ack' });
        const settled = await response; assert.equal(settled.status, 200); assert.equal((await settled.json()).delivery, 'confirmed');
        const again = await f.request(suffix, 'POST', f.submission(view)); assert.equal(again.status, 200); assert.equal((await again.json()).delivery, 'confirmed');
        assert.equal((await f.request(suffix, 'POST', { ...f.submission(view), responseId: 'different-response' })).status, 409);
        assert.equal(f.frames.filter(v => v.kind === 'interaction-answer').length, 1);
        assert.equal((await f.request('interactions', 'GET', undefined, { 'x-agentopsdeck-execution-grant': '' })).status, 403);
        assert.equal((await f.request('interaction-mode', 'PATCH', { mode: 'interactive', application: {} })).status, 400);
        assert.ok(f.logs.every(line => !line.includes('agentopsdeck_session=') && !line.includes('Original answer') && !line.includes('Original prompt')));
      } finally { await f.close(); }
    });

for (const runtime of ['claude-code', 'ghcp'] as const) {
  for (const stage of ['sdkInteractionAnswer', 'sdkInteractionClaim', 'sdkInteractionDeliverable'] as const)
    test(`${runtime}: original application logout after ${stage} prevents native delivery`, { timeout: 30_000 }, async () => {
      const f = await fixture(runtime, 1000, { role: 'hub', mode: 'sqlite' });
      try {
        const view = await f.open(); let calls = 0;
        f.hook(async kind => { if (kind === stage && ++calls === (stage === 'sdkInteractionAnswer' ? 2 : 1)) await f.appSupport!.revoke(); });
        const result = await f.request(`interactions/${view.request.requestId}/answer`, 'POST', f.submission(view));
        assert.notEqual(result.status, 200); assert.equal(f.frames.filter(v => v.kind === 'interaction-answer').length, 0);
        f.hook(undefined);
        assert.equal((await f.request('interactions')).status, 403);
        assert.deepEqual(await f.interactions.mode({ ...f.scope, mode: 'automatic', nativeReady: true }), { ok: true, value: 'automatic' }, 'original machine transport remains independent');
      } finally { await f.close(); }
    });

  test(`${runtime}: ACK then logout keeps the confirmed worker fact but suppresses application delivery`, { timeout: 30_000 }, async () => {
    const f = await fixture(runtime, 1000, { role: 'standalone', mode: 'json' });
    try {
      const view = await f.open(); f.hook(async kind => { if (kind === 'sdkInteractionSettle') await f.appSupport!.revoke(); });
      const response = f.request(`interactions/${view.request.requestId}/answer`, 'POST', f.submission(view));
      await until(() => f.frames.some(v => v.kind === 'interaction-answer'));
      f.native.receive({ ...f.identity, requestId: 'private-request', kind: 'interaction-ack' });
      assert.notEqual((await response).status, 200); f.hook(undefined);
      const receipt = await f.answer(view); assert.ok(receipt.ok); assert.equal(receipt.value.delivery, 'confirmed');
      assert.equal(f.frames.filter(v => v.kind === 'interaction-answer').length, 1);
    } finally { await f.close(); }
  });

  test(`${runtime}: application timeout retains original ACK ownership and closing drains it`, { timeout: 30_000 }, async () => {
    const f = await fixture(runtime, 1000, { role: 'standalone', mode: 'sqlite', timeoutMs: 200 });
    try {
      const view = await f.open(), hold = gate(); let entered = false, closed = false;
      f.hook(async kind => { if (kind === 'sdkInteractionSettle') { entered = true; await hold.promise; } });
      const response = f.request(`interactions/${view.request.requestId}/answer`, 'POST', f.submission(view));
      await until(() => f.frames.some(v => v.kind === 'interaction-answer'));
      f.native.receive({ ...f.identity, requestId: 'private-request', kind: 'interaction-ack' }); await until(() => entered);
      try {
        assert.equal((await response).status, 503);
        const closing = f.interactions.close(); void closing.then(() => { closed = true; }); await tick(); assert.equal(closed, false);
        hold.release(); await closing; assert.equal(closed, true);
      } finally { hold.release(); }
      f.hook(undefined);
      const receipt = await f.owner.command('sdkInteractionAnswer', { ...f.scope, requestId: view.request.requestId, submission: f.submission(view) });
      assert.ok(receipt.ok); assert.equal(receipt.value.delivery, 'confirmed');
    } finally { await f.close(); }
  });
}

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: sole worker HTTP answer reaches only original native ACK; duplicate is a receipt`, { timeout: 20_000 }, async () => {
    const f = await fixture(runtime);
    try {
      const view = await f.open();
      assert.equal(f.native.receive({ ...f.identity, epoch: 'foreign', requestId: 'private-request', kind: 'interaction-ack' }), false);
      const response = f.request(`interactions/${view.request.requestId}/answer`, 'POST', f.submission(view));
      await until(() => f.frames.some(v => v.kind === 'interaction-answer'));
      const duplicate = await f.answer(view); assert.ok(duplicate.ok); assert.equal(duplicate.value.delivery, 'claimed');
      assert.equal(f.frames.filter(v => v.kind === 'interaction-answer').length, 1);
      f.native.receive({ ...f.identity, requestId: 'private-request', kind: 'interaction-ack' });
      const settled = await response; assert.equal(settled.status, 200); assert.equal((await settled.json()).delivery, 'confirmed');
      const again = await f.answer(view); assert.ok(again.ok); assert.equal(again.value.delivery, 'confirmed');
      assert.equal(f.frames.filter(v => v.kind === 'interaction-answer').length, 1);
      assert.ok(f.logs.every(line => !line.includes(authorization) && !line.includes('Original prompt') && !line.includes('Original answer')));
    } finally { await f.close(); }
  });

  for (const stage of ['sdkInteractionAnswer', 'sdkInteractionClaim'] as const) test(`${runtime}: revoke after ${stage} never delivers native answer`, { timeout: 20_000 }, async () => {
    const f = await fixture(runtime);
    try {
      const view = await f.open(), actor = await f.owner.command('tokenAuthenticate', { authorization }); assert.ok(actor);
      let calls = 0;
      f.hook(async kind => { if (kind === stage && ++calls === (stage === 'sdkInteractionAnswer' ? 2 : 1)) await f.owner.command('tokenRevoke', { tokenId: actor.tokenId }); });
      const result = await f.answer(view); if (result.ok) assert.equal(result.value.delivery, 'unknown');
      assert.equal(f.frames.filter(v => v.kind === 'interaction-answer').length, 0);
    } finally { await f.close(); }
  });

  test(`${runtime}: ACK timeout and restart retain uncertainty without replay or release`, { timeout: 20_000 }, async () => {
    const f = await fixture(runtime, 5);
    try {
      const view = await f.open(), result = await f.answer(view); assert.ok(result.ok); assert.equal(result.value.delivery, 'unknown');
      f.native.receive({ ...f.identity, requestId: 'private-request', kind: 'interaction-ack' });
      const late = await f.answer(view); assert.ok(late.ok); assert.equal(late.value.delivery, 'unknown');
      const owner = await f.restart(), recovered = new AsyncSdkInteractionRuntime(owner, undefined, f.diagnostics);
      try {
        const duplicate = await recovered.answer({ ...f.scope, requestId: view.request.requestId, submission: f.submission(view) });
        assert.ok(duplicate.ok); assert.equal(duplicate.value.delivery, 'unknown');
        assert.equal((await owner.command('sdkSnapshotRead', { runtime, key: f.key })).unresolved, true);
        assert.equal(f.frames.filter(v => v.kind === 'interaction-answer').length, 1);
      } finally { await recovered.close(); }
    } finally { await f.close(); }
  });

  test(`${runtime}: an old answer receipt outside the history page remains readable without replay`, { timeout: 60_000 }, async () => {
    const f = await fixture(runtime);
    try {
      let first: InteractionView | undefined;
      for (let index = 0; index < 65; index++) {
        const view = await f.open(`private-${index}`); first ??= view;
        const work = f.answer(view);
        await until(() => f.frames.some(v => v.kind === 'interaction-answer' && v.requestId === `private-${index}`));
        f.native.receive({ ...f.identity, requestId: `private-${index}`, kind: 'interaction-ack' });
        const result = await work; assert.ok(result.ok); assert.equal(result.value.delivery, 'confirmed');
      }
      assert.ok(first); assert.equal((await f.views()).length, 64);
      assert.equal((await f.views()).some(v => v.request.requestId === first!.request.requestId), false);
      const duplicate = await f.answer(first); assert.ok(duplicate.ok); assert.equal(duplicate.value.delivery, 'confirmed');
      assert.equal(f.frames.filter(v => v.kind === 'interaction-answer').length, 65);
    } finally { await f.close(); }
  });

  test(`${runtime}: stable but foreign continuation evidence cannot open an interaction`, { timeout: 20_000 }, async () => {
    const f = await fixture(runtime);
    try {
      await assert.rejects(f.context.runtime.open({ kind: 'text', prompt: 'Original prompt' }, f.context.capabilities, {
        scope: f.context.scope, active: () => true, permitted: async () => true,
        continuation: async () => ({ connectionId: 'foreign-epoch', goal: { status: 'absent', version: `${runtime}:no-native-goal:v1` } }),
        deliver: async () => { assert.fail('foreign continuation must never execute'); }, cancel: () => {},
      }));
      assert.deepEqual(await f.views(), []);
      // A rejected request is not a failed physical cleanup or a reason to fence
      // an otherwise healthy original native runtime.
      const valid = await f.open(); assert.equal(valid.status, 'pending');
    } finally { await f.close(); }
  });

  test(`${runtime}: close retains the physical answer promise after its ACK waiter times out`, { timeout: 20_000 }, async () => {
    const f = await fixture(runtime, 5), physical = gate();
    try {
      const view = await f.context.runtime.open({ kind: 'text', prompt: 'Original prompt' }, f.context.capabilities, {
        scope: f.context.scope, active: () => true, permitted: f.context.permitted, continuation: f.context.continuation,
        deliver: async () => { await physical.promise; return 'confirmed'; }, cancel: () => {},
      });
      const result = await f.answer(view); assert.ok(result.ok); assert.equal(result.value.delivery, 'unknown');
      let closed = false; const work = f.interactions.close().then(() => { closed = true; });
      await tick(); assert.equal(closed, false);
      physical.release(); await work;
      const fact = await f.owner.command('sdkInteractionAnswer', { ...f.scope, requestId: view.request.requestId, submission: f.submission(view) });
      assert.ok(fact.ok); assert.equal(fact.value.delivery, 'unknown');
    } finally { physical.release(); await f.close(); }
  });

  test(`${runtime}: disconnect versus physical exit have distinct retirement proofs`, { timeout: 20_000 }, async () => {
    const f = await fixture(runtime);
    try {
      const view = await f.open(), work = f.answer(view);
      await until(() => f.frames.some(v => v.kind === 'interaction-answer'));
      f.native.close(); const result = await work; assert.ok(result.ok); assert.equal(result.value.delivery, 'unknown');
      const before = await f.owner.command('sdkSnapshotRead', { runtime, key: f.key }); assert.equal(before.unresolved, true);
      // Only original child-exit evidence may retire the unresolved interaction.
      f.native.exited(); await f.manager.release(f.ref);
      const observed = await f.views(); assert.equal(observed.find(v => v.request.requestId === view.request.requestId)?.delivery, 'unknown');
    } finally { await f.close(); }
  });

  test(`${runtime}: close drains a late original open and rejects all subsequent HTTP operations`, { timeout: 20_000 }, async () => {
    const f = await fixture(runtime), hold = gate(); let entered = false;
    try {
      f.hook(async kind => { if (kind === 'sdkInteractionOpen') { entered = true; await hold.promise; } });
      f.native.receive({ ...f.identity, requestId: 'late-open', kind: 'interaction-request', question: { kind: 'text', prompt: 'Original prompt' } });
      await until(() => entered); let done = false; const close = f.interactions.close().then(() => { done = true; });
      await tick(); assert.equal(done, false); hold.release(); await close;
      assert.deepEqual(await f.interactions.observe(f.scope), { ok: false, error: 503 });
      assert.equal((await f.request('interactions')).status, 503);
      assert.deepEqual(await f.interactions.mode({ ...f.scope, mode: 'interactive', nativeReady: true }), { ok: false, error: 503 });
      assert.equal(f.frames.filter(v => v.kind === 'interaction-answer').length, 0);
    } finally { hold.release(); await f.close(); }
  });

  test(`${runtime}: interaction HTTP preserves capabilities and rejects delegated grants, invalid input and unavailable mode`, { timeout: 20_000 }, async () => {
    const f = await fixture(runtime);
    try {
      const result = await f.request('interactions'); assert.equal(result.status, 200); assert.equal((await result.json()).version, 1);
      assert.equal((await f.request('interaction-mode', 'PATCH', { mode: 'interactive', ownerId: 'forged' })).status, 400);
      assert.equal((await f.request('interactions', 'GET', undefined, { 'x-agentopsdeck-execution-grant': '' })).status, 403);
      assert.equal((await f.request('interactions', 'GET', undefined, { authorization: '' })).status, 401);
      assert.equal((await f.request('interactions/missing/answer', 'POST', { scope: f.scope })).status, 400);
      f.readiness(false);
      const unavailable = await f.request('interactions'); assert.deepEqual((await unavailable.json()).capabilities.kinds, []);
      assert.equal((await f.request('interaction-mode', 'PATCH', { mode: 'interactive' })).status, 503);
    } finally { await f.close(); }
  });
}
