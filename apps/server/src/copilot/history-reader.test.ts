import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { COPILOT_HISTORY_LINE_BYTES, COPILOT_HISTORY_SCAN_BYTES, readCopilotHistoryTail } from './history-reader.js';

const user = { id: 'u', type: 'user.message', data: { messageId: 'prompt', content: 'private prompt' } };
const assistant = { id: 'a', type: 'assistant.message', data: { messageId: 'answer', originatingMessageId: 'prompt', content: 'private answer' } };
const jsonl = (...events: unknown[]) => events.map(event => JSON.stringify(event) + '\n').join('');
async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'agentopsdeck-copilot-history-')), id = randomUUID();
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, 'copilot', 'session-state', id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return { home, id, directory, path: join(directory, 'events.jsonl') };
}

test('Copilot reads stopped native JSONL identities without returning prompt/output/tool bodies', async t => {
  const f = await fixture(t);
  await writeFile(f.path, jsonl(user, { ...assistant, id: 'child', agentId: 'child' },
    { id: 'tool', type: 'tool.execution_complete', data: { image: 'omitted' } }, assistant), { mode: 0o600 });
  const result = await readCopilotHistoryTail(f.home, f.id);
  assert.deepEqual(result.entries, [{ id: 'u', type: 'user.message', messageId: 'prompt' },
    { id: 'a', type: 'assistant.message', messageId: 'answer', originatingMessageId: 'prompt' }]);
  assert.equal(result.truncated, false);
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('Copilot scans at most 16MiB of a large historical file and retains current-turn identities', async t => {
  const f = await fixture(t);
  const old = jsonl({ id: 'old', type: 'tool.execution_complete', data: { body: 'x'.repeat(64000) } });
  await writeFile(f.path, old.repeat(Math.ceil(COPILOT_HISTORY_SCAN_BYTES / old.length) + 4) + jsonl(user, assistant), { mode: 0o600 });
  const result = await readCopilotHistoryTail(f.home, f.id);
  assert.equal(result.bytesRead, COPILOT_HISTORY_SCAN_BYTES);
  assert.equal(result.truncated, true);
  assert.equal(result.entries.length, 2);
});

test('Copilot rejects malformed, duplicate, unfinished, oversized and invalid UTF8 records without leaking content', async t => {
  const f = await fixture(t);
  for (const text of [jsonl(user, user), jsonl(user).trimEnd(), '\n', '{"private":"secret"}\n',
    jsonl({ ...user, data: { content: 'x'.repeat(COPILOT_HISTORY_LINE_BYTES) } }),
    Buffer.concat([Buffer.from('{"id":"'), Buffer.from([0xff]), Buffer.from('","type":"user.message","data":{}}\n')])]) {
    await writeFile(f.path, text, { mode: 0o600 });
    await assert.rejects(readCopilotHistoryTail(f.home, f.id), /^Error: Copilot persisted history could not be verified$/);
  }
});

test('Copilot rejects paths outside private canonical HOME and replaced/linked native files', async t => {
  const f = await fixture(t);
  await writeFile(f.path, jsonl(user), { mode: 0o600 });
  await assert.rejects(readCopilotHistoryTail(f.home, '../escape'));
  await chmod(f.home, 0o755);
  await assert.rejects(readCopilotHistoryTail(f.home, f.id));
  await chmod(f.home, 0o700);
  await link(f.path, join(f.home, 'alias'));
  await assert.rejects(readCopilotHistoryTail(f.home, f.id));
  await rm(join(f.home, 'alias'));
  await rm(f.path);
  await writeFile(join(f.home, 'target'), jsonl(user), { mode: 0o600 });
  await symlink(join(f.home, 'target'), f.path);
  await assert.rejects(readCopilotHistoryTail(f.home, f.id));
});

test('Copilot rejects group/world-writable history even within a private HOME', async t => {
  const f = await fixture(t);
  await writeFile(f.path, jsonl(user), { mode: 0o600 });
  assert.equal((await readCopilotHistoryTail(f.home, f.id)).entries.length, 1);
  for (const mode of [0o620, 0o602]) {
    await chmod(f.path, mode);
    await assert.rejects(readCopilotHistoryTail(f.home, f.id), /^Error: Copilot persisted history could not be verified$/);
  }
  await chmod(f.path, 0o600);
  assert.equal((await readCopilotHistoryTail(f.home, f.id)).entries.length, 1);
});
