import assert from 'node:assert/strict';
import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { serve } from '@hono/node-server';
import { createApplication } from '../application.js';
import { loadConfig, type ServerRole } from '../config.js';
import { createConnectorRuntime } from '../connector/runtime.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';

const simulator = `
  const fs = require('node:fs');
  const stateFile = process.argv[1];
  const state = fs.existsSync(stateFile)
    ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { requests: [], thread: null };
  const persist = () => {
    fs.writeFileSync(stateFile + '.next', JSON.stringify(state));
    fs.renameSync(stateFile + '.next', stateFile);
  };
  const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    state.requests.push({ method: request.method, params: request.params });
    let result = {};
    if (request.method === 'thread/start') {
      if (state.thread) throw new Error('Unexpected duplicate thread creation');
      state.thread = { id: 'synthetic-thread', status: { type: 'idle' }, turns: [] };
      result = { thread: state.thread };
    } else if (request.method === 'thread/list') {
      result = { data: state.thread ? [state.thread] : [], nextCursor: null };
    } else if (request.method === 'thread/read' && request.params.includeTurns && !state.thread.turns.length) {
      persist();
      emit({ id: request.id, error: { code: -32600,
        message: 'thread ' + state.thread.id + ' is not materialized yet; includeTurns is unavailable before first user message' } });
      return;
    } else if (request.method === 'thread/read' || request.method === 'thread/resume') {
      result = { thread: state.thread };
    } else if (request.method === 'thread/backgroundTerminals/list') {
      result = { data: [], nextCursor: null };
    } else if (request.method === 'thread/goal/get') {
      result = { goal: null };
    } else if (request.method === 'turn/start') {
      const turn = { id: 'native-turn-' + (state.thread.turns.length + 1), status: 'inProgress',
        items: [{ id: 'user-' + state.thread.turns.length, type: 'userMessage',
          clientId: request.params.clientUserMessageId, content: request.params.input }] };
      state.thread.turns.push(turn);
      state.thread.status = { type: 'active', activeFlags: [] };
      result = { turn };
    } else if (request.method === 'fixture/complete') {
      const turn = state.thread.turns.at(-1);
      turn.status = request.params.status;
      state.thread.status = { type: 'idle' };
      const item = { id: 'reply-' + turn.id, type: 'agentMessage', text: request.params.text };
      turn.items.push(item);
      persist();
      emit({ method: 'item/agentMessage/delta', params: { threadId: state.thread.id,
        turnId: turn.id, itemId: item.id, delta: item.text } });
      emit({ method: 'item/completed', params: { threadId: state.thread.id, turnId: turn.id, item } });
      emit({ method: 'turn/completed', params: { threadId: state.thread.id, turn } });
    } else if (!['initialize', 'initialized', 'turn/interrupt', 'thread/name/set'].includes(request.method)) {
      throw new Error('Unexpected protocol method: ' + request.method);
    }
    persist();
    if (request.id != null) emit({ id: request.id, result });
  });
`;

