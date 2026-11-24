// Real pinned native CLIs + loopback fixture provider. No real account/model
// acceptance. Installs are supplied externally, never a user's installed CLI.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { verifyCopilotDispatch } from './lib/copilot-dispatch-probe.mjs';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runIsolatedSdkProbe } from './lib/isolated-sdk-probe.mjs';
import { verifyClaudeDurableDispatch } from './lib/claude-durable-probe.mjs';
import { verifyClaudePrivateWorker } from './lib/claude-private-worker-probe.mjs';
import { verifyCopilotPrivateWorker } from './lib/copilot-private-worker-probe.mjs';
import { verifySdkHubNative } from './lib/sdk-hub-native-probe.mjs';
import { sdkSourceImport } from './lib/sdk-source-import.mjs';
import { verifySdkBrowser } from './lib/sdk-browser-probe.mjs';
import { verifySdkService } from './lib/sdk-service-probe.mjs';
import { verifyClaudeCompact, verifyCopilotCompact, verifyCopilotAfterCompact } from './lib/sdk-compact-probe.mjs';

const sdkRoot = process.argv[2];
const trustedExec = process.argv.includes('--trusted-exec');
const [playwrightModule, browserExecutable] = process.argv.slice(3).filter(value => value !== '--trusted-exec');
assert.equal(Boolean(playwrightModule), Boolean(browserExecutable), 'Provide both Playwright module and browser executable, or neither');
if (!process.env.AOD_SDK_PROBE_WORKER) {
  await runIsolatedSdkProbe(fileURLToPath(import.meta.url), sdkRoot, playwrightModule ? 240_000 : 180_000,
    [...(playwrightModule ? [playwrightModule, browserExecutable] : []), ...(trustedExec ? ['--trusted-exec'] : [])]);
} else {
  try { await probe(); }
  finally { if (process.connected) process.disconnect(); }
}

