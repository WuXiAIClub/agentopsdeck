import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncSdkDispatch } from './async-sdk-dispatch.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { connectorProjectionReadKinds, createConnectorOwnerCommands, validConnectorOwnerInput,
  validConnectorOwnerOutput } from './connector-owner-domain.js';
import type { ConnectorSdkContextCommands } from './connector-sdk-context-domain.js';
import { workspaceFileContext } from './workspace-file-context.js';
import { LOCAL_FILE_BOARD_OWNER } from './workspace-board-file-policy.js';

type Scope = ConnectorSdkContextCommands['sdkExecutionContext']['input'];
const silence = new PerformanceDiagnostics(() => {});
async function fixture(t: import('node:test').TestContext, runtime: 'claude-code' | 'ghcp',
  options: { scope?: boolean; toolPolicy?: string; policy?: boolean; local?: boolean; delegated?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sdk-original-context-'));
  const config = { file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json'), bootstrapToken: 'isolated-context-test' };
  const tokens = new ConnectorTokenStore(config.tokenFile, config.bootstrapToken);
  const actor = options.local ? LOCAL_FILE_BOARD_OWNER : tokens.create({ label: 'original files',
    scopes: options.scope === false ? ['messages:send'] : ['messages:send', 'boards:files', 'execution:delegate'] }).record.id;
  if (options.local) {
    const files = tokens.createTransient(['boards:files'], LOCAL_FILE_BOARD_OWNER);
    const execution = tokens.createTransient(['messages:send'], 'local:daily');
    t.after(() => { files.dispose(); execution.dispose(); });
  }
  const key = `${runtime}:${randomUUID()}`;
  const boardFiles = { root: join(root, 'files'), policies: [{ owner: options.policy === false ? 'foreign-owner' : actor, runtime }] };
  const fileToolPolicies = { claude: { toolPolicy: options.toolPolicy ?? 'workspace-edit' }, copilot: { toolPolicy: options.toolPolicy ?? 'workspace-edit' } };
  mkdirSync(boardFiles.root, { mode: 0o700 });
  const store = new ConnectorUserStore(config.file, (id, action) => tokens.hasScope(id, 'execution:delegate')
    && tokens.hasScope(id, 'messages:send') && action === 'messages:send', { runtimeOwner: true });
  const journal = runtime === 'claude-code' ? store.claudeJournal : store.copilotJournal;
  journal.create({ key, nativeSessionId: 'original-native', title: 'Original', createdAt: 0 });
  const boards = store.createFileBoards(boardFiles.root, () => true), cards = store.createFileCards(boardFiles.root, () => true);
  await boards.install(actor, { id: randomUUID(), sessionKey: key, content: { title: 'Original tasks', tasks: [] } });
  await cards.install(actor, { id: randomUUID(), sessionKey: key,
    content: { kind: 'notebook', content: { title: 'Original note', text: 'private-hot-content', archive: 'private-cold-content' } } });
  await boards.install(actor, { id: randomUUID(), sessionKey: `${runtime}:foreign-session`, content: { title: 'Foreign session', tasks: [] } });
  await boards.install('foreign-owner', { id: randomUUID(), sessionKey: key, content: { title: 'Foreign owner', tasks: [] } });
  const paths = [...boards.filesForSession(actor, key), ...cards.filesForSession(actor, key)];
  const bytes = paths.map(path => readFileSync(path, 'utf8'));
  const expected = { text: workspaceFileContext(boards, cards, () => true, key, actor), files: paths };
  const grant = options.delegated ? store.executionGrants.issue({ issuerTokenId: actor, hubId: 'original-hub',
    principalId: 'original-principal', grantKey: 'original-grant', version: 1,
    runtime: 'codex', sessionKey: 'codex:original-delegated-session' },
  ['messages:send'], Date.now() + 60_000) : undefined;
  await store.turns.enqueueAsync(runtime, { id: 'original-input', sessionKey: key, createdAt: 1,
    payload: { text: 'original request', images: [], actorId: grant?.actorId ?? (options.local ? 'local:daily' : actor),
      ...(grant ? { executionGrant: { ...grant, issuerTokenId: actor } } : {}) } });
  const owner = { command: createConnectorOwnerCommands(store, tokens, undefined, undefined, boardFiles, false, fileToolPolicies) };
  async function claim(): Promise<Scope> {
    const plan = await owner.command('sdkDispatchPlan', { runtime, key }); assert.ok(plan && plan !== 'blocked');
    const execution = await owner.command('sdkDispatchClaim', { runtime, key, epoch: 'original-epoch', id: 'original-intent', digest: plan.digest });
    assert.ok(execution);
    return { runtime, ref: { id: execution.id, key: execution.key, epoch: execution.epoch, nativeSessionId: execution.nativeSessionId } };
  }
  let closed = false;
  async function closeStore() { if (!closed) { await boards.close(); await cards.close(); store.close(); closed = true; } }
  t.after(async () => { await closeStore(); rmSync(root, { recursive: true, force: true }); });
  return { config: { ...config, boardFiles, fileToolPolicies }, store, journal, owner, actor, tokens, key, claim,
    expected, paths, bytes, closeStore, boards, cards };
}

test('SDK context protocol accepts only original runtime/ref, never actor, authorization flags or paths', () => {
  const scope: Scope = { runtime: 'ghcp', ref: { key: 'ghcp:original', id: 'intent', epoch: 'epoch', nativeSessionId: 'native' } };
  assert.equal(validConnectorOwnerInput('sdkExecutionContext', scope), true);
  for (const name of ['actorId', 'authorized', 'authorization', 'files', 'sql', 'context'])
    assert.equal(validConnectorOwnerInput('sdkExecutionContext', { ...scope, [name]: true }), false);
  assert.equal(validConnectorOwnerInput('sdkExecutionContext', { ...scope, runtime: 'claude-code' }), false);
  assert.equal(validConnectorOwnerOutput('sdkExecutionContext', { ...scope, context: { text: '', files: ['relative/card.json'] } }), false);
  assert.equal(validConnectorOwnerOutput('sdkExecutionContext', { ...scope, context: { text: '', files: [], authorized: true } }), false);
  assert.equal((connectorProjectionReadKinds as readonly string[]).includes('sdkExecutionContext'), false);
});

test('SDK context reply bounds exact file grants and text without admitting caller paths', () => {
  const scope: Scope = { runtime: 'ghcp', ref: { key: 'ghcp:original', id: 'intent', epoch: 'epoch', nativeSessionId: 'native' } };
  const files = Array.from({ length: 64 }, (_, i) => join(tmpdir(), `sdk-file-${i}`, i % 2 ? 'card.json' : 'tasks.json'));
  const valid = (context: unknown) => validConnectorOwnerOutput('sdkExecutionContext', { ...scope, context });
  assert.equal(valid({ text: '', files }), true);
  for (const bad of [[...files, join(tmpdir(), 'overflow', 'tasks.json')], [...files, files[0]],
    ['relative/tasks.json'], [join(tmpdir(), 'secret.sqlite')]]) assert.equal(valid({ text: '', files: bad }), false);
  assert.equal(valid({ text: 'x'.repeat(64_001), files: [] }), false);
  assert.equal(valid({ text: '', files: [], authorized: true }), false);
});

for (const runtime of ['claude-code', 'ghcp'] as const) {
  for (const mode of ['original', 'no-file-scope', 'read-only', 'foreign-policy', 'delegated', 'local'] as const)
    test(`${runtime}: SDK worker context preserves original file policy (${mode})`, async t => {
      const f = await fixture(t, runtime, { scope: mode !== 'no-file-scope',
        toolPolicy: mode === 'read-only' ? 'read-only' : 'workspace-edit', policy: mode !== 'foreign-policy',
        local: mode === 'local', delegated: mode === 'delegated' });
      // SDK runtimes do not support delegated execution. Even a genuine grant
      // from a supported runtime cannot authorize this SDK FIFO or file context.
      if (mode === 'delegated') {
        assert.equal(await f.owner.command('sdkDispatchPlan', { runtime, key: f.key }), 'blocked');
        assert.equal(await f.owner.command('sdkExecutionContext', { runtime, ref: {
          key: f.key, id: 'unclaimed', epoch: 'original-epoch', nativeSessionId: 'original-native',
        } }), null);
        assert.deepEqual(f.paths.map(path => readFileSync(path, 'utf8')), f.bytes);
        return;
      }
      const scope = await f.claim(), reply = await f.owner.command('sdkExecutionContext', scope);
      assert.ok(reply); assert.deepEqual(reply.ref, scope.ref);
      assert.deepEqual(reply.context, mode === 'original' || mode === 'local' ? f.expected : { text: '', files: [] });
      assert.deepEqual(f.paths.map(path => readFileSync(path, 'utf8')), f.bytes);
      assert.equal(JSON.stringify(reply).includes('private-cold-content'), false);
      assert.equal(JSON.stringify(reply).includes('private-hot-content'), false);
      assert.equal(f.journal.current(f.key)?.phase, 'dispatching');
    });

  for (const mode of ['foreign-id', 'foreign-key', 'foreign-epoch', 'foreign-native', 'revoked', 'stopped', 'deleted', 'closed-admission'] as const)
    test(`${runtime}: SDK context rejects lost original execution (${mode})`, async t => {
      const f = await fixture(t, runtime), scope = await f.claim();
      if (mode === 'foreign-id') scope.ref.id = 'other';
      if (mode === 'foreign-key') scope.ref.key = `${runtime}:other`;
      if (mode === 'foreign-epoch') scope.ref.epoch = 'other';
      if (mode === 'foreign-native') scope.ref.nativeSessionId = 'other';
      if (mode === 'revoked') f.tokens.revoke(f.actor);
      if (mode === 'stopped') {
        assert.equal(f.journal.acknowledge(scope.ref, 'ack', f.store.turns), true);
        assert.equal(f.journal.requestStop(scope.ref), true);
      }
      if (mode === 'closed-admission') f.store.pauseTurnStarts();
      if (mode === 'deleted') {
        const receiptScope = JSON.stringify(['delete', JSON.stringify([f.actor, f.key])]);
        await f.store.commands.claimAsync(receiptScope, 'original-delete', {});
        f.store.commands.settle(receiptScope, 'original-delete', { status: 200, body: { ok: true } });
      }
      assert.equal(await f.owner.command('sdkExecutionContext', scope), null);
      assert.deepEqual(f.paths.map(path => readFileSync(path, 'utf8')), f.bytes);
    });

  for (const mode of ['original', 'foreign-reply', 'mutated-request', 'lost-reply', 'revoked-after-ready'] as const)
    test(`${runtime}: real sole worker → original SDK adapter → reopen, ${mode}`, async t => {
      const f = await fixture(t, runtime); await f.closeStore();
      const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line));
      let calls = 0;
      const actual = new AsyncConnectorOwner(f.config, diagnostics); await actual.open();
      try {
        const owner = { command: (async (kind, input) => {
          const reply = await actual.command(kind, input);
          if (kind === 'sdkExecutionContext') {
            const value = reply as NonNullable<ConnectorSdkContextCommands['sdkExecutionContext']['output']>;
            if (mode === 'foreign-reply') value.ref.id = 'foreign';
            if (mode === 'mutated-request') { (input as Scope).ref.id = 'foreign'; value.ref.id = 'foreign'; }
            if (mode === 'lost-reply') throw Error('lost context response');
          }
          if (kind === 'sdkNativeReady' && mode === 'revoked-after-ready') f.tokens.revoke(f.actor);
          return reply;
        }) as AsyncConnectorOwner['command'] };
        const dispatch = new AsyncSdkDispatch({ owner, runtime, deadlineMs: 5000, adapter: {
          epoch: 'original-epoch', ready: true,
          async send(_execution, text, context) { calls++; assert.equal(text, 'original request');
            assert.deepEqual(context, f.expected); return { nativeRequestId: 'original-ack' }; },
          interrupt: async () => {}, inspectSettlement: async ref => ({ ...ref, historyPersisted: false, nativeQuiescent: false }),
        } });
        assert.equal(await dispatch.dispatch(f.key), mode === 'original' ? 'accepted' : 'unknown');
        assert.equal(calls, mode === 'original' ? 1 : 0);
        assert.equal(await dispatch.dispatch(f.key), 'not_started');
        assert.deepEqual(f.paths.map(path => readFileSync(path, 'utf8')), f.bytes);
        assert.ok(logs.some(line => line.includes('"step":335')));
        assert.ok(!logs.join('').includes('private-hot-content'));
        assert.ok(!logs.join('').includes('private-cold-content'));
      } finally { await actual.close(); }
      const reopened = new AsyncConnectorOwner(f.config, silence); await reopened.open();
      try {
        const snapshot = await reopened.command('sdkSnapshotRead', { runtime, key: f.key });
        assert.equal(snapshot.execution?.phase, 'unknown');
        const e = snapshot.execution!;
        assert.equal(await reopened.command('sdkExecutionContext', { runtime,
          ref: { id: e.id, key: e.key, epoch: e.epoch, nativeSessionId: e.nativeSessionId } }), null);
        assert.deepEqual(f.paths.map(path => readFileSync(path, 'utf8')), f.bytes);
      } finally { await reopened.close(); }
    });
}
