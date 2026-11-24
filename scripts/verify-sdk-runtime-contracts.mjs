// Runs real, separately installed SDKs against synthetic native endpoints.
// No authentication/provider calls; never launches an installed Agent CLI.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runIsolatedSdkProbe } from './lib/isolated-sdk-probe.mjs';

const sdkRoot = process.argv[2];
if (!sdkRoot || !isAbsolute(sdkRoot)) throw new Error('Usage: node scripts/verify-sdk-runtime-contracts.mjs /absolute/isolated-sdk-install');
if (!process.env.AOD_SDK_PROBE_WORKER) {
  await runIsolatedSdkProbe(fileURLToPath(import.meta.url), sdkRoot, 25_000);
} else {
  await probe();
}
async function probe() {
const { tsImport } = await import('../apps/server/node_modules/tsx/dist/esm/api/index.mjs');
const { runNativeOperation, NativeOperationError } = await tsImport('../apps/server/src/connector/native-operation.ts', import.meta.url);
const fixture = fileURLToPath(new URL('./fixtures/sdk-contract-runtime.mjs', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-sdk-contract-'));
const children = [];
const env = { PATH: dirname(process.execPath), HOME: join(root, 'home'), XDG_CACHE_HOME: join(root, 'cache'),
  CLAUDE_CONFIG_DIR: join(root, 'claude'), COPILOT_HOME: join(root, 'copilot'), TMPDIR: join(root, 'tmp'),
  ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) };
try {
  for (const dir of [env.HOME, env.XDG_CACHE_HOME, env.CLAUDE_CONFIG_DIR, env.COPILOT_HOME, env.TMPDIR]) await mkdir(dir);
  async function sdk(name, version, entry) {
    const dir = resolve(sdkRoot, 'node_modules', name);
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.version, version, 'probe only accepts the reviewed SDK version');
    return import(pathToFileURL(join(dir, entry)).href);
  }
  const { query } = await sdk('@anthropic-ai/claude-agent-sdk', '0.3.280', 'sdk.mjs');
  const received = [];
  let denied = 0;
  const stream = query({ prompt: 'fixture only', options: {
    cwd: root, env, settingSources: [], permissionMode: 'default', includePartialMessages: true,
    pathToClaudeCodeExecutable: process.execPath,
    canUseTool: async () => { denied++; return { behavior: 'deny', message: 'Fixture: denied' }; },
    spawnClaudeCodeProcess: options => {
      assert.equal(options.cwd, root);
      assert.ok(options.args.includes('--output-format'));
      const child = spawn(process.execPath, [fixture, 'claude'], { cwd: root, env, stdio: 'pipe' });
      child.stderr.resume(); children.push(child); return child;
    },
  } });
  try {
    for await (const event of stream) { received.push(event); if (event.type === 'result') break; }
  } finally { stream.close(); }
  assert.equal(denied, 1);
  assert.ok(received.some(e => e.type === 'stream_event'));
  assert.equal(received.find(e => e.type === 'result')?.result, 'fixture reply');
  assert.deepEqual(received.find(e => e.type === 'result')?.fixture, { sends: 1, permissionDenied: true });

  const { CopilotClient, RuntimeConnection } = await sdk('@github/copilot-sdk', '1.0.14', 'dist/index.js');
  const client = new CopilotClient({ connection: RuntimeConnection.forStdio({ path: process.execPath, args: [fixture, 'copilot'] }),
    mode: 'empty', workingDirectory: root, baseDirectory: env.COPILOT_HOME, env,
    useLoggedInUser: false, logLevel: 'none' });
  let copilotDenied = 0;
  const config = { availableTools: [], onPermissionRequest: () => { copilotDenied++; return { kind: 'reject' }; } };
  try {
    await client.start();
    const session = await client.createSession(config);
    const events = [];
    let finish;
    const idle = new Promise(resolve => { finish = resolve; });
    session.on(event => { events.push(event); if (event.type === 'session.idle') finish(); });
    assert.equal(await session.send('fixture only'), 'user-fixture');
    await idle;
    assert.equal(copilotDenied, 1);
    assert.ok(events.some(e => e.type === 'assistant.message_delta'));
    assert.equal(events.find(e => e.type === 'assistant.message')?.data.content, 'fixture reply');
    assert.ok((await session.getEvents()).some(e => e.type === 'assistant.message'));
    const id = session.sessionId;
    await session.disconnect();
    const resumed = await client.resumeSession(id, config);
    assert.equal(resumed.sessionId, id);
    assert.ok((await resumed.getEvents()).some(e => e.type === 'assistant.message'));
    await resumed.abort();
    await resumed.disconnect();
  } finally {
    const errors = await client.stop();
    if (errors.length) throw new AggregateError(errors, 'SDK fixture shutdown failed');
  }
  for (const scenario of ['incompatible', 'lost-send']) {
    console.log(`Copilot negative contract: ${scenario}`);
    const broken = new CopilotClient({ connection: RuntimeConnection.forStdio({ path: process.execPath, args: [fixture, 'copilot', scenario] }),
      mode: 'empty', workingDirectory: root, baseDirectory: env.COPILOT_HOME, env,
      useLoggedInUser: false, logLevel: 'none' });
    try {
      if (scenario === 'incompatible') await assert.rejects(broken.start(), /protocol version mismatch/);
      else {
        await broken.start();
        const session = await broken.createSession(config);
        // This pinned SDK leaves the raw send promise pending on a lost ACK.
        // Exercise AgentOpsDeck's guard: timeout means UNKNOWN, never not-delivered.
        await assert.rejects(runNativeOperation(() => session.send('fixture lost acknowledgement'), { timeoutMs: 250 }),
          error => error instanceof NativeOperationError && error.outcome === 'unknown');
      }
    } finally { console.log(`Copilot negative contract cleanup: ${scenario}`); await broken.forceStop(); }
  }
  console.log(JSON.stringify({ scope: 'real SDK / synthetic native endpoints; no provider acceptance',
    claude: { sdk: '0.3.280', stream: true, permissionDenied: true, sends: 1 },
    copilot: { sdk: '1.0.14', stream: true, permissionDenied: true, resume: true, history: true, abort: true, sends: 1,
      incompatibleProtocolRejected: true, lostSendBoundedAsUnknown: true } }, null, 2));
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
    }
  }
  // Only the fresh directory owned by this invocation; no Agent data.
  await rm(root, { recursive: true, force: true });
}
}
