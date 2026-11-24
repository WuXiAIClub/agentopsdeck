import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copilotPatchPaths } from './patch-paths.js';
import { copilotToolPolicy } from './tool-policy.js';

const patch = (...parts: string[]) => ['*** Begin Patch', ...parts, '*** End Patch'].join('\n');
const update = (path: string) => `*** Update File: ${path}\n@@\n-before\n+after`;

test('native patch parser checks the whole envelope, including moves and multiple files', () => {
  assert.deepEqual(copilotPatchPaths(patch(update('/work/a'))), [{ path: '/work/a', create: false, destructive: false }]);
  assert.deepEqual(copilotPatchPaths(patch('*** Update File: a\n*** Move to: b\n@@\n-a\n+b', '*** Delete File: c')),
    [{ path: 'a', create: false, destructive: true }, { path: 'b', create: true, destructive: true }, { path: 'c', create: false, destructive: true }]);
  for (const value of [null, {}, '', patch(), patch('*** Unknown File: a'), patch('*** Add File: a\nraw'),
    patch('*** Update File: a\n*** Move to: b\n*** Move to: c\n@@\n+a'), patch('*** Delete File: a\n+bad'),
    patch('*** Add File: a\n+a\n*** Update File: b'), patch('*** Add File: a \n+a'), patch(update('/a')) + '\ntrailer',
    patch('*** Add File: a\n+\0'), 'x'.repeat(1_048_577)]) assert.equal(copilotPatchPaths(value), undefined);
  assert.equal(copilotPatchPaths(patch('*** Add File: a\n+*** Delete File: outside'))?.length, 1);
});

test('native freeform hooks validate every patch target without shell or directory grants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'copilot-patch-policy-'));
  try {
    const workspace = join(root, 'workspace'), board = join(root, 'board');
    await mkdir(workspace); await mkdir(board);
    const task = join(board, 'tasks.json'), outside = join(board, 'other');
    await writeFile(task, 'before'); await writeFile(outside, 'before');
    await writeFile(join(workspace, 'file'), 'before'); await symlink(outside, join(workspace, 'link'));
    let active = true;
    const policy = copilotToolPolicy({ workspace, toolPolicy: 'workspace-edit' }, () => active, undefined, [task]);
    const input = (text: string) => ({ sessionId: 'fixture', toolName: 'apply_patch', toolArgs: text });
    const check = async (text: string, expected: boolean) => {
      assert.equal((await policy.onPreToolUse(input(text), { sessionId: 'fixture' })).permissionDecision, expected ? 'ask' : 'deny');
      assert.equal((await policy.onPermissionRequest({ kind: 'hook', ...input(text) })).kind, expected ? 'approve-once' : 'reject');
    };
    await check(patch(update(task)), true);
    await check(patch(update('file'), '*** Add File: new\n+new'), true);
    await check(patch('*** Update File: file\n*** Move to: moved\n@@\n-before\n+after'), true);
    for (const text of [patch(update(task), update(outside)), patch(update('link')), patch(update('../board/other')),
      patch('*** Delete File: ' + task), patch(`*** Update File: ${task}\n*** Move to: new\n@@\n-before\n+after`),
      patch(`*** Update File: file\n*** Move to: ${task}\n@@\n-before\n+after`), patch('*** Add File: .git/config\n+bad')]) await check(text, false);
    for (const mode of ['none', 'workspace-read'] as const) {
      const p = copilotToolPolicy({ workspace, toolPolicy: mode }, undefined, undefined, [task]);
      assert.equal((await p.onPreToolUse(input(patch(update(task))), { sessionId: 'fixture' })).permissionDecision, 'deny');
      assert.equal((await p.onPermissionRequest({ kind: 'hook', ...input(patch(update(task))) })).kind, 'reject');
    }
    const pending = policy.onPreToolUse(input(patch(update(task))), { sessionId: 'fixture' });
    active = false;
    assert.equal((await pending).permissionDecision, 'deny');
    await check(patch(update(task)), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
