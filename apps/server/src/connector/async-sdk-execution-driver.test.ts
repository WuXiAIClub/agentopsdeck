import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncSdkMessages } from './async-sdk-messages.js';
import { AsyncClaudeExecutionDriver } from '../claude/async-execution-driver.js';
import { AsyncCopilotExecutionDriver } from '../copilot/async-execution-driver.js';
import { CLAUDE_CLI_VERSION } from '../claude/dispatch-adapter.js';
import { COPILOT_CLI_VERSION, type CopilotHistoryIdentity } from '../copilot/dispatch-adapter.js';
import { projectClaudeMessage } from '../claude/message-projection.js';
import { projectCopilotMessage } from '../copilot/message-projection.js';
import type { SdkAgentId, SdkExecution } from './sdk-execution-journal.js';
import type { SdkInputAttachment } from './sdk-attachment-input.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncSdkCompactOptions } from './async-sdk-compact-driver.js';
import { Hono } from 'hono';
import { registerSdkMessagesHttp } from './sdk-messages-http.js';

const token = 'isolated-sdk-native-driver', authorization = `Bearer ${token}`;
function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, 'bounded native/worker observation did not converge');
    await delay(2);
  }
}
type Call = { execution: SdkExecution; text: string; attachments?: SdkInputAttachment[];
  finish(): void; fail(): void; cleanup(): void; closed: number; interruptions: number };
async function fixture(runtime: SdkAgentId, options: {
  ready?: () => boolean; holdCleanup?: boolean; badCleanup?: boolean; closeThrows?: boolean;
  deadlineMs?: number; proxy?: (owner: AsyncConnectorOwner) => Pick<AsyncConnectorOwner, 'command'>;
  compact?: AsyncSdkCompactOptions;
  interruptAck?: Promise<void>; interruptError?: boolean;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-native-driver-')), file = join(directory, 'connector.sqlite');
  const logs: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => { logs.push(line); });
  const owner = new AsyncConnectorOwner({ file, tokenFile: join(directory, 'tokens.json'), bootstrapToken: token,
    sdkModels: { 'claude-code': { model: 'default' }, ghcp: { model: 'default' } } }, diagnostics);
  await owner.open();
  const port = options.proxy?.(owner) ?? owner;
  const created = await owner.command('sdkSessionCreate', { runtime, authorization, commandKey: 'create', payloadJson: '{}' });
  assert.ok('receipt' in created && created.key);
  const key = created.key, calls: Call[] = [];
  function control(execution: SdkExecution, text: string, attachments?: SdkInputAttachment[]) {
    const input = gate(), finished = gate();
    let failed = false, stopped = false, physical = false;
    const call: Call = { execution, text, ...(attachments ? { attachments } : {}), closed: 0, interruptions: 0, finish: input.release,
      fail: () => { failed = true; input.release(); }, cleanup: () => { physical = true; finished.release(); } };
    calls.push(call);
    return { call, input, finished, failed: () => failed, stopped: () => stopped,
      interrupted: async () => {
        const snapshot = await owner.command('sdkSnapshotRead', { runtime, key: execution.key });
        assert.equal(snapshot.execution?.stopRequested, true, 'fresh worker stop intent precedes native stop');
        call.interruptions++;
        await options.interruptAck;
        if (options.interruptError) throw Error('secret native interrupt failure');
        stopped = true; input.release();
      },
      ended: () => { if (!options.holdCleanup) call.cleanup(); },
      quiet: async () => physical && !options.badCleanup,
      close: () => { call.closed++; input.release(); if (options.closeThrows) throw Error('secret native close error'); },
    };
  }
  const base = { owner: port, deadlineMs: options.deadlineMs ?? 1_000, diagnostics,
    ...(options.compact ? { compact: options.compact } : {}),
    admissionReady: options.ready ?? (() => true), changed: () => { throw Error('untrusted observer'); } };
  const driver = runtime === 'claude-code' ? new AsyncClaudeExecutionDriver({ ...base,
    start(execution, text, projection, _context, attachments) {
      const c = control(execution, text, attachments), session_id = execution.nativeSessionId, answer = randomUUID();
      let assistant = false;
      return { finished: c.finished.promise, inspectQuiescence: c.quiet, interrupt: c.interrupted, close: c.close,
        historyIdentities: async () => [{ type: 'user', uuid: execution.id, session_id, parent_tool_use_id: null },
          ...(assistant ? [{ type: 'assistant', uuid: answer, session_id, parent_tool_use_id: null }] : [])],
        async *[Symbol.asyncIterator]() {
          try {
            yield { type: 'system', subtype: 'init', session_id, claude_code_version: CLAUDE_CLI_VERSION };
            const user = { type: 'user', uuid: execution.id, session_id, parent_tool_use_id: null,
              message: { role: 'user', content: text } };
            projection.project(projectClaudeMessage(user, session_id)); yield user;
            await c.input.promise;
            if (c.failed()) throw Error('secret native disconnect');
            if (c.call.closed) return;
            if (!c.stopped()) {
              const output = { type: 'assistant', uuid: answer, session_id, parent_tool_use_id: null,
                user_message_uuid: execution.id, message: { role: 'assistant', content: 'Fixture reply' } };
              projection.project(projectClaudeMessage(output, session_id)); assistant = true; yield output;
            }
            yield { type: 'result', uuid: randomUUID(), session_id, user_message_uuid: execution.id,
              subtype: c.stopped() ? 'error_during_execution' : 'success', is_error: c.stopped() };
          } finally { c.ended(); }
        },
      };
    },
  }) : new AsyncCopilotExecutionDriver({ ...base,
    start(execution, text, projection, _context, attachments) {
      const c = control(execution, text, attachments), nativeSessionId = execution.nativeSessionId;
      const inputId = randomUUID(), inputEvent = randomUUID(), answer = randomUUID(), answerEvent = randomUUID();
      const history: CopilotHistoryIdentity[] = [];
      return { finished: c.finished.promise, inspectQuiescence: c.quiet, interrupt: c.interrupted, close: c.close,
        verified: Promise.resolve({ sessionId: nativeSessionId, version: COPILOT_CLI_VERSION, protocolVersion: 3 }),
        admitted: Promise.resolve({ messageId: inputId }),
        historyIdentities: async () => ({ sessionId: nativeSessionId, entries: history }),
        async *[Symbol.asyncIterator]() {
          try {
            const input = { id: inputEvent, type: 'user.message', timestamp: new Date().toISOString(),
              data: { messageId: inputId, content: text } };
            projection.project(projectCopilotMessage(input)!); yield input;
            history.push({ id: inputEvent, type: 'user.message', messageId: inputId });
            await c.input.promise;
            if (c.failed()) throw Error('secret native disconnect');
            if (c.call.closed) return;
            if (!c.stopped()) {
              const output = { id: answerEvent, type: 'assistant.message', timestamp: new Date().toISOString(),
                data: { messageId: answer, originatingMessageId: inputId, content: 'Fixture reply' } };
              projection.project(projectCopilotMessage(output)!); yield output;
              history.push({ id: answerEvent, type: 'assistant.message', messageId: answer, originatingMessageId: inputId });
            }
            yield { id: randomUUID(), type: 'session.idle', data: { aborted: c.stopped() } };
          } finally { c.ended(); }
        },
      };
    },
  });
  const messages = new AsyncSdkMessages(owner, (_runtime, admittedKey) => { void driver.wake(admittedKey); });
  let serial = 0, disposed = false;
  const send = async (message: string, media?: SdkInputAttachment[]) => {
    const payloadJson = JSON.stringify({ message, ...(media ? { media: media.map(item => ({
      name: item.name, mimeType: item.mimeType, dataUrl: `data:${item.mimeType};base64,${item.data}`,
    })) } : {}) });
    const result = await messages.send({ runtime, key, authorization, commandKey: `send-${++serial}`, payloadJson }, { timeoutMs: 5_000 });
    assert.ok('receipt' in result && result.admitted); return result;
  };
  const snapshot = () => owner.command('sdkSnapshotRead', { runtime, key });
  const http = (timeoutMs = 1_000) => {
    const app = new Hono();
    registerSdkMessagesHttp(app, '/sessions/:sessionKey', { messages, ready: () => false,
      stop: input => driver.interruptMessage(input), diagnostics, timeoutMs });
    app.post('/sessions/:sessionKey/messages', () => { throw Error('stop reached synchronous fallback'); });
    return {
      post: (body: unknown, credential = authorization) => app.request(`/sessions/${key}/messages`, {
        method: 'POST', headers: { authorization: credential, 'content-type': 'application/json' }, body: JSON.stringify(body),
      }),
      get: (commandKey: string, credential = authorization) => app.request(`/sessions/${key}/commands/${commandKey}`, {
        headers: { authorization: credential },
      }),
    };
  };
  return { owner, port, driver, key, calls, send, snapshot, file, logs, http,
    async dispose() {
      if (disposed) return;
      disposed = true;
      try { for (const call of calls) call.cleanup(); await driver.close().catch(() => {}); }
      finally { await owner.close(); rmSync(directory, { recursive: true, force: true }); }
    },
  };
}

