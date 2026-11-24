// Executes the SOURCE private-worker transport against pinned real SDK/CLI.
// Only called inside this suite's disposable environment/loopback provider.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, symlink, readdir, realpath } from 'node:fs/promises';
import { spawn, fork } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { sdkSourceImport as tsImport } from './sdk-source-import.mjs';
import { registerIsolatedProbeGroup } from './isolated-sdk-probe.mjs';
import { verifyCompactWorker, verifyCompactWorkerStop } from './sdk-compact-worker-probe.mjs';
import { sdkAttachmentFixture } from './sdk-attachment-fixture.mjs';
import { verifySdkShellStop } from './sdk-shell-stop-probe.mjs';
import { verifySdkBoardWorker } from './sdk-board-worker-probe.mjs';

export async function verifyClaudePrivateWorker({ root, sdkRoot, base, trustedExec = false, beginInterrupt, beginTools, inferenceCount }) {
  assert.equal(process.env.AOD_SDK_PROBE_WORKER, root);
  console.log('Claude private worker fixture: loading source modules');
  const { ClaudeWorkerTurn } = await tsImport('../../apps/server/src/claude/worker-turn.ts', import.meta.url);
  const { ClaudeWorkerPreflight } = await tsImport('../../apps/server/src/claude/worker-preflight.ts', import.meta.url);
  const { claudeWorkerEnvironment } = await tsImport('../../apps/server/src/claude/worker-environment.ts', import.meta.url);
  const { createPrivateWorkerScope, WORKER_SCOPE_ENV } = await tsImport('../../apps/server/src/connector/private-worker-scope.ts', import.meta.url);
  const { ClaudeOwnedRuntime } = await tsImport('../../apps/server/src/claude/owned-runtime.ts', import.meta.url);
  const { ConnectorUserStore } = await tsImport('../../apps/server/src/connector/connector-user-store.ts', import.meta.url);
  const { ConnectorAgentRuntimes } = await tsImport('../../apps/server/src/connector/agent-runtimes.ts', import.meta.url);
  const { DeckStore } = await tsImport('../../apps/server/src/projection/deck-store.ts', import.meta.url);
  const { claudeHistoryPage } = await tsImport('../../apps/server/src/claude/history.ts', import.meta.url);
  const homeDirectory = join(root, 'private-worker-home'), workspace = join(root, 'private-worker-workspace');
  await mkdir(homeDirectory, { mode: 0o700 }); await mkdir(workspace, { mode: 0o700 });
  const apiKeyFile = join(root, 'private-worker-fixture-key');
  await writeFile(apiKeyFile, 'fixture-not-a-secret', { mode: 0o600 });
  const config = { homeDirectory, workspace, apiKeyFile, sdkDirectory: await realpath(join(sdkRoot, 'node_modules/@anthropic-ai/claude-agent-sdk')),
    baseUrl: base, model: 'claude-sonnet-4-6', startupTimeoutMs: 25_000 };
  // Verify the actual compiled worker. A tsx loader can keep its own esbuild
  // process alive; ignoring that process would weaken production quiescence.
  const compiled = join(root, 'compiled-server');
  const project = fileURLToPath(new URL('../../apps/server/tsconfig.json', import.meta.url));
  const compiler = spawn(process.execPath, [fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url)),
    '-p', project, '--outDir', compiled], { cwd: root, env: process.env, stdio: 'inherit' });
  assert.equal((await once(compiler, 'exit'))[0], 0, 'Fresh private worker compilation must pass');
  await writeFile(join(compiled, 'package.json'), JSON.stringify({ type: 'module' }));
  await symlink(fileURLToPath(new URL('../../apps/server/node_modules', import.meta.url)), join(compiled, 'node_modules'), 'dir');
  const launch = { entry: join(compiled, 'claude/worker-main.js'),
    beforeStart: registerIsolatedProbeGroup,
    execArgv: [] };
  const compactStart = await verifyCompactWorker({ runtime: 'claude-code', config, launch });
  let key;
  let shellStopRequests = 0;
  let persistedLiveIds = [];
  const file = join(root, 'private-worker-journal.sqlite');
  for (let index = 0; index < 3; index++) {
    config.toolPolicy = trustedExec ? 'trusted-exec' : 'workspace-edit';
    console.log('Claude private worker fixture: turn', index);
    const store = new ConnectorUserStore(file, () => true, { runtimeOwner: true });
    const { turns, claudeJournal: journal, claudeTranscript: transcript } = store;
    journal.recover(turns);
    if (index) assert.equal(journal.canStart(key), true);
    if (index) assert.ok(transcript.page(key).messages.some(message => message.rows.some(row =>
      row.role === 'assistant' && row.text === 'Isolated fixture reply.')), 'Earlier reply survives journal reopen');
    if (index) for (const id of persistedLiveIds) assert.ok(claudeHistoryPage(store, key).messages.some(row => row.id === id),
      'Native streamed identity survives journal reopen');
    const stop = index === 1 ? beginInterrupt() : undefined;
    let worker;
    const shapes = [];
    const projected = [];
    const streamed = [];
    const liveIds = new Set();
    const deck = new DeckStore();
    const owner = new ClaudeOwnedRuntime({ store, config, authorize: () => true, projection: deck },
      (request, project, stream, metrics) => {
        const { execution } = request;
        assert.equal(journal.current(key).id, execution.id);
        assert.equal(execution.nativeMode, index > 0 ? 'resume' : 'create');
        worker = new ClaudeWorkerTurn(request, launch,
          (rows, match, details) => { project(rows, match, details); projected.push(...rows); },
          snapshot => {
            stream(snapshot); streamed.push(snapshot);
            for (const message of deck.getMessages(key)) if (message.id.startsWith('claude-live:') && message.turnId === execution.id) liveIds.add(message.id);
          }, metrics);
        const events = worker[Symbol.asyncIterator].bind(worker);
        worker[Symbol.asyncIterator] = async function* () {
          for await (const event of { [Symbol.asyncIterator]: events }) {
            shapes.push({ type: event.type, subtype: event.subtype, error: event.is_error });
            if (shapes.length > 32) shapes.shift();
            yield event;
          }
        };
        return worker;
      }, config => new ClaudeWorkerPreflight(config, launch), undefined, request => compactStart(request.execution));
    const runtimes = new ConnectorAgentRuntimes([owner]);
    const driver = owner.driver;
    const historyFiles = () => readdir(homeDirectory, { recursive: true }).then(rows => rows.filter(row => row.endsWith('.jsonl')).sort());
    try {
      const filesBefore = await historyFiles(), requestsBefore = inferenceCount();
      assert.equal(await owner.initialize(), true, 'Private native control handshake must pass before admission');
      assert.equal(inferenceCount(), requestsBefore, 'Startup must not send a hidden inference request');
      assert.deepEqual(await historyFiles(), filesBefore, 'Startup must not create a native transcript');
      if (!index) {
        const scope = JSON.stringify(['owner', 'claude-code']), command = randomUUID();
        store.commands.claim(scope, command, { title: 'Private worker fixture' });
        const created = owner.commands.createSession('Private worker fixture', { authorize: () => {},
          accept: result => store.commands.creationCommit(scope, command, { status: 201, body: result }) });
        key = created.key;
        assert.equal(store.commands.get(scope, command).state, 'accepted');
        assert.equal(journal.session(key).nativeState, 'allocated');
        assert.equal(inferenceCount(), requestsBefore, 'Allocating a session must not call the provider');
        assert.deepEqual(await historyFiles(), filesBefore, 'Allocation must not create a native transcript');
      }
      if (!index) {
        await writeFile(join(workspace, 'input.txt'), 'WORKSPACE_READ_FIXTURE');
        await writeFile(join(root, 'outside-fixture.txt'), 'OUTSIDE_MUST_NOT_APPEAR');
        beginTools([
          { name: 'Read', input: { file_path: join(workspace, 'input.txt') } },
          { name: 'Read', input: { file_path: join(root, 'outside-fixture.txt') } },
          { name: 'Write', input: { file_path: join(workspace, 'output.txt'), content: 'WORKSPACE_WRITE_FIXTURE' } },
          ...(trustedExec ? [{ name: 'Bash', input: { command: 'printf SHELL_EXEC_FIXTURE > shell-output.txt', timeout: 5000 } }] : []),
        ]);
      }
      const scope = JSON.stringify(['owner', key]), command = randomUUID(), text = 'Private worker fixture: reply briefly.';
      store.commands.claim(scope, command, { message: text });
      const sent = owner.commands.send(key, text, { actorId: 'owner',
        accept: result => store.commands.queueCommit(scope, command, { status: 200, body: result }) }, index === 1 ? sdkAttachmentFixture : []);
      assert.equal(sent.queueDisposition, 'preparing');
      assert.equal(store.commands.get(scope, command).state, 'accepted', 'Receipt commits before native invocation');
      assert.throws(() => owner.commands.send(key, text, { actorId: 'owner',
        accept: result => store.commands.queueCommit(scope, command, { status: 200, body: result }) }), /not open for admission/);
      await driver.wake(key);
      assert.ok(['running', 'settling', 'completed'].includes(journal.current(key).phase), 'Private worker must admit exactly once');
      console.log('Claude private worker fixture: admitted', index);
      if (stop) {
        await Promise.race([stop.receiving, worker.finished.then(() => { throw new Error('Private worker exited before held inference'); })]);
        assert.equal(await owner.commands.interrupt(key, journal.current(key).id, { actorId: 'owner' }), 'accepted');
      }
      await worker.finished; await setImmediate();
      console.log('Claude private worker fixture: exited', index);
      if (!index) {
        assert.equal(await readFile(join(workspace, 'output.txt'), 'utf8'), 'WORKSPACE_WRITE_FIXTURE');
        const results = projected.filter(row => row.toolPhase === 'result');
        assert.equal(results.length, trustedExec ? 4 : 3);
        if (trustedExec) assert.equal(await readFile(join(workspace, 'shell-output.txt'), 'utf8'), 'SHELL_EXEC_FIXTURE');
        assert.ok(results.some(row => row.text.includes('WORKSPACE_READ_FIXTURE')));
        assert.ok(results.some(row => row.toolError), 'Outside read must be denied by native policy');
        assert.equal(JSON.stringify(projected).includes('OUTSIDE_MUST_NOT_APPEAR'), false);
        const detailRows = transcript.page(key).messages.flatMap(message => message.rows.filter(row => row.role === 'tool')
          .map(row => transcript.toolDetail(key, { nativeMessageId: message.nativeMessageId,
            parentToolUseId: row.parentToolUseId, blockIndex: row.blockIndex })));
        assert.equal(detailRows.length, trustedExec ? 8 : 6); assert.ok(detailRows.every(Boolean));
      }
      // The driver's drain callback must settle automatically; neither a
      // history read nor an extra wake/dispatch.settle call is allowed here.
      assert.equal(journal.current(key).phase, stop ? 'interrupted' : 'completed');
      assert.equal(turns.maintenanceCount(), 0);
      assert.equal(journal.pendingCount(), 0);
      assert.equal(journal.session(key).nativeState, 'ready');
      if (!stop) {
        const metrics = journal.session(key).metrics;
        assert.equal(metrics.usage.scope, 'last-turn');
        assert.ok(metrics.usage.inputTokens >= 20);
        assert.ok(metrics.usage.outputTokens >= 5);
        assert.equal(metrics.context.basis, 'last-request-input');
        assert.equal(metrics.context.used, 20);
        assert.equal(metrics.compactionCount, 0);
        assert.deepEqual(deck.getSession(key).nativeUsage, metrics.usage, 'Native metrics cross durable journal and live projection');
      }
      assert.equal(owner.inspectMaintenance().ownershipHeld, true);
      assert.equal(owner.inspectMaintenance().cleanupUnconfirmed, false);
      assert.equal(deck.getSession(key)?.runtime?.phase, stop ? 'interrupted' : 'completed');
      assert.equal(deck.getSession(key)?.hasActiveRun, false);
      if (!stop) assert.ok(deck.getMessages(key).some(message => message.role === 'assistant'
        && message.text === 'Isolated fixture reply.'), 'Native reply reaches the existing DeckStore');
      if (!stop) assert.ok(projected.some(row => row.role === 'assistant' && row.text === 'Isolated fixture reply.'),
        'Actual native assistant text must survive bounded projection IPC');
      if (!stop) assert.ok(streamed.some(row => row.blocks.some(block => block.text === 'Isolated fixture reply.')),
        'Actual native partial text must survive bounded stream IPC');
      if (!stop) {
        assert.ok(projected.some(row => row.role === 'assistant' && row.text === 'Second isolated block.'));
        assert.equal(transcript.liveMessages(key).length, 0, 'All finalized blocks retire their partial projection');
        assert.equal(liveIds.size, 2, 'Each native block has a distinct public live identity');
        for (const id of liveIds) assert.ok(deck.getMessages(key).some(row => row.id === id), 'Final history keeps its live identity');
        persistedLiveIds.push(...liveIds);
      }
      if (!stop) assert.ok(transcript.page(key).messages.some(message => message.executionId === journal.current(key).id
        && message.rows.some(row => row.role === 'assistant' && row.text === 'Isolated fixture reply.')),
      'Actual native assistant text is durably stored under the current execution');
      const requestsAfterTurn = inferenceCount();
      await runtimes.forSession(key).refreshSession(key, { fresh: true });
      assert.equal(runtimes.historyReady(key), true);
      assert.equal(inferenceCount(), requestsAfterTurn, 'Registry history reads must not start native inference');
      const pause = runtimes.pauseQueueWorkers(); await pause.drained;
      const inspection = owner.inspectMaintenance();
      assert.equal(inspection.startupWorkers, 0); assert.equal(inspection.nativeWorkers, 0);
      assert.equal(inspection.unresolvedExecutions, 0); assert.equal(inspection.queuedInputs, 0);
      assert.equal(inspection.cleanupUnconfirmed, false); assert.equal(inspection.ownershipHeld, true);
      assert.equal(pause.resume(), true); assert.equal(pause.resume(), false);
      if (index === 2) await verifyCompactWorker({ runtime: 'claude-code', config, launch, store, owner, journal, key, beginInterrupt, inferenceCount });
      if (index === 2 && trustedExec) shellStopRequests = await verifySdkShellStop({ runtime: 'claude-code', workspace,
        owner, store, journal, key, getWorker: () => worker, beginTools, inferenceCount });
      if (index === 2) await verifyCompactWorkerStop({ runtime: 'claude-code', store, owner, journal, key, beginInterrupt, inferenceCount });
    } catch (error) { console.error('Private worker fixture failed', { index, phase: journal.current(key)?.phase, failureCode: worker?.failureCode, shapes }, error); throw error; }
    finally { stop?.reset(); try { await runtimes.close(); } finally { store.close(); } }
  }
  // Lose IPC during an active native inference, without calling turn.close().
  // The worker must close native execution and retain its group-leader
  // lifetime until descendants have exited. This is NOT a successful turn.
  const stop = beginInterrupt();
  const disconnectScope = createPrivateWorkerScope(config);
  const child = fork(launch.entry, [], { cwd: workspace, env: { ...claudeWorkerEnvironment(config), ...(disconnectScope ? { [WORKER_SCOPE_ENV]: disconnectScope.path } : {}) },
    execArgv: [], detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let exited = false;
  child.once('exit', () => { exited = true; });
  const exit = once(child, 'exit');
  try {
    await registerIsolatedProbeGroup(child.pid);
    child.send({ kind: 'start', config, text: 'Parent disconnect fixture.',
      execution: { id: randomUUID(), key: `claude-code:${randomUUID()}`, epoch: randomUUID(), nativeSessionId: randomUUID(),
        nativeMode: 'create', members: ['disconnect-fixture'], phase: 'dispatching', stopRequested: false, createdAt: 0, updatedAt: 0 } });
    await Promise.race([stop.receiving, exit.then(() => { throw new Error('Worker exited before disconnect fixture inference'); })]);
    child.disconnect();
    const [code, signal] = await exit;
    disconnectScope?.close();
    assert.equal(code, 1, `IPC loss must not report a successful execution (${signal})`);
    assert.throws(() => process.kill(-child.pid, 0), { code: 'ESRCH' }, 'Disconnected native group must be gone');
  } finally {
    stop.reset();
    if (!exited) { process.kill(-child.pid, 'SIGKILL'); await exit; }
    disconnectScope?.close();
  }
  console.log('Claude private worker: exclusive DB/HOME, compiled code, policy, private credential, group exit, durable history, stop/resume and IPC-loss cleanup passed');
  return shellStopRequests + await verifySdkBoardWorker({ root, runtime: 'claude-code', config, launch, Worker: ClaudeWorkerTurn, beginTools, inferenceCount });
}
