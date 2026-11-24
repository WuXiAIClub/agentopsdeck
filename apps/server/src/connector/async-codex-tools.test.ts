import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WorkspaceBoards } from '../hub/workspace-boards.js';
import { WorkspaceBoardCapabilities } from '../hub/workspace-board-capabilities.js';
import { registerWorkspaceAgentRoutes } from '../routes/workspace-agent.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { CodexAppServer } from '../codex/app-server.js';
import { codexAdmissionProof } from '../codex/dispatch-admission.js';
import { DeckStore } from '../projection/deck-store.js';
import { BOARD_READ_TOOL, BOARD_UPDATE_TOOL } from '../tools/workspace-board-worker.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { AsyncCodexDispatch, type PreparedCodexDispatch } from './async-codex-dispatch.js';
import { AsyncCodexTools } from './async-codex-tools.js';
import type { ConnectorOwnerKind } from './connector-owner-domain.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture(t: import('node:test').TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-owned-tools-')), grants = join(directory, 'grants');
  await mkdir(grants, { mode: 0o700 }); await chmod(grants, 0o700);
  const threadId = randomUUID(), sessionKey = `codex:${threadId}`, connectionId = 'original-connection';
  const config = { file: join(directory, 'connector.sqlite'), tokenFile: join(directory, 'tokens.json'), bootstrapToken: 'isolated-native-tools' };
  const tokens = new ConnectorTokenStore(config.tokenFile, config.bootstrapToken), actor = tokens.authenticateAuthorization(`Bearer ${config.bootstrapToken}`)!.tokenId;
  const seed = new ConnectorUserStore(config.file, undefined, { runtimeOwner: true });
  seed.codexExecutions.enrollBoardTools(threadId);
  await seed.turns.enqueueAsync('codex', { id: 'original-command', sessionKey, createdAt: 1, payload: { text: 'private-request', images: [], actorId: actor } });
  const prepared: PreparedCodexDispatch = { claim: { sessionKey, commandId: 'original-command', connectionId,
    proof: codexAdmissionProof(seed.turns, seed.turns.list<{ text: string; images: unknown[]; actorId: string }>('codex', sessionKey)), preparing: false, blockedGoalInput: false },
    input: [{ type: 'text', text: 'private-request' }], interactive: false };
  seed.close();
  const owner = new AsyncConnectorOwner(config); await owner.open();
  const hubDb = new DatabaseSync(':memory:'), boards = new WorkspaceBoards(hubDb), caps = new WorkspaceBoardCapabilities(hubDb, boards);
  const taskId = randomUUID(); boards.save('owner', 'default', { title: 'Board', revision: 0, mutationId: randomUUID(),
    tasks: [{ id: taskId, title: 'Original task', detail: '', status: 'todo' }] });
  const capability = caps.issue('owner', 'default', { taskIds: [taskId], fields: ['status'], expiresAt: Date.now() + 60_000 })!;
  const hub = new Hono(); registerWorkspaceAgentRoutes(hub, caps);
  const listening = deferred<void>(), server = serve({ fetch: hub.fetch, hostname: '127.0.0.1', port: 0 }, () => listening.resolve());
  await listening.promise;
  const credential = { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspace-agent/v1/board`,
    token: capability.token, expiresAt: capability.capability.expiresAt };
  await writeFile(join(grants, `codex-${threadId}.json`), JSON.stringify({ runtime: 'codex', sessionId: threadId, credential }), { mode: 0o600 });
  const localDb = new ConnectorUserStore(':memory:'), store = new DeckStore();
  store.upsertSession({ sessionKey, agentId: 'codex', title: 'Original executor', status: 'idle' });
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: 'C:\\isolated\\cwd',
    defaultModel: 'test-model', approvalPolicy: 'never', store, turnQueue: localDb.turns, executions: localDb.codexExecutions,
    boardToolsDirectory: grants, authorizeTurn: () => { throw Error('legacy authority forbidden'); } });
  const runtime = codex as any, writes: any[] = [], replies = new Map<string, ReturnType<typeof deferred<any>>>();
  const child = { stdin: { writable: true, write(line: string) {
    const value = JSON.parse(line); writes.push(value);
    if (value.method === 'turn/start') queueMicrotask(() => runtime.receive(JSON.stringify({ id: value.id, result: { turn: { id: 'native-run' } } })));
    else if (value.id) replies.get(String(value.id))?.resolve(value.result);
    return true;
  } } };
  runtime.setConnection(connectionId); runtime.child = child;
  // Dispatch consumes a prepared, already-loaded original thread; cold loading has separate coverage.
  runtime.loadedThreadIds.add(threadId);
  const saved = { get: localDb.codexExecutions.get, enrolled: localDb.codexExecutions.hasBoardTools, list: localDb.turns.list, session: store.getSession };
  localDb.codexExecutions.get = localDb.codexExecutions.hasBoardTools = localDb.turns.list = store.getSession = () => { throw Error('main-thread SQL/legacy authority forbidden'); };
  const kinds: ConnectorOwnerKind[] = [];
  let hook: ((kind: ConnectorOwnerKind, input: any, work: () => Promise<any>) => Promise<any>) | undefined;
  const port = { command: ((kind: ConnectorOwnerKind, input: any) => {
    kinds.push(kind); const work = () => owner.command(kind, input); return hook ? hook(kind, input, work) : work();
  }) as AsyncConnectorOwner['command'] };
  const tools = new AsyncCodexTools({ owner: port, runtime: codex });
  const dispatch = new AsyncCodexDispatch({ owner: port, runtime: codex, tools, local() {} });
  t.after(async () => {
    await dispatch.close(); await tools.close();
    localDb.codexExecutions.get = saved.get; localDb.codexExecutions.hasBoardTools = saved.enrolled;
    localDb.turns.list = saved.list; store.getSession = saved.session;
    runtime.child = undefined; await codex.close(); localDb.close(); await owner.close();
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); (server as Server).closeAllConnections(); });
    hubDb.close(); await rm(directory, { recursive: true, force: true });
  });
  const invoke = (tool = BOARD_READ_TOOL, args: unknown = {}, runId = 'native-run') => {
    const id = randomUUID(), reply = deferred<any>(); replies.set(id, reply);
    runtime.receive(JSON.stringify({ id, method: 'item/tool/call', params: { threadId, turnId: runId, callId: id,
      namespace: null, tool, arguments: args } }));
    return reply.promise;
  };
  return { owner, runtime, tools, dispatch, prepared, kinds, boards, taskId, writes, invoke,
    hook(fn: NonNullable<typeof hook>) { hook = fn; } };
}

test('original dispatch → same worker → native task bridge → real Hub CAS stays off Connector main-thread SQL', async t => {
  const f = await fixture(t);
  assert.equal(await f.dispatch.dispatch(f.prepared), 'admitted');
  assert.deepEqual(f.kinds, ['codexDispatchClaim', 'codexToolsBind', 'codexDispatchReady', 'codexExecutionAcknowledge']);
  const read = await f.invoke(); assert.equal(read.success, true);
  const mutationId = randomUUID(), update = await f.invoke(BOARD_UPDATE_TOOL, { revision: 1, mutationId, tasks: [{ id: f.taskId, status: 'done' }] });
  assert.equal(update.success, true); assert.equal(JSON.parse(update.contentItems[0].text).status, 'saved');
  assert.equal(f.boards.get('owner', 'default').tasks[0]!.status, 'done');
  assert.equal((await f.invoke(BOARD_READ_TOOL, {}, 'another-run')).success, false);
  assert.equal(f.kinds.filter(kind => kind === 'codexToolsBind').length, 1);
  await f.tools.close(); assert.equal((await f.invoke()).success, false);
  assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: f.prepared.claim.sessionKey }))?.phase, 'running');
});

test('close freezes original bridge and privately drains pending worker authorization before release', async t => {
  const f = await fixture(t); assert.equal(await f.dispatch.dispatch(f.prepared), 'admitted');
  const entered = deferred<void>(), gate = deferred<void>();
  f.hook(async (kind, _input, work) => { if (kind === 'codexToolsCheck') { entered.resolve(); await gate.promise; } return work(); });
  const pending = f.invoke(); await entered.promise;
  let drained = false; const closing = f.tools.close().then(() => { drained = true; });
  await tick(); assert.equal(drained, false); assert.ok(!f.kinds.includes('codexToolsRelease'));
  gate.resolve(); assert.equal((await pending).success, false); await closing;
  assert.equal(drained, true); assert.equal(f.kinds.filter(kind => kind === 'codexToolsRelease').length, 1);
  assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: f.prepared.claim.sessionKey }))?.phase, 'running');
});

test('worker binding reply arriving after close cannot install the native bridge or send turn/start', async t => {
  const f = await fixture(t), entered = deferred<void>(), gate = deferred<void>();
  f.hook(async (kind, _input, work) => { const reply = await work(); if (kind === 'codexToolsBind') { entered.resolve(); await gate.promise; } return reply; });
  const pending = f.dispatch.dispatch(f.prepared); await entered.promise;
  const closing = f.tools.close(); gate.resolve();
  assert.equal(await pending, 'unknown'); await closing;
  assert.equal(f.writes.length, 0); assert.equal((await f.invoke()).success, false);
  assert.ok(f.kinds.includes('codexToolsRelease'));
});
