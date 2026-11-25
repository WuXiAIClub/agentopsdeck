import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AntigravityAcpClient, AntigravityAcpError, type AntigravitySessionUpdate } from './acp-client.js';
import type { AntigravityConfig } from './config.js';

const supported = { skip: process.platform !== 'linux' };

function fixture(context: TestContext, mode = 'normal') {
  const root = mkdtempSync(join(tmpdir(), 'aod-antigravity-'));
  const homeDirectory = join(root, 'home'), workspace = join(root, mode), command = join(root, 'bin', 'agy');
  for (const directory of [homeDirectory, workspace, join(root, 'bin')]) mkdirSync(directory, { mode: 0o700 });
  for (const name of ['config', 'cache', 'data', 'tmp']) mkdirSync(join(homeDirectory, name), { mode: 0o700 });
  copyFileSync(fileURLToPath(new URL('./acp-fixture.mjs', import.meta.url)), command);
  chmodSync(command, 0o700);
  const config: AntigravityConfig = { command, homeDirectory, workspace, startupTimeoutMs: 1000 };
  const updates: AntigravitySessionUpdate[] = [];
  let received: () => void = () => {};
  const updateReceived = new Promise<void>(resolve => { received = resolve; });
  let owned = true;
  const client = new AntigravityAcpClient({ config, assertOwnership: () => { if (!owned) throw Error('synthetic ownership lost'); },
    update: update => { updates.push(update); received(); } });
  context.after(async () => {
    try { client.close(); await client.finished; }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  const requests = () => readFileSync(join(workspace, 'requests.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { config, updates, updateReceived, client, requests, loseOwnership: () => { owned = false; } };
}

test('Antigravity negotiates ACP, preserves fragmented UTF-8 and persists intent before prompt', supported, async context => {
  const original = fixture(context);
  assert.equal((await original.client.initialize()).protocolVersion, 1);
  const sessionId = await original.client.newSession();
  assert.equal(sessionId, 'synthetic-native-session');
  let persisted = false;
  const outcome = await original.client.prompt('synthetic harmless prompt', async native => {
    assert.equal(native, sessionId);
    assert.ok(!original.requests().some(request => request.method === 'session/prompt'));
    persisted = true;
  });
  assert.equal(persisted, true);
  assert.deepEqual(outcome, { stopReason: 'end_turn' });
  assert.deepEqual(original.updates[0]?.update, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好，ACP' } });
  const initialization = original.requests()[0];
  assert.deepEqual(initialization.params.clientInfo, { name: 'AgentOpsDeck', version: '1.0.0' });
  assert.equal(initialization.params.clientCapabilities.terminal, false);
  assert.equal(original.client.inspectTransportClosed(), false);
  await assert.rejects(original.client.prompt('must not reuse worker', async () => {}));
  original.client.close(); await original.client.finished;
  assert.equal(original.client.inspectTransportClosed(), true);
});

test('Antigravity denies permission requests and unsupported client tools', supported, async context => {
  for (const prompt of ['permission', 'unsupported-client-tool']) {
    const original = fixture(context);
    await original.client.initialize(); await original.client.newSession();
    assert.equal((await original.client.prompt(prompt, async () => {})).stopReason, 'end_turn');
    const reply = original.requests().find(request => request.id === (prompt === 'permission' ? 'permission-1' : 'terminal-1'));
    if (prompt === 'permission') assert.deepEqual(reply.result, { outcome: { outcome: 'cancelled' } });
    else assert.equal(reply.error.code, -32601);
    original.client.close(); await original.client.finished;
  }
});

test('Antigravity resumes only verified owned identity and suppresses historical updates', supported, async context => {
  const original = fixture(context);
  await original.client.initialize();
  await assert.rejects(original.client.resumeOwnedSession('foreign', () => { throw Error('not owned'); }));
  await assert.rejects(original.client.resumeOwnedSession('synthetic-native-session', async () => { throw Error('synthetic asynchronous ownership failure'); }));
  assert.ok(!original.requests().some(request => request.method === 'session/resume'));
  let checked = false;
  await original.client.resumeOwnedSession('synthetic-native-session', sessionId => {
    assert.equal(sessionId, 'synthetic-native-session'); checked = true;
  });
  assert.equal(checked, true);
  assert.deepEqual(original.updates, []);
  await original.client.prompt('synthetic prompt', async () => {});
  assert.equal(original.updates.length, 1);
  assert.ok(!original.requests().some(request => ['session/load', 'session/list'].includes(request.method)));
});

test('Antigravity refuses unadvertised resume without fallback or session discovery', supported, async context => {
  const original = fixture(context, 'no-resume');
  await original.client.initialize();
  await assert.rejects(original.client.resumeOwnedSession('synthetic-native-session', () => {}));
  assert.equal(original.requests().length, 1);
});

test('Antigravity session creation cannot race', supported, async context => {
  const original = fixture(context);
  await original.client.initialize();
  const opening = original.client.newSession();
  await assert.rejects(original.client.newSession());
  await opening;
  assert.equal(original.requests().filter(request => request.method === 'session/new').length, 1);
});

test('Antigravity cancellation requires correlated prompt result, not a notification ACK', supported, async context => {
  const original = fixture(context);
  await original.client.initialize(); await original.client.newSession();
  await assert.rejects(async () => original.client.cancel());
  let release: () => void = () => {};
  const intent = new Promise<void>(resolve => { release = resolve; });
  const pending = original.client.prompt('cancel', () => intent);
  await assert.rejects(original.client.prompt('overlapping', async () => {}));
  release();
  await original.updateReceived;
  original.client.cancel();
  assert.deepEqual(await pending, { stopReason: 'cancelled' });
  assert.equal(original.requests().filter(request => request.method === 'session/prompt').length, 1);
  assert.equal(original.client.inspectTransportClosed(), false);
});

for (const prompt of ['disconnect', 'oversize', 'invalid-utf8', 'foreign', 'malformed', 'duplicate-response', 'unsolicited-cancel', 'bad-stop',
  'array-stop', 'bad-update', 'update-count-limit', 'update-byte-limit']) {
  test(`Antigravity fails closed without replay after ${prompt}`, supported, async context => {
    const original = fixture(context);
    await original.client.initialize(); await original.client.newSession();
    await assert.rejects(original.client.prompt(prompt, async () => {}), /Antigravity/);
    await original.client.finished;
    await assert.rejects(original.client.prompt('must not replay', async () => {}));
    assert.equal(original.requests().filter(request => request.method === 'session/prompt').length, 1);
  });
}

test('Antigravity authentication errors never include provider error bodies', supported, async context => {
  const original = fixture(context, 'auth');
  await assert.rejects(original.client.initialize(), error => {
    assert.ok(error instanceof AntigravityAcpError);
    assert.equal(error.code, -32000);
    assert.ok(!error.message.includes('synthetic-private'));
    return true;
  });
  await original.client.finished;
});

test('Antigravity projects only bounded text and tool metadata, never native bodies', supported, async context => {
  const original = fixture(context);
  await original.client.initialize(); await original.client.newSession();
  assert.deepEqual(await original.client.prompt('private-update', async () => {}), { stopReason: 'end_turn' });
  assert.deepEqual(original.updates, [
    { sessionId: 'synthetic-native-session', update: {
      sessionUpdate: 'tool_call', toolCallId: 'synthetic-tool', title: 'Read', status: 'completed', kind: 'read',
    } },
    { sessionId: 'synthetic-native-session', update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'synthetic-visible-text' },
    } },
  ]);
});

test('Antigravity refuses asynchronous ownership assertions before spawning', supported, async context => {
  const original = fixture(context);
  await original.client.initialize();
  original.client.close(); await original.client.finished;
  const requests = original.requests();
  assert.throws(() => new AntigravityAcpClient({ config: original.config, update: () => {},
    assertOwnership: async () => { throw Error('synthetic asynchronous ownership failure'); } }));
  assert.deepEqual(original.requests(), requests);
});

test('Antigravity refuses writable and missing private paths without leaking paths', supported, async context => {
  const original = fixture(context);
  original.client.close(); await original.client.finished;
  const assertPrivateFailure = (config: AntigravityConfig) => assert.throws(() => new AntigravityAcpClient({
    config, assertOwnership: () => {}, update: () => {},
  }), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Antigravity private environment could not be verified');
    return true;
  });
  for (const path of [original.config.command, original.config.workspace]) {
    chmodSync(path, 0o777);
    assertPrivateFailure(original.config);
    chmodSync(path, 0o700);
  }
  assertPrivateFailure({ ...original.config, workspace: join(original.config.workspace, 'synthetic-private-missing-path') });
});

test('Antigravity rejects incompatible handshakes and enforces startup deadlines', supported, async context => {
  for (const mode of ['wrong-version', 'timeout', 'setup-timeout']) {
    const original = fixture(context, mode);
    if (mode === 'setup-timeout') { await original.client.initialize(); await assert.rejects(original.client.newSession()); }
    else await assert.rejects(original.client.initialize());
    await original.client.finished;
  }
});

test('Antigravity does not send a prompt after persistence or ownership failure', supported, async context => {
  for (const loseOwnership of [false, true]) {
    const original = fixture(context);
    await original.client.initialize(); await original.client.newSession();
    await assert.rejects(original.client.prompt('synthetic prompt', async () => {
      if (loseOwnership) original.loseOwnership();
      else throw Error('synthetic storage failure');
    }));
    await original.client.finished;
    assert.ok(!original.requests().some(request => request.method === 'session/prompt'));
  }
});

test('Antigravity refuses symlinked runtime directories before spawning', supported, async context => {
  const original = fixture(context);
  original.client.close(); await original.client.finished;
  rmSync(join(original.config.homeDirectory, 'tmp'), { recursive: true });
  symlinkSync(original.config.workspace, join(original.config.homeDirectory, 'tmp'));
  assert.throws(() => new AntigravityAcpClient({ config: original.config, assertOwnership: () => {}, update: () => {} }));
});
