// Opt-in actual model/native worker acceptance. Only disposable sessions/data.
// A failed/unknown send is never retried. Credentials stay in private workers.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runIsolatedSdkProbe, registerIsolatedProbeGroup } from './lib/isolated-sdk-probe.mjs';
import { litellmProbeEnvironment } from './lib/sdk-litellm-settings.mjs';
import { liveInteractionOptions, newTurnFailed } from './lib/live-interaction-options.mjs';
import { verifyCandidateRelease } from './stage-candidate-release.mjs';

const { settingsFile, codexCommand, codexProvider, selected, scenario, provider, runtimes, candidateRoot } = liveInteractionOptions(process.argv.slice(2));
const candidate = candidateRoot ? await verifyCandidateRelease(candidateRoot) : undefined;
if (!process.env.AOD_SDK_PROBE_WORKER) {
  await runIsolatedSdkProbe(fileURLToPath(import.meta.url), settingsFile, 1_200_000,
    [codexCommand, codexProvider, selected, scenario, ...(candidateRoot ? [candidateRoot] : [])], { retainEvidence: true });
} else {
  try { await probe(); }
  catch { console.error('Live interaction acceptance failed; inspect private bounded result.json (0600). No message was resent.'); process.exitCode = 1; }
  finally { if (process.connected) process.disconnect(); }
}

