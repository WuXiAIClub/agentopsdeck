// Real SDK/model acceptance; only disposable fixture data is changed. Every
// message has one command identity. A timeout is evidence, never a resend.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function verifySdkFileBoards({ json, wait, state, start, stop, sessions, streams, sse, data, result, checkpoint }) {
  const boards = new Map();
  result.scope = 'isolated-real-LiteLLM-file-boards';
  result.commands = [];
  const sessionPath = runtime => `/api/hub/v1/sessions/${encodeURIComponent(sessions.get(runtime))}`;
  for (const runtime of ['claude-code', 'ghcp']) {
    await checkpoint(`${runtime}-bind-empty-board`);
    const created = await json(`/api/hub/v1/connections/local/agents/${runtime}/sessions`, 'POST',
      { title: `File board acceptance ${runtime}`, idempotencyKey: randomUUID() }, 201);
    sessions.set(runtime, created.key);
    const path = `/api/hub/v1/workspace/boards/${randomUUID()}`;
    const board = await json(path, 'PUT', { title: 'File acceptance', tasks: [], revision: 0, mutationId: randomUUID() });
    const id = randomUUID();
    await json(`${path}/file-binding`, 'POST', { requestId: id, revision: board.revision, sessionId: created.key });
    await wait(async () => (await json(`${path}/file-binding/${id}`)).binding.state === 'active', 'binding');
    boards.set(runtime, { path, id, texts: [] });
    assert.equal(streams[runtime], 0, 'Binding must not start a hidden turn');
  }
  async function turn(runtime, title, titles) {
    const board = boards.get(runtime), before = streams[runtime], events = sse.messages;
    const previousIds = new Set((board.history ?? []).map(message => message.id));
    const message = 'This is an isolated acceptance test. Use the task progress file convention supplied with this turn. '
      + `Read that file, preserve existing tasks, add one task titled ${title} with a valid UUID and status done, and write valid JSON. `
      + 'Only modify that progress file; do not inspect other files, use network, run shell commands or spawn agents. '
      + 'Use ordinary file read/write tools, not a task-board API. Then reply FILE_BOARD_OK.';
    const command = { message, idempotencyKey: randomUUID() };
    result.commands.push({ runtime, id: command.idempotencyKey, title });
    await checkpoint(`${runtime}-${title}-send-once`);
    assert.equal((await json(`${sessionPath(runtime)}/messages`, 'POST', command)).command.state, 'accepted');
    board.texts.push(message);
    await wait(async () => {
      const current = await state(runtime);
      assert.ok(!['failed', 'unknown', 'interrupted'].includes(current?.runtime?.phase), 'Real turn must finish successfully');
      if (current?.runtime?.phase !== 'completed' || current.hasActiveRun || current.runtime.sync !== 'current') return false;
      const projected = await json(board.path);
      return titles.every(title => projected.tasks.some(task => task.title === title && task.status === 'done'));
    }, 'real file write and projection', 180_000);
    await checkpoint(`${runtime}-${title}-history`);
    const page = await json(`${sessionPath(runtime)}/messages?limit=200`);
    const newMessages = page.messages.filter(message => !previousIds.has(message.id));
    result.lastTurnChecks = { runtime, title, nativeEvents: streams[runtime] - before,
      exactInputs: board.texts.map(text => page.messages.filter(m => m.role === 'user' && m.text === text).length),
      finalReply: newMessages.some(m => m.role === 'assistant' && m.text.includes('FILE_BOARD_OK')),
      toolResults: newMessages.filter(m => m.role === 'tool' && m.toolPhase === 'result' && m.status !== 'failed').length };
    for (const text of board.texts) assert.equal(page.messages.filter(m => m.role === 'user' && m.text === text).length, 1, 'Exact original input, without injected context');
    assert.ok(result.lastTurnChecks.finalReply, 'This turn has a final reply, not an earlier turn');
    const tool = newMessages.find(m => m.role === 'tool' && m.toolPhase === 'result' && m.status !== 'failed');
    assert.ok(tool, 'Real native file tools projected');
    await checkpoint(`${runtime}-${title}-tool-detail`);
    await json(`${sessionPath(runtime)}/messages/${encodeURIComponent(tool.id)}`);
    await checkpoint(`${runtime}-${title}-stream`);
    // A 13-character final can supersede all partials inside the worker's
    // 50ms coalescing window. Count these honestly; do not require a redundant
    // partial per short turn. verify-sdk-litellm's full lifecycle probe retains
    // its separate native live-stream assertions (including stop mid-stream).
    await wait(() => sse.messages > events, 'Hub message SSE');
    const file = JSON.parse(await readFile(join(data, 'panels', board.id, 'tasks.json'), 'utf8'));
    assert.ok(titles.every(title => file.tasks.some(task => task.title === title && task.status === 'done')));
    result.stages.push({ runtime, title, nativeEvents: streams[runtime] - before, historyNormalized: true, tools: true });
    board.history = page.messages;
  }
  for (const runtime of sessions.keys()) await turn(runtime, 'FIRST_NATIVE_TASK', ['FIRST_NATIVE_TASK']);
  await checkpoint('graceful-restart'); await stop(); await start();
  for (const runtime of ['ghcp', 'claude-code']) {
    await checkpoint(`${runtime}-restart-readiness`);
    await wait(async () => { const s = await state(runtime); return s?.runtime?.phase === 'completed' && s.runtime.sync === 'current' && !s.hasActiveRun; }, 'restart readiness');
    await checkpoint(`${runtime}-restart-history`);
    const messages = (await json(`${sessionPath(runtime)}/messages?limit=200`)).messages;
    const previous = boards.get(runtime).history;
    result.historyChecks ??= [];
    result.historyChecks.push({ runtime, before: previous.length, after: messages.length,
      changes: messages.flatMap((message, index) => {
        const old = previous[index];
        if (!old) return [{ index, fields: ['added'] }];
        const fields = [...new Set([...Object.keys(old), ...Object.keys(message)])]
          .filter(key => JSON.stringify(old[key]) !== JSON.stringify(message[key]));
        return fields.length ? [{ index, fields }] : [];
      }) });
    assert.deepEqual(messages, previous);
    await turn(runtime, 'SECOND_NATIVE_TASK', ['FIRST_NATIVE_TASK', 'SECOND_NATIVE_TASK']);
    const board = boards.get(runtime), final = await json(board.path), before = streams[runtime];
    await checkpoint(`${runtime}-unlink`);
    await json(`${board.path}/file-binding/${board.id}`, 'DELETE');
    await checkpoint(`${runtime}-unlink-file-retained`);
    const path = join(data, 'panels', board.id, 'tasks.json');
    const file = JSON.parse(await readFile(path, 'utf8'));
    file.tasks.push({ id: randomUUID(), title: 'AFTER_UNLINK', detail: '', status: 'todo' });
    await writeFile(path, JSON.stringify(file), { mode: 0o600 });
    await delay(1500);
    await checkpoint(`${runtime}-unlink-projection-frozen`);
    assert.deepEqual((await json(board.path)).tasks, final.tasks, 'Unlinked file does not update board');
    assert.equal(streams[runtime], before, 'Unlink never starts a turn');
  }
  result.restartVerified = true;
  result.unlinkVerified = true;
  await checkpoint('file-boards-verified');
}