async function eventually(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out: ${label}`);
}

function configuration(directory: string, role: ServerRole) {
  return loadConfig({ HOME: directory, AOD_SERVER_ROLE: role,
    AOD_ACCESS_KEY: 'synthetic-access-key', AOD_HUB_VAULT_SECRET: 'synthetic-vault',
    AOD_HUB_DATABASE_FILE: join(directory, 'hub.sqlite'),
    AOD_SESSION_TITLES_FILE: join(directory, 'titles.json'),
    AOD_PASSKEYS_FILE: join(directory, 'passkeys.json'),
    AOD_AUTH_SESSIONS_FILE: join(directory, 'auth.json'),
    AOD_CONNECTOR_USERS_DATABASE_FILE: join(directory, 'connector.sqlite'),
    AOD_CONNECTOR_TOKENS_FILE: join(directory, 'tokens.json'),
    AOD_CONNECTOR_BOOTSTRAP_TOKEN: 'synthetic-connector-token',
    AOD_CONNECTOR_UPDATE_STATE_FILE: join(directory, 'update.json'),
    AOD_CONNECTOR_UPDATE_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false',
    AOD_QUEUE_FILE: join(directory, 'queue.json'), AOD_MIRROR_OUTBOX_FILE: join(directory, 'mirror.json'),
    AOD_ARTIFACT_INDEX_FILE: join(directory, 'artifacts.json'),
    AOD_MEDIA_BRIDGE_ENABLED: 'false', AOD_ARTIFACT_RECEIVER_ENABLED: 'false',
    AOD_CODEX_ENABLED: role === 'hub' ? 'false' : 'true',
    AOD_CODEX_COMMAND: 'synthetic-codex-process-only', AOD_CODEX_DEFAULT_CWD: directory,
    AOD_CODEX_HOME: join(directory, 'native-home'),
    AOD_CODEX_DEFAULT_MODEL: 'synthetic-model', AOD_CODEX_APPROVAL_POLICY: 'never' });
}

test('assembled two-user two-node Codex isolates colliding identities, shared execution, events, revocation and restart',
  { timeout: 90_000 }, async context => {
    const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-codex-two-nodes-'));
    const nativeSpawn = childProcess.spawn;
    const children: Array<{ child: ChildProcessWithoutNullStreams; exited: Promise<unknown> }> = [];
    const nodes = ['alice', 'bob'].map(label => {
      const home = join(directory, label);
      mkdirSync(home);
      return { label, home, stateFile: join(home, 'native.json'),
        config: configuration(home, 'connector'),
        child: undefined as ChildProcessWithoutNullStreams | undefined,
        application: undefined as ReturnType<typeof createApplication> | undefined,
        runtime: undefined as ReturnType<typeof createConnectorRuntime> | undefined,
        server: undefined as ReturnType<typeof serve> | undefined,
        origin: '', nodeId: '', userId: '', token: '', keyId: '', sessionKey: '', remoteSessionKey: '', commandId: '', issuerToken: '' };
    });
    let hub: ReturnType<typeof createApplication> | undefined;
    const stop = async () => {
      await hub?.close(); hub = undefined;
      for (const node of nodes) { await node.application?.close(); node.application = undefined; }
    };
    context.after(async () => {
      try { await stop(); } finally {
        for (const node of nodes) if (node.server) {
          const server = node.server;
          const closing = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
          if ('closeAllConnections' in server) server.closeAllConnections();
          await closing;
        }
        for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await Promise.all(children.map(({ exited }) => exited));
        context.mock.restoreAll(); syncBuiltinESMExports();
        rmSync(directory, { recursive: true, force: true });
      }
    });
    context.mock.method(childProcess, 'spawn', (command: string, _args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; detached?: boolean }) => {
      assert.equal(command, 'synthetic-codex-process-only');
      const node = nodes.find(candidate => candidate.home === options.cwd);
      assert.ok(node, 'native child must belong to one isolated Connector');
      assert.equal(options.env.CODEX_HOME, join(node.home, 'native-home'));
      node.child = nativeSpawn(process.execPath, ['-e', simulator, node.stateFile], {
        cwd: node.home, detached: options.detached ?? false, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: node.home, NODE_ENV: 'test' },
      });
      children.push({ child: node.child, exited: once(node.child, 'close') });
      return node.child;
    });
    syncBuiltinESMExports();
    const start = async () => {
      for (const node of nodes) {
        node.application = createApplication(node.config, (...args) => node.runtime = createConnectorRuntime(...args));
        node.server ??= serve({ hostname: '127.0.0.1', port: 0,
          fetch: request => node.application ? node.application.app.fetch(request) : new Response(null, { status: 503 }) });
        if (!node.server.listening) await once(node.server, 'listening');
        const address = node.server.address();
        assert.ok(address && typeof address !== 'string');
        node.origin = `http://127.0.0.1:${address.port}`;
      }
      hub = createApplication(configuration(join(directory, 'hub'), 'hub'), () => { throw new Error('Hub must not own a native runtime'); });
    };
    const request = async (path: string, token = 'synthetic-access-key', body?: unknown, expected = 200, method = body === undefined ? 'GET' : 'POST') => {
      const response = await hub!.app.request(`/api/hub/v1${path}`, { method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const result = response.headers.get('content-type')?.includes('application/json')
        ? await response.json() : { error: await response.text() };
      assert.equal(response.status, expected, JSON.stringify(result));
      return result;
    };
    const requests = (node: typeof nodes[number], method: string): Array<{ params: any }> => existsSync(node.stateFile)
      ? JSON.parse(readFileSync(node.stateFile, 'utf8')).requests.filter((entry: { method: string }) => entry.method === method) : [];
    const path = (node: typeof nodes[number]) => `/sessions/${encodeURIComponent(node.sessionKey)}/messages`;
    const readyHistory = (node: typeof nodes[number]) => eventually(async () => {
      try { await node.runtime!.codex.refreshSession(node.remoteSessionKey); }
      catch (error) {
        if (!(error instanceof Error) || !/^Codex thread snapshot (obsolete|unavailable)$/.test(error.message)) throw error;
        return false;
      }
      return node.runtime!.codex.isSessionHistoryReady(node.remoteSessionKey);
    }, `${node.label} current native history`);
    const complete = (node: typeof nodes[number]) => node.child!.stdin.write(
      `${JSON.stringify({ method: 'fixture/complete', params: { text: `${node.label} private reply`, status: 'completed' } })}\n`);
    await start();
    for (const node of nodes) {
      const { user } = await request('/users', undefined, { label: node.label }, 201);
      node.userId = user.id;
      const key = await request(`/users/${node.userId}/login-keys`, undefined, {}, 201);
      node.token = key.token; node.keyId = key.id;
      await request('/connections', node.token, { id: 'same', label: node.label, connectorUrl: node.origin,
        token: 'synthetic-connector-token', ownerUserId: 'default' }, 201);
      node.nodeId = (await request('/connections/same/verify', node.token, {})).connection.nodeId;
      const created = await request('/connections/same/agents/codex/sessions', node.token,
        { title: `${node.label} private session`, idempotencyKey: 'identical-create-key' }, 201);
      node.sessionKey = created.key; node.remoteSessionKey = created.remoteSessionKey;
      const body = { message: `${node.label} private input`, idempotencyKey: 'identical-send-key' };
      const admitted = await request(path(node), node.token, body);
      node.commandId = admitted.runId;
      assert.equal((await request(path(node), node.token, body)).runId, node.commandId);
      await eventually(() => requests(node, 'turn/start').length === 1, `${node.label} first native dispatch`);
      await eventually(() => node.runtime!.connectorUsers.codexExecutions.get(node.remoteSessionKey)?.runId === 'native-turn-1', `${node.label} ACK`);
    }
    const [alice, bob] = nodes;
    assert.ok(alice && bob);
    assert.notEqual(alice.nodeId, bob.nodeId);
    assert.equal(alice.sessionKey, bob.sessionKey, 'connection aliases and native IDs deliberately collide across owners');
    for (const node of nodes) {
      const other = node === alice ? bob : alice;
      const input = requests(node, 'turn/start')[0]!.params.input;
      assert.ok(JSON.stringify(input).includes(`${node.label} private input`));
      assert.ok(!JSON.stringify(input).includes(`${other.label} private input`));
      const reference = new URLSearchParams({ nodeId: other.nodeId, runtimeId: 'codex', nativeSessionKey: 'synthetic-thread' });
      await request(`/session-reference?${reference}`, node.token, undefined, 404);
      await request(path(node), node.token, { message: `${other.label} private input`, idempotencyKey: 'identical-send-key' }, 409);
      complete(node);
    }
    for (const node of nodes) await eventually(() => {
      const fact = node.runtime!.connectorUsers.codexExecutions.get(node.remoteSessionKey);
      return fact?.phase === 'completed' && fact.sync === 'current';
    }, `${node.label} final native history`);
    await stop(); await start();
    for (const node of nodes) {
      assert.equal(node.runtime!.connectorUsers.nodeId, node.nodeId);
      const created = await request('/connections/same/agents/codex/sessions', node.token,
        { title: `${node.label} private session`, idempotencyKey: 'identical-create-key' }, 201);
      assert.equal(created.key, node.sessionKey);
      assert.equal((await request(path(node), node.token,
        { message: `${node.label} private input`, idempotencyKey: 'identical-send-key' })).runId, node.commandId);
      await readyHistory(node);
      let history: { messages: Array<{ text: string }> } | undefined;
      await eventually(async () => {
        const response = await hub!.app.request(`/api/hub/v1${path(node)}`, {
          headers: { authorization: `Bearer ${node.token}` },
        });
        if (response.status === 503) { await response.body?.cancel(); return false; }
        assert.equal(response.status, 200);
        history = await response.json();
        return true;
      }, `${node.label} restarted Hub history`);
      assert.ok(history);
      const other = node === alice ? bob : alice;
      assert.ok(history.messages.some((message: { text: string }) => message.text === `${node.label} private reply`));
      assert.ok(!JSON.stringify(history).includes(`${other.label} private reply`));
      assert.equal(requests(node, 'thread/start').length, 1);
      assert.equal(requests(node, 'turn/start').length, 1);
      const fact = node.runtime!.connectorUsers.codexExecutions.get(node.remoteSessionKey);
      assert.equal(fact?.commandId, node.commandId);
      assert.equal(fact?.runId, 'native-turn-1');
    }
    for (const node of nodes) {
      const { hubId } = await request('/connections/same/execution-issuer', node.token);
      const tokens = new ConnectorTokenStore(node.config.connector.tokenFile);
      node.issuerToken = tokens.create({ label: 'Isolated operator-issued delegation', delegationHubId: hubId,
        scopes: ['execution:delegate', 'messages:send', 'messages:read', 'events:read'] }).token;
    }
    await stop(); await start();
    const grants = new Map<string, { id: string; version: number }>();
    const sharedPath = (node: typeof nodes[number]) => `/shared/${node.userId}/sessions/${encodeURIComponent(node.sessionKey)}`;
    const streams: Array<{ node: typeof nodes[number]; text: string; ended: boolean; completed: Promise<void> }> = [];
    for (const node of nodes) {
      const recipient: typeof nodes[number] = node === alice ? bob : alice;
      await request('/connections/same/execution-issuer', node.token, { token: node.issuerToken }, 200, 'PUT');
      const { nodeVersion } = await request('/connections/same/grants', node.token);
      const { grant } = await request('/connections/same/grants', node.token, { userId: recipient.userId, nodeVersion,
        policy: { runtime: 'codex', sessionKey: node.remoteSessionKey, actions: ['messages:read', 'messages:send', 'events:read'] } }, 201);
      grants.set(node.label, grant);
      await readyHistory(node);
      const response = await hub!.app.request(`/api/hub/v1${sharedPath(node)}/events/stream`, {
        headers: { authorization: `Bearer ${recipient.token}` },
      });
      assert.equal(response.status, 200);
      assert.ok(response.headers.get('content-type')?.includes('text/event-stream'));
      const reader = response.body!.getReader(), decoder = new TextDecoder();
      const stream = { node, text: '', ended: false, completed: Promise.resolve() };
      stream.completed = (async () => {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            stream.text += decoder.decode(chunk.value, { stream: true });
          }
        } finally { stream.ended = true; reader.releaseLock(); }
      })();
      context.after(async () => { await hub?.close(); await stream.completed; });
      streams.push(stream);
      await eventually(() => stream.text.includes('event: heartbeat'), `${node.label} shared heartbeat`);
      // Browser heartbeat intentionally precedes asynchronous upstream startup.
      // source_changed invalidates snapshots on connection (covered separately);
      // only after that handshake can this assertion require individual events.
      await eventually(() => stream.text.includes('event: stream.reset'), `${node.label} shared upstream connected`);
      const first = { message: `${recipient.label} shared input on ${node.label}`, idempotencyKey: 'identical-shared-key' };
      const admitted = await request(`${sharedPath(node)}/messages`, recipient.token, first);
      assert.equal((await request(`${sharedPath(node)}/messages`, recipient.token, first)).runId, admitted.runId);
      await eventually(() => node.runtime!.connectorUsers.codexExecutions.get(node.remoteSessionKey)?.runId === 'native-turn-2', `${node.label} shared ACK`);
      await request(`${sharedPath(node)}/messages`, recipient.token,
        { message: `${recipient.label} queued input on ${node.label}`, idempotencyKey: 'identical-shared-successor' });
      assert.equal(requests(node, 'turn/start').length, 2);
      assert.ok(JSON.stringify(requests(node, 'turn/start')[1]!.params.input).includes(first.message));
    }
    for (const stream of streams) {
      await eventually(() => stream.text.includes('event: session.invalidated'), `${stream.node.label} shared invalidation`);
      assert.ok(!stream.text.includes('private reply') && !stream.text.includes('shared input'));
      const frames = stream.text.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
      for (const frame of frames.filter(frame => frame.type === 'session.invalidated')) {
        assert.deepEqual(frame.sessionRef, { nodeId: stream.node.nodeId, runtimeId: 'codex', nativeSessionKey: 'synthetic-thread' });
        assert.deepEqual(frame.payload, { invalidation: true });
      }
    }
    const revoked = grants.get(alice.label)!;
    await request(`/connections/same/grants/${revoked.id}`, alice.token, { version: revoked.version }, 200, 'DELETE');
    await request(`${sharedPath(alice)}/messages`, bob.token, undefined, 404);
    await request(`${sharedPath(alice)}/messages`, bob.token,
      { message: 'must not be admitted', idempotencyKey: 'after-shared-revoke' }, 404);
    await eventually(() => streams[0]!.ended, 'revoked resource SSE closes');
    assert.equal(streams[1]!.ended, false, 'revocation on Alice cannot close Bob resource stream');
    await eventually(() => alice.runtime!.connectorUsers.turns.head('codex', alice.remoteSessionKey)?.state === 'blocked',
      'original delegated successor blocked at Connector');
    for (const node of nodes) complete(node);
    await eventually(() => bob.runtime!.connectorUsers.codexExecutions.get(bob.remoteSessionKey)?.runId === 'native-turn-3', 'unrevoked shared successor runs');
    complete(bob);
    for (const node of nodes) await eventually(() => {
      const fact = node.runtime!.connectorUsers.codexExecutions.get(node.remoteSessionKey);
      return fact?.phase === 'completed' && fact.sync === 'current';
    }, `${node.label} shared terminal history`);
    assert.equal(requests(alice, 'turn/start').length, 2, 'revoking queued work cannot interrupt or replay its admitted predecessor');
    assert.equal(requests(bob, 'turn/start').length, 3);
    await stop();
    await Promise.all(streams.map(stream => stream.completed));
    await start();
    await request(`${sharedPath(alice)}/messages`, bob.token, undefined, 404);
    const originalShared = await request(`${sharedPath(bob)}/messages`, alice.token,
      { message: 'alice shared input on bob', idempotencyKey: 'identical-shared-key' });
    assert.equal(originalShared.command.state, 'accepted');
    assert.equal(requests(bob, 'turn/start').length, 3, 'recovered shared receipt cannot replay native work');
    assert.equal(alice.runtime!.connectorUsers.turns.head('codex', alice.remoteSessionKey)?.state, 'blocked');
    await readyHistory(bob);
    await request(`/users/${alice.userId}/login-keys/${alice.keyId}`, undefined, undefined, 200, 'DELETE');
    await request(path(alice), alice.token, undefined, 401);
    await request(path(alice), alice.token, { message: 'revoked input', idempotencyKey: 'revoked-send' }, 401);
    await eventually(async () => {
      const response = await hub!.app.request(`/api/hub/v1${path(bob)}`, { headers: { authorization: `Bearer ${bob.token}` } });
      if (response.status === 503) { await response.body?.cancel(); return false; }
      assert.equal(response.status, 200);
      await response.body?.cancel();
      return true;
    }, 'unrevoked owner history after shared restart');
    assert.equal(requests(alice, 'turn/start').length, 2);
    assert.equal(requests(bob, 'turn/start').length, 3);
  });

