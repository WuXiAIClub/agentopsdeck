import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { isOpenClawCliAvailable, startOpenClawAgentFallback } from './cli.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { GatewayRpcError } from '../gateway/rpc-error.js';
import { createOpenClawDispatch } from './dispatch.js';

type Completion = Parameters<NonNullable<Parameters<typeof startOpenClawAgentFallback>[5]>>[0];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(context: TestContext, agentId?: string,
  complete?: Parameters<typeof startOpenClawAgentFallback>[5], ownLifetime?: Parameters<typeof startOpenClawAgentFallback>[6]) {
  const root = mkdtempSync(join(tmpdir(), 'aod-cli-launch-'));
  const home = join(root, 'native'), ambient = join(root, 'ambient');
  for (const directory of [home, ambient]) mkdirSync(directory, { mode: 0o700 });
  const environment = { AOD_LOCAL_OPENCLAW_CLI: 'true', AOD_OPENCLAW_HOME: home, AOD_OPENCLAW_CLI_PATH: process.execPath,
    HOME: ambient, USERPROFILE: ambient, OPENCLAW_CLI_PATH: '/synthetic-private-binary',
    OPENCLAW_CONFIG_PATH: '/synthetic-private-config', OPENCLAW_STATE_DIR: '/synthetic-private-state',
    OPENAI_API_KEY: 'synthetic-private-key', HTTPS_PROXY: 'synthetic-private-proxy', NODE_OPTIONS: 'synthetic-private-preload' };
  const saved = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]]));
  Object.assign(process.env, environment);
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => { throw new Error('output limits must not infer native cancellation'); } });
  const results: Completion[] = [];
  let lifetime!: Promise<void>, closed = false;
  const launches: { executable: string; options: { env: NodeJS.ProcessEnv; cwd: string } }[] = [];
  context.mock.method(childProcess, 'spawn', (executable: string, _args: string[], options: { env: NodeJS.ProcessEnv; cwd: string }) => {
    launches.push({ executable, options }); return child;
  });
  syncBuiltinESMExports();
  const starting = startOpenClawAgentFallback('synthetic', agentId, 'synthetic', 'input', 'original',
    result => { results.push(result); return complete?.(result); }, pending => {
      lifetime = pending;
      ownLifetime?.(pending);
      void pending.then(() => { closed = true; });
    });
  context.after(async () => {
    child.emit('exit', 0, null); child.emit('close', 0, null); await starting; await lifetime;
    context.mock.restoreAll(); syncBuiltinESMExports();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { child, results, starting, launches, home, ambient, completion: () => lifetime, closed: () => closed };
}

test('CLI failure projects only static diagnostics into message, failureReason and session recent', async context => {
  const owner = new ConnectorUserStore(':memory:'), store = new DeckStore();
  const key = 'agent:main:dashboard:agentopsdeck-web-synthetic', commandId = 'original';
  store.upsertSession({ sessionKey: key, agentId: 'main', title: 'Synthetic', status: 'idle' });
  assert.ok(owner.openClawExecutions.begin(key, commandId));
  let setup!: ReturnType<typeof fixture>;
  const dispatch = createOpenClawDispatch({ executions: owner.openClawExecutions, store, allowCliFallback: true,
    authorizeTurn: () => true, message: text => text,
    gateway: { requestBound: async (_method: string, _params: unknown, _timeout: unknown, beforeSend: () => void) => {
      beforeSend(); throw new GatewayRpcError('agent', 'INVALID_REQUEST', 'missing scope: operator.write');
    } } as any,
    startCli: async (...args) => {
      setup = fixture(context, 'main', args[5], args[6]);
      return setup.starting;
    } });
  context.after(async () => {
    setup?.child.emit('exit', 1, null); setup?.child.emit('close', 1, null);
    await dispatch.close(); owner.close();
  });
  const pending = dispatch({ id: commandId, sessionKey: key, createdAt: 1, state: 'dispatching',
    payload: { actorId: 'synthetic', message: 'input', media: [], deliveryMode: 'web-only' } }, []);
  const rejected = assert.rejects(pending, /code=1; original invocation must not be retried/);
  await tick();
  setup.child.stderr.emit('data', Buffer.from('Authorization: Bearer synthetic-private-stderr'));
  setup.child.stdout.emit('data', Buffer.from('synthetic-private-stdout'));
  setup.child.emit('exit', 1, null); await rejected;
  assert.equal(store.getMessages(key).length, 0);
  setup.child.emit('close', 1, null); await setup.completion();
  const diagnostic = 'openclaw CLI execution failed: code=1; original invocation must not be retried';
  const messages = store.getMessages(key);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.text, diagnostic);
  assert.equal(messages[0]?.failureReason, diagnostic);
  assert.equal(store.getSession(key)?.recent, diagnostic);
  assert.equal(JSON.stringify([messages, store.getSession(key)]).includes('synthetic-private'), false);
  assert.equal(owner.openClawExecutions.get(key)?.commandId, commandId);
  assert.equal(owner.openClawExecutions.get(key)?.phase, 'failed');
  assert.equal(setup.launches.length, 1);
});

