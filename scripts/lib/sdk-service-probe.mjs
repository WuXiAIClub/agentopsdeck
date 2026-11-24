import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdir, writeFile, cp, rename, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { registerIsolatedProbeGroup } from './isolated-sdk-probe.mjs';

export async function verifySdkService({ root, sdkRoot, base, inferenceCount }) {
  assert.equal(process.env.AOD_SDK_PROBE_WORKER, root);
  const data = join(root, 'service-data');
  await mkdir(data, { mode: 0o700 });
  for (const name of ['claude-home', 'copilot-home', 'workspace', 'state']) await mkdir(join(data, name), { mode: 0o700 });
  const credential = join(data, 'fixture-key');
  await writeFile(credential, 'fixture-not-a-secret', { mode: 0o600 });
  const env = { ...process.env, AOD_SERVER_ROLE: 'all', AOD_ACCESS_KEY: 'synthetic-service-key',
    AOD_HUB_VAULT_SECRET: 'synthetic-service-vault', AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false',
    AOD_MEDIA_BRIDGE_ENABLED: 'false', AOD_MEDIA_LIBRARY_ENABLED: 'false', AOD_ARTIFACT_RECEIVER_ENABLED: 'false',
    AOD_ARTIFACT_CAPABILITY_INJECTION: 'false', AOD_ARTIFACT_GATEWAY_CLIENT_ENABLED: 'false',
    AOD_CONNECTOR_UPDATE_ENABLED: 'false',
    AOD_CLAUDE_ENABLED: 'true', AOD_CLAUDE_DEDICATED: 'true',
    AOD_CLAUDE_SDK_DIR: await realpath(join(sdkRoot, 'node_modules/@anthropic-ai/claude-agent-sdk')),
    AOD_CLAUDE_HOME: join(data, 'claude-home'), AOD_CLAUDE_WORKSPACE: join(data, 'workspace'),
    AOD_CLAUDE_API_KEY_FILE: credential, AOD_CLAUDE_BASE_URL: base, AOD_CLAUDE_ALLOW_HTTP: 'true',
    AOD_CLAUDE_MODEL: 'claude-sonnet-4-6',
    AOD_COPILOT_ENABLED: 'true', AOD_COPILOT_DEDICATED: 'true',
    AOD_COPILOT_SDK_DIR: await realpath(join(sdkRoot, 'node_modules/@github/copilot-sdk')),
    AOD_COPILOT_HOME: join(data, 'copilot-home'), AOD_COPILOT_WORKSPACE: join(data, 'workspace'),
    AOD_COPILOT_AUTH_MODE: 'provider', AOD_COPILOT_PROVIDER_TYPE: 'openai', AOD_COPILOT_WIRE_API: 'completions',
    AOD_COPILOT_API_KEY_FILE: credential, AOD_COPILOT_BASE_URL: `${base}/v1`, AOD_COPILOT_ALLOW_HTTP: 'true',
    AOD_COPILOT_MODEL: 'gpt-4.1' };
  const wait = async (check, label) => {
    for (let i = 0; i < 600; i++) { if (await check()) return; await delay(50); }
    assert.fail(`Full service timeout: ${label}`);
  };
  let child, exit, exited = true, origin;
  const pids = new Set(), sessions = new Map(), histories = new Map();
  async function start() {
    origin = undefined; exited = false;
    child = fork(fileURLToPath(new URL('./sdk-service-host.mjs', import.meta.url)), [], {
      cwd: join(data, 'state'), env, execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    assert.ok(!pids.has(child.pid), 'New OS process after each stop'); pids.add(child.pid);
    exit = new Promise(resolve => child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }));
    const host = child;
    host.on('message', message => {
      if (message?.kind === 'service-ready') origin = message.origin;
      if (message?.kind === 'sdk-probe-group') void registerIsolatedProbeGroup(message.pid).then(() => {
        if (host.connected) host.send({ kind: 'sdk-probe-group-registered', pid: message.pid }, () => {});
      }, () => { if (host.connected) host.disconnect(); });
    });
    await wait(() => { assert.equal(exited, false, 'Service startup exit'); return origin; }, 'HTTP listener');
    await wait(async () => { const health = await json('/api/connector/v1/health');
      return health.claude?.ready && health.copilot?.ready; }, 'both runtime preflights');
    await json('/api/hub/v1/connections/local/verify', 'POST', {});
  }
  async function stop() {
    if (!child || exited) return;
    child.kill('SIGTERM');
    await wait(() => exited, 'graceful process shutdown');
    assert.deepEqual(await exit, { code: 0, signal: null });
  }
  async function json(path, method = 'GET', body, status = 200) {
    const response = await fetch(origin + path, { method, headers: { authorization: 'Bearer synthetic-service-key',
      'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result;
  }
  async function send(runtime, stage) {
    const key = sessions.get(runtime), path = `/api/hub/v1/sessions/${encodeURIComponent(key)}`;
    const text = `${stage} full service ${runtime}`;
    const body = { message: text, idempotencyKey: `${stage}-${runtime}` };
    assert.equal((await json(`${path}/messages`, 'POST', body)).command.state, 'accepted');
    assert.equal((await json(`${path}/messages`, 'POST', body)).command.state, 'accepted');
    await wait(async () => {
      const page = await json(`${path}/messages?limit=200`);
      const state = await json('/api/hub/v1/sessions/state');
      const session = state.groups.flatMap(group => group.sessions).find(session => session.sessionKey === key);
      return page.messages.some(message => message.role === 'user' && message.text === text)
        && session?.runtime?.phase === 'completed' && (await json(`${path}/queue`)).items.length === 0;
    }, `persisted terminal ${runtime} ${stage}`);
    const messages = (await json(`${path}/messages?limit=200`)).messages;
    assert.equal(messages.filter(m => m.role === 'user' && m.text === text).length, 1);
    assert.ok(messages.some(m => m.role === 'assistant' && m.text === 'Isolated fixture reply.'));
    return messages;
  }
  const before = inferenceCount();
  try {
    await start();
    for (const runtime of ['claude-code', 'ghcp']) {
      const result = await json(`/api/hub/v1/connections/local/agents/${runtime}/sessions`, 'POST',
        { title: `Full service ${runtime}`, idempotencyKey: `service-create-${runtime}` }, 201);
      sessions.set(runtime, result.key);
      histories.set(runtime, await send(runtime, 'first'));
    }
    await stop();
    await cp(data, join(root, 'service-backup'), { recursive: true, errorOnExist: true, force: false });
    for (const stage of ['restarted', 'restored']) {
      if (stage === 'restored') {
        await rename(data, join(root, 'service-after-restart'));
        await cp(join(root, 'service-backup'), data, { recursive: true, errorOnExist: true, force: false });
      }
      await start();
      for (const [runtime, key] of sessions) {
        const path = `/api/hub/v1/sessions/${encodeURIComponent(key)}`;
        assert.deepEqual((await json(`${path}/messages?limit=200`)).messages, histories.get(runtime));
        // Durable duplicate identity survives process replacement/restore.
        assert.equal((await json(`${path}/messages`, 'POST', { message: `first full service ${runtime}`,
          idempotencyKey: `first-${runtime}` })).command.state, 'accepted');
        await send(runtime, stage);
      }
      await stop();
    }
    assert.equal(pids.size, 3);
    assert.equal(inferenceCount() - before, 6, 'Process restart/restore never replays accepted commands');
    console.log('Full compiled application: both runtimes, 3 OS processes, SIGTERM stop, stopped backup, restore and same-session continuation passed');
  } finally { await stop(); }
  return { claude: 3, copilot: 3 };
}
