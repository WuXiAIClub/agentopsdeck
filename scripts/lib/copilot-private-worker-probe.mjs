// Real pinned CLI through the compiled product private-worker IPC/lifecycle.
// Synthetic loopback provider only; not real GitHub/provider authentication.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { sdkSourceImport as tsImport } from './sdk-source-import.mjs';
import { registerIsolatedProbeGroup } from './isolated-sdk-probe.mjs';
import { verifyCompactWorker, verifyCompactWorkerStop } from './sdk-compact-worker-probe.mjs';
import { sdkAttachmentFixture } from './sdk-attachment-fixture.mjs';
import { verifySdkShellStop } from './sdk-shell-stop-probe.mjs';
import { verifySdkBoardWorker } from './sdk-board-worker-probe.mjs';

export async function verifyCopilotPrivateWorker({ root, sdkRoot, base, trustedExec = false, beginInterrupt, beginTools, inferenceCount }) {
  assert.equal(process.env.AOD_SDK_PROBE_WORKER, root);
  const { CopilotWorkerTurn } = await tsImport('../../apps/server/src/copilot/worker-turn.ts', import.meta.url);
  const { CopilotWorkerPreflight } = await tsImport('../../apps/server/src/copilot/worker-preflight.ts', import.meta.url);
  const { CopilotOwnedRuntime } = await tsImport('../../apps/server/src/copilot/owned-runtime.ts', import.meta.url);
  const { DeckStore } = await tsImport('../../apps/server/src/projection/deck-store.ts', import.meta.url);
  const { ConnectorUserStore } = await tsImport('../../apps/server/src/connector/connector-user-store.ts', import.meta.url);
  const { copilotMessageId } = await tsImport('../../apps/server/src/copilot/message-projection.ts', import.meta.url);
  const homeDirectory = join(root, 'copilot-private-home'), workspace = join(root, 'copilot-private-workspace');
  await mkdir(homeDirectory, { mode: 0o700 }); await mkdir(workspace, { mode: 0o700 });
  const credentialFile = join(root, 'copilot-private-fixture-key');
  await writeFile(credentialFile, 'fixture-not-a-secret', { mode: 0o600 });
  const config = { homeDirectory, workspace, sdkDirectory: await realpath(join(sdkRoot, 'node_modules/@github/copilot-sdk')),
    model: 'gpt-4.1', startupTimeoutMs: 25_000, ...(trustedExec ? { toolPolicy: 'trusted-exec' } : {}),
    auth: { mode: 'provider', credentialFile, providerType: 'openai', wireApi: 'completions', baseUrl: `${base}/v1` } };
  // Compilation performed afresh by the earlier Claude fixture in this run.
  const launch = { entry: join(root, 'compiled-server/copilot/worker-main.js'), execArgv: [], beforeStart: registerIsolatedProbeGroup };
  const compactStart = await verifyCompactWorker({ runtime: 'ghcp', config, launch });
  const count = inferenceCount(), file = join(root, 'copilot-private-journal.sqlite');
  let key;
  for (let index = 0; index < 3; index++) {
    console.log('Copilot compiled private worker: turn', index);
    const store = new ConnectorUserStore(file, () => true, { runtimeOwner: true });
    const { turns, copilotJournal: journal } = store;
    const deck = new DeckStore();
    const stop = index === 2 ? beginInterrupt() : undefined;
    let worker, sawStream;
    const rows = [], streams = [], streamed = new Promise(resolve => { sawStream = resolve; });
    const owner = new CopilotOwnedRuntime({ store, config, authorize: () => true, projection: deck },
      (request, projection) => worker = new CopilotWorkerTurn(request, launch,
        { project: (row, detail) => {
          try { projection.project(row, detail); rows.push(row); }
          catch (error) { console.error('Fixture projection rejected', row.role, error); throw error; }
        },
          stream: snapshot => { projection.stream(snapshot); streams.push(snapshot); sawStream(); }, metrics: projection.metrics }),
      settings => new CopilotWorkerPreflight(settings, launch), undefined, request => compactStart(request.execution));
    const driver = owner.driver;
    try {
      const beforeStartup = inferenceCount();
      assert.equal(await owner.initialize(), true, 'Owned runtime startup control handshake');
      assert.equal(inferenceCount(), beforeStartup, 'Startup must not submit an inference');
      if (!index) {
        const scope = JSON.stringify(['owner', 'ghcp']), command = randomUUID();
        store.commands.claim(scope, command, { title: 'Private fixture' });
        key = owner.commands.createSession('Private fixture', { authorize() {},
          accept: result => store.commands.creationCommit(scope, command, { status: 201, body: result }) }).key;
      }
      assert.equal(journal.canStart(key), true);
      const scope = JSON.stringify(['owner', key]), command = randomUUID(), text = `Private fixture ${index}`;
      store.commands.claim(scope, command, { message: text });
      const admissionId = owner.commands.send(key, text, { actorId: 'owner',
        accept: result => store.commands.queueCommit(scope, command, { status: 200, body: result }) }, index === 1 ? sdkAttachmentFixture : []).idempotencyKey;
      await driver.wake(key);
      assert.equal(journal.current(key)?.phase, 'running');
      assert.equal(await worker.inspectQuiescence(), false);
      if (stop) {
        await stop.receiving;
        let timeout;
        try { await Promise.race([streamed, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('No partial text')), 5000); })]); }
        finally { clearTimeout(timeout); }
        assert.equal(await owner.commands.interrupt(key, journal.current(key).id, { actorId: 'owner' }), 'accepted');
      }
      await worker.finished; await setImmediate();
      assert.equal(await worker.inspectQuiescence(), true, 'Both worker and native group must exit');
      await driver.wake(key);
      assert.equal(journal.current(key)?.phase, stop ? 'interrupted' : 'completed');
      assert.equal(journal.current(key)?.outcome, stop ? 'interrupted' : 'completed');
      assert.equal(journal.canStart(key), true);
      const page = store.copilotTranscript.page(key);
      assert.equal(page.totalCount, stop ? 5 : (index + 1) * 2, 'Durable summary survives store reopen');
      assert.equal(page.messages.find(message => message.id === admissionId)?.status, 'sent');
      assert.equal(store.copilotTranscript.liveMessages(key).length, 0);
      await owner.refreshSession(key);
      assert.equal(owner.isSessionHistoryReady(key), true);
      assert.equal(deck.getMessages(key).length, page.totalCount);
      assert.equal(deck.getSession(key).runtime.phase, stop ? 'interrupted' : 'completed');
      if (!stop) {
        const metrics = journal.session(key).metrics;
        assert.equal(metrics.usage.scope, 'last-call');
        assert.equal(metrics.usage.inputTokens, 20);
        assert.equal(metrics.usage.outputTokens, 5);
        assert.equal(metrics.context.basis, 'native-context');
        assert.ok(metrics.context.used >= 0 && metrics.context.limit > 0);
        assert.equal(metrics.compactionCount, 0);
        assert.deepEqual(deck.getSession(key).nativeUsage, metrics.usage, 'Native metrics cross durable journal and live projection');
      }
      const pause = owner.pauseQueueWorker(); await pause.drained;
      assert.equal(owner.inspectMaintenance().nativeWorkers, 0);
      assert.equal(owner.inspectMaintenance().unresolvedExecutions, 0);
      assert.equal(owner.inspectMaintenance().queuedInputs, 0);
      await owner.refreshSession(key);
      assert.equal(pause.resume(), true);
      const history = await worker.historyIdentities();
      assert.equal(history.entries.filter(row => row.type === 'user.message').length, index + 1);
      assert.equal(history.entries.filter(row => row.type === 'assistant.message').length, stop ? 2 : index + 1);
      assert.equal(rows.filter(row => row.role === 'user').length, 1);
      assert.equal(rows.filter(row => row.role === 'assistant').length, stop ? 0 : 1);
      assert.ok(streams.length > 0, 'Actual native partial text crosses compiled private IPC');
      if (!stop) {
        const final = rows.find(row => row.role === 'assistant');
        assert.equal(final.text, 'Isolated fixture reply.');
        assert.equal(copilotMessageId(key, final, 'assistant', final.messageId),
          copilotMessageId(key, streams[0], 'assistant', streams[0].messageId));
      }
      if (index === 1) await verifyCompactWorker({ runtime: 'ghcp', config, launch, store, owner, journal, key, beginInterrupt, inferenceCount });
    } catch (error) {
      // Preserve the primary isolated-fixture failure if cleanup also refuses
      // to release HOME. No provider payload or credential is logged here.
      console.error('Copilot owned fixture failed', error, owner.inspectMaintenance());
      throw error;
    } finally {
      stop?.reset(); await owner.close();
      if (worker) { worker.close(); await worker.finished; }
      store.close();
    }
  }
  assert.equal(inferenceCount() - count, 4, 'Three native turns and one explicit compact, no replay');
  console.log('Copilot compiled private worker: preflight, ACK, history, stop, process reopen and cleanup passed');
  const toolsStart = inferenceCount();
  await writeFile(join(workspace, 'read.txt'), 'fixture read content');
  const outside = join(root, 'copilot-private-outside');
  await writeFile(outside, 'OUTSIDE_MUST_NOT_APPEAR');
  const tests = [
    { name: 'view', input: { path: join(workspace, 'read.txt') }, allowed: true },
    { name: 'create', input: { path: join(workspace, 'created.txt'), file_text: 'original fixture' }, allowed: true },
    { name: 'edit', input: { path: join(workspace, 'created.txt'), old_str: 'original fixture', new_str: 'edited fixture' }, allowed: true },
    { name: 'view', input: { path: outside }, allowed: false },
    ...(trustedExec ? [{ name: 'bash', input: { command: 'printf SHELL_EXEC_FIXTURE > shell-output.txt', mode: 'sync' }, allowed: true }] : []),
  ];
  for (const [index, tool] of tests.entries()) {
    console.log('Copilot compiled private tool:', tool.name, tool.allowed ? 'allowed' : 'denied');
    const store = new ConnectorUserStore(file, () => true, { runtimeOwner: true });
    let worker;
    const owner = new CopilotOwnedRuntime({ store, config: { ...config, toolPolicy: trustedExec ? 'trusted-exec' : 'workspace-edit' }, authorize: () => true },
      (request, projection) => worker = new CopilotWorkerTurn(request, launch, projection),
      settings => new CopilotWorkerPreflight(settings, launch), undefined, request => compactStart(request.execution));
    try {
      assert.equal(await owner.initialize(), true);
      const before = inferenceCount(), scope = JSON.stringify(['owner', key]), command = randomUUID();
      beginTools([tool]);
      store.commands.claim(scope, command, { message: `File tool fixture ${index}` });
      owner.commands.send(key, `File tool fixture ${index}`, { actorId: 'owner',
        accept: result => store.commands.queueCommit(scope, command, { status: 200, body: result }) });
      await owner.driver.wake(key);
      assert.equal(store.copilotJournal.current(key)?.phase, 'running');
      await worker.finished; await setImmediate(); await owner.driver.wake(key);
      assert.equal(store.copilotJournal.current(key)?.phase, 'completed');
      const execution = store.copilotJournal.current(key).id;
      const page = store.copilotTranscript.page(key);
      const results = page.messages.filter(row => row.turnId === execution && row.toolPhase === 'result');
      assert.equal(results.length, 1, 'Exactly one native tool result, no replay');
      assert.equal(results[0].toolDetailAvailable, true);
      const detail = store.copilotTranscript.toolDetail(key, results[0].id);
      assert.equal(results[0].status === 'failed', !tool.allowed, `Isolated tool fixture: ${detail.text.slice(0, 3000)}`);
      assert.ok(detail.text.includes('Input\n'), 'Lazy input/result pairing');
      assert.ok(!JSON.stringify(page).includes('fixture read content'), 'No eager tool bodies');
      assert.ok(!detail.text.includes('OUTSIDE_MUST_NOT_APPEAR'), 'Outside content denied');
      if (!index) assert.ok(detail.text.includes('fixture read content'));
      if (index === 1) assert.equal(await readFile(join(workspace, 'created.txt'), 'utf8'), 'original fixture');
      if (index === 2) assert.equal(await readFile(join(workspace, 'created.txt'), 'utf8'), 'edited fixture');
      if (tool.name === 'bash') assert.equal(await readFile(join(workspace, 'shell-output.txt'), 'utf8'), 'SHELL_EXEC_FIXTURE');
      const delta = inferenceCount() - before;
      assert.ok(delta >= 1 && delta <= 2, 'One requested tool and at most one final inference');
      if (index === tests.length - 1 && trustedExec) await verifySdkShellStop({ runtime: 'ghcp', workspace,
        owner, store, journal: store.copilotJournal, key, getWorker: () => worker, beginTools, inferenceCount });
      if (index === tests.length - 1) await verifyCompactWorkerStop({ runtime: 'ghcp', store, owner,
        journal: store.copilotJournal, key, beginInterrupt, inferenceCount });
    } catch (error) {
      console.error('Copilot private tool fixture failed', { index, phase: store.copilotJournal.current(key)?.phase,
        failureCode: worker?.failureCode }, error);
      throw error;
    } finally {
      beginTools([]); try { await owner.close(); } finally { store.close(); }
    }
  }
  console.log('Copilot compiled private worker: native file policy, outside denial and lazy details passed');
  await verifySdkBoardWorker({ root, runtime: 'ghcp', config, launch, Worker: CopilotWorkerTurn, beginTools, inferenceCount });
  return inferenceCount() - toolsStart;
}