for (const stream of ['stdout', 'stderr'] as const) {
  for (const chunks of ['single', 'fragmented'] as const) {
    test(`CLI ${stream} ${chunks} overflow drains until close without forwarding a truncated result`, async context => {
      const setup = fixture(context), limit = stream === 'stdout' ? 1024 * 1024 : 64 * 1024;
      setup.child.stdout.emit('data', Buffer.from('{"result":{"payloads":[{"text":"must not forward"}]}}'));
      const bytes = Buffer.alloc(limit + 1, 32);
      if (chunks === 'single') setup.child[stream].emit('data', bytes);
      else for (let offset = 0; offset < bytes.length; offset += 257) setup.child[stream].emit('data', bytes.subarray(offset, offset + 257));
      setup.child[stream].emit('data', Buffer.from('synthetic-private-diagnostic'));
      await tick();
      assert.deepEqual(setup.results, []);
      assert.equal(setup.closed(), false);
      setup.child.emit('exit', 0, null);
      assert.deepEqual(await setup.starting, { ok: true });
      assert.equal(setup.closed(), false);
      setup.child.emit('close', 0, null);
      await setup.completion();
      assert.equal(setup.results.length, 1);
      assert.deepEqual(setup.results[0], { ok: false,
        error: 'openclaw CLI output exceeded its capture budget; original invocation must not be retried' });
      setup.child.emit('close', 0, null);
      assert.equal(setup.results.length, 1);
      assert.equal(setup.closed(), true);
    });
  }
}

test('CLI exact byte budgets preserve split UTF-8 and original structured reply', async context => {
  const setup = fixture(context);
  const encoded = Buffer.from(JSON.stringify({ result: { payloads: [{ text: '原回复🙂' }] } }));
  for (const byte of encoded) setup.child.stdout.emit('data', Buffer.from([byte]));
  setup.child.stdout.emit('data', Buffer.alloc(1024 * 1024 - encoded.length, 32));
  setup.child.stderr.emit('data', Buffer.alloc(64 * 1024, 32));
  setup.child.emit('exit', 0, null); await setup.starting;
  setup.child.emit('close', 0, null); await setup.completion();
  assert.equal(setup.results.length, 1);
  const result = setup.results[0]!;
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.replyText, '原回复🙂');
});

test('CLI failed-process diagnostics discard sensitive native text and retain only static status', async context => {
  const setup = fixture(context);
  setup.child.stderr.emit('data', Buffer.from('Authorization: Bearer synthetic-private-stderr'));
  setup.child.stdout.emit('data', Buffer.from('synthetic-private-stdout'));
  setup.child.emit('exit', 1, null); assert.equal((await setup.starting).ok, false);
  setup.child.emit('close', 1, null); await setup.completion();
  assert.deepEqual(setup.results, [{ ok: false,
    error: 'openclaw CLI execution failed: code=1; original invocation must not be retried' }]);
});

