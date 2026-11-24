// Disposable full application process. Only this test host injects worker
// registration; production routing/configuration/composition remain intact.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerIsolatedProbeGroup } from './isolated-sdk-probe.mjs';
import { sdkProbeHttpModule } from './sdk-probe-assets.mjs';
const ALLOWED_ERROR_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'AssertionError', 'AbortError', 'TimeoutError',
]);
export function formatHostCloseDiagnostic(error) {
  const rawName = typeof error?.name === 'string' ? error.name : '';
  const name = ALLOWED_ERROR_NAMES.has(rawName) ? rawName : 'Error';
  const rawCode = typeof error?.code === 'string' ? error.code : '';
  const code = /^(?:E[A-Z0-9_]{1,31}|ERR_[A-Z0-9_]{1,48})$/.test(rawCode) ? rawCode : undefined;
  return code ? { name, code } : { name };
}

if (process.env.AOD_SDK_PROBE_WORKER) {
  const root = process.env.AOD_SDK_PROBE_WORKER;
  assert.ok(root && process.send);
  const compiled = process.argv[2] ?? join(root, 'compiled-server');
  assert.ok(compiled.startsWith('/'));
  const load = name => import(pathToFileURL(join(compiled, `${name}.js`)).href);
  const { serve } = process.argv[2]
    ? await import(pathToFileURL(sdkProbeHttpModule(compiled)))
    : await import('../../apps/server/node_modules/@hono/node-server/dist/index.mjs');
  const { loadConfig } = await load('config');
  const { createApplication } = await load('application');
  const { createConnectorRuntime } = await load('connector/runtime');
  const { ClaudeConnectorRuntime } = await load('claude/connector-runtime');
  const { ClaudeOwnedRuntime } = await load('claude/owned-runtime');
  const { ClaudeWorkerTurn } = await load('claude/worker-turn');
  const { ClaudeWorkerPreflight } = await load('claude/worker-preflight');
  const { CopilotConnectorRuntime } = await load('copilot/connector-runtime');
  const { CopilotOwnedRuntime } = await load('copilot/owned-runtime');
  const { CopilotWorkerTurn } = await load('copilot/worker-turn');
  const { CopilotWorkerPreflight } = await load('copilot/worker-preflight');
  const { SdkCompactWorker } = await load('connector/sdk-compact-worker');
  const { claudeWorkerEnvironment } = await load('claude/worker-environment');
  const { copilotWorkerEnvironment } = await load('copilot/worker-environment');
  const telemetry = new URL('./sdk-probe-stream-shapes.mjs', import.meta.url);
  telemetry.searchParams.set('root', root); telemetry.searchParams.set('compiled', compiled);
  const launch = vendor => ({ entry: join(compiled, vendor, 'worker-main.js'),
    execArgv: vendor === 'claude' ? ['--import', telemetry.href] : [],
    beforeStart: registerIsolatedProbeGroup });
  const streamed = runtime => { if (process.connected) process.send({ kind: 'sdk-probe-stream', runtime }); };
  const compact = runtime => request => new SdkCompactWorker(request, {
    runtime, workspace: request.config.workspace, timeoutMs: request.config.compactTimeoutMs ?? 600_000,
    env: runtime === 'ghcp' ? copilotWorkerEnvironment(request.config) : claudeWorkerEnvironment(request.config),
    launch: launch(runtime === 'ghcp' ? 'copilot' : 'claude'),
  });
  let connector;
  const application = createApplication(loadConfig(), (config, authorized) => connector = createConnectorRuntime(config, authorized, {
    claude: options => new ClaudeConnectorRuntime(options, settings => new ClaudeOwnedRuntime(settings,
      (request, project, stream, metrics, interaction) => new ClaudeWorkerTurn(request, launch('claude'), project,
        snapshot => { streamed('claude-code'); stream(snapshot); }, metrics, interaction),
      config => new ClaudeWorkerPreflight(config, launch('claude')), undefined, compact('claude-code'))),
    copilot: options => new CopilotConnectorRuntime(options, settings => new CopilotOwnedRuntime(settings,
      (request, project) => new CopilotWorkerTurn(request, launch('copilot'), { ...project,
        stream: snapshot => { streamed('ghcp'); project.stream?.(snapshot); } }),
      config => new CopilotWorkerPreflight(config, launch('copilot')), undefined, compact('ghcp'))),
  }));
  // Test-only IPC, not an HTTP/production endpoint. Native goal changes are
  // restricted to this disposable Connector's already-created Codex threads.
  process.on('message', message => {
    if (message?.kind !== 'sdk-probe-goal' || process.env.AOD_SDK_PROBE_GOALS !== 'true') return;
    void (async () => {
      assert.match(message.threadId, /^[a-f0-9-]{36}$/);
      assert.ok(connector.codex.owns(`codex:${message.threadId}`));
      assert.ok(connector.store.getSession(`codex:${message.threadId}`));
      assert.ok(['get', 'set'].includes(message.operation));
      const params = { threadId: message.threadId };
      if (message.operation === 'set') {
        assert.ok(['blocked', 'paused', 'complete', 'budgetLimited', 'usageLimited'].includes(message.status));
        params.status = message.status;
        if (message.objective !== undefined) {
          assert.ok(typeof message.objective === 'string' && message.objective.length <= 200);
          params.objective = message.objective;
        }
      }
      const result = await connector.codex.request(`thread/goal/${message.operation}`, params);
      if (process.connected) process.send({ kind: 'sdk-probe-goal-result', id: message.id, result });
    })().catch(() => {
      if (process.connected) process.send({ kind: 'sdk-probe-goal-result', id: message.id, failed: true });
    });
  });
  const server = serve({ fetch: application.app.fetch, hostname: '127.0.0.1', port: 0 }, info => {
    process.send({ kind: 'service-ready', origin: `http://127.0.0.1:${info.port}` });
  });
  let closing;
  const stop = (code = 0) => closing ??= (async () => {
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await application.close(); await closed;
    process.exit(code);
  })().catch(error => {
    const diagnostic = formatHostCloseDiagnostic(error);
    if (process.connected) process.send({ kind: 'sdk-probe-close-failure', diagnostic }, () => process.exit(1));
    else process.exit(1);
  });
  process.on('SIGTERM', () => { void stop(); });
  process.on('SIGINT', () => { void stop(); });
  process.on('disconnect', () => { void stop(1); });
}
