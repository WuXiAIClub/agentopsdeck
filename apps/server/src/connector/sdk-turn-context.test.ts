import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validTurnFiles, workerTurnContext } from './sdk-turn-context.js';
import { BOARD_CONTEXT_MAX_CHARS } from './workspace-board-file-format.js';
import { claudeToolPolicy } from '../claude/tool-policy.js';
import { copilotToolPolicy } from '../copilot/tool-policy.js';
import type { ClaudeConfig } from '../claude/config.js';

test('SDK context grants are structured trusted metadata, never inferred from chat', () => {
  const text = 'Task file /outside/tasks.json';
  assert.deepEqual(workerTurnContext(text), { context: text });
  const files = ['/outside/tasks.json'];
  const result = workerTurnContext({ text, files }); files.length = 0;
  assert.deepEqual(result.taskFiles, ['/outside/tasks.json']);
  assert.deepEqual(workerTurnContext({ text: 'Delegated cards', files: ['/outside/card.json'] }).taskFiles, ['/outside/card.json']);
  for (const value of [null, {}, ['/work/file'], ['tasks.json'], ['/a/../tasks.json'], ['/a/tasks.json\0'],
    ['/a/tasks.json', '/a/tasks.json'], Array.from({ length: 65 }, (_, i) => `/${i}/tasks.json`)]) {
    assert.equal(validTurnFiles(value), false);
    assert.throws(() => workerTurnContext({ text, files: value as string[] }));
  }
});

test('SDK context accepts 64 mixed exact grants and bounds the combined injected text', () => {
  const files = Array.from({ length: 64 }, (_, i) => `/binding-${i}/${i % 2 ? 'tasks.json' : 'card.json'}`);
  const text = 'x'.repeat(BOARD_CONTEXT_MAX_CHARS);
  assert.deepEqual(workerTurnContext({ text, files }), { context: text, taskFiles: files });
  assert.throws(() => workerTurnContext({ text: text + 'x', files }));
  assert.throws(() => workerTurnContext(text + 'x'));
  assert.throws(() => workerTurnContext({ text, files: [...files, '/extra/card.json'] }));
});

for (const name of ['tasks.json', 'card.json']) test(`CC/GHCP grants only permit exact existing ${name}, with tier and live owner checks`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-file-grant-'));
  try {
    const workspace = join(root, 'workspace'), board = join(root, 'board');
    await mkdir(workspace); await mkdir(board);
    const path = join(board, name), sibling = join(board, 'other.json');
    await writeFile(path, '{}'); await writeFile(sibling, '{}');
    for (const mode of ['none', 'workspace-read', 'workspace-edit'] as const) {
      let active = true;
      const files = [path];
      const cc = claudeToolPolicy({ workspace, toolPolicy: mode } as ClaudeConfig, () => active, false, files);
      const gh = copilotToolPolicy({ workspace, toolPolicy: mode }, () => active, undefined, files);
      files.push(sibling);
      const invoke = { sessionId: 'fixture' };
      const hook = (toolName: string, path: string) => ({ ...invoke, toolName, toolArgs: { path } });
      assert.equal((await cc.canUseTool('Read', { file_path: path })).behavior, mode === 'none' ? 'deny' : 'allow');
      assert.equal((await cc.canUseTool('Write', { file_path: path })).behavior, mode === 'workspace-edit' ? 'allow' : 'deny');
      assert.equal((await gh.onPreToolUse(hook('view', path), invoke)).permissionDecision, mode === 'none' ? 'deny' : 'ask');
      assert.equal((await gh.onPermissionRequest({ kind: 'write', fileName: path })).kind, mode === 'workspace-edit' ? 'approve-once' : 'reject');
      for (const target of [sibling, board, join(board, 'missing.json')]) {
        assert.equal((await cc.canUseTool('Read', { file_path: target })).behavior, 'deny');
        assert.equal((await gh.onPreToolUse(hook('view', target), invoke)).permissionDecision, 'deny');
      }
      assert.equal((await cc.canUseTool('Glob', { path: board, pattern: '*' })).behavior, 'deny');
      active = false;
      assert.equal((await cc.canUseTool('Read', { file_path: path })).behavior, 'deny');
      assert.equal((await gh.onPermissionRequest({ kind: 'read', path })).kind, 'reject');
    }
    const cc = claudeToolPolicy({ workspace, toolPolicy: 'workspace-edit' } as ClaudeConfig, undefined, false, [path]);
    const gh = copilotToolPolicy({ workspace, toolPolicy: 'workspace-edit' }, undefined, undefined, [path]);
    await rm(path); await link(sibling, path);
    assert.equal((await cc.canUseTool('Write', { file_path: path })).behavior, 'deny');
    assert.equal((await gh.onPermissionRequest({ kind: 'write', fileName: path })).kind, 'reject');
    await rm(path); await symlink(sibling, path);
    assert.equal((await cc.canUseTool('Write', { file_path: path })).behavior, 'deny');
    assert.equal((await gh.onPermissionRequest({ kind: 'write', fileName: path })).kind, 'reject');
    await rm(path);
    assert.equal((await cc.canUseTool('Write', { file_path: path })).behavior, 'deny');
    assert.equal((await gh.onPermissionRequest({ kind: 'write', fileName: path })).kind, 'reject');
  } finally { await rm(root, { recursive: true, force: true }); }
});