async function probe() {
  const root = process.env.AOD_SDK_PROBE_WORKER;
  const requests = { claude: 0, copilot: 0, refused: 0 };
  const compactRequests = { claude: 0, copilot: 0 };
  const observedModels = {};
  const unexpectedRequests = [];
  const attachmentObserved = { claude: false, copilot: false };
  const attachment = { name: 'fixture.png', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=' };
  const attachmentText = { name: 'fixture.txt', mimeType: 'text/plain', data: Buffer.from('ATTACHMENT_TEXT_FIXTURE').toString('base64') };
  const { claudeAttachmentPrompt, copilotAttachmentPrompt, normalizeClaudeAttachmentEcho } = await sdkSourceImport('../apps/server/src/connector/sdk-attachment-input.ts', import.meta.url);
  const { ClaudeStreamDelivery } = await sdkSourceImport('../apps/server/src/claude/stream-delivery.ts', import.meta.url);
  let hold = false;
  let onHolding;
  let requestTool = false;
  let multipleBlocks = false;
  let browserStream;
  const beginStreaming = () => {
    assert.equal(browserStream, undefined);
    let received, release;
    const receiving = new Promise(resolve => { received = resolve; });
    const finished = new Promise(resolve => { release = resolve; });
    browserStream = { received, finished };
    return { receiving, finish: () => { browserStream = undefined; release(); } };
  };
  const waitForBrowser = async () => {
    const stream = browserStream;
    if (stream) { stream.received(); await stream.finished; }
  };
  let privateTools = [];
  let copilotTools = [];
  const marker = join(root, 'denied-tool-marker');
  const command = 'printf fixture > denied-tool-marker';
  const reply = 'Isolated fixture reply.';
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; assert.ok(body.length < 2_000_000); }
      const url = new URL(req.url, 'http://localhost');
      if (req.method !== 'POST' || !['/v1/messages', '/v1/chat/completions'].includes(url.pathname)) {
        // Fixture paths only: never log headers, query strings or bodies.
        console.log('Fixture refused request', req.method, url.pathname.slice(0, 160));
        if (req.method !== 'HEAD' || url.pathname !== '/api/hello') unexpectedRequests.push('Unexpected non-inference request');
        requests.refused++; res.writeHead(404); res.end(); return;
      }
      const input = JSON.parse(body);
      if (JSON.stringify(input.messages).includes(attachment.data) && JSON.stringify(input.messages).includes('ATTACHMENT_TEXT_FIXTURE')) {
        attachmentObserved[url.pathname === '/v1/messages' ? 'claude' : 'copilot'] = true;
      }
      observedModels[url.pathname === '/v1/messages' ? 'claude-code' : 'ghcp'] = input.model;
      assert.equal(input.stream, true);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const sse = value => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
      if (url.pathname === '/v1/messages') {
        requests.claude++;
        sse({ type: 'message_start', message: { id: `msg_fixture_${requests.claude}`, type: 'message', role: 'assistant',
          model: input.model, content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
        const privateTool = privateTools.shift();
        const tool = requestTool || !!privateTool;
        requestTool = false;
        sse({ type: 'content_block_start', index: 0, content_block: tool
          ? { type: 'tool_use', id: `toolu_fixture_${requests.claude}`, name: privateTool?.name ?? 'Bash', input: {} } : { type: 'text', text: '' } });
        sse({ type: 'content_block_delta', index: 0, delta: tool
          ? { type: 'input_json_delta', partial_json: JSON.stringify(privateTool?.input ?? { command }) } : { type: 'text_delta', text: reply } });
        if (hold) { onHolding(); return; }
        await waitForBrowser();
        sse({ type: 'content_block_stop', index: 0 });
        if (multipleBlocks && !tool) {
          sse({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
          sse({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Second isolated block.' } });
          sse({ type: 'content_block_stop', index: 1 });
        }
        sse({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
        sse({ type: 'message_stop' });
      } else {
        requests.copilot++;
        const privateTool = copilotTools.shift();
        if (privateTool) assert.ok(input.tools?.some(tool => tool.function?.name === privateTool.name), 'Private fixture requests advertised file tool');
        if (requestTool) assert.ok(input.tools?.some(tool => tool.function?.name === 'bash'), 'Fixture must request an advertised tool');
        const chunk = (delta, finish_reason) => res.write(`data: ${JSON.stringify({
          id: `chat_fixture_${requests.copilot}`, object: 'chat.completion.chunk', created: 1, model: input.model,
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`);
        chunk({ role: 'assistant', content: '' }, null);
        const tool = requestTool || !!privateTool;
        requestTool = false;
        chunk(tool ? { tool_calls: [{ index: 0, id: 'call_fixture_deny', type: 'function',
          function: { name: privateTool?.name ?? 'bash', arguments: JSON.stringify(privateTool?.input ?? { command, description: 'Fixture denial check' }) } }] } : { content: reply }, null);
        if (hold) { onHolding(); return; }
        await waitForBrowser();
        await delay(100); // Exercise real partial-to-final private IPC delivery.
        chunk({}, tool ? 'tool_calls' : 'stop');
        res.write(`data: ${JSON.stringify({ id: `chat_fixture_${requests.copilot}`, object: 'chat.completion.chunk',
          created: 1, model: input.model, choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\n`);
        res.write('data: [DONE]\n\n');
      }
      res.end();
    } catch { res.destroy(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Deny incidental proxy traffic as well; not a network namespace/sandbox.
  const env = { ...process.env, HTTP_PROXY: base, HTTPS_PROXY: base, ALL_PROXY: base,
    NO_PROXY: '127.0.0.1,localhost', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: 'fixture-not-a-secret' };
  async function sdk(name, version, entry) {
    const dir = join(sdkRoot, 'node_modules', name);
    assert.equal(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).version, version);
    return import(pathToFileURL(join(dir, entry)).href);
  }
  try {
    const { query, getSessionMessages, getSessionInfo, deleteSession } = await sdk('@anthropic-ai/claude-agent-sdk', '0.3.280', 'sdk.mjs');
    let claudeId;
    for (let turn = 0; turn < 2; turn++) {
      const text = `Fixture turn ${turn + 1}: reply briefly`;
      const inputId = randomUUID();
      async function* attachmentPrompt() { yield { type: 'user', uuid: inputId, session_id: claudeId, parent_tool_use_id: null,
        message: { role: 'user', content: claudeAttachmentPrompt(text, [attachment, attachmentText]) } }; }
      const stream = query({ prompt: turn ? attachmentPrompt() : text, options: {
        cwd: root, env, settingSources: [], tools: [], permissionMode: 'default',
        canUseTool: async () => ({ behavior: 'deny', message: 'Fixture denies all tools' }),
        includePartialMessages: true, model: 'claude-sonnet-4-6', maxTurns: 1,
        extraArgs: { 'replay-user-messages': null },
        systemPrompt: 'Return a brief reply.', persistSession: true,
        ...(claudeId ? { resume: claudeId } : {}),
      } });
      const events = [];
      const delivery = turn ? new ClaudeStreamDelivery(claudeId, async () => {}, () => {}) : undefined;
      try { for await (const event of stream) {
        events.push(event);
        if (delivery) {
          try { await delivery.send(normalizeClaudeAttachmentEcho(event, { id: inputId, nativeSessionId: claudeId }, text, [attachment, attachmentText])); }
          catch (error) { console.error('Synthetic attachment projection:', { type: event.type, subtype: event.subtype,
            sameInput: event.uuid === inputId, blocks: event.message?.content?.map?.(row => row.type) }, error); throw error; }
        }
      } await delivery?.finish(); }
      finally { stream.close(); }
      const result = events.find(event => event.type === 'result');
      assert.equal(result?.is_error, false, 'Claude native turn must succeed');
      assert.equal(result?.result, reply);
      assert.ok(events.some(event => event.type === 'stream_event'));
      if (claudeId) assert.equal(result.session_id, claudeId);
      claudeId = result.session_id;
      const history = await getSessionMessages(claudeId, { dir: root });
      assert.equal(history.filter(event => event.type === 'assistant').length, turn + 1);
    }
    console.log('Claude native: stream, persisted history, new-process resume passed');
    hold = true;
    const holdingClaude = new Promise(resolve => { onHolding = resolve; });
    const stopInputId = randomUUID(), stopText = 'Fixture stop test';
    async function* stopPrompt() { yield { type: 'user', uuid: stopInputId, session_id: claudeId, parent_tool_use_id: null,
      message: { role: 'user', content: claudeAttachmentPrompt(stopText, [attachment, attachmentText]) } }; }
    const stopDelivery = new ClaudeStreamDelivery(claudeId, async () => {}, () => {});
    const interrupted = query({ prompt: stopPrompt(), options: {
      cwd: root, env, settingSources: [], tools: [], permissionMode: 'default',
      canUseTool: async () => ({ behavior: 'deny', message: 'Fixture denies all tools' }),
      includePartialMessages: true, model: 'claude-sonnet-4-6', systemPrompt: 'Return a brief reply.', resume: claudeId,
      extraArgs: { 'replay-user-messages': null },
    } });
    const interruptedEvents = [];
    const consume = (async () => {
      try { for await (const event of interrupted) {
        interruptedEvents.push(event);
        try { await stopDelivery.send(normalizeClaudeAttachmentEcho(event, { id: stopInputId, nativeSessionId: claudeId }, stopText, [attachment, attachmentText])); }
        catch (error) { console.error('Synthetic attachment stop projection:', { type: event.type, subtype: event.subtype,
          sameInput: event.uuid === stopInputId, blocks: event.message?.content?.map?.(row => row.type) }, error); throw error; }
      } return { threw: false }; }
      catch { return { threw: true }; }
    })();
    try {
      await holdingClaude;
      await interrupted.interrupt();
      const outcome = await consume;
      const terminal = interruptedEvents.find(event => event.type === 'result');
      assert.ok(terminal, 'Stop must reach a native terminal event');
      assert.equal(terminal.is_error, true, 'Pinned Claude reports interrupted inference as an error result');
      console.log(JSON.stringify({ claudeStop: { subtype: terminal.subtype, sdkThrewAfterResult: outcome.threw } }));
    } finally { interrupted.close(); }
    hold = false;
    console.log('Claude native: interrupt active inference passed');
    requestTool = true;
    let claudeDenied = 0;
    const toolStream = query({ prompt: 'Fixture permission test', options: {
      cwd: root, env, settingSources: [], tools: ['Bash'], permissionMode: 'default',
      canUseTool: async () => { claudeDenied++; return { behavior: 'deny', message: 'Fixture denies tool' }; },
      model: 'claude-sonnet-4-6', systemPrompt: 'Return a brief reply.', maxTurns: 2, resume: claudeId,
    } });
    const claudeTools = [];
    try { for await (const event of toolStream) claudeTools.push(event); } finally { toolStream.close(); }
    assert.equal(claudeDenied, 1);
    assert.equal(claudeTools.find(event => event.type === 'result')?.result, reply);
    assert.ok(claudeTools.some(event => event.type === 'assistant' && event.message.content.some(block => block.type === 'tool_use')));
    assert.ok(claudeTools.some(event => event.type === 'user' && event.message.content.some(block => block.type === 'tool_result' && block.is_error)));
    await assert.rejects(stat(marker), { code: 'ENOENT' });
    const { projectClaudeMessage } = await sdkSourceImport('../apps/server/src/claude/message-projection.ts', import.meta.url);
    const toolRows = claudeTools.flatMap(event => projectClaudeMessage(event, claudeId));
    const call = toolRows.find(row => row.toolPhase === 'call');
    assert.ok(call && call.toolName === 'Bash' && call.detailAvailable);
    assert.ok(toolRows.some(row => row.toolPhase === 'result' && row.toolCallId === call.toolCallId && row.toolError));
    assert.ok(!JSON.stringify(toolRows).includes(command), 'Raw tool command stays out of eager projections');
    console.log('Claude native: denied tool + tool-chain call/result passed');
    const beforeClaudeCompact = requests.claude;
    await verifyClaudeCompact({ query, getSessionMessages, root, env, sessionId: claudeId, expectedReply: reply });
    compactRequests.claude = requests.claude - beforeClaudeCompact;
    // Only this harness-created, quiescent native session is removed. No
    // provider call, path guessing or manual unlink stands in for SDK delete.
    const beforeClaudeDeletion = requests.claude;
    assert.ok(await getSessionInfo(claudeId, { dir: root }));
    await deleteSession(claudeId, { dir: root });
    assert.equal(await getSessionInfo(claudeId, { dir: root }), undefined);
    await assert.rejects(deleteSession(claudeId, { dir: root }));
    assert.equal(requests.claude, beforeClaudeDeletion);
    console.log('Claude native deletion POC: exact disposable session removed, absent on read, repeated deletion refused; no inference');
    await verifyClaudeDurableDispatch({ root, env, query, getSessionMessages, beginInterrupt: () => {
      hold = true;
      const receiving = new Promise(resolve => { onHolding = resolve; });
      return { receiving, reset: () => { hold = false; } };
    } });
    multipleBlocks = true;
    const claudeShellStopRequests = await verifyClaudePrivateWorker({ root, sdkRoot, base, trustedExec, beginTools: tools => { privateTools = tools; },
      inferenceCount: () => requests.claude, beginInterrupt: () => {
      hold = true;
      const receiving = new Promise(resolve => { onHolding = resolve; });
      return { receiving, reset: () => { hold = false; } };
    } });
    multipleBlocks = false;
    const { CopilotClient, RuntimeConnection } = await sdk('@github/copilot-sdk', '1.0.14', 'dist/index.js');
    let copilotDenied = 0;
    const config = { model: 'gpt-4.1', availableTools: ['bash'], streaming: true, enableSessionTelemetry: false,
      provider: { type: 'openai', wireApi: 'completions', baseUrl: `${base}/v1`, apiKey: 'fixture-not-a-secret' },
      onPermissionRequest: () => { copilotDenied++; return { kind: 'reject' }; } };
    let copilotId, copilotCompactId;
    for (let turn = 0; turn < 2; turn++) {
      const client = new CopilotClient({ connection: RuntimeConnection.forStdio(),
        mode: 'empty', workingDirectory: root, baseDirectory: env.COPILOT_HOME, env,
        useLoggedInUser: false, logLevel: 'none' });
      try {
        await client.start();
        const status = await client.getStatus();
        assert.equal(status.version, '1.0.85');
        assert.equal(status.protocolVersion, 3);
        const session = copilotId ? await client.resumeSession(copilotId, config) : await client.createSession(config);
        if (copilotId) assert.equal(session.sessionId, copilotId);
        copilotId = session.sessionId;
        const events = [];
        let complete;
        let fail;
        const finished = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
        // Attach rejection handling before send awaits so a fast failure cannot
        // become an unhandled rejection.
        finished.catch(() => {});
        const unsub = session.on(event => {
          events.push(event);
          if (['assistant.usage', 'session.usage_info'].includes(event.type)) {
            // Disposable fixture diagnostics: numeric fields and known attribution
            // only, never raw events, request bodies, headers or provider errors.
            console.log('Copilot fixture metric', JSON.stringify({ type: event.type,
              input: event.data.inputTokens, output: event.data.outputTokens,
              current: event.data.currentTokens, limit: event.data.tokenLimit,
              root: event.agentId === undefined && event.data.parentToolCallId === undefined,
              initiatorAbsent: event.data.initiator === undefined,
              initiator: ['user', 'agent', 'conversation-agent', 'sub-agent', 'mcp-sampling'].includes(event.data.initiator) ? event.data.initiator : 'other-or-absent',
              interaction: ['conversation-agent', 'conversation-user'].includes(event.data.interactionType) ? event.data.interactionType : 'other-or-absent' }));
          }
          if (event.type === 'session.idle') complete();
          if (event.type === 'session.error') fail(new Error('Copilot native session failed'));
        });
        try {
          if (turn === 0) await verifyCopilotDispatch({ session, status, prompt: `Fixture turn ${turn + 1}: reply briefly` });
          else await session.send(copilotAttachmentPrompt(`Fixture turn ${turn + 1}: reply briefly`, [attachment, attachmentText]));
          await finished;
        }
        finally { unsub(); }
        assert.ok(events.some(event => event.type === 'assistant.message_delta'));
        assert.ok(events.some(event => event.type === 'assistant.message' && event.data.content === reply));
        const history = await session.getEvents();
        assert.equal(history.filter(event => event.type === 'assistant.message').length, turn + 1);
        if (turn === 1) {
          hold = true;
          const holdingCopilot = new Promise(resolve => { onHolding = resolve; });
          let idleAfterAbort;
          const aborted = new Promise(resolve => { idleAfterAbort = resolve; });
          const stopListen = session.on(event => { if (event.type === 'session.idle') idleAfterAbort(); });
          try {
            await session.send('Fixture stop test');
            await holdingCopilot;
            await session.abort();
            await aborted;
          } finally { stopListen(); hold = false; }
          requestTool = true;
          let finishTool;
          const toolDone = new Promise(resolve => { finishTool = resolve; });
          const toolEvents = [];
          const toolListen = session.on(event => { toolEvents.push(event); if (event.type === 'session.idle') finishTool(); });
          try { await session.send('Fixture permission test'); await toolDone; } finally { toolListen(); }
          assert.equal(copilotDenied, 1);
          assert.ok(toolEvents.some(event => event.type === 'tool.execution_start'));
          assert.ok(toolEvents.some(event => event.type === 'tool.execution_complete' && event.data.success === false));
          await assert.rejects(stat(marker), { code: 'ENOENT' });
          // A Copilot permission rejection ends this native turn instead of
          // asking the provider to continue (unlike the Claude fixture above).
          assert.ok(!toolEvents.some(event => event.type === 'assistant.message' && event.data.content === reply));
          let continued;
          const continuation = new Promise(resolve => { continued = resolve; });
          const continuationEvents = [];
          const listenAgain = session.on(event => { continuationEvents.push(event); if (event.type === 'session.idle') continued(); });
          try { await session.send('Fixture explicit follow-up after denied tool'); await continuation; } finally { listenAgain(); }
          assert.ok(continuationEvents.some(event => event.type === 'assistant.message' && event.data.content === reply));
        }
        if (turn === 1) {
          const beforeCopilotCompact = requests.copilot;
          copilotCompactId = await verifyCopilotCompact(session);
          compactRequests.copilot = requests.copilot - beforeCopilotCompact;
        }
        await session.disconnect();
      } finally { assert.equal((await client.stop()).length, 0); }
    }
    const reopenedClient = new CopilotClient({ connection: RuntimeConnection.forStdio(),
      mode: 'empty', workingDirectory: root, baseDirectory: env.COPILOT_HOME, env,
      useLoggedInUser: false, logLevel: 'none' });
    try {
      await reopenedClient.start();
      const resumed = await reopenedClient.resumeSession(copilotId, config);
      assert.equal(resumed.sessionId, copilotId);
      const beforeFollowup = requests.copilot;
      await verifyCopilotAfterCompact(resumed, copilotCompactId, reply);
      compactRequests.copilot += requests.copilot - beforeFollowup;
      await resumed.disconnect();
      const beforeCopilotDeletion = requests.copilot;
      assert.ok((await reopenedClient.listSessions()).some(row => row.sessionId === copilotId));
      await reopenedClient.deleteSession(copilotId);
      assert.ok(!(await reopenedClient.listSessions()).some(row => row.sessionId === copilotId));
      assert.equal(requests.copilot, beforeCopilotDeletion);
      console.log('Copilot native deletion POC: exact disposable session removed, absent from native directory; no inference');
    } finally { assert.equal((await reopenedClient.stop()).length, 0); }
    assert.deepEqual(compactRequests, { claude: 2, copilot: 2 }, 'One native compact inference and one explicit follow-up per runtime; no replay');
    const copilotToolRequests = await verifyCopilotPrivateWorker({ root, sdkRoot, base, trustedExec,
      beginTools: tools => { copilotTools = tools; }, inferenceCount: () => requests.copilot, beginInterrupt: () => {
      hold = true;
      const receiving = new Promise(resolve => { onHolding = resolve; });
      return { receiving, reset: () => { hold = false; } };
    } });
    const hubRequests = await verifySdkHubNative({ root, sdkRoot, base,
      observedModel: runtime => observedModels[runtime],
      inferenceCount: () => requests.claude + requests.copilot,
      ...(playwrightModule ? { browserProbe: fixture => verifySdkBrowser({ ...fixture, playwrightModule, browserExecutable, beginStreaming }) } : {}) });
    const serviceRequests = await verifySdkService({ root, sdkRoot, base, inferenceCount: () => requests.claude + requests.copilot });
    assert.deepEqual(attachmentObserved, { claude: true, copilot: true }, 'Both pinned CLIs must deliver actual image bytes and text attachment to the provider');
    assert.equal(requests.claude, 18 + Number(trustedExec) + claudeShellStopRequests + compactRequests.claude + hubRequests.claude + serviceRequests.claude, 'No Claude inference replay (workspace tools, compact stop, IPC loss and HTTP lifecycle)');
    assert.equal(requests.copilot, 9 + compactRequests.copilot + copilotToolRequests + hubRequests.copilot + serviceRequests.copilot, 'No Copilot inference replay, including compiled worker lifecycle, file tools and HTTP lifecycle');
    assert.deepEqual(unexpectedRequests, [], 'Unexpected provider paths require review');
    console.log(JSON.stringify({ scope: 'authenticated Hub/Connector / full application process restart / real native CLIs / loopback provider; NOT real provider/account acceptance',
      browserAcceptance: Boolean(playwrightModule),
      claude: { sdk: '0.3.280', cli: '2.1.280', stream: true, history: true, processRestartResume: true, interrupt: true, toolDenied: true, durableDispatch: true, privateWorker: true },
      copilot: { sdk: '1.0.14', cli: '1.0.85', stream: true, history: true, processRestartResume: true, abort: true,
        toolDenied: true, compiledPrivateWorkerLifecycle: true }, requests }, null, 2));
  } catch (error) {
    // Fixture-only failures: all providers, keys and prompts above are
    // synthetic. Production worker diagnostics never forward native errors.
    console.error('Isolated native fixture failure', error);
    throw error;
  } finally {
    // Stop accepting connections first, then close existing connections. A
    // still-closing SDK must not race a new socket into the cleanup window.
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  }
}
