// Opt-in REAL provider acceptance. Uses disposable Hub/Connector data and native
// HOMEs, never production users/sessions. Each POST has one durable command ID;
// unknown results are retained, not automatically resent under a new identity.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runIsolatedSdkProbe, registerIsolatedProbeGroup } from './lib/isolated-sdk-probe.mjs';
import { litellmProbeEnvironment } from './lib/sdk-litellm-settings.mjs';
import { sdkAttachmentFixture } from './lib/sdk-attachment-fixture.mjs';
import { verifySdkFileBoards } from './lib/sdk-file-board-probe.mjs';
import { verifyAllCardLinkage } from './lib/all-card-linkage-probe.mjs';
import { sdkProbeOptions } from './lib/sdk-probe-options.mjs';
import { verifyCandidateRelease } from './stage-candidate-release.mjs';
import { verifySdkProbeAssets } from './lib/sdk-probe-assets.mjs';

const { settingsFile, fileBoards, fileCards, businessContent, candidate, childArgs } = sdkProbeOptions(process.argv.slice(2));
if (!process.env.AOD_SDK_PROBE_WORKER) {
  const scriptRoot = dirname(fileURLToPath(import.meta.url));
  await verifySdkProbeAssets(scriptRoot, join(candidate ?? dirname(scriptRoot), 'apps/server/dist'));
  if (candidate) await verifyCandidateRelease(candidate);
  await runIsolatedSdkProbe(fileURLToPath(import.meta.url), settingsFile, fileCards ? 1_800_000 : 600_000, childArgs, { retainEvidence: true });
} else {
  try { await probe(); }
  catch { console.error('Real LiteLLM acceptance failed; private bounded evidence retained (0600 result.json). No automatic resend.'); process.exitCode = 1; }
  finally { if (process.connected) process.disconnect(); }
}

const MAX_FIXTURE_BODY_BYTES = 16 * 1024 * 1024;
async function readBoundedJson(response, maxBytes = MAX_FIXTURE_BODY_BYTES) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Fixture JSON response exceeded byte ceiling');
  }
  if (!response.body) {
    const text = await response.text();
    assert.ok(Buffer.byteLength(text, 'utf8') <= maxBytes, 'Fixture JSON response exceeded byte ceiling');
    return JSON.parse(text);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buf = Buffer.from(chunk);
    total += buf.byteLength;
    assert.ok(total <= maxBytes, 'Fixture JSON response exceeded byte ceiling');
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
}