test('opt-in CLI uses the instance home, fixed environment and launch-bound transcript only', async context => {
  const setup = fixture(context, 'main');
  const launch = setup.launches[0]!;
  assert.equal(launch.options.cwd, setup.home);
  assert.equal(launch.options.env.HOME, setup.home);
  assert.equal(launch.options.env.OPENCLAW_HOME, setup.home);
  assert.equal(launch.options.env.OPENCLAW_STATE_DIR, setup.home);
  assert.equal(launch.options.env.OPENCLAW_CONFIG_PATH, join(setup.home, 'openclaw.json'));
  assert.equal(launch.options.env.XDG_CONFIG_HOME, join(setup.home, 'config'));
  assert.equal(launch.options.env.TMPDIR, join(setup.home, 'tmp'));
  assert.equal(JSON.stringify(launch.options.env).includes('synthetic-private'), false);
  assert.notEqual(launch.executable, process.env.OPENCLAW_CLI_PATH);
  for (const [home, text] of [[setup.home, 'instance transcript'], [join(setup.ambient, '.openclaw'), 'ambient transcript']]) {
    const directory = join(home!, 'agents', 'main', 'sessions');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'synthetic.jsonl'), JSON.stringify({ timestamp: Date.now() + 1000,
      message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n');
  }
  process.env.AOD_OPENCLAW_HOME = setup.ambient;
  setup.child.stdout.emit('data', Buffer.from(JSON.stringify({ result: { payloads: [{ text: 'instance reply' }] } })));
  setup.child.emit('exit', 0, null); await setup.starting;
  setup.child.emit('close', 0, null); await setup.completion();
  assert.equal(setup.results[0]?.ok, true);
  assert.equal(JSON.stringify(setup.results).includes('instance transcript'), true);
  assert.equal(JSON.stringify(setup.results).includes('ambient transcript'), false);
});

test('CLI refuses transcript directory aliases instead of importing another home', async context => {
  const setup = fixture(context, 'main'), directory = join(setup.ambient, 'main', 'sessions');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'synthetic.jsonl'), JSON.stringify({ timestamp: Date.now() + 1000,
    message: { role: 'assistant', content: [{ type: 'text', text: 'outside transcript' }] } }) + '\n');
  symlinkSync(setup.ambient, join(setup.home, 'agents'));
  setup.child.stdout.emit('data', Buffer.from(JSON.stringify({ result: { payloads: [{ text: 'instance reply' }] } })));
  setup.child.emit('exit', 0, null); await setup.starting;
  setup.child.emit('close', 0, null); await setup.completion();
  assert.equal(JSON.stringify(setup.results).includes('outside transcript'), false);
});

test('CLI availability remains opt-in and never selects the generic parent binary override', context => {
  fixture(context);
  delete process.env.AOD_LOCAL_OPENCLAW_CLI;
  assert.equal(isOpenClawCliAvailable(), false);
  process.env.AOD_LOCAL_OPENCLAW_CLI = 'true';
  process.env.AOD_OPENCLAW_CLI_PATH = '/synthetic-nonexistent-binary';
  assert.equal(isOpenClawCliAvailable(), false);
});

test('CLI synchronous launch exceptions cannot leak native diagnostics', async context => {
  const setup = fixture(context);
  context.mock.method(childProcess, 'spawn', () => { throw new Error('synthetic-private-spawn-error'); });
  syncBuiltinESMExports();
  let lifetime!: Promise<void>;
  const result = await startOpenClawAgentFallback('synthetic', 'main', 'synthetic', 'input', 'second',
    () => assert.fail('no child means no native completion'), pending => { lifetime = pending; });
  await lifetime;
  assert.deepEqual(result, { ok: false,
    error: 'openclaw CLI launch unavailable; original invocation must not be retried' });
  assert.equal(setup.launches.length, 1);
});

test('CLI refuses an unsafe instance home without creating another child', async context => {
  const setup = fixture(context);
  chmodSync(setup.home, 0o755);
  assert.equal(isOpenClawCliAvailable(), false);
  const result = await startOpenClawAgentFallback('synthetic', 'main', 'synthetic', 'input', 'second');
  assert.equal(result.ok, false);
  assert.equal(setup.launches.length, 1);
});

test('CLI error events and malformed successful stdout cannot forward raw diagnostics', async context => {
  const setup = fixture(context);
  setup.child.emit('error', new Error('synthetic-private-launch-error'));
  assert.deepEqual(await setup.starting, { ok: false,
    error: 'openclaw CLI launch unavailable; original invocation must not be retried' });
  setup.child.stdout.emit('data', Buffer.from('synthetic-private-diagnostic-not-json'));
  setup.child.emit('close', 0, null); await setup.completion();
  assert.deepEqual(setup.results, [{ ok: false,
    error: 'openclaw CLI result unavailable; original invocation must not be retried' }]);
});