async function probe() {
  const root = process.env.AOD_SDK_PROBE_WORKER, data = join(root, 'data');
  console.log(JSON.stringify({ evidence: root, scope: 'isolated-real-model' }));
  const compiled = join(candidateRoot ?? dirname(dirname(fileURLToPath(import.meta.url))), 'apps/server/dist');
  for (const name of ['', 'state', 'workspace', 'claude-home', 'copilot-home', 'codex-home']) await mkdir(join(data, name), { mode: 0o700 });
  const settings = JSON.parse(await readFile(settingsFile, 'utf8'));
  await writeFile(join(data, 'codex-home/config.toml'), `model = ${JSON.stringify(settings.model)}
model_provider = "copilot_bridge"
[model_providers.copilot_bridge]
name = "copilot_bridge"
base_url = ${JSON.stringify(provider.origin)}
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
`, { mode: 0o600, flag: 'wx' });
  const env = { ...process.env, ...litellmProbeEnvironment(settings, data),
    AOD_SDK_PROBE_GOALS: String(scenario === 'goals'),
    AOD_SERVER_ROLE: 'all', AOD_ACCESS_KEY: randomUUID(), AOD_HUB_VAULT_SECRET: randomUUID(),
    AOD_CODEX_ENABLED: String(runtimes.includes('codex')), AOD_CODEX_COMMAND: codexCommand,
    AOD_CODEX_HOME: join(data, 'codex-home'), AOD_CODEX_DEFAULT_CWD: join(data, 'workspace'),
    AOD_CODEX_DEFAULT_MODEL: settings.model, AOD_CODEX_MODEL_PROVIDER: 'copilot_bridge',
    AOD_CODEX_APPROVAL_POLICY: 'never',
    AOD_CLAUDE_TOOL_POLICY: 'workspace-edit', AOD_COPILOT_TOOL_POLICY: 'workspace-edit',
    AOD_LOCAL_OPENCLAW_CLI: 'false', AOD_MEDIA_BRIDGE_ENABLED: 'false',
    AOD_MEDIA_LIBRARY_ENABLED: 'false', AOD_ARTIFACT_RECEIVER_ENABLED: 'false',
    AOD_ARTIFACT_CAPABILITY_INJECTION: 'false', AOD_ARTIFACT_GATEWAY_CLIENT_ENABLED: 'false',
    AOD_CONNECTOR_UPDATE_ENABLED: 'false' };
  const evidence = { passed: false, scope: 'isolated-real-model-Hub-Connector-native-workers',
    startedAt: new Date().toISOString(), model: settings.model, productionTouched: false, candidate, stages: [], sessions: {}, interactionEvents: 0 };
  let child, exit, exited = true, origin, abort, eventsDone, stage = 'startup';
  const save = () => writeFile(join(root, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  const record = async (runtime, label, extra = {}) => { const item = { runtime, label, passed: true, ...extra }; evidence.stages.push(item); await save(); console.log(JSON.stringify(item)); };
  async function json(path, method = 'GET', body, expected = 200) {
    const res = await fetch(origin + path, { method, headers: { authorization: `Bearer ${env.AOD_ACCESS_KEY}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
    if (res.status !== expected) evidence.failedHttp = { method, status: res.status, expected, route: path.split('/').at(-1)?.split('?')[0] };
    assert.equal(res.status, expected, 'API status');
    const text = await res.text();
    assert.ok(Buffer.byteLength(text, 'utf8') <= 16 * 1024 * 1024, 'API response exceeded byte ceiling');
    return JSON.parse(text);
  }
  const path = runtime => `/api/hub/v1/sessions/${encodeURIComponent(evidence.sessions[runtime])}`;
  const interactions = runtime => json(`${path(runtime)}/interactions`);
  const previousRuns = new Map();
  const state = async runtime => (await json('/api/hub/v1/sessions/state')).groups.flatMap(g => g.sessions).find(s => s.sessionKey === evidence.sessions[runtime]);
  async function wait(check, label, timeout = 120_000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { assert.ok(!exited, 'Isolated host exited'); const value = await check(); if (value) return value; await delay(250); }
    throw new Error(`Timeout: ${label}`);
  }
  async function start({ fenced = false } = {}) {
    exited = false; origin = undefined;
    child = fork(fileURLToPath(new URL('./lib/sdk-service-host.mjs', import.meta.url)), [compiled], {
      cwd: join(data, 'state'), env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const host = child;
    exit = new Promise(resolve => host.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }));
    host.on('message', message => {
      if (message?.kind === 'service-ready') origin = message.origin;
      if (message?.kind === 'sdk-probe-close-failure') evidence.hostCloseFailure = message.diagnostic;
      if (message?.kind === 'sdk-probe-group') void registerIsolatedProbeGroup(message.pid).then(() => {
        if (host.connected) host.send({ kind: 'sdk-probe-group-registered', pid: message.pid }, () => {});
      }, () => { if (host.connected) host.disconnect(); });
    });
    await wait(() => origin, 'listener');
    // Codex starts lazily on the first session catalog read, not health GET.
    await json('/api/hub/v1/sessions/state');
    await wait(async () => {
      const h = await json('/api/connector/v1/health');
      const sdkReady = [['claude-code', h.claude], ['ghcp', h.copilot]].every(([runtime, health]) =>
        fenced && runtimes.includes(runtime) ? health?.status === 'failed' && !health.ready : health?.ready);
      return sdkReady && (!runtimes.includes('codex') || h.codex?.sessionListReady);
    }, fenced ? 'unfinished SDK ownership remains fenced' : 'native readiness');
    await json('/api/hub/v1/connections/local/verify', 'POST', {});
    abort = new AbortController();
    const response = await fetch(origin + '/api/hub/v1/events/stream', { headers: { authorization: `Bearer ${env.AOD_ACCESS_KEY}` }, signal: abort.signal });
    assert.equal(response.status, 200);
    const signal = abort.signal;
    eventsDone = (async () => { let tail = ''; const decoder = new TextDecoder();
      try { for await (const chunk of response.body) { tail += decoder.decode(chunk, { stream: true }); let i;
        while ((i = tail.indexOf('\n\n')) >= 0) { const frame = tail.slice(0, i); tail = tail.slice(i + 2);
          if (/^event:\s*interaction\.updated/m.test(frame)) evidence.interactionEvents++; }
        assert.ok(tail.length < 2_000_000);
      } } catch { if (!signal.aborted) evidence.streamFailed = true; }
    })();
  }
  async function stop(expectedCode = 0) {
    abort?.abort(); await eventsDone;
    if (!child || exited) return;
    child.kill('SIGTERM'); let timer;
    try { assert.deepEqual(await Promise.race([exit, new Promise(resolve => { timer = setTimeout(resolve, 25_000); })]), { code: expectedCode, signal: null }); }
    finally { clearTimeout(timer); }
  }
  async function send(runtime, message) {
    previousRuns.set(runtime, (await state(runtime))?.runtime?.turnId);
    const receipt = await json(`${path(runtime)}/messages`, 'POST', { message, idempotencyKey: randomUUID() });
    assert.equal(receipt.command.state, 'accepted');
  }
  async function pending(runtime, previous) {
    return wait(async () => {
      const list = await interactions(runtime), row = list.requests.find(v => v.status === 'pending' && !previous.has(v.request.requestId));
      if (row) return row;
      const s = await state(runtime);
      evidence.lastRuntime = s?.runtime?.phase;
      // A catalog snapshot may still describe the previous stopped run while
      // the newly accepted command starts. Never attribute it to the new send.
      assert.ok(!newTurnFailed(s?.runtime, previousRuns.get(runtime)), 'Native turn failed before interaction');
    }, 'native interaction');
  }
  async function answer(runtime, row, answer, negative = false) {
    const url = `${path(runtime)}/interactions/${encodeURIComponent(row.request.requestId)}/answer`;
    const body = { runId: row.request.runId, responseId: randomUUID(), expectedRevision: row.revision, answer };
    if (negative) await json(url, 'POST', { ...body, runId: randomUUID() }, 409);
    await json(url, 'POST', body);
    await json(url, 'POST', body); // exact same ID only: idempotent receipt, never a new answer
    await wait(async () => (await interactions(runtime)).requests.some(v => v.request.requestId === row.request.requestId && v.delivery === 'confirmed'), 'native ACK');
    return body;
  }
  async function complete(runtime, runId, expected) {
    await wait(async () => { const s = await state(runtime); evidence.lastRuntime = s?.runtime?.phase;
      if (s?.runtime?.turnId === runId) assert.ok(!['failed', 'unknown', 'interrupted'].includes(s.runtime.phase), 'Native terminal failure');
      return s?.runtime?.turnId === runId && s.runtime.phase === 'completed'; }, 'run completion');
    const messages = (await json(`${path(runtime)}/messages?limit=200`)).messages;
    if (expected) assert.ok(messages.some(m => m.role === 'assistant' && m.turnId === runId && m.text?.includes(expected)), 'Real answer consumed');
  }
  async function goal(operation, patch = {}) {
    const native = Buffer.from(evidence.sessions.codex.slice('local:'.length), 'base64url').toString();
    assert.ok(native.startsWith('codex:'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.off('message', receive); reject(new Error('Timeout: native goal control')); }, 15_000);
      function receive(message) {
        if (message?.kind !== 'sdk-probe-goal-result' || message.id !== id) return;
        clearTimeout(timer); child.off('message', receive);
        if (message.failed) reject(new Error('Native goal probe unavailable')); else resolve(message.result);
      }
      child.on('message', receive);
      child.send({ kind: 'sdk-probe-goal', id, threadId: native.slice('codex:'.length), operation, ...patch }, error => {
        if (!error) return;
        clearTimeout(timer); child.off('message', receive);
        reject(new Error('Native goal probe disconnected'));
      });
    });
  }
  async function goalScenarios() {
    assert.deepEqual(runtimes, ['codex']);
    for (const variant of ['blocked', 'paused', 'budgetLimited', 'usageLimited', 'changed-objective']) {
      stage = `codex:goal-${variant}`;
      const created = await json('/api/hub/v1/connections/local/agents/codex/sessions', 'POST',
        { title: `Disposable native goal ${variant}`, idempotencyKey: randomUUID() }, 201);
      evidence.sessions.codex = created.key;
      await json(`${path('codex')}/interaction-mode`, 'PATCH', { mode: 'interactive' });
      await send('codex', 'This is a bounded native goal acceptance test. First use create_goal to create the goal "Collect a color choice then finish this test" with token_budget 200000. Then call request_user_input to ask me to choose Amber or Indigo. Do not use other tools. After receiving an answer mark this goal complete using update_goal and reply GOAL_CHOICE_ followed by the chosen color.');
      const row = await pending('codex', new Set());
      const original = (await goal('get')).goal;
      assert.ok(original && ['active', 'blocked'].includes(original.status), 'Real native goal exists before question');
      const updated = (await goal('set', variant === 'changed-objective'
        ? { status: 'blocked', objective: 'A different acceptance goal generation' } : { status: variant })).goal;
      assert.equal(updated.status, variant === 'changed-objective' ? 'blocked' : variant);
      const response = row.request.kind === 'text' ? { kind: 'text', text: 'Indigo' }
        : { kind: row.request.kind, optionIds: [row.request.options.find(o => o.label.includes('Indigo')).id] };
      if (variant === 'blocked') {
        await answer('codex', row, response);
        await complete('codex', row.request.runId, 'GOAL_CHOICE_Indigo');
        assert.equal((await goal('get')).goal.status, 'complete');
        await record('codex', 'native-goal-active-blocked-answer-completes');
      } else {
        await json(`${path('codex')}/interactions/${row.request.requestId}/answer`, 'POST', {
          runId: row.request.runId, responseId: randomUUID(), expectedRevision: row.revision, answer: response,
        }, 409);
        const unchanged = (await interactions('codex')).requests.find(v => v.request.requestId === row.request.requestId);
        assert.equal(unchanged.delivery, 'none');
        assert.equal((await goal('get')).goal.status, updated.status, 'Rejected answer must not resume a goal');
        await json(`${path('codex')}/messages`, 'POST', {
          message: '/stop', expectedRunId: row.request.runId, idempotencyKey: randomUUID(),
        });
        await wait(async () => !(await state('codex'))?.hasActiveRun, 'goal run stopped');
        await record('codex', `native-goal-${variant}-rejects-answer-no-resume`);
      }
    }
  }
  async function questionScenarios() {
    for (const runtime of runtimes) {
      stage = `${runtime}:native-question-shapes`;
      const created = await json(`/api/hub/v1/connections/local/agents/${runtime}/sessions`, 'POST',
        { title: `Disposable native question shapes ${runtime}`, idempotencyKey: randomUUID() }, 201);
      evidence.sessions[runtime] = created.key;
      await json(`${path(runtime)}/interaction-mode`, 'PATCH', { mode: 'interactive' });
      const prompt = runtime === 'ghcp'
        ? 'Use your native ask_user tool to ask for my project nickname, with allowFreeform true. You may offer Amber and Indigo but must accept my custom text. Do not use other tools. After my answer reply NICKNAME_ followed by my exact answer.'
        : `Use your native ${runtime === 'codex' ? 'request_user_input' : 'AskUserQuestion'} tool ONCE with two questions in its questions array. First ask for colors, with Amber, Indigo and Teal choices${runtime === 'claude-code' ? ' and multiSelect true (I will select two)' : ' as single choice'}. Second ask for a shape with Circle and Square as single choice. Do not ask in plain chat or use any other tool. After both answers reply SUMMARY_ followed by all selected color names and then the shape.`;
      await send(runtime, prompt);
      const previous = new Set(), first = await pending(runtime, previous);
      previous.add(first.request.requestId);
      if (runtime === 'ghcp') {
        assert.ok(first.request.kind === 'text' || first.request.allowFreeform === true);
        const value = '项目-Azure42';
        await answer(runtime, first, first.request.kind === 'text' ? { kind: 'text', text: value }
          : { kind: first.request.kind, optionIds: [], text: value });
        await complete(runtime, first.request.runId, `NICKNAME_${value}`);
        await record(runtime, 'native-freeform-unicode-answer');
      } else {
        assert.equal(first.request.kind, runtime === 'claude-code' ? 'multi-select' : 'single-select');
        const labels = runtime === 'claude-code' ? ['Indigo', 'Teal'] : ['Indigo'];
        const optionIds = labels.map(label => {
          const option = first.request.options.find(o => o.label.includes(label));
          assert.ok(option, 'Native option label'); return option.id;
        });
        await answer(runtime, first, { kind: first.request.kind, optionIds });
        const second = await pending(runtime, previous);
        assert.equal(second.request.runId, first.request.runId, 'Both questions continue original native run');
        assert.equal(second.request.kind, 'single-select');
        const square = second.request.options.find(o => o.label.includes('Square')); assert.ok(square);
        await answer(runtime, second, { kind: 'single-select', optionIds: [square.id] });
        await complete(runtime, first.request.runId, 'SUMMARY_');
        const messages = (await json(`${path(runtime)}/messages?limit=200`)).messages;
        assert.ok(messages.some(m => m.role === 'assistant' && m.turnId === first.request.runId
          && [...labels, 'Square'].every(label => m.text?.includes(label))), 'All native answers consumed');
        await record(runtime, 'native-two-questions-original-run', { multiSelect: runtime === 'claude-code' });
      }
    }
  }
  try {
    await start();
    if (scenario === 'browser') {
      const { liveInteractionBrowser } = await import('./lib/live-interaction-browser.mjs');
      const browser = await liveInteractionBrowser({ origin, accessKey: env.AOD_ACCESS_KEY, root });
      try {
        for (const runtime of runtimes) {
          stage = `${runtime}:real-browser-native-answer`;
          const created = await json(`/api/hub/v1/connections/local/agents/${runtime}/sessions`, 'POST',
            { title: `Disposable real browser ${runtime}`, idempotencyKey: randomUUID() }, 201);
          evidence.sessions[runtime] = created.key;
          const viewport = await browser.open(created.key, runtime === 'ghcp' ? 430 : 1440);
          await wait(async () => (await interactions(runtime)).mode === 'interactive', 'browser changed native mode');
          const tool = runtime === 'codex' ? 'request_user_input' : runtime === 'claude-code' ? 'AskUserQuestion' : 'ask_user';
          await send(runtime, `Use your native ${tool} tool to ask me to choose Amber or Indigo. Use no other tools. After I answer reply BROWSER_CHOICE_ followed by my choice.`);
          const question = await pending(runtime, new Set());
          await browser.answerIndigo(`browser-${runtime}`);
          await complete(runtime, question.request.runId, 'BROWSER_CHOICE_Indigo');
          await record(runtime, 'actual-browser-Hub-Connector-native-answer-and-final', { viewport });
        }
      } catch (error) {
        evidence.browserFailure = error instanceof assert.AssertionError ? error.message.slice(0, 200)
          : /^Timeout:/.test(error?.message) ? error.message : 'Browser operation failed';
        throw error;
      } finally { try { await browser.close(); } catch { evidence.browserCloseFailed = true; } }
      assert.ok(!evidence.browserCloseFailed, 'Browser shutdown must complete');
      assert.ok(evidence.interactionEvents > 0 && !evidence.streamFailed, 'Real browser interaction SSE observed');
      evidence.passed = true; return;
    }
    if (scenario === 'questions') {
      await questionScenarios();
      assert.ok(evidence.interactionEvents > 0 && !evidence.streamFailed, 'Real question interaction SSE observed');
      evidence.passed = true; return;
    }
    if (scenario === 'goals') {
      await goalScenarios();
      assert.ok(evidence.interactionEvents > 0 && !evidence.streamFailed, 'Real goal interaction SSE observed');
      evidence.passed = true; return;
    }
    for (const runtime of runtimes) {
      stage = `${runtime}:create`;
      const created = await json(`/api/hub/v1/connections/local/agents/${runtime}/sessions`, 'POST',
        { title: `Disposable 2.3.4 interaction ${runtime}`, idempotencyKey: randomUUID() }, 201);
      evidence.sessions[runtime] = created.key;
      const capability = await interactions(runtime);
      assert.ok(capability.capabilities.modes.includes('interactive'), 'Native interaction supported');
      assert.equal((await json(`${path(runtime)}/interaction-mode`, 'PATCH', { mode: 'interactive' })).mode, 'interactive');
      if (scenario === 'pending') continue;
      const previous = new Set();
      const tool = runtime === 'codex' ? 'request_user_input' : runtime === 'claude-code' ? 'AskUserQuestion' : 'ask_user';
      stage = `${runtime}:question`;
      await send(runtime, `Acceptance test: use your native ${tool} tool now to ask which color I choose: Amber or Indigo. Do not answer the question yourself, do not ask in plain chat, and use no other tool. After receiving my choice reply exactly CHOSEN_ followed by the chosen color.`);
      const question = await pending(runtime, previous); previous.add(question.request.requestId);
      assert.ok(['text', 'single-select', 'multi-select'].includes(question.request.kind));
      const choice = question.request.kind === 'text' ? { kind: 'text', text: 'Indigo' }
        : { kind: question.request.kind, optionIds: [question.request.options.find(o => /indigo/i.test(o.label))?.id] };
      await answer(runtime, question, choice, true);
      await complete(runtime, question.request.runId, 'CHOSEN_Indigo');
      await record(runtime, 'question-real-answer-and-duplicate-safe', { kind: question.request.kind });
      for (const decision of ['allow-once', 'deny']) {
        stage = `${runtime}:${decision}`;
        const marker = join(data, 'workspace', `${runtime}-${decision}.txt`), nonce = `MARKER_${randomUUID()}`;
        const instruction = runtime === 'codex' ? 'Use a shell command to write' : 'Use only your file write/create tool to write';
        await send(runtime, `${instruction} exactly ${nonce} into ${marker}. One attempt only. If approval is denied do not retry or use another tool. Then reply with ALLOWED if written or DENIED if denied.`);
        const approval = await pending(runtime, previous); previous.add(approval.request.requestId);
        assert.equal(approval.request.kind, 'approval');
        await answer(runtime, approval, { kind: 'approval', decision });
        await complete(runtime, approval.request.runId);
        if (decision === 'allow-once') assert.equal((await readFile(marker, 'utf8')).trim(), nonce);
        else await assert.rejects(stat(marker), { code: 'ENOENT' });
        await record(runtime, decision, { actualFileEffectChecked: true });
      }
      stage = `${runtime}:stop-pending`;
      await send(runtime, `Use ${tool} to ask me which color: Amber or Indigo. Wait for my answer. Use no other tools.`);
      const unanswered = await pending(runtime, previous); previous.add(unanswered.request.requestId);
      assert.equal((await json(`${path(runtime)}/messages`, 'POST', {
        message: '/stop', expectedRunId: unanswered.request.runId, idempotencyKey: randomUUID(),
      })).command.state, 'accepted');
      await wait(async () => !(await interactions(runtime)).requests.some(v => v.request.requestId === unanswered.request.requestId && v.status === 'pending'), 'stop closes prompt');
      await wait(async () => !(await state(runtime))?.hasActiveRun, 'stopped run');
      await json(`${path(runtime)}/interactions/${unanswered.request.requestId}/answer`, 'POST', {
        runId: unanswered.request.runId, responseId: randomUUID(), expectedRevision: unanswered.revision,
        answer: unanswered.request.kind === 'text' ? { kind: 'text', text: 'Indigo' } : { kind: unanswered.request.kind, optionIds: [unanswered.request.options[0].id] },
      }, 409);
      await record(runtime, 'stop-pending-rejects-late-answer');
    }
    if (scenario === 'matrix') {
      stage = 'graceful-restart';
      const before = Object.fromEntries(await Promise.all(runtimes.map(async r => [r, await interactions(r)])));
      await stop(); await start();
      for (const runtime of runtimes) {
        const after = await interactions(runtime);
        assert.equal(after.mode, 'interactive');
        assert.deepEqual(after.requests, before[runtime].requests);
        assert.equal((await json(`${path(runtime)}/queue`)).items.length, 0);
        await record(runtime, 'restart-preserves-receipts-no-replay');
      }
    }
    // A second restart happens WHILE real native tools are awaiting an answer.
    // The old prompt must close, never turn into a retry after process restart.
    const interrupted = {};
    for (const runtime of runtimes) {
      stage = `${runtime}:restart-pending-question`;
      const previous = new Set((await interactions(runtime)).requests.map(v => v.request.requestId));
      const tool = runtime === 'codex' ? 'request_user_input' : runtime === 'claude-code' ? 'AskUserQuestion' : 'ask_user';
      await send(runtime, `Use your native ${tool} tool to ask whether I choose Amber or Indigo. Wait for my answer. Do not use any other tool.`);
      const row = await pending(runtime, previous);
      interrupted[runtime] = { row, count: (await json(`${path(runtime)}/messages?limit=200`)).messages.filter(m => m.role === 'user').length };
    }
    stage = 'restart-with-pending-native-questions';
    // SIGTERM with unfinished SDK workers is NOT the supported deployment
    // procedure. Unconfirmed native cleanup must retain HOME leases; a dead
    // parent PID is not proof that every descendant has stopped. Verify the
    // failure fence, never delete it to make this negative test pass.
    const sdkInterrupted = runtimes.some(runtime => runtime !== 'codex');
    await stop(sdkInterrupted ? 1 : 0);
    const ownerFiles = runtimes.filter(runtime => runtime !== 'codex').map(runtime => join(data,
      runtime === 'claude-code' ? 'claude-home/.agentopsdeck-claude-owner' : 'copilot-home/.agentopsdeck-copilot-owner'));
    const ownersBefore = await Promise.all(ownerFiles.map(file => readFile(file, 'utf8')));
    await start({ fenced: sdkInterrupted });
    assert.deepEqual(await Promise.all(ownerFiles.map(file => readFile(file, 'utf8'))), ownersBefore, 'No automatic ownership takeover');
    for (const runtime of runtimes) {
      const { row, count } = interrupted[runtime];
      stage = `${runtime}:forced-stop-old-interaction`;
      const after = await interactions(runtime), closed = after.requests.find(v => v.request.requestId === row.request.requestId);
      assert.ok(closed && closed.status === 'closed' && closed.delivery === 'cancelled');
      assert.ok(!after.requests.some(v => v.status === 'pending'));
      await json(`${path(runtime)}/interactions/${row.request.requestId}/answer`, 'POST', {
        runId: row.request.runId, responseId: randomUUID(), expectedRevision: row.revision,
        answer: row.request.kind === 'text' ? { kind: 'text', text: 'Indigo' } : { kind: row.request.kind, optionIds: [row.request.options[0].id] },
      }, 409);
      assert.equal((await json(`${path(runtime)}/queue`)).items.length, 0);
      stage = `${runtime}:forced-stop-history`;
      // A cold Codex projection may briefly be unavailable after startup.
      // Retry bounded READS only; never replay the stopped command/answer.
      const history = await wait(async () => {
        const response = await fetch(origin + `${path(runtime)}/messages?limit=200`, {
          headers: { authorization: `Bearer ${env.AOD_ACCESS_KEY}` }, signal: AbortSignal.timeout(20_000),
        });
        if (response.status === 503) {
          await response.body?.cancel();
          evidence.coldHistoryUnavailable = (evidence.coldHistoryUnavailable ?? 0) + 1;
          return false;
        }
        assert.equal(response.status, 200, 'Persisted history after forced stop');
        return response.json();
      }, 'persisted history after forced stop', 30_000);
      assert.equal(history.messages.filter(m => m.role === 'user').length, count);
      await record(runtime, 'forced-stop-pending-closed-no-replay', { sdkOwnershipFenced: runtime !== 'codex' });
    }
    assert.ok(evidence.interactionEvents > 0, 'Real Hub interaction SSE observed');
    assert.ok(!evidence.streamFailed); evidence.passed = true;
  } catch (error) {
    evidence.failedStage = stage;
    if (/^[a-z-]{1,40}$/.test(error?.browserPhase)) evidence.browserPhase = error.browserPhase;
    if (/^[a-z ]{1,60}$/.test(error?.webdriverCode)) evidence.webdriverCode = error.webdriverCode;
    // No native/provider exception body, prompt, environment or credential.
    evidence.failure = error instanceof assert.AssertionError ? error.message.slice(0, 200) : /^Timeout:/.test(error?.message) ? error.message : 'Isolated acceptance failed';
    throw error;
  } finally { try { await stop(); evidence.hostClosed = true; } finally { evidence.finishedAt = new Date().toISOString(); await save(); } }
}