async function probe() {
  const root = process.env.AOD_SDK_PROBE_WORKER;
  const source = dirname(dirname(fileURLToPath(import.meta.url))), compiled = join(candidate ?? source, 'apps/server/dist');
  const candidateManifest = candidate ? await verifyCandidateRelease(candidate) : undefined;
  const settings = JSON.parse(await readFile(settingsFile, 'utf8'));
  const data = join(root, 'service-data');
  await mkdir(data, { mode: 0o700 });
  for (const name of ['claude-home', 'copilot-home', 'workspace', 'state']) await mkdir(join(data, name), { mode: 0o700 });
  const providerEnv = litellmProbeEnvironment(settings, data);
  const env = { ...process.env, ...providerEnv, AOD_SERVER_ROLE: 'all',
    AOD_ACCESS_KEY: randomUUID(), AOD_HUB_VAULT_SECRET: randomUUID(),
    AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false',
    AOD_MEDIA_BRIDGE_ENABLED: 'false', AOD_MEDIA_LIBRARY_ENABLED: 'false',
    AOD_ARTIFACT_RECEIVER_ENABLED: 'false', AOD_ARTIFACT_CAPABILITY_INJECTION: 'false',
    AOD_ARTIFACT_GATEWAY_CLIENT_ENABLED: 'false', AOD_CONNECTOR_UPDATE_ENABLED: 'false' };
  if (fileBoards || fileCards) {
    const boardRoot = join(data, 'panels');
    await mkdir(boardRoot, { mode: 0o700 });
    Object.assign(env, { AOD_BOARD_FILES_ENABLED: 'true',
      AOD_BOARD_FILES_JSON: JSON.stringify({ root: boardRoot,
        policies: ['claude-code', 'ghcp'].map(runtime => ({ owner: 'local:file-boards', runtime })) }),
      AOD_CLAUDE_TOOL_POLICY: 'workspace-edit', AOD_COPILOT_TOOL_POLICY: 'workspace-edit' });
  }
  // Validate production configuration before credential access or any inference.
  const { claudeConfig } = await import(pathToFileURL(join(compiled, 'claude/config.js')));
  const { copilotConfig } = await import(pathToFileURL(join(compiled, 'copilot/config.js')));
  claudeConfig(env); copilotConfig(env);
  const result = { passed: false, startedAt: new Date().toISOString(), scope: 'isolated-real-LiteLLM-Hub-Connector',
    model: settings.model, copilotWireApi: providerEnv.AOD_COPILOT_WIRE_API, stages: [], liveServiceChanged: false,
    ...(candidate ? { candidate, candidateManifest } : {}) };
  let stage = 'models', check = 'models', child, exit, exited = true, origin, streamAbort, streamFinished;
  const streams = { 'claude-code': 0, ghcp: 0 }, sse = { messages: 0, total: 0 };
  const sessions = new Map(), histories = new Map(), firstCommands = new Map(), modelCommands = new Map(), attachmentDownloads = new Map();
  const nonce = `LITELLM_${randomUUID().replaceAll('-', '')}`;
  const toolNonce = `FILE_${randomUUID().replaceAll('-', '')}`;
  await writeFile(join(data, 'workspace', 'verification.txt'), toolNonce, { mode: 0o600 });
  const wait = async (check, label, timeout = 90_000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) { assert.equal(exited, false, 'Fixture service exited'); if (await check()) return; await delay(100); }
    throw new Error(`Timed out: ${label}`);
  };
  async function json(path, method = 'GET', body, status = 200, headers = {}) {
    const response = await fetch(origin + path, { method,
      headers: { authorization: `Bearer ${env.AOD_ACCESS_KEY}`, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    if (response.status !== status) result.failedHttp = { method, status: response.status, expected: status };
    assert.equal(response.status, status, `HTTP status for ${method} fixture request`);
    return readBoundedJson(response);
  }
  const sessionPath = runtime => `/api/hub/v1/sessions/${encodeURIComponent(sessions.get(runtime))}`;
  async function state(runtime) {
    const page = await json('/api/hub/v1/sessions/state');
    return page.groups.flatMap(group => group.sessions).find(s => s.sessionKey === sessions.get(runtime));
  }
  async function start() {
    check = 'fixture-service-listener';
    origin = undefined; exited = false;
    child = fork(fileURLToPath(new URL('./lib/sdk-service-host.mjs', import.meta.url)), [compiled], {
      cwd: join(data, 'state'), env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const host = child;
    exit = new Promise(resolve => host.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }));
    host.on('message', message => {
      if (message?.kind === 'service-ready') origin = message.origin;
      if (message?.kind === 'sdk-probe-stream' && Object.hasOwn(streams, message.runtime)) streams[message.runtime]++;
      if (message?.kind === 'sdk-probe-group') void registerIsolatedProbeGroup(message.pid).then(() => {
        if (host.connected) host.send({ kind: 'sdk-probe-group-registered', pid: message.pid }, () => {});
      }, () => { if (host.connected) host.disconnect(); });
    });
    await wait(() => origin, 'fixture HTTP listener');
    check = 'native-readiness';
    await wait(async () => { const health = await json('/api/connector/v1/health'); return health.claude?.ready && health.copilot?.ready; }, 'native readiness');
    check = 'connection-verification';
    await json('/api/hub/v1/connections/local/verify', 'POST', {});
    check = 'event-stream';
    streamAbort = new AbortController();
    const response = await fetch(`${origin}/api/hub/v1/events/stream`, {
      headers: { authorization: `Bearer ${env.AOD_ACCESS_KEY}` }, signal: streamAbort.signal });
    assert.equal(response.status, 200);
    streamFinished = (async () => {
      const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '';
      try { while (true) {
        const { value, done } = await reader.read(); if (done) break;
        pending += decoder.decode(value, { stream: true });
        let index;
        while ((index = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, index); pending = pending.slice(index + 2);
          if (/^event:/m.test(frame)) sse.total++;
          if (/^event:\s*message\./m.test(frame)) sse.messages++;
        }
        assert.ok(pending.length < 2_000_000);
      } } catch { if (!streamAbort.signal.aborted) result.streamFailed = true; }
      finally { reader.releaseLock(); }
    })();
  }
  async function stop() {
    streamAbort?.abort(); await streamFinished;
    if (!child || exited) return;
    child.kill('SIGTERM');
    let timer;
    try {
      const stopped = await Promise.race([exit, new Promise(resolve => { timer = setTimeout(resolve, 20_000); })]);
      assert.deepEqual(stopped, { code: 0, signal: null }, 'Graceful fixture shutdown required');
    } finally { clearTimeout(timer); }
  }
  async function queueEditCancel(runtime) {
    const path = sessionPath(runtime), text = `CANCEL_ME_${randomUUID()}`;
    const previousIds = new Set((await json(`${path}/queue`)).items.map(i => i.id));
    await json(`${path}/messages`, 'POST', { message: text, idempotencyKey: randomUUID() });
    let item = (await json(`${path}/queue`)).items.find(i => !previousIds.has(i.id));
    assert.ok(item, 'Waiting input visible');
    assert.equal(item.state, 'queued');
    const id = item.id, edited = `${text}_EDITED`;
    await json(`${path}/queue/${encodeURIComponent(id)}`, 'PATCH', { message: edited }, 200,
      { 'if-match': `"${item.version}"`, 'idempotency-key': randomUUID() });
    item = (await json(`${path}/queue`)).items.find(i => i.id === id);
    assert.ok(item);
    assert.ok((await json(`${path}/messages?limit=200`)).messages.some(m => m.text === edited));
    await json(`${path}/queue/${encodeURIComponent(id)}`, 'DELETE', undefined, 200,
      { 'if-match': `"${item.version}"`, 'idempotency-key': randomUUID() });
    assert.ok(!(await json(`${path}/queue`)).items.some(i => i.id === id));
    return edited;
  }
  async function verifyDownloads(runtime) {
    for (const { url, data } of attachmentDownloads.get(runtime) ?? []) {
      check = 'attachment-scoped-url';
      assert.ok(url.startsWith('/api/hub/v1/sessions/'), 'Download must use scoped Hub API');
      const response = await fetch(origin + url, { headers: { authorization: `Bearer ${env.AOD_ACCESS_KEY}` }, signal: AbortSignal.timeout(15_000) });
      check = `attachment-http-${response.status}`;
      assert.equal(response.status, 200);
      check = 'attachment-nosniff'; assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      check = 'attachment-bytes';
      const expectedBytes = Buffer.from(data, 'base64');
      const chunks = [];
      let total = 0;
      for await (const chunk of response.body ?? []) {
        const buf = Buffer.from(chunk);
        total += buf.byteLength;
        assert.ok(total <= expectedBytes.byteLength + 1024, 'Attachment download exceeded expected size');
        chunks.push(buf);
      }
      assert.deepEqual(Buffer.concat(chunks, total), expectedBytes);
      check = 'attachment-unauthenticated';
      assert.notEqual((await fetch(origin + url, { signal: AbortSignal.timeout(15_000) })).status, 200, 'Unauthenticated media denied');
    }
  }
  async function send(runtime, label, text, expected, withQueue = false, attachments = []) {
    stage = `${runtime}:${label}`;
    check = 'send-admission';
    const before = streams[runtime], beforeSse = sse.messages, previous = (await state(runtime))?.runtime?.turnId;
    const path = sessionPath(runtime), command = { message: text, idempotencyKey: randomUUID(),
      ...(attachments.length ? { media: attachments.map(item => ({ type: item.mimeType.startsWith('image/') ? 'image' : 'file',
        name: item.name, mimeType: item.mimeType, dataUrl: `data:${item.mimeType};base64,${item.data}` })) } : {}) };
    const receipt = await json(`${path}/messages`, 'POST', command);
    assert.equal(receipt.command.state, 'accepted');
    if (label === 'first') firstCommands.set(runtime, command);
    // Repeating the SAME ID is a receipt lookup, never a new command.
    assert.equal((await json(`${path}/messages`, 'POST', command)).command.state, 'accepted');
    let cancelled;
    if (withQueue) {
      check = 'queue-edit-cancel';
      await wait(async () => (await state(runtime))?.hasActiveRun, 'running before queue');
      cancelled = await queueEditCancel(runtime);
    }
    check = 'run-completion';
    let completedTurn;
    await wait(async () => {
      const current = await state(runtime);
      if (current?.runtime?.turnId === previous) return false;
      assert.ok(!['failed', 'unknown', 'interrupted'].includes(current?.runtime?.phase), `Non-success ${runtime} terminal`);
      if (current?.runtime?.phase !== 'completed') return false;
      completedTurn = current.runtime.turnId;
      return true;
    }, `${runtime} completed`);
    const page = await json(`${path}/messages?limit=200`);
    check = 'current-turn-exact-reply';
    assert.equal(page.messages.filter(m => m.role === 'user' && m.text === text).length, 1);
    assert.ok(page.messages.some(m => m.turnId === completedTurn && m.role === 'assistant' && m.text?.trim() === expected), 'Exact current-turn real model response');
    check = 'queue-empty-and-streaming';
    assert.equal((await json(`${path}/queue`)).items.length, 0);
    if (cancelled) assert.ok(!page.messages.some(m => m.text?.includes(cancelled)), 'Cancelled input never executed');
    assert.ok(streams[runtime] > before, 'Native live text projection observed');
    await wait(() => sse.messages > beforeSse, 'Hub message SSE');
    const checked = { runtime, label, passed: true, liveProjections: streams[runtime] - before,
      hubMessageEvents: sse.messages - beforeSse, messages: page.messages.length,
      queueEditCancel: !!withQueue };
    if (attachments.length) {
      check = 'scoped-attachment-download';
      const user = page.messages.find(m => m.role === 'user' && m.text === text);
      check = 'attachment-metadata-count';
      assert.equal(user.media.length, attachments.length);
      check = 'attachment-history-no-body';
      assert.ok(!JSON.stringify(page).includes(attachments[0].data), 'History never contains attachment base64');
      attachmentDownloads.set(runtime, attachments.map(item => ({ url: user.media.find(m => m.name === item.name).url, data: item.data })));
      await verifyDownloads(runtime); checked.attachmentsVerified = true;
    }
    if (label === 'tool') {
      check = 'lazy-tool-detail';
      const tool = page.messages.find(m => m.turnId === completedTurn && m.role === 'tool' && m.toolPhase === 'result' && m.status !== 'failed');
      assert.ok(tool, 'Tool chain contains real file read');
      await json(`${path}/messages/${encodeURIComponent(tool.id)}`);
      checked.lazyToolDetail = true;
    }
    result.stages.push(checked); console.log(JSON.stringify(checked));
    histories.set(runtime, page.messages);
  }
  async function compact(runtime) {
    stage = `${runtime}:compact`; check = 'compact-admission';
    const path = sessionPath(runtime), idempotencyKey = randomUUID();
    const accepted = await json(`${path}/compact`, 'POST', { idempotencyKey });
    assert.equal(accepted.command.state, 'accepted');
    assert.equal((await json(`${path}/compact-commands/${idempotencyKey}`)).command.state, 'accepted');
    check = 'compact-native-terminal';
    await wait(async () => {
      const current = (await state(runtime))?.runtime;
      assert.ok(!['unknown', 'failed', 'interrupted'].includes(current?.phase));
      return current?.operation === 'compact' && current.phase === 'completed';
    }, 'compact completed');
    result.stages.push({ runtime, label: 'compact', passed: true });
    console.log(JSON.stringify(result.stages.at(-1)));
    await send(runtime, 'after-compact', 'After this compaction, repeat only the original verification word from my first message, not the file contents. Do not use tools.', nonce);
  }
  async function stopActive(runtime) {
    stage = `${runtime}:stop`; check = 'stop-run-admission';
    const path = sessionPath(runtime), previous = (await state(runtime))?.runtime?.turnId, before = streams[runtime];
    const message = 'Write the integers from 1 through 20000 in order, one per line. No tools, no abbreviations, no commentary.';
    assert.equal((await json(`${path}/messages`, 'POST', { message, idempotencyKey: randomUUID() })).command.state, 'accepted');
    let expectedRunId;
    check = 'stop-live-stream';
    await wait(async () => {
      const current = await state(runtime);
      expectedRunId = current?.runtime?.turnId;
      return expectedRunId && expectedRunId !== previous && current.hasActiveRun && streams[runtime] > before;
    }, 'live output before stop');
    check = 'stop-exact-run';
    const stopped = await json(`${path}/messages`, 'POST', { message: '/stop', expectedRunId, idempotencyKey: randomUUID() });
    assert.equal(stopped.command.state, 'accepted');
    check = 'stop-native-terminal';
    await wait(async () => {
      const current = (await state(runtime))?.runtime;
      assert.equal(current?.turnId, expectedRunId);
      assert.ok(!['unknown', 'failed'].includes(current?.phase));
      return current?.phase === 'interrupted';
    }, 'interrupted exact run');
    assert.equal((await json(`${path}/queue`)).items.length, 0);
    const history = (await json(`${path}/messages?limit=200`)).messages;
    assert.equal(history.filter(m => m.role === 'user' && m.text === message).length, 1);
    result.stages.push({ runtime, label: 'stop', passed: true, exactRun: true });
    console.log(JSON.stringify(result.stages.at(-1)));
    await send(runtime, 'after-stop', 'Reply exactly STOP_RECOVERED, without punctuation or tools.', 'STOP_RECOVERED');
  }
  try {
    const { readPrivateWorkerCredential } = await import(pathToFileURL(join(compiled, 'connector/private-worker-credential.js')));
    const key = await readPrivateWorkerCredential(settings.apiKeyFile);
    const models = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/v1/models`, {
      headers: { authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    assert.equal(models.status, 200);
    assert.ok((await readBoundedJson(models, 2 * 1024 * 1024)).data.some(m => m.id === settings.model));
    result.modelsVerified = true;
    stage = 'startup'; await start();
    if (fileCards) {
      await verifyAllCardLinkage({ json, wait, state, start, stop, sessions,
        businessContent,
        runtimes: ['claude-code', 'ghcp'], connectionId: 'local', panelRoot: join(data, 'panels'), result,
        checkpoint: async label => { stage = label; check = label;
          await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 }); } });
      result.passed = true;
      return;
    }
    if (fileBoards) {
      await verifySdkFileBoards({ json, wait, state, start, stop, sessions, streams, sse, data, result,
        checkpoint: async label => { stage = label; check = label;
          await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 }); } });
      result.passed = true;
      return;
    }
    for (const runtime of ['claude-code', 'ghcp']) {
      const created = await json(`/api/hub/v1/connections/local/agents/${runtime}/sessions`, 'POST',
        { title: `Isolated LiteLLM acceptance ${runtime}`, idempotencyKey: randomUUID() }, 201);
      sessions.set(runtime, created.key);
      stage = `${runtime}-model-setting`; check = 'configured model accepted without provider mutation';
      const catalog = await json(`/api/hub/v1/connections/local/models/${runtime}`);
      assert.ok(catalog.models.some(model => model.id === settings.model));
      const command = { model: settings.model, idempotencyKey: randomUUID() };
      modelCommands.set(runtime, command);
      const applied = await json(`/api/sessions/${encodeURIComponent(created.key)}`, 'PATCH', command);
      assert.equal(applied.command.state, 'accepted');
      assert.equal(applied.settings.model, settings.model);
      await send(runtime, 'first', `Remember the verification word ${nonce}. Reply with only that word, no punctuation or tools.`, nonce);
      await send(runtime, 'tool', `Read the file at ${join(data, 'workspace', 'verification.txt')} using the file read tool. Reply only with the exact file contents, no punctuation.`, toolNonce, true);
      await send(runtime, 'attachments', 'Read the attached text file. Reply only with its exact contents, no punctuation or tools. An image is also attached.',
        'ATTACHMENT_TEXT_FIXTURE', false, sdkAttachmentFixture);
    }
    stage = 'graceful-stop'; await stop();
    stage = 'restart'; await start();
    for (const runtime of sessions.keys()) {
      await verifyDownloads(runtime);
      assert.deepEqual((await json(`${sessionPath(runtime)}/messages?limit=200`)).messages, histories.get(runtime));
      assert.equal((await json(`${sessionPath(runtime)}/messages`, 'POST', firstCommands.get(runtime))).command.state, 'accepted');
      assert.deepEqual((await json(`${sessionPath(runtime)}/messages?limit=200`)).messages, histories.get(runtime), 'Duplicate receipt must not append history');
      stage = `${runtime}-model-restart`; check = 'model receipt survives service restart';
      const settingsPath = `/api/sessions/${encodeURIComponent(sessions.get(runtime))}`;
      assert.equal((await json(settingsPath, 'PATCH', modelCommands.get(runtime))).command.state, 'accepted');
      assert.equal((await state(runtime)).model, settings.model);
      await send(runtime, 'resume', 'Repeat only the original verification word from my first message, not the file contents. Do not use tools.', nonce);
      stage = `${runtime}-model-reset`; check = 'model reset accepted';
      const reset = await json(settingsPath, 'PATCH', { model: null, idempotencyKey: randomUUID() });
      assert.equal(reset.command.state, 'accepted'); assert.equal(reset.settings.model, settings.model);
      await compact(runtime);
      await stopActive(runtime);
    }
    result.modelSettingsVerified = true;
    result.passed = true;
  } catch {
    result.failedStage = stage;
    result.failedCheck = check;
    // Persist only known local facts, never SDK/provider diagnostics or headers.
    if (origin && !exited) result.sessionPhases = await Promise.all([...sessions.keys()].map(async runtime => {
      try { return { runtime, phase: (await state(runtime))?.runtime?.phase }; } catch { return { runtime, unavailable: true }; }
    }));
  } finally {
    try { await stop(); result.gracefulShutdown = true; }
    catch { result.passed = false; result.gracefulShutdown = false; }
    if (result.streamFailed) result.passed = false;
    if (!result.passed) process.exitCode = 1;
    result.finishedAt = new Date().toISOString();
    await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ passed: result.passed, failedStage: result.failedStage, evidence: join(root, 'result.json') }));
  }
  assert.equal(result.passed, true);
}
