// Real Claude CLI + Connector queue/journal. Called ONLY inside the isolated
// native probe worker, with a loopback provider and no enabled native tools.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { sdkSourceImport as tsImport } from './sdk-source-import.mjs';

export async function verifyClaudeDurableDispatch({ root, env, query, getSessionMessages, beginInterrupt }) {
  assert.equal(process.env.AOD_SDK_PROBE_WORKER, root);
  const { TurnQueue } = await tsImport('../../apps/server/src/commands/turn-queue.ts', import.meta.url);
  const { SdkExecutionJournal } = await tsImport('../../apps/server/src/connector/sdk-execution-journal.ts', import.meta.url);
  const { SdkDispatch } = await tsImport('../../apps/server/src/connector/sdk-dispatch.ts', import.meta.url);
  const { ClaudeDispatchAdapter } = await tsImport('../../apps/server/src/claude/dispatch-adapter.ts', import.meta.url);
  const nativeSessionId = randomUUID(), key = `claude-code:${randomUUID()}`;
  const file = join(root, 'claude-dispatch.sqlite');
  for (let turn = 0; turn < 4; turn++) {
    const db = new DatabaseSync(file);
    const turns = new TurnQueue(db), journal = new SdkExecutionJournal(db, 'claude-code');
    if (!turn) journal.create({ key, nativeSessionId, title: 'Native durable fixture', createdAt: 0 });
    journal.recover(turns);
    assert.equal(journal.canStart(key), true, 'previous completed intent survives reopening without replay');
    const entries = turn ? [turn === 1 ? 'third' : turn === 2 ? 'fourth-stop' : 'fifth-after-stop'] : ['first', 'second'];
    const interrupt = turn === 2 ? beginInterrupt() : undefined;
    for (const id of entries) turns.enqueue('claude-code', { id, sessionKey: key, createdAt: 0,
      payload: { text: `Fixture ${id}: reply briefly.`, actorId: 'isolated-owner', images: [] } });
    let nativeExited = false, stream, exit, completed;
    const shapes = [];
    const adapter = new ClaudeDispatchAdapter({
      epoch: randomUUID(),
      terminal: (ref, outcome) => dispatch.terminal(ref, outcome),
      unknown: ref => { console.error('Claude lifecycle fixture event shapes', shapes); journal.markUnknown(ref, turns); },
      start(execution, text) {
        assert.equal(journal.current(key).id, execution.id);
        assert.equal(turns.head('claude-code', key).state, 'dispatching');
        // A client-supplied UUID ties durable native user input to the persisted
        // execution, without matching prompt text or wall-clock timestamps.
        async function* prompt() {
          yield { type: 'user', uuid: execution.id, session_id: nativeSessionId,
            parent_tool_use_id: null, message: { role: 'user', content: text } };
        }
        stream = query({ prompt: prompt(), options: {
          cwd: root, env, settingSources: [], tools: [], permissionMode: 'default',
          canUseTool: async () => ({ behavior: 'deny', message: 'Fixture denies tools' }),
          model: 'claude-sonnet-4-6', systemPrompt: 'Return a brief reply.',
          includePartialMessages: true, persistSession: true, maxTurns: 1,
          ...(execution.nativeMode === 'resume' ? { resume: nativeSessionId } : { sessionId: nativeSessionId }),
          spawnClaudeCodeProcess(options) {
            const child = spawn(options.command, options.args, {
              cwd: options.cwd, env: options.env, stdio: 'pipe', signal: options.signal,
            });
            child.stderr.resume();
            // No shell or enabled tools in this fixture. Exit proof here is
            // not advertised as a general descendant/background-task proof.
            exit = new Promise(resolve => child.once('exit', () => { nativeExited = true; resolve(); }));
            return child;
          },
        } });
        let finish;
        completed = new Promise(resolve => { finish = resolve; });
        return {
          async *[Symbol.asyncIterator]() {
            let streamed = false, result = false;
            try {
              for await (const event of stream) {
                shapes.push({ type: event.type, subtype: event.subtype,
                  sessionMatches: event.session_id === nativeSessionId, child: !!event.parent_tool_use_id,
                  cliVersion: event.claude_code_version, hasUuid: typeof event.uuid === 'string',
                  inputMatches: event.user_message_uuid === execution.id, hasInputUuid: event.user_message_uuid !== undefined,
                  foldedInputs: event.user_message_uuids?.length, queued: event.queued_turn_count,
                  role: event.message?.role });
                if (shapes.length > 32) shapes.shift();
                if (event.type === 'stream_event') streamed = true;
                if (event.type === 'result') {
                  assert.equal(event.is_error, !!interrupt);
                  assert.equal(event.user_message_uuid, execution.id);
                  result = true;
                }
                yield event;
              }
              assert.ok(streamed && result);
            } finally { stream.close(); await exit; finish(); }
          },
          interrupt: () => stream.interrupt(),
          close: () => stream.close(),
          inspectQuiescence: async () => nativeExited,
          async historyIdentities() {
            const history = await getSessionMessages(nativeSessionId, { dir: root });
            return history.map(({ type, uuid, session_id, parent_tool_use_id }) => ({ type, uuid, session_id, parent_tool_use_id }));
          },
        };
      },
    });
    const dispatch = new SdkDispatch({ journal, turns, adapter, deadlineMs: 25_000,
      authorize: (_key, payload) => payload.actorId === 'isolated-owner' });
    try {
      assert.equal(await dispatch.dispatch(key), 'accepted');
      if (interrupt) {
        await interrupt.receiving;
        assert.equal(await dispatch.interrupt(journal.current(key), { text: '', actorId: 'isolated-owner', images: [] }), 'accepted');
      }
      await completed; await setImmediate();
      const execution = journal.current(key);
      assert.deepEqual(execution.members, entries);
      assert.equal(execution.phase, 'settling');
      assert.equal(turns.maintenanceCount(), 0);
      assert.equal(journal.canStart(key), false);
      assert.equal(await dispatch.settle(execution), true);
      assert.equal(journal.current(key).phase, interrupt ? 'interrupted' : 'completed');
      assert.equal(journal.pendingCount(), 0);
    } finally { interrupt?.reset(); adapter.close(); stream?.close(); await exit; db.close(); }
  }
  console.log('Claude native durable dispatch: persisted FIFO batch, exact input UUID, native exit/history gate, reopened journal, interrupt and successor resume passed');
}