async function compactStopFixture(runtime: SdkAgentId, options: {
  interruptError?: boolean; proxy?: NonNullable<Parameters<typeof fixture>[1]>['proxy'];
} = {}) {
  const ack = gate(), result = gate(), physical = gate();
  let quiet = false, interruptions = 0, starts = 0, admission = true;
  const f = await fixture(runtime, { deadlineMs: 5_000, ready: () => admission,
    ...(options.proxy ? { proxy: options.proxy } : {}),
    compact: { models: { model: 'default' }, start(execution) {
      starts++;
      return { result: result.promise.then(() => ({ ...execution, nativeRequestId: execution.id,
        completionEventId: 'original-boundary', outcome: 'completed' as const })), finished: physical.promise,
        inspectQuiescence: async () => quiet,
        inspectSettlement: async () => ({ ...execution, completionEventId: 'original-boundary', historyPersisted: true, nativeQuiescent: true }),
        interrupt: async () => {
          assert.equal((await f.snapshot()).execution?.stopRequested, true);
          interruptions++; await ack.promise;
          if (options.interruptError) throw Error('secret compact interrupt failure');
        }, close: () => {} };
    } } });
  await f.send('initial'); await until(async () => (await f.snapshot()).execution?.phase === 'running');
  f.calls[0]!.finish(); await until(() => f.driver.inspect().retainedIntents === 0); await f.driver.wake(f.key);
  const compact = f.driver.compact(f.key, 'original-compact', authorization); await until(() => starts === 1);
  const execution = (await f.snapshot()).execution!;
  return { ...f, execution, compact, ack, result, interruptions: () => interruptions,
    pauseAdmission: () => { admission = false; }, finish: () => { quiet = true; physical.release(); },
    async dispose() { ack.release(); result.release(); quiet = true; physical.release(); await compact; await f.dispose(); } };
}

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: message stop uses original compact worker during maintenance; ACK cannot release FIFO`, async () => {
    const f = await compactStopFixture(runtime);
    try {
      const http = f.http(), body = { message: '/stop', expectedRunId: f.execution.id, idempotencyKey: 'compact-stop' };
      const invalid = await http.post({ ...body, expectedRunId: 'wrong-run', idempotencyKey: 'wrong-compact-stop' });
      assert.equal(invalid.status, 409); assert.equal(f.interruptions(), 0);
      await f.send('after compact'); f.pauseAdmission();
      const lease = f.driver.pauseQueueWorker(); await lease.drained;
      const request = http.post(body); await until(() => f.interruptions() === 1); f.ack.release();
      assert.equal((await request).status, 200);
      assert.equal((await http.post(body)).status, 200); assert.equal(f.interruptions(), 1);
      assert.equal(f.calls[0]!.interruptions, 0, 'compact stop must never call ordinary adapter');
      assert.equal((await f.snapshot()).execution?.kind, 'compact');
      assert.equal((await f.snapshot()).execution?.stopRequested, true);
      f.result.release(); await delay(15);
      assert.equal(f.calls.length, 1); assert.equal(f.driver.inspect().nativeWorkers, 1);
      f.finish(); assert.equal(await f.compact, 'accepted');
      assert.equal((await (await http.get('compact-stop')).json()).command.state, 'accepted');
    } finally { await f.dispose(); }
  });

  test(`${runtime}: compact stop HTTP timeout retains late original ACK and duplicate never replays`, async () => {
    const f = await compactStopFixture(runtime);
    try {
      const body = { message: '/stop', expectedRunId: f.execution.id, idempotencyKey: 'slow-compact-stop' };
      const request = f.http(80).post(body); await until(() => f.interruptions() === 1);
      assert.equal((await request).status, 503);
      assert.equal((await f.http().post(body)).status, 202); assert.equal(f.interruptions(), 1);
      assert.equal((await (await f.http().get('slow-compact-stop')).json()).command.state, 'outcome_unknown');
      f.ack.release();
      await until(async () => (await (await f.http().get('slow-compact-stop')).json()).command.state === 'accepted');
      assert.equal(f.driver.inspect().nativeWorkers, 1); assert.equal(f.calls[0]!.interruptions, 0);
      f.result.release(); f.finish(); assert.equal(await f.compact, 'accepted');
      assert.equal((await f.http().post(body)).status, 200); assert.equal(f.interruptions(), 1);
    } finally { await f.dispose(); }
  });

  test(`${runtime}: compact stop shutdown drains ACK even after original physical compact finishes`, async () => {
    const f = await compactStopFixture(runtime);
    let closing: Promise<void> | undefined;
    try {
      const request = f.http(80).post({ message: '/stop', expectedRunId: f.execution.id, idempotencyKey: 'drain-compact-stop' });
      await until(() => f.interruptions() === 1); assert.equal((await request).status, 503);
      f.result.release(); f.finish(); assert.equal(await f.compact, 'accepted');
      let closed = false; closing = f.driver.close().then(() => { closed = true; });
      await delay(20); assert.equal(closed, false, 'physical exit does not abandon original stop ACK');
      f.ack.release(); await closing;
      const recovered = await f.owner.command('sdkMessageReceiptRead', { runtime, key: f.key, authorization, commandKey: 'drain-compact-stop' });
      assert.ok('receipt' in recovered); assert.equal(recovered.receipt?.state, 'accepted');
      assert.equal(f.interruptions(), 1);
    } finally { f.ack.release(); await closing; await f.dispose(); }
  });

  test(`${runtime}: revoked compact stop evidence between claim and ready prevents native interrupt`, async () => {
    const claimed = gate(), proceed = gate();
    const f = await compactStopFixture(runtime, { proxy: owner => ({ command: (async (kind, input) => {
      const output = await owner.command(kind, input);
      if (kind === 'sdkMessageStopClaim') { claimed.release(); await proceed.promise; }
      return output;
    }) as typeof owner.command }) });
    try {
      const request = f.http().post({ message: '/stop', expectedRunId: f.execution.id, idempotencyKey: 'revoked-compact-stop' });
      await claimed.promise;
      const actor = await f.owner.command('tokenAuthenticate', { authorization }); assert.ok(actor);
      await f.owner.command('tokenRevoke', { tokenId: actor.tokenId }); proceed.release();
      assert.equal((await request).status, 401); assert.equal(f.interruptions(), 0);
      assert.equal((await f.snapshot()).execution?.stopRequested, true);
    } finally { proceed.release(); await f.dispose(); }
  });

  test(`${runtime}: revoked after compact native dispatch hides delivery but preserves late ACK`, async () => {
    const f = await compactStopFixture(runtime);
    try {
      const request = f.http().post({ message: '/stop', expectedRunId: f.execution.id, idempotencyKey: 'late-compact-stop' });
      await until(() => f.interruptions() === 1);
      const actor = await f.owner.command('tokenAuthenticate', { authorization }); assert.ok(actor);
      await f.owner.command('tokenRevoke', { tokenId: actor.tokenId }); f.ack.release();
      assert.equal((await request).status, 401);
      f.result.release(); f.finish(); await f.compact; await f.driver.close(); await f.owner.close();
      const original = new ConnectorUserStore(f.file);
      try { assert.equal(original.commands.get(JSON.stringify([actor.tokenId, f.key]), 'late-compact-stop')?.state, 'accepted'); }
      finally { original.close(); }
    } finally { await f.dispose(); }
  });

  test(`${runtime}: compact interrupt failure persists unknown through worker reopen without replay`, async () => {
    const f = await compactStopFixture(runtime, { interruptError: true });
    try {
      f.ack.release();
      const body = { message: '/stop', expectedRunId: f.execution.id, idempotencyKey: 'failed-compact-stop' };
      const response = await f.http().post(body); assert.equal(response.status, 202);
      const receipt = (await response.json()).command;
      assert.equal(receipt.state, 'outcome_unknown'); assert.equal(f.interruptions(), 1);
      assert.equal((await f.http().post(body)).status, 202); assert.equal(f.interruptions(), 1);
      assert.equal((await f.snapshot()).execution?.phase, 'unknown');
      assert.equal(f.driver.inspect().nativeWorkers, 1);
      f.result.release(); f.finish(); await f.compact; await f.driver.close(); await f.owner.close();
      const reopened = new AsyncConnectorOwner({ file: f.file, tokenFile: join(f.file, '..', 'tokens.json'), bootstrapToken: token });
      await reopened.open();
      try {
        const recovered = await reopened.command('sdkMessageStopClaim', { runtime, key: f.key, authorization,
          commandKey: 'failed-compact-stop', payloadJson: JSON.stringify({ message: '/stop', expectedRunId: f.execution.id }), ref: null });
        assert.ok('receipt' in recovered); assert.equal(recovered.receipt.id, receipt.id);
        assert.equal(recovered.receipt.state, 'outcome_unknown'); assert.equal(recovered.execution, null);
        assert.equal(f.interruptions(), 1); assert.equal(f.calls[0]!.interruptions, 0);
      } finally { await reopened.close(); }
      assert.ok(!f.logs.join('').includes('secret compact interrupt failure'));
    } finally { await f.dispose(); }
  });

  test(`${runtime}: stop HTTP original ACK is durable, duplicate-safe and never a physical exit proof`, async () => {
    const f = await fixture(runtime, { holdCleanup: true });
    try {
      await f.send('original run'); await until(async () => (await f.snapshot()).execution?.phase === 'running');
      const execution = (await f.snapshot()).execution!, http = f.http();
      const lease = f.driver.pauseQueueWorker(); await lease.drained;
      const body = { message: '/stop', expectedRunId: execution.id, idempotencyKey: 'http-stop' };
      const response = await http.post(body); assert.equal(response.status, 200);
      const accepted = await response.json();
      assert.equal(accepted.status, 'interrupt_requested'); assert.equal(accepted.runId, execution.id);
      assert.equal(accepted.command.state, 'accepted'); assert.equal(f.calls[0]!.interruptions, 1);
      assert.equal(f.driver.inspect().nativeWorkers, 1); assert.equal(f.driver.inspect().retainedIntents, 1);
      assert.notEqual((await f.snapshot()).execution?.phase, 'interrupted', 'ACK is not physical exit');
      assert.equal((await http.post(body)).status, 200); assert.equal(f.calls[0]!.interruptions, 1);
      assert.equal((await http.post({ ...body, expectedRunId: 'wrong-run' })).status, 409);
      const receipt = await (await http.get('http-stop')).json();
      assert.equal(receipt.command.id, accepted.command.id);
      f.calls[0]!.cleanup(); await until(() => f.driver.inspect().retainedIntents === 0);
      assert.equal((await f.snapshot()).execution?.phase, 'interrupted');
      await f.driver.close(); await f.owner.close();
      const reopened = new AsyncConnectorOwner({ file: f.file, tokenFile: join(f.file, '..', 'tokens.json'), bootstrapToken: token });
      await reopened.open();
      try {
        const current = await reopened.command('sdkMessageReceiptRead', { runtime, key: f.key, authorization, commandKey: 'http-stop' });
        assert.ok('receipt' in current); assert.equal(current.receipt?.id, accepted.command.id);
        assert.equal(current.receipt?.state, 'accepted');
        const duplicate = await reopened.command('sdkMessageStopClaim', { runtime, key: f.key, authorization,
          commandKey: 'http-stop', payloadJson: JSON.stringify({ message: '/stop', expectedRunId: execution.id }), ref: null });
        assert.ok('receipt' in duplicate); assert.equal(duplicate.receipt.id, accepted.command.id); assert.equal(duplicate.execution, null);
      } finally { await reopened.close(); }
    } finally { await f.dispose(); }
  });

  test(`${runtime}: stop HTTP validates original run and body before native effects`, async () => {
    const f = await fixture(runtime);
    try {
      await f.send('original'); await until(async () => (await f.snapshot()).execution?.phase === 'running');
      const execution = (await f.snapshot()).execution!, http = f.http();
      for (const [index, body, status] of [
        [0, { message: '/stop' }, 400],
        [1, { message: '/stop', expectedRunId: 'different-run' }, 409],
        [2, { message: '/stop', expectedRunId: execution.id, deliveryMode: 'mirror' }, 409],
        [3, { message: '/stop', expectedRunId: execution.id, media: [{ name: 'x', mimeType: 'text/plain', dataUrl: 'data:text/plain;base64,eA==' }] }, 400],
      ] as const) {
        assert.equal((await http.post({ ...body, idempotencyKey: `invalid-stop-${index}` })).status, status);
        assert.equal(f.calls[0]!.interruptions, 0); assert.equal((await f.snapshot()).execution?.stopRequested, false);
      }
      assert.equal((await http.post({ message: '/stop', expectedRunId: execution.id }, '')).status, 401);
      const response = await http.post({ message: ' /stop ', expectedRunId: execution.id, idempotencyKey: 'valid-stop' });
      assert.equal(response.status, 200); assert.equal(f.calls[0]!.interruptions, 1);
      await until(() => f.driver.inspect().retainedIntents === 0);
    } finally { await f.dispose(); }
  });

  test(`${runtime}: HTTP deadline retains original stop ACK and native fence until physical finish`, async () => {
    const ack = gate(), f = await fixture(runtime, { interruptAck: ack.promise, holdCleanup: true });
    try {
      await f.send('original'); await until(async () => (await f.snapshot()).execution?.phase === 'running');
      const execution = (await f.snapshot()).execution!, http = f.http(80);
      const body = { message: '/stop', expectedRunId: execution.id, idempotencyKey: 'slow-stop' };
      const response = await http.post(body); assert.equal(response.status, 503);
      await until(() => f.calls[0]!.interruptions === 1);
      assert.equal((await (await f.http().get('slow-stop')).json()).command.state, 'outcome_unknown');
      const duplicate = await f.http().post(body); assert.equal(duplicate.status, 202);
      assert.equal((await duplicate.json()).command.state, 'outcome_unknown'); assert.equal(f.calls[0]!.interruptions, 1);
      assert.equal(f.driver.inspect().nativeWorkers, 1);
      ack.release();
      await until(async () => (await (await f.http().get('slow-stop')).json()).command.state === 'accepted');
      assert.equal(f.driver.inspect().nativeWorkers, 1);
      assert.equal((await f.http().post(body)).status, 200); assert.equal(f.calls[0]!.interruptions, 1);
      f.calls[0]!.cleanup(); await until(() => f.driver.inspect().retainedIntents === 0);
      assert.ok(f.logs.some(line => line.includes('sdk-message-http')));
      assert.ok(f.logs.some(line => line.includes('sdk-async-dispatch')));
      assert.ok(!f.logs.join('').includes(token));
    } finally { ack.release(); await f.dispose(); }
  });

  test(`${runtime}: revoked original authority between stop claim and ready never invokes native`, async () => {
    const claimed = gate(), proceed = gate();
    const f = await fixture(runtime, { proxy: owner => ({ command: (async (kind, input) => {
      const result = await owner.command(kind, input);
      if (kind === 'sdkMessageStopClaim') { claimed.release(); await proceed.promise; }
      return result;
    }) as typeof owner.command }) });
    try {
      await f.send('original'); await until(async () => (await f.snapshot()).execution?.phase === 'running');
      const task = f.http().post({ message: '/stop', expectedRunId: (await f.snapshot()).execution!.id, idempotencyKey: 'revoked-stop' });
      await claimed.promise;
      const actor = await f.owner.command('tokenAuthenticate', { authorization }); assert.ok(actor);
      assert.equal(await f.owner.command('tokenRevoke', { tokenId: actor.tokenId }), true); proceed.release();
      assert.equal((await task).status, 401); assert.equal(f.calls[0]!.interruptions, 0);
      assert.equal((await f.snapshot()).execution?.stopRequested, true);
      assert.equal(f.driver.inspect().nativeWorkers, 1);
    } finally { proceed.release(); await f.dispose(); }
  });

  test(`${runtime}: revoke after native stop keeps original ACK durable but denies HTTP delivery`, async () => {
    const ack = gate(), f = await fixture(runtime, { interruptAck: ack.promise, holdCleanup: true });
    try {
      await f.send('original'); await until(async () => (await f.snapshot()).execution?.phase === 'running');
      const task = f.http().post({ message: '/stop', expectedRunId: (await f.snapshot()).execution!.id, idempotencyKey: 'late-revoked-stop' });
      await until(() => f.calls[0]!.interruptions === 1);
      const actor = await f.owner.command('tokenAuthenticate', { authorization }); assert.ok(actor);
      await f.owner.command('tokenRevoke', { tokenId: actor.tokenId }); ack.release();
      assert.equal((await task).status, 401); assert.equal((await f.http().get('late-revoked-stop')).status, 401);
      assert.equal(f.driver.inspect().nativeWorkers, 1);
      f.calls[0]!.cleanup(); await until(() => f.driver.inspect().retainedIntents === 0);
      await f.driver.close(); await f.owner.close();
      const original = new ConnectorUserStore(f.file);
      try { assert.equal(original.commands.get(JSON.stringify([actor.tokenId, f.key]), 'late-revoked-stop')?.state, 'accepted'); }
      finally { original.close(); }
    } finally { ack.release(); await f.dispose(); }
  });

  test(`${runtime}: native stop failure fences unknown and duplicate/read never replay`, async () => {
    const f = await fixture(runtime, { interruptError: true, holdCleanup: true });
    try {
      await f.send('original'); await until(async () => (await f.snapshot()).execution?.phase === 'running');
      const http = f.http(), body = { message: '/stop', expectedRunId: (await f.snapshot()).execution!.id, idempotencyKey: 'failed-stop' };
      const response = await http.post(body); assert.equal(response.status, 202);
      const receipt = (await response.json()).command; assert.equal(receipt.state, 'outcome_unknown');
      assert.equal((await f.snapshot()).execution?.phase, 'unknown');
      assert.equal((await http.post(body)).status, 202); assert.equal(f.calls[0]!.interruptions, 1);
      assert.equal((await (await http.get('failed-stop')).json()).command.state, 'outcome_unknown');
      assert.equal(f.driver.inspect().nativeWorkers, 1);
      assert.ok(!f.logs.join('').includes('secret native interrupt failure'));
      f.calls[0]!.cleanup(); await f.driver.close(); await f.owner.close();
      const reopened = new AsyncConnectorOwner({ file: f.file, tokenFile: join(f.file, '..', 'tokens.json'), bootstrapToken: token });
      await reopened.open();
      try {
        const original = await reopened.command('sdkMessageStopClaim', { runtime, key: f.key, authorization,
          commandKey: 'failed-stop', payloadJson: JSON.stringify({ message: '/stop', expectedRunId: body.expectedRunId }), ref: null });
        assert.ok('receipt' in original); assert.equal(original.receipt.id, receipt.id);
        assert.equal(original.receipt.state, 'outcome_unknown'); assert.equal(original.execution, null);
        assert.equal(f.calls[0]!.interruptions, 1, 'restart cannot recreate physical dispatch authority');
      } finally { await reopened.close(); }
    } finally { await f.dispose(); }
  });

  test(`${runtime}: shutdown drains original pending stop ACK after HTTP timeout without replay`, async () => {
    const ack = gate(), f = await fixture(runtime, { interruptAck: ack.promise, holdCleanup: true });
    let closing: Promise<void> | undefined;
    try {
      await f.send('original'); await until(async () => (await f.snapshot()).execution?.phase === 'running');
      const execution = (await f.snapshot()).execution!;
      const request = f.http(80).post({ message: '/stop', expectedRunId: execution.id, idempotencyKey: 'shutdown-stop' });
      await until(() => f.calls[0]!.interruptions === 1);
      assert.equal((await request).status, 503);
      let drained = false;
      closing = f.driver.close().then(() => { drained = true; });
      assert.equal(f.driver.close(), f.driver.close(), 'shutdown shares the original drain');
      f.calls[0]!.cleanup();
      await delay(0); assert.equal(drained, false, 'physical cleanup alone cannot forget pending ACK');
      ack.release(); await closing; assert.equal(drained, true);
      const recovered = await f.owner.command('sdkMessageReceiptRead', { runtime, key: f.key, authorization, commandKey: 'shutdown-stop' });
      assert.ok('receipt' in recovered); assert.equal(recovered.receipt?.state, 'accepted');
      assert.equal(f.calls[0]!.interruptions, 1);
    } finally { ack.release(); await closing?.catch(() => {}); await f.dispose(); }
  });

  test(`${runtime}: original compact physical ownership blocks message FIFO until strict exit and settlement`, async () => {
    const result = gate(), physical = gate();
    let quiet = false, starts = 0, closes = 0;
    const f = await fixture(runtime, { compact: { models: { model: 'default' }, start(execution) {
      starts++;
      return { result: result.promise.then(() => ({ ...execution, nativeRequestId: execution.id,
        completionEventId: 'boundary', outcome: 'completed' as const })), finished: physical.promise,
        inspectQuiescence: async () => quiet,
        inspectSettlement: async () => ({ ...execution, completionEventId: 'boundary', historyPersisted: true, nativeQuiescent: true }),
        interrupt: async () => {}, close: () => { closes++; } };
    } } });
    try {
      await f.send('initial'); await until(async () => (await f.snapshot()).execution?.phase === 'running');
      f.calls[0]!.finish(); await until(() => f.driver.inspect().retainedIntents === 0);
      await f.driver.wake(f.key);
      const task = f.driver.compact(f.key, 'compact-one', authorization); await until(() => starts === 1);
      await f.send('after compact'); result.release(); await f.driver.wake(f.key);
      assert.equal(f.calls.length, 1); assert.equal(f.driver.inspect().nativeWorkers, 1);
      quiet = true; physical.release(); assert.equal(await task, 'accepted');
      await until(async () => f.calls.length === 2 && (await f.snapshot()).execution?.phase === 'running');
      assert.equal(f.calls[1]!.text, 'after compact'); assert.equal(starts, 1); assert.equal(closes, 1);
      f.calls[1]!.finish(); await until(() => f.driver.inspect().retainedIntents === 0);
      await f.driver.close(); assert.equal(f.driver.inspect().faulted, false);
    } finally { quiet = true; result.release(); physical.release(); await f.dispose(); }
  });
  test(`${runtime}: actual adapter and worker FIFO/batch persist original transcript across reopen, observer failure is isolated`, async () => {
    const f = await fixture(runtime);
    try {
      await f.send('one'); await until(async () => (await f.snapshot()).execution?.phase === 'running');
      await f.send('two'); await f.send('three');
      await f.driver.wake(f.key); assert.equal(f.calls.length, 1);
      f.calls[0]!.finish();
      await until(async () => f.calls.length === 2 && (await f.snapshot()).execution?.phase === 'running');
      assert.equal(f.calls[1]!.execution.nativeMode, 'resume');
      assert.equal(f.calls[1]!.execution.members.length, 2);
      assert.match(f.calls[1]!.text, /^two\n\n\[Queued message boundary [a-f0-9-]+\]\n\nthree$/);
      f.calls[1]!.finish(); await until(() => f.driver.inspect().retainedIntents === 0);
      assert.equal((await f.snapshot()).execution?.phase, 'completed');
      assert.equal(f.driver.inspect().faulted, false);
      await f.driver.close(); await f.owner.close();
      const reopened = new ConnectorUserStore(f.file);
      try {
        const journal = runtime === 'claude-code' ? reopened.claudeJournal : reopened.copilotJournal;
        const transcript = runtime === 'claude-code' ? reopened.claudeTranscript : reopened.copilotTranscript;
        assert.equal(journal.current(f.key)?.phase, 'completed');
        // Copilot preserves all three original queued user identities, while
        // Claude's native batch echo is one user record for the second turn.
        assert.equal(transcript.page(f.key)?.messages.length, runtime === 'ghcp' ? 5 : 4);
        assert.equal(reopened.turns.maintenanceCount(), 0);
      } finally { reopened.close(); }
    } finally { await f.dispose(); }
  });

  test(`${runtime}: original attachments reach vendor starter, without synchronous store lookup`, async () => {
    const f = await fixture(runtime), media = [{ name: 'original.txt', mimeType: 'text/plain', data: Buffer.from('original attachment').toString('base64') }];
    try {
      await f.send('with attachment', media);
      await until(async () => (await f.snapshot()).execution?.phase === 'running');
      assert.deepEqual(f.calls[0]!.attachments, media);
      f.calls[0]!.finish(); await until(() => f.driver.inspect().retainedIntents === 0);
      await f.driver.close();
      assert.ok(!f.logs.join('').includes('original attachment'));
    } finally { await f.dispose(); }
  });

  test(`${runtime}: maintenance pause allows settlement, one-use resume scans worker FIFO and never resends`, async () => {
    const f = await fixture(runtime);
    try {
      await f.send('first'); await until(async () => (await f.snapshot()).execution?.phase === 'running');
      await f.send('waiting');
      const lease = f.driver.pauseQueueWorker(); assert.equal(lease.resume(), false); await lease.drained;
      f.calls[0]!.finish(); await until(() => f.driver.inspect().retainedIntents === 0);
      assert.equal(f.calls.length, 1); assert.equal(lease.resume(), true); assert.equal(lease.resume(), false);
      await until(async () => f.calls.length === 2 && (await f.snapshot()).execution?.phase === 'running');
      assert.equal(f.calls[1]!.text, 'waiting'); f.calls[1]!.finish();
      await until(() => f.driver.inspect().retainedIntents === 0);
    } finally { await f.dispose(); }
  });

  test(`${runtime}: native physical cleanup barrier holds successor and database close`, async () => {
    const f = await fixture(runtime, { holdCleanup: true });
    try {
      await f.send('first'); await until(async () => (await f.snapshot()).execution?.phase === 'running');
      await f.send('waiting'); f.calls[0]!.finish();
      await until(async () => (await f.snapshot()).execution?.phase === 'settling');
      await f.driver.wake(f.key); assert.equal(f.calls.length, 1);
      let closed = false; const closing = f.driver.close().then(() => { closed = true; });
      await delay(10); assert.equal(closed, false); assert.equal(f.calls.length, 1);
      f.calls[0]!.cleanup(); await closing;
      assert.equal(f.driver.inspect().nativeWorkers, 0);
      assert.equal((await f.snapshot()).execution?.phase, 'unknown');
    } finally { await f.dispose(); }
  });

  test(`${runtime}: pause does not suppress a worker-authorized interrupt`, async () => {
    const f = await fixture(runtime);
    try {
      await f.send('interrupt'); await until(async () => (await f.snapshot()).execution?.phase === 'running');
      const lease = f.driver.pauseQueueWorker(); await lease.drained;
      const execution = (await f.snapshot()).execution!;
      const principal = await f.owner.command('tokenAuthenticate', { authorization });
      assert.ok(principal);
      const actor = { actorId: principal.tokenId, text: '', images: [] as [] };
      // The actor id comes from the original credential, not an HTTP
      // caller-invented approved boolean. Worker rechecks it at stop claim.
      assert.equal(await f.driver.interrupt(f.key, 'stale', actor), 'not_started');
      assert.equal(await f.driver.interrupt(f.key, execution.id, actor), 'accepted');
      await until(() => f.driver.inspect().retainedIntents === 0);
      assert.equal((await f.snapshot()).execution?.phase, 'interrupted');
    } finally { await f.dispose(); }
  });

  test(`${runtime}: failed projection ACK fences admission and retains unknown, not a false completion`, async () => {
    const failedAck = gate(), appended = gate();
    const f = await fixture(runtime, { proxy: owner => ({ command: (async (kind, input) => {
      const value = await owner.command(kind, input);
      if (kind === 'sdkTranscriptAppend') { appended.release(); await failedAck.promise; return { ...value as object, applied: false }; }
      return value;
    }) as typeof owner.command }) });
    try {
      await f.send('first'); await appended.promise;
      await until(async () => (await f.snapshot()).execution?.phase === 'running');
      await f.send('waiting'); failedAck.release();
      await until(async () => (await f.snapshot()).execution?.phase === 'unknown');
      f.calls[0]!.finish();
      await until(async () => (await f.snapshot()).execution?.phase === 'unknown');
      await f.driver.wake(f.key); assert.equal(f.calls.length, 1);
      assert.equal(f.driver.inspect().faulted, false);
      const lease = f.driver.pauseQueueWorker(); await lease.drained; assert.equal(lease.resume(), true);
      await f.driver.close();
      assert.ok(!f.logs.join('').includes('secret native'));
    } finally { failedAck.release(); await f.dispose(); }
  });

  test(`${runtime}: terminal timeout retains original late persistence and drains it before close, no successor replay`, async () => {
    const appendAck = gate(), appended = gate();
    let hold = true;
    const f = await fixture(runtime, { deadlineMs: 40, proxy: owner => ({ command: (async (kind, input) => {
      const value = await owner.command(kind, input);
      if (kind === 'sdkTranscriptAppend' && hold) { appended.release(); await appendAck.promise; }
      return value;
    }) as typeof owner.command }) });
    try {
      await f.send('first'); await appended.promise;
      await until(async () => (await f.snapshot()).execution?.phase === 'running');
      await f.send('waiting'); f.calls[0]!.finish();
      await until(async () => (await f.snapshot()).execution?.phase === 'unknown');
      let closed = false; const closing = f.driver.close().then(() => { closed = true; });
      await delay(10); assert.equal(closed, false); assert.equal(f.calls.length, 1);
      hold = false; appendAck.release(); await closing;
      assert.equal((await f.snapshot()).execution?.phase, 'unknown');
    } finally { hold = false; appendAck.release(); await f.dispose(); }
  });

  test(`${runtime}: Promise-shaped readiness is never permission to start`, async () => {
    const f = await fixture(runtime, { ready: (() => Promise.resolve(true)) as unknown as () => boolean });
    try {
      await f.send('waiting'); await f.driver.wake(f.key);
      assert.equal(f.calls.length, 0); assert.equal((await f.snapshot()).execution, null);
      await f.driver.close();
    } finally { await f.dispose(); }
  });

  test(`${runtime}: native cleanup failure permanently fences admission and is observable on close`, async () => {
    const f = await fixture(runtime, { badCleanup: true });
    try {
      await f.send('first'); await until(async () => (await f.snapshot()).execution?.phase === 'running');
      await f.send('waiting'); f.calls[0]!.finish();
      await until(() => f.driver.inspect().cleanupUnconfirmed);
      await f.driver.wake(f.key); assert.equal(f.calls.length, 1);
      await assert.rejects(f.driver.close(), /cleanup could not be confirmed/);
      assert.equal((await f.snapshot()).execution?.phase, 'unknown');
    } finally { await f.dispose(); }
  });

  test(`${runtime}: revoked current token cannot interrupt or start a queued successor on resume`, async () => {
    const f = await fixture(runtime);
    try {
      await f.send('first'); await until(async () => (await f.snapshot()).execution?.phase === 'running');
      await f.send('waiting'); const pause = f.driver.pauseQueueWorker(); await pause.drained;
      const principal = await f.owner.command('tokenAuthenticate', { authorization }); assert.ok(principal);
      assert.equal(await f.owner.command('tokenRevoke', { tokenId: principal.tokenId }), true);
      const execution = (await f.snapshot()).execution!;
      assert.equal(await f.driver.interrupt(f.key, execution.id, { actorId: principal.tokenId, text: '', images: [] }), 'blocked');
      f.calls[0]!.finish(); await until(() => f.driver.inspect().retainedIntents === 0);
      assert.equal(pause.resume(), true);
      await until(() => f.driver.inspect().admissionInFlight === 0);
      assert.equal(f.calls.length, 1); await f.driver.close();
    } finally { await f.dispose(); }
  });

  test(`${runtime}: all native turns are closed despite one close throwing, failure is sanitized and physical writes drain`, async () => {
    const f = await fixture(runtime, { closeThrows: true });
    try {
      await f.send('first'); await until(async () => (await f.snapshot()).execution?.phase === 'running');
      const created = await f.owner.command('sdkSessionCreate', { runtime, authorization, commandKey: 'second-session', payloadJson: '{}' });
      assert.ok('receipt' in created && created.key);
      await f.owner.command('sdkMessageSend', { runtime, authorization, key: created.key, commandKey: 'second-send', payloadJson: '{"message":"second"}' });
      await f.driver.wake(created.key); assert.equal(f.calls.length, 2);
      await assert.rejects(f.driver.close(), /cleanup could not be confirmed/);
      assert.ok(f.calls.every(call => call.closed > 0));
      assert.equal(f.driver.inspect().nativeWorkers, 0);
      assert.equal(f.driver.inspect().cleanupUnconfirmed, true);
      assert.ok(!f.logs.join('').includes('secret native close error'));
    } finally { await f.dispose(); }
  });

  test(`${runtime}: in-process recovery releases cleaned unknown intent, projection lane and adapter slot for successor turns`, async () => {
    const f = await fixture(runtime);
    try {
      await f.send('first'); await until(async () => (await f.snapshot()).execution?.phase === 'running');
      const failedRun = (await f.snapshot()).execution!;
      f.calls[0]!.fail();
      await until(async () => (await f.snapshot()).execution?.phase === 'unknown' && f.driver.canRecover(f.key, failedRun.id));
      assert.equal(f.driver.inspect().retainedIntents, 1);
      assert.equal(f.driver.isOccupied(f.key), true);
      assert.equal(f.driver.canRecover(f.key, 'wrong-run-id'), false);
      const recovered = await f.owner.command('sdkSessionRecover', { runtime, key: f.key, authorization, expectedRunId: failedRun.id });
      assert.deepEqual(recovered, { requested: true });
      await f.driver.releaseRecovered(f.key, failedRun.id);
      assert.equal(f.driver.inspect().retainedIntents, 0);
      assert.equal(f.driver.isOccupied(f.key), false);
      await f.send('after recovery');
      await until(async () => f.calls.length === 2 && (await f.snapshot()).execution?.phase === 'running');
      assert.equal(f.calls[1]!.text, 'after recovery');
      f.calls[1]!.finish();
      await until(() => f.driver.inspect().retainedIntents === 0);
      assert.equal((await f.snapshot()).execution?.phase, 'completed');
      assert.equal(f.driver.inspect().faulted, false);
      await f.driver.close();
    } finally { await f.dispose(); }
  });
}
