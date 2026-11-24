import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSourceFiles } from '@agentopsdeck/shared';
import { completedFileChanges } from './file-change-evidence.js';
import { historicalMessages } from './app-server.js';
import { summarizeToolMessage } from '../messages/tool-summary.js';
import { sourceReferenceMedia } from '../messages/source-preview.js';
import { projectMessageMedia } from '../hub/message-projection.js';
import { DatabaseSync } from 'node:sqlite';
import { DeckStore } from '../projection/deck-store.js';
import { TurnQueue } from '../commands/turn-queue.js';
import { CodexExecutions } from './executions.js';
import { CodexAppServer } from './app-server.js';

const native = { id: 'file-item', type: 'fileChange', status: 'completed', changes: [
  { path: '/repo/new.ts', kind: { type: 'add' }, diff: 'PRIVATE BODY'.repeat(2000) },
  { path: 'C:\\repo\\edit.ts', kind: { type: 'update' } },
  { path: '/repo/gone.ts', kind: { type: 'delete' } },
] };
test('live completed tool projection matches native history evidence without launching an Agent', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new DeckStore();
    const server = new CodexAppServer({ authorizeTurn: () => true, turnQueue: new TurnQueue(db), executions: new CodexExecutions(db),
      enabled: false, command: '/must-not-launch', defaultCwd: '/repo', defaultModel: 'fixture', approvalPolicy: 'never', store });
    store.upsertSession({ sessionKey: 'codex:fixture', agentId: 'codex', title: 'Fixture', status: 'running' });
    (server as any).recordToolCompleted('codex:fixture', native.id, native, 10);
    const result = store.getMessages('codex:fixture').find(message => message.toolPhase === 'result');
    assert.deepEqual(result?.sourceFiles, completedFileChanges(native));
    assert.equal(store.getMessages('codex:fixture').find(message => message.toolPhase === 'call')?.sourceFiles, undefined);
  } finally { db.close(); }
});
test('completed native file changes retain bounded paths/kinds, never diff content', () => {
  assert.deepEqual(completedFileChanges(native), [{ path: '/repo/new.ts', kind: 'added' }, { path: 'C:\\repo\\edit.ts', kind: 'modified' }, { path: '/repo/gone.ts', kind: 'deleted' }]);
  for (const status of ['running', 'inProgress', 'failed', 'declined', undefined]) assert.deepEqual(completedFileChanges({ ...native, status }), []);
  for (const input of [null, 'shell', { ...native, type: 'commandExecution' }, { ...native, error: 'error' }, { ...native, success: false }]) assert.deepEqual(completedFileChanges(input), []);
});
test('metadata validation rejects unsafe/relative/encoded paths, deduplicates and bounds size', () => {
  const valid = { path: '/repo/good.ts', kind: 'modified' };
  assert.deepEqual(normalizeSourceFiles([null, valid, valid, ...['relative.ts', '/repo/../bad.ts', '/repo/file.ts:2', '/repo/file%20name.ts', 'https://example/a.ts', '/repo/file.ts\n'].map(path => ({ ...valid, path }))]), [valid]);
  assert.equal(normalizeSourceFiles(Array.from({ length: 1000 }, (_, i) => ({ ...valid, path: `/repo/${i}.ts` }))).length, 16);
  const large = normalizeSourceFiles(Array.from({ length: 20 }, (_, i) => ({ ...valid, path: `/repo/${'x'.repeat(2000)}${i}.ts` })));
  assert.ok(large.reduce((n, row) => n + row.path.length, 0) <= 8192);
  assert.deepEqual(completedFileChanges({ ...native, changes: [{ path: '/repo/a.ts', kind: 'unknown' }] }), []);
});
test('native history and tool summary retain evidence, Hub projects message-bound preview without tool detail reads', async () => {
  const messages = await historicalMessages('codex:fixture', [{ id: 'turn', status: 'completed', items: [native] }]);
  const call = messages.find(m => m.toolPhase === 'call')!, result = messages.find(m => m.toolPhase === 'result')!;
  assert.equal(call.sourceFiles, undefined);
  assert.equal(result.sourceFiles?.length, 3);
  const summary = summarizeToolMessage(result);
  assert.deepEqual(summary.sourceFiles, result.sourceFiles); assert.ok(summary.text.length <= 1000);
  const media = projectMessageMedia(summary, 'codex:fixture', '/api/hub/v1/sessions/s');
  assert.equal(media?.length, 2, 'deletion must not create current-file media');
  assert.match(media![0]!.url, /^\/api\/hub\/v1\/sessions\/s\/messages\/[^/]+\/media\/[a-f0-9]{64}$/);
  assert.deepEqual(sourceReferenceMedia({ ...result, status: 'failed' }), []);
  assert.deepEqual(sourceReferenceMedia({ ...result, toolPhase: 'call' }), []);
  assert.throws(() => projectMessageMedia(summary, 'codex:other', '/api/hub/v1/sessions/other'), /identity/);
});