for (const transport of ['local', 'http'] as const) {
  test(`assembled Codex ${transport}: authenticated creation, durable queue, restart, replies and run-bound stop`,
    { timeout: 60_000 }, async context => {
      const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-codex-hub-runtime-'));
      const stateFile = join(directory, 'synthetic-native.json');
      const nativeSpawn = childProcess.spawn;
      const children: Array<{ child: ChildProcessWithoutNullStreams; exited: Promise<unknown> }> = [];
      let activeChild: ChildProcessWithoutNullStreams;
      let runtime: ReturnType<typeof createConnectorRuntime>;
      let hub: ReturnType<typeof createApplication> | undefined;
      let connector: ReturnType<typeof createApplication> | undefined;
      let server: ReturnType<typeof serve> | undefined;
      const stop = async () => {
        await hub?.close(); hub = undefined;
        await connector?.close(); connector = undefined;
      };
      context.after(async () => {
        try { await stop(); } finally {
          if (server) {
            const closing = new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
            if ('closeAllConnections' in server) server.closeAllConnections();
            await closing; server = undefined;
          }
          for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          await Promise.all(children.map(({ exited }) => exited));
          context.mock.restoreAll(); syncBuiltinESMExports();
          rmSync(directory, { recursive: true, force: true });
        }
      });
      context.mock.method(childProcess, 'spawn', (command: string, _args: string[], options: { detached?: boolean }) => {
        assert.equal(command, 'synthetic-codex-process-only');
        activeChild = nativeSpawn(process.execPath, ['-e', simulator, stateFile], {
          cwd: directory, detached: options.detached ?? false, stdio: ['pipe', 'pipe', 'pipe'],
          env: { PATH: '/usr/bin:/bin', HOME: directory, NODE_ENV: 'test' },
        });
        children.push({ child: activeChild, exited: once(activeChild, 'close') });
        return activeChild;
      });
      syncBuiltinESMExports();
      const start = async () => {
        const factory: typeof createConnectorRuntime = (...args) => runtime = createConnectorRuntime(...args);
        if (transport === 'local') hub = createApplication(configuration(directory, 'all'), factory);
        else {
          connector = createApplication(configuration(directory, 'connector'), factory);
          server ??= serve({ fetch: request => connector ? connector.app.fetch(request) : new Response(null, { status: 503 }), hostname: '127.0.0.1', port: 0 });
          if (!server.listening) await once(server, 'listening');
          const address = server.address();
          assert.ok(address && typeof address !== 'string');
          const config = configuration(directory, 'hub');
          config.hub.localConnectorUrl = `http://127.0.0.1:${address.port}`;
          config.hub.localConnectorToken = 'synthetic-connector-token';
          hub = createApplication(config);
        }
      };
      const request = async (path: string, body?: unknown, expected = 200) => {
        const response = await hub!.app.request(`/api/hub/v1${path}`, {
          headers: { 'x-agentopsdeck-key': 'synthetic-access-key', 'content-type': 'application/json' },
          ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
        });
        const result = await response.json();
        assert.equal(response.status, expected, JSON.stringify(result));
        return result;
      };
      const requests = (method: string): Array<{ params: Record<string, unknown> }> => existsSync(stateFile)
        ? JSON.parse(readFileSync(stateFile, 'utf8')).requests.filter((entry: { method: string }) => entry.method === method) : [];
      const complete = (text: string, status = 'completed') => activeChild.stdin.write(
        `${JSON.stringify({ method: 'fixture/complete', params: { text, status } })}\n`);
      await start();
      assert.equal((await hub!.app.request('/api/hub/v1/connections')).status, 401);
      const verified = await request('/connections/local/verify', {});
      const nodeId = runtime!.connectorUsers.nodeId;
      assert.equal(verified.connection.nodeId, nodeId);
      const creationPath = '/connections/local/agents/codex/sessions';
      const createBody = { title: 'Synthetic Codex acceptance', idempotencyKey: 'create-original' };
      const created = await request(creationPath, createBody, 201);
      assert.equal((await request(creationPath, createBody, 201)).key, created.key);
      assert.equal(requests('thread/start').length, 1);
      const sessionKey = created.remoteSessionKey as string;
      const sessionPath = `/sessions/${encodeURIComponent(created.key)}`;
      await runtime!.codex.refreshSession(sessionKey);
      assert.equal(requests('thread/read').at(-1)?.params.includeTurns, false);
      const firstBody = { message: 'First synthetic command', idempotencyKey: 'send-first' };
      const first = await request(`${sessionPath}/messages`, firstBody);
      assert.equal(first.status, 'queued');
      assert.equal((await request(`${sessionPath}/messages`, firstBody)).runId, first.runId);
      await eventually(() => requests('turn/start').length === 1, 'first native dispatch');
      await eventually(() => runtime!.connectorUsers.codexExecutions.get(sessionKey)?.runId === 'native-turn-1', 'original ACK binding');
      const secondBody = { message: 'Second synthetic command', idempotencyKey: 'send-second' };
      const second = await request(`${sessionPath}/messages`, secondBody);
      const batchBody = { message: 'Another waiting command in the same turn', idempotencyKey: 'send-batch-member' };
      const batchMember = await request(`${sessionPath}/messages`, batchBody);
      assert.notEqual(batchMember.runId, second.runId);
      assert.equal(runtime!.connectorUsers.turns.list('codex', sessionKey).length, 2);
      assert.notEqual(second.runId, first.runId);
      assert.equal(runtime!.connectorUsers.codexExecutions.get(sessionKey)?.phase, 'running');
      assert.equal(requests('turn/start').length, 1, 'ACK cannot release the successor');
      complete('First synthetic reply');
      await eventually(() => requests('turn/start').length === 2, 'successor after original completion and history');
      await eventually(() => runtime!.connectorUsers.codexExecutions.get(sessionKey)?.runId === 'native-turn-2', 'successor ACK binding');
      const batchParts = requests('turn/start')[1]!.params.input as { type: string; text?: string }[];
      const batchInput = batchParts.filter(part => part.type === 'text').map(part => part.text).join('\n');
      assert.ok(batchInput.includes(secondBody.message));
      assert.ok(batchInput.indexOf(batchBody.message) > batchInput.indexOf(secondBody.message));
      assert.deepEqual(runtime!.connectorUsers.codexExecutions.batchForRun(sessionKey, 'native-turn-2')?.members.map(member => member.id), [second.runId, batchMember.runId]);
      assert.equal(runtime!.connectorUsers.turns.list('codex', sessionKey).length, 0);
      await eventually(async () => (await request(`${sessionPath}/messages`)).messages.some(
        (message: { text: string }) => message.text === 'First synthetic reply'), 'Hub reply projection');
      await request(`${sessionPath}/messages`, { message: '/stop', expectedRunId: 'native-turn-1', idempotencyKey: 'stop-stale' }, 409);
      assert.equal(requests('turn/interrupt').length, 0);
      const stopBody = { message: '/stop', expectedRunId: 'native-turn-2', idempotencyKey: 'stop-original' };
      const stopped = await request(`${sessionPath}/messages`, stopBody);
      assert.equal(stopped.status, 'interrupt_requested');
      assert.equal((await request(`${sessionPath}/messages`, stopBody)).status, 'interrupt_requested');
      assert.equal(requests('turn/interrupt').length, 1);
      assert.equal(requests('turn/interrupt')[0]!.params.turnId, 'native-turn-2');
      assert.equal(runtime!.connectorUsers.codexExecutions.get(sessionKey)?.phase, 'running', 'interrupt ACK is not terminal');
      complete('Second synthetic reply', 'interrupted');
      await eventually(() => {
        const execution = runtime!.connectorUsers.codexExecutions.get(sessionKey);
        return execution?.phase === 'interrupted' && execution.sync === 'current';
      }, 'authoritative interrupted completion and history');
      await stop();
      await start();
      assert.equal(runtime!.connectorUsers.nodeId, nodeId);
      await request('/connections/local/verify', {});
      const replay = await request(creationPath, createBody, 201);
      assert.equal(replay.key, created.key);
      assert.equal((await request(`${sessionPath}/messages`, firstBody)).runId, first.runId);
      assert.equal((await request(`${sessionPath}/messages`, secondBody)).runId, second.runId);
      assert.equal((await request(`${sessionPath}/messages`, batchBody)).runId, batchMember.runId);
      await request('/sessions/state');
      await eventually(() => runtime!.connectorUsers.codexExecutions.get(sessionKey)?.sync === 'current', 'cold terminal history restoration');
      assert.equal(requests('thread/start').length, 1);
      assert.equal(requests('turn/start').length, 2, 'restart cannot redispatch accepted commands');
      const history = await request(`${sessionPath}/messages`);
      for (const text of ['First synthetic reply', 'Second synthetic reply', secondBody.message, batchBody.message]) {
        assert.equal(history.messages.filter((message: { text: string }) => message.text === text).length, 1);
      }
      for (const id of [second.runId, batchMember.runId]) {
        assert.equal(history.messages.filter((message: { id: string }) => message.id === id).length, 1);
      }
      assert.equal(requests('turn/start').length, 2);
      assert.equal(children.length, 2);
      const thirdBody = { message: 'Post-restart command', idempotencyKey: 'send-third' };
      const third = await request(`${sessionPath}/messages`, thirdBody);
      await eventually(() => runtime!.connectorUsers.codexExecutions.get(sessionKey)?.runId === 'native-turn-3', 'post-restart native dispatch');
      const fourthBody = { message: 'Wait for unresolved predecessor', idempotencyKey: 'send-fourth' };
      const fourth = await request(`${sessionPath}/messages`, fourthBody);
      await stop();
      await start();
      await request('/connections/local/verify', {});
      assert.equal((await request(`${sessionPath}/messages`, thirdBody)).runId, third.runId);
      assert.equal((await request(`${sessionPath}/messages`, fourthBody)).runId, fourth.runId);
      await request('/sessions/state');
      await eventually(() => requests('initialize').length === 3, 'active-run restart protocol');
      complete('Untrusted post-restart completion');
      await eventually(() => requests('fixture/complete').length === 3, 'post-restart fixture event');
      await request(`${sessionPath}/messages`);
      const unresolved = runtime!.connectorUsers.codexExecutions.get(sessionKey);
      assert.equal(unresolved?.phase, 'unknown');
      assert.equal(unresolved?.reason, 'restarted');
      assert.equal(unresolved?.commandId, third.runId);
      assert.equal(unresolved?.runId, 'native-turn-3');
      assert.equal(runtime!.connectorUsers.turns.head('codex', sessionKey)?.id, fourth.runId);
      assert.equal(requests('turn/start').length, 3, 'unresolved restart must neither replay nor release its successor');
      assert.equal(children.length, 3);
    });
}
