import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncConnectorEventProjection } from './async-event-projection.js';
import { AsyncSdkApplication, type AsyncSdkApplicationPorts } from './async-sdk-application.js';
import { DeckStore } from '../projection/deck-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerSdkMessagesHttp } from './sdk-messages-http.js';
import { registerSdkLocalHttp } from './sdk-local-http.js';
import { registerSdkQueueHttp } from './sdk-queue-http.js';
import { registerSdkDeletionHttp } from './sdk-deletion-http.js';
import { registerSdkCompactHttp } from './sdk-compact-http.js';
import { registerSdkInteractionsHttp } from './sdk-interactions-http.js';
import { registerSdkHistoryHttp } from './sdk-history-http.js';
import { registerSdkUsageHttp } from './sdk-usage-http.js';
import { registerSdkFilesHttp } from './sdk-files-http.js';
import { registerSdkMetadataHttp } from './sdk-metadata-http.js';
import { WorkerInteractionPort, type WorkerInteractionContext } from '../commands/interaction-port.js';
import type { SdkExecution } from './sdk-execution-journal.js';
import type { InteractionParentFrame } from '../commands/interaction-wire.js';
import { CLAUDE_CLI_VERSION } from '../claude/dispatch-adapter.js';
import { COPILOT_CLI_VERSION, type CopilotHistoryIdentity } from '../copilot/dispatch-adapter.js';
import { projectClaudeMessage } from '../claude/message-projection.js';
import { projectCopilotMessage } from '../copilot/message-projection.js';
import type { SdkAgentId } from './sdk-execution-journal.js';
import { createAsyncCodexRuntime } from './async-codex-runtime.js';
import { createAsyncRuntimeMaintenanceInspection } from './async-runtime-maintenance-inspection.js';
import { RuntimeMaintenancePersistence } from './runtime-maintenance-persistence.js';
import { AsyncUpdatePersistence } from './async-update-persistence.js';
import { ConnectorUpdateService } from './update-service.js';
import { loadConfig } from '../config.js';
import { CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { EXPECTED_NODE_HEADER } from './node-identity.js';
import { createApplicationCommandScopes } from '../auth/application-command-scope.js';
import { createApplicationMessageIngress } from '../application-message-ingress.js';
import { NativeOperationError } from './native-operation.js';

const authorization = 'Bearer isolated-sdk-application';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function until(predicate: () => boolean | Promise<boolean>) {
  const end = Date.now() + 5_000;
  while (!await predicate()) { assert.ok(Date.now() < end, 'original SDK assembly did not converge'); await tick(); }
}
async function fixture(runtime: SdkAgentId, options: { disabled?: boolean; holdCreateAck?: boolean; holdMessageAck?: boolean; interaction?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-app-')), homeDirectory = join(root, 'home');
  mkdirSync(homeDirectory, { mode: 0o700 });
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => { logs.push(line); });
  const owner = new AsyncConnectorOwner({ file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json'),
    bootstrapToken: authorization.slice(7), sdkModels: { [runtime]: { model: 'default', modelChoices: ['default', 'alternate'] } } }, diagnostics);
  await owner.open();
  const ack = gate(), submitted = gate(), messageAck = gate(), messageSubmitted = gate();
  let creates = 0, sends = 0, checks = 0, starts = 0, interruptions = 0;
  const port: Pick<AsyncConnectorOwner, 'command' | 'runtimeOwnerFile'> = {
    get runtimeOwnerFile() { return owner.runtimeOwnerFile; },
    command: (async (kind, input) => {
      const result = await owner.command(kind, input);
      if (kind === 'sdkSessionCreate') { creates++; submitted.release(); if (options.holdCreateAck) await ack.promise; }
      if (kind === 'sdkMessageSend') { sends++; messageSubmitted.release(); if (options.holdMessageAck) await messageAck.promise; }
      return result;
    }) as AsyncConnectorOwner['command'],
  };
  const deck = new DeckStore();
  const config = { homeDirectory, workspace: root, sdkDirectory: root, startupTimeoutMs: 1_000,
    apiKeyFile: join(root, 'absent-key'), model: 'default', modelChoices: ['default', 'alternate'], baseUrl: 'http://127.0.0.1:1',
    auth: { mode: 'github' as const, credentialFile: join(root, 'absent-key') } };
  const check = () => { checks++; return { ready: Promise.resolve(true), finished: Promise.resolve(), inspectQuiescence: () => true, close() {} }; };
  const native = () => {
    starts++; const input = gate(), finished = gate(); let quiet = false, stopped = false;
    return { input, finished, stopped: () => stopped, quiet: async () => quiet,
      interrupt: async () => { interruptions++; stopped = true; input.release(); }, close: () => input.release(),
      ended: () => { quiet = true; finished.release(); } };
  };
  const interactionFrames: InteractionParentFrame[] = [];
  let interactionPort: WorkerInteractionPort | undefined;
  const interaction = (execution: SdkExecution, context?: WorkerInteractionContext) => {
    if (!options.interaction) return;
    assert.ok(context, 'original owned runtime must receive the worker-backed interaction context');
    const identity = { executionId: execution.id, epoch: execution.epoch };
    interactionPort = new WorkerInteractionPort(identity, context, frame => {
      interactionFrames.push(frame);
      if (frame.kind === 'interaction-answer') queueMicrotask(() => interactionPort!.receive({ ...identity, requestId: frame.requestId, kind: 'interaction-ack' }));
    }, () => true);
    // Original readiness is acknowledged after start; ask only once it is live.
    void until(async () => (await owner.command('sdkSnapshotRead', { runtime, key: execution.key })).execution?.phase === 'running')
      .then(() => interactionPort!.receive({ ...identity, requestId: 'native-question', kind: 'interaction-request', question: { kind: 'text', prompt: 'Original native question' } }));
  };
  const ports: AsyncSdkApplicationPorts = runtime === 'claude-code' ? { claude: { check,
    start(execution, text, projection, _context, _attachments, context) {
      interaction(execution, context);
      const c = native(), session_id = execution.nativeSessionId;
      return { finished: c.finished.promise, inspectQuiescence: c.quiet, interrupt: c.interrupt, close: c.close,
        historyIdentities: async () => [{ type: 'user', uuid: execution.id, session_id, parent_tool_use_id: null }],
        async *[Symbol.asyncIterator]() {
          try {
            yield { type: 'system', subtype: 'init', session_id, claude_code_version: CLAUDE_CLI_VERSION };
            const message = { type: 'user', uuid: execution.id, session_id, parent_tool_use_id: null, message: { role: 'user', content: text } };
            projection.project(projectClaudeMessage(message, session_id)); yield message;
            await c.input.promise;
            yield { type: 'result', uuid: randomUUID(), session_id, user_message_uuid: execution.id,
              subtype: c.stopped() ? 'error_during_execution' : 'success', is_error: c.stopped() };
          } finally { c.ended(); }
        } };
    } } } : { copilot: { check,
    start(execution, text, projection, _context, _attachments, context) {
      interaction(execution, context);
      const c = native(), inputId = randomUUID(), inputEvent = randomUUID(), history: CopilotHistoryIdentity[] = [];
      return { finished: c.finished.promise, inspectQuiescence: c.quiet, interrupt: c.interrupt, close: c.close,
        verified: Promise.resolve({ sessionId: execution.nativeSessionId, version: COPILOT_CLI_VERSION, protocolVersion: 3 }),
        admitted: Promise.resolve({ messageId: inputId }), historyIdentities: async () => ({ sessionId: execution.nativeSessionId, entries: history }),
        async *[Symbol.asyncIterator]() {
          try {
            const message = { id: inputEvent, type: 'user.message', timestamp: new Date().toISOString(), data: { messageId: inputId, content: text } };
            projection.project(projectCopilotMessage(message)!); yield message;
            history.push({ id: inputEvent, type: 'user.message', messageId: inputId });
            await c.input.promise; yield { id: randomUUID(), type: 'session.idle', data: { aborted: c.stopped() } };
          } finally { c.ended(); }
        } };
    } } };
  const application = new AsyncSdkApplication({ owner: port, projection: deck, diagnostics,
    ...(!options.disabled ? runtime === 'ghcp' ? { copilot: config } : { claude: config } : {}) }, ports);
  const app = new Hono(), base = '/api/connector/v1', path = `${base}/sessions/:sessionKey`;
  registerSdkMessagesHttp(app, path, application.http.sdkMessages);
  registerSdkLocalHttp(app, base, application.http.sdkLocal);
  registerSdkQueueHttp(app, path, application.http.sdkQueue);
  registerSdkDeletionHttp(app, path, application.http.sdkDeletion);
  registerSdkCompactHttp(app, path, application.http.sdkCompact);
  registerSdkInteractionsHttp(app, path, application.http.sdkInteractions);
  registerSdkHistoryHttp(app, path, application.http.sdkHistory);
  registerSdkUsageHttp(app, path, application.http.sdkUsage);
  registerSdkFilesHttp(app, path, application.http.sdkFiles);
  registerSdkMetadataHttp(app, base, application.http.sdkMetadata);
  const request = (path: string, method = 'GET', body?: unknown) => app.request(`${base}${path}`, {
    method, headers: { authorization, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const target = runtime === 'ghcp' ? application.copilot : application.claude;
  const marker = join(homeDirectory, runtime === 'ghcp' ? '.agentopsdeck-copilot-owner' : '.agentopsdeck-claude-owner');
  const activate = async () => { application.activate(); await until(() => target?.ready === true); };
  const create = () => request(`/agents/${runtime}/sessions`, 'POST', { title: 'Original SDK app', idempotencyKey: 'app-create' });
  return { root, owner, application, app, request, target, marker, deck, activate, create, ack, submitted, messageAck, messageSubmitted, runtime, logs,
    interactionFrames, counts: () => ({ creates, sends, checks, starts, interruptions }),
    close: async () => { ack.release(); messageAck.release(); interactionPort?.close(); try { await application.close(); } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); } } };
}

for (const runtime of ['claude-code', 'ghcp'] as const) {
  for (const failed of [false, true]) test(`${runtime}: original application scope retains actual SDK notification ${failed ? 'failure' : 'completion'} through joint close`, { timeout: 20_000 }, async t => {
    const f = await fixture(runtime), entered = gate(), notification = gate();
    const scopes = createApplicationCommandScopes({ authorize: () => true, assertAvailable() {}, diagnostics: new PerformanceDiagnostics(() => {}) });
    let notices = 0, scopeClosed = false, applicationClosed = false;
    try {
      await f.activate(); assert.ok(f.target);
      const created = await (await f.create()).json() as { key: string };
      f.target.withRetainedOwner(original => t.mock.method(original.driver, 'wake', async () => {
        notices++; entered.release(); await notification.promise;
        if (failed) throw Error('isolated original notification failure');
      }));
      const ingress = createApplicationMessageIngress(scopes, { sdk: f.application.http.sdkMessages.messages });
      const receiptScope = { runtime, key: created.key, authorization, commandKey: 'scope-original-notification' };
      const input = { ...receiptScope, payloadJson: '{"message":"retained notification"}' };
      const sending = ingress.sdk(new Request('http://application.invalid/'), input, { timeoutMs: 10 });
      const expired = assert.rejects(sending, error => error instanceof NativeOperationError && error.outcome === 'unknown');
      await entered.promise; await expired;
      const receipt = await f.owner.command('sdkMessageSendReceiptRead', receiptScope);
      assert.ok('receipt' in receipt && receipt.receipt?.state === 'accepted');
      assert.equal(scopes.pending, 1, 'actual notification belongs to original application scope, not just SDK pending tasks');
      const scopeClosing = scopes.close().then(() => { scopeClosed = true; });
      const applicationClosing = f.application.close().then(() => { applicationClosed = true; });
      await tick(); assert.equal(scopeClosed, false); assert.equal(applicationClosed, false);
      notification.release(); await Promise.all([scopeClosing, applicationClosing]);
      assert.equal(scopes.pending, 0); assert.equal(notices, 1); assert.equal(f.counts().starts, 0);
      assert.deepEqual(await f.owner.command('sdkMessageSendReceiptRead', receiptScope), receipt, 'notification outcome does not rewrite original committed receipt');
    } finally { notification.release(); await scopes.close(); await f.close(); }
  });

  test(`${runtime}: parent close drains original committed message ACK, freezes admission, and retains borrowed worker receipt`, { timeout: 20_000 }, async () => {
    const f = await fixture(runtime, { holdMessageAck: true });
    try {
      await f.activate();
      const created = await (await f.create()).json() as { key: string };
      const scope = { runtime, key: created.key, authorization, commandKey: 'late-original-message' };
      const sending = f.application.http.sdkMessages.messages.send({ ...scope, payloadJson: '{"message":"original native input"}' }, { timeoutMs: 1 });
      await assert.rejects(sending); await f.messageSubmitted.promise;
      const receipt = await f.owner.command('sdkMessageSendReceiptRead', scope);
      assert.ok('receipt' in receipt && receipt.receipt?.state === 'accepted');
      let closed = false;
      const closing = f.application.close().then(() => { closed = true; });
      await tick(); assert.equal(closed, false);
      await assert.rejects(f.application.http.sdkMessages.messages.send({ ...scope, commandKey: 'must-not-send', payloadJson: '{}' }, { timeoutMs: 1_000 }));
      assert.equal(f.counts().sends, 1); assert.equal(f.counts().starts, 0);
      f.messageAck.release(); await closing;
      assert.equal(f.counts().starts, 0, 'late admission notification cannot start native work after close');
      assert.deepEqual(await f.owner.command('sdkMessageSendReceiptRead', scope), receipt);
      assert.ok(await f.owner.command('tokenAuthenticate', { authorization }));
    } finally { await f.close(); }
  });

  test(`${runtime}: original directory refresh remains physically owned through application close`, { timeout: 20_000 }, async t => {
    const f = await fixture(runtime), held = gate(); let entered = false, closed = false;
    try {
      await f.activate(); assert.ok(f.target);
      t.mock.method(f.target, 'refreshDirectory', async () => { entered = true; await held.promise; });
      const reading = f.application.refreshDirectories(), rejected = assert.rejects(reading);
      await until(() => entered);
      const closing = f.application.close().then(() => { closed = true; });
      await assert.rejects(f.application.refreshDirectories());
      await tick(); assert.equal(closed, false);
      held.release(); await rejected; await closing;
      assert.equal(f.counts().starts, 0, 'Directory refresh does not start native execution');
      assert.ok(await f.owner.command('tokenAuthenticate', { authorization }));
    } finally { held.release(); await f.close(); }
  });

  test(`${runtime}: original SDK maintenance facts compose with Codex and the same worker owner`, { timeout: 20_000 }, async () => {
    const f = await fixture(runtime);
    const nodeId = await f.owner.command('nodeIdentity', {});
    const diagnostics = new PerformanceDiagnostics(() => {});
    const native = createAsyncCodexRuntime({ owner: f.owner, nodeId, deck: f.deck,
      native: { enabled: false, command: 'must-not-launch', defaultCwd: f.root, defaultModel: 'default', approvalPolicy: 'never' },
      snapshot: capture => capture('joint-maintenance'), diagnostics });
    const authority = new AsyncUpdatePersistence(f.owner, nodeId, diagnostics);
    const persistence = new RuntimeMaintenancePersistence(authority.maintenance, diagnostics);
    const updater = new ConnectorUpdateService(loadConfig({ AOD_CONNECTOR_UPDATE_ENABLED: 'false',
      AOD_CONNECTOR_UPDATE_STATE_FILE: join(f.root, 'unused-update.json') }), authority);
    assert.ok(f.target);
    const inspection = createAsyncRuntimeMaintenanceInspection({ nodeId, updateService: updater, persistence,
      codex: native, sdk: [f.target], requests: { isStopping: () => false, isPaused: () => false, activeWrites: () => 0 },
      unsupportedNative: () => false, probes: () => 0 });
    try {
      await f.activate(); await native.open();
      const lifecycle = await f.owner.command('tokenCreate', { label: 'joint inspection', scopes: ['connector:lifecycle'] });
      const request = new Request('http://local/maintenance', { headers: { authorization: `Bearer ${lifecycle.token}`,
        [CONNECTOR_PROTOCOL_HEADER]: '1', [EXPECTED_NODE_HEADER]: nodeId } });
      const sdk = await f.target.inspectMaintenance();
      assert.equal(sdk.ownershipHeld, true);
      assert.equal(sdk.nativeWorkers, 0);
      assert.equal(sdk.admissionInFlight, 0);
      assert.equal(sdk.startupWorkers, 0);
      const observation = await authority.run(request, 'readiness', operator => inspection.inspect(operator.check, () => {}));
      assert.equal(observation.nodeId, nodeId);
      assert.equal(observation.nativeVerified, true);
      assert.equal(observation.activeRuns, 0);
      assert.equal(observation.inFlightWrites, 0);
      observation.assertCurrent();
      assert.equal(f.counts().starts, 0, 'inspection must not launch a model turn');
      await f.application.close();
      assert.throws(observation.assertCurrent, 'SDK close invalidates an already captured joint observation');
      assert.equal(await f.owner.command('nodeIdentity', {}), nodeId, 'SDK close retains shared owner');
    } finally {
      await inspection.close(); await native.close(); await persistence.close(); await authority.close(); await f.close();
    }
  });

  test(`${runtime}: application authoritative refresh observes committed facts without a notifier or new execution`, { timeout: 20_000 }, async () => {
    const f = await fixture(runtime);
    // This fixture contains only this SDK vendor: the callback covers its
    // captured fragment, not an assertion about the production-wide Deck.
    const events = new AsyncConnectorEventProjection(f.owner, new PerformanceDiagnostics(() => {}));
    let refreshes = 0;
    const refresh = async () => { refreshes++; await f.application.refreshProjection(); };
    try {
      await assert.rejects(f.application.refreshProjection());
      await f.activate();
      const reader = await f.owner.command('tokenCreate', { label: 'Current HTTP reader', scopes: ['messages:read', 'models:read', 'queue:manage'] });
      const read = (path: string) => f.app.request(`/api/connector/v1${path}`, { headers: { authorization: `Bearer ${reader.token}` } });
      const created = await f.owner.command('sdkSessionCreate', { runtime, authorization, commandKey: 'barrier-create', payloadJson: '{"title":"Unnotified"}' });
      assert.ok('receipt' in created && created.key);
      assert.equal(f.deck.getSession(created.key!), undefined);
      const snapshot = await events.snapshot(cursor => ({ cursor, session: f.deck.getSession(created.key!) }), refresh);
      assert.equal(snapshot.session?.title, 'Unnotified');
      assert.equal(snapshot.cursor, (await events.replay(null)).cursor);
      const stableRefreshes = refreshes, stableHead = await f.owner.command('eventProjectionHead', {});
      for (const path of [`/models/${runtime}`, `/sessions/${created.key!}/state`, `/sessions/${created.key!}/messages`,
        `/sessions/${created.key!}/queue`, `/sessions/${created.key!}/token-usage?from=0&to=120000&bucketMs=60000`,
        `/sessions/${created.key!}/token-usage/export?from=0&to=120000&bucketMs=60000`]) {
        const response = await read(path); assert.equal(response.status, 200, path);
        await response.json();
        const observed = await events.snapshot((): import('@agentopsdeck/shared').SessionSummary | undefined => f.deck.getSession(created.key!), refresh);
        assert.equal(observed?.title, 'Unnotified');
        assert.equal(refreshes, stableRefreshes, 'HTTP observation must not trigger a full session scan');
        assert.deepEqual(await f.owner.command('eventProjectionHead', {}), stableHead);
      }
      const beforeModel = await f.owner.command('eventProjectionHead', {});
      const changed = await f.owner.command('sdkModelUpdate', { runtime, key: created.key!, authorization, commandKey: 'barrier-model', payloadJson: '{"model":"alternate"}' });
      assert.ok('receipt' in changed && changed.receipt.state === 'accepted');
      const afterModel = await f.owner.command('eventProjectionHead', {});
      assert.equal(afterModel.cursor, beforeModel.cursor);
      assert.notEqual(afterModel.version, beforeModel.version);
      const updated = await events.snapshot(() => f.deck.getSession(created.key!), refresh);
      assert.equal(updated?.model, 'alternate');
      assert.ok(refreshes > stableRefreshes, 'model commit must invalidate the checkpoint even with an unchanged display cursor');
      const head = f.deck.latestEventId();
      await events.snapshot(() => f.deck.getSession(created.key!), refresh);
      assert.equal(f.deck.latestEventId(), head);
      await f.owner.command('tokenRevoke', { tokenId: reader.record.id });
      for (const path of [`/models/${runtime}`, `/sessions/${created.key!}/messages`, `/sessions/${created.key!}/state`]) {
        const response = await read(path); assert.equal(response.status, 401, 'projection cache must never cache reader authority');
      }
      const revokedRefreshes = refreshes;
      await events.snapshot(() => f.deck.getSession(created.key!), refresh);
      assert.ok(refreshes > revokedRefreshes, 'authority mutation also invalidates the fact checkpoint');
      assert.equal(f.counts().starts, 0);
      await f.application.close(); await assert.rejects(f.application.refreshProjection());
    } finally { await events.close(); await f.close(); }
  });

  test(`${runtime}: complete SDK application interaction HTTP uses original native handle and durable ACK`, { timeout: 20_000 }, async () => {
    const f = await fixture(runtime, { interaction: true });
    try {
      await f.activate(); const created = await f.create(); assert.equal(created.status, 201); const key: string = (await created.json()).key;
      assert.equal((await f.request(`/sessions/${key}/interaction-mode`, 'PATCH', { mode: 'interactive' })).status, 200);
      assert.equal((await f.request(`/sessions/${key}/messages`, 'POST', { message: 'Original native input', idempotencyKey: 'interactive-message' })).status, 200);
      let view: import('../commands/interaction-runtime.js').InteractionView | undefined;
      await until(async () => { const response = await f.request(`/sessions/${key}/interactions`); assert.equal(response.status, 200);
        view = (await response.json()).requests.find((v: { status: string }) => v.status === 'pending'); return !!view; });
      assert.ok(view);
      const body = { runId: view.request.runId, expectedRevision: view.revision, responseId: 'original-browser-response', answer: { kind: 'text', text: 'Original browser answer' } };
      const path = `/sessions/${key}/interactions/${view.request.requestId}/answer`;
      const answer = await f.request(path, 'POST', body); assert.equal(answer.status, 200); assert.equal((await answer.json()).delivery, 'confirmed');
      assert.equal((await f.request(path, 'POST', body)).status, 200);
      assert.equal(f.interactionFrames.filter(v => v.kind === 'interaction-answer').length, 1);
      await f.application.close();
      assert.equal((await f.request(`/sessions/${key}/interactions`)).status, 503);
      assert.ok(await f.owner.command('tokenAuthenticate', { authorization }));
    } finally { await f.close(); }
  });
  test(`${runtime}: complete SDK HTTP bundle owns original worker, native stop during maintenance and recovery`, { timeout: 20_000 }, async () => {
    const f = await fixture(runtime);
    try {
      assert.deepEqual(f.counts(), { creates: 0, sends: 0, checks: 0, starts: 0, interruptions: 0 }); assert.equal(existsSync(f.marker), false);
      await f.activate(); assert.equal(existsSync(f.marker), true); assert.equal(f.application.agents.length, 1);
      const created = await f.create(); assert.equal(created.status, 201); const body = await created.json(), key: string = body.key;
      await until(() => f.deck.getSession(key)?.title === 'Original SDK app');
      const updated = await f.request(`/sessions/${key}`, 'PATCH', { model: 'alternate', idempotencyKey: 'app-model' });
      assert.equal(updated.status, 200); await until(() => f.deck.getSession(key)?.model === 'alternate');
      const send = await f.request(`/sessions/${key}/messages`, 'POST', { message: 'Original native input', idempotencyKey: 'app-message' });
      assert.equal(send.status, 200); await until(async () => (await f.owner.command('sdkSnapshotRead', { runtime, key })).execution?.phase === 'running');
      assert.equal(f.counts().starts, 1);
      const state = await f.request(`/sessions/${key}/state`); assert.equal(state.status, 200);
      const executionState = await state.json(); assert.equal(executionState.sessionKey, key);
      assert.equal(executionState.status, 'running'); assert.equal(executionState.runtime.phase, 'running');
      assert.equal(executionState.runtime.connection, 'connected'); assert.equal(typeof executionState.sourceCursor, 'string');
      assert.equal((await f.request(`/models/${runtime}`)).status, 403, 'bootstrap has no implicit model scope');
      const modelToken = await f.owner.command('tokenCreate', { label: 'models reader', scopes: ['models:read'] });
      const models = await f.app.request(`/api/connector/v1/models/${runtime}`, { headers: { authorization: `Bearer ${modelToken.token}` } }); assert.equal(models.status, 200);
      assert.deepEqual(await models.json(), { models: [{ id: 'default', label: 'default' }, { id: 'alternate', label: 'alternate' }] });
      const history = await f.request(`/sessions/${key}/messages`); assert.equal(history.status, 200);
      const historyBody = await history.json(); assert.ok(historyBody.messages.some((row: { text: string }) => row.text === 'Original native input'));
      const historyId = historyBody.messages.find((row: { text: string }) => row.text === 'Original native input').id;
      await until(async () => (await f.request(`/sessions/${key}/messages/${encodeURIComponent(historyId)}`)).status === 200);
      const detail = await f.request(`/sessions/${key}/messages/${encodeURIComponent(historyId)}`); assert.equal(detail.status, 200);
      assert.equal((await detail.json()).message.text, 'Original native input');
      const usagePath = `/sessions/${key}/token-usage`;
      const usageRange = { from: 0, to: 120_000, bucketMs: 60_000 };
      assert.equal((await f.request(`${usagePath}?from=0&to=120000&bucketMs=60000`)).status, 200);
      const exported = await f.request(`${usagePath}/export?from=0&to=120000&bucketMs=60000`); assert.equal(exported.status, 200);
      const selection = { ...usageRange, requestId: randomUUID() };
      const snapshot = await f.request(`${usagePath}/snapshots`, 'POST', selection); assert.equal(snapshot.status, 200);
      const originalSnapshot = await snapshot.json(); assert.deepEqual(originalSnapshot.data, await exported.json());
      const receipt = await f.request(`${usagePath}/snapshots/${selection.requestId}`); assert.equal(receipt.status, 200);
      assert.deepEqual(await receipt.json(), originalSnapshot);
      const filesPath = `/sessions/${key}/files`;
      const indexed = await f.request(filesPath); assert.equal(indexed.status, 200); assert.equal((await indexed.json()).rebuildAvailable, true);
      const started = await f.request(`${filesPath}/rebuild`, 'POST'); assert.equal(started.status, 200);
      const fileJob = await started.json(); assert.equal(fileJob.state, 'scanning');
      const scanned = await f.request(`${filesPath}/rebuild/${fileJob.id}`, 'POST', { step: 0 }); assert.equal(scanned.status, 200);
      const progress = await scanned.json(); assert.equal(progress.state, 'completed');
      const cancelled = await f.request(`${filesPath}/rebuild/${fileJob.id}`, 'DELETE'); assert.equal(cancelled.status, 200);
      assert.deepEqual(await cancelled.json(), progress);
      const pause = f.target!.pauseQueueWorker();
      const fresh = await f.request(`/sessions/${key}/messages`, 'POST', { message: 'Must not start', idempotencyKey: 'paused-message' });
      assert.equal(fresh.status, 409);
      const running = await f.owner.command('sdkSnapshotRead', { runtime, key });
      assert.ok(running.execution);
      const stop = await f.request(`/sessions/${key}/messages`, 'POST', { message: '/stop', idempotencyKey: 'app-stop', expectedRunId: running.execution.id });
      assert.equal(stop.status, 200); await pause.drained; assert.equal(f.counts().interruptions, 1); assert.equal(f.counts().starts, 1);
      const status = await f.request(`/sessions/${key}/messages`, 'POST', { message: '/status', idempotencyKey: 'app-status' });
      assert.equal(status.status, 200); assert.equal((await status.json()).deliveryMode, 'web-only');
      const report = await f.request(`/sessions/${key}/commands/app-status/status`); assert.equal(report.status, 200);
      assert.equal((await f.request(`/sessions/${key}/queue`)).status, 200);
      assert.equal((await f.request(`/sessions/${key}/compact-commands/not-submitted`)).status, 404);
      assert.equal((await f.request(`/sessions/${key}/deletion-commands/not-submitted`)).status, 404);
      assert.equal(pause.resume(), true); await until(() => f.target!.ready);
      const duplicate = await f.create(); assert.equal(duplicate.status, 201); assert.equal((await duplicate.json()).key, key);
      const close = f.application.close(); assert.equal(f.application.close(), close); await close;
      assert.equal((await f.request(`/sessions/${key}/messages`)).status, 503);
      assert.equal((await f.request(`${usagePath}?from=0&to=120000&bucketMs=60000`)).status, 503);
      assert.equal((await f.request(`${usagePath}/export?from=0&to=120000&bucketMs=60000`)).status, 503);
      assert.equal((await f.request(`${usagePath}/snapshots`, 'POST', selection)).status, 503);
      assert.equal((await f.request(`${usagePath}/snapshots/${selection.requestId}`)).status, 503);
      assert.equal((await f.request(filesPath)).status, 503);
      assert.equal((await f.request(`/sessions/${key}/state`)).status, 503);
      assert.equal((await f.request(`/models/${runtime}`)).status, 503);
      assert.equal((await f.request(`${filesPath}/rebuild`, 'POST')).status, 503);
      assert.equal((await f.request(`${filesPath}/rebuild/${fileJob.id}`, 'POST', { step: 0 })).status, 503);
      assert.equal((await f.request(`${filesPath}/rebuild/${fileJob.id}`, 'DELETE')).status, 503);
      assert.equal(existsSync(f.marker), false); assert.equal(f.counts().checks, 1);
      assert.ok(await f.owner.command('tokenAuthenticate', { authorization }), 'application does not close the shared startup owner');
      assert.ok(f.logs.every(line => !line.includes(authorization) && !line.includes('Original native input') && !line.includes(f.marker)));
    } finally { await f.close(); }
  });

  test(`${runtime}: disabled SDK has no HOME/native effects and rejects new admissions instead of legacy fallback`, async () => {
    const f = await fixture(runtime, { disabled: true });
    try {
      f.application.activate(); await tick(); assert.equal(f.application.agents.length, 0);
      assert.equal((await f.create()).status, 409); assert.equal(existsSync(f.marker), false);
      const modelToken = await f.owner.command('tokenCreate', { label: 'models reader', scopes: ['models:read'] });
      const models = await f.app.request(`/api/connector/v1/models/${runtime}`, { headers: { authorization: `Bearer ${modelToken.token}` } });
      assert.equal(models.status, 404, 'configured worker catalog cannot enable a disabled application runtime');
      assert.equal(f.counts().checks + f.counts().starts, 0);
    } finally { await f.close(); }
  });

  for (const closing of [false, true]) test(`${runtime}: original late local ACK ${closing ? 'is drained on close' : 'refreshes projection after waiter timeout'} without replay`, async () => {
    const f = await fixture(runtime, { holdCreateAck: true });
    try {
      await f.activate();
      const work = f.application.http.sdkLocal.local.create({ runtime, authorization, commandKey: 'late-create', payloadJson: '{"title":"Late commit"}' }, { timeoutMs: 1 });
      await assert.rejects(work); await f.submitted.promise; assert.equal(f.counts().creates, 1);
      const recovered = await f.owner.command('sdkLocalReceiptRead', { runtime, operation: 'create', authorization, commandKey: 'late-create' });
      assert.ok('receipt' in recovered && recovered.receipt?.state === 'accepted' && recovered.key);
      if (closing) {
        let done = false; const close = f.application.close().then(() => { done = true; });
        await tick(); assert.equal(done, false); f.ack.release(); await close;
        assert.ok(await f.owner.command('tokenAuthenticate', { authorization }));
      } else {
        assert.equal(f.deck.getSession(recovered.key), undefined); f.ack.release();
        await until(() => f.deck.getSession(recovered.key!)?.title === 'Late commit');
      }
      assert.equal(f.counts().creates, 1);
    } finally { await f.close(); }
  });
}
