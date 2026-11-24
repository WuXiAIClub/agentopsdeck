import assert from 'node:assert/strict';
import test from 'node:test';
import { homedir } from 'node:os';
import { parseFileBoardPolicy, fileBoardRuntime, fileBoardWritable, fileBoardRuntimes, FILE_BOARD_RUNTIMES, type FileBoardPolicy } from './workspace-board-file-policy.js';
import { boardFilesContext, BOARD_CONTEXT_MAX_CHARS } from './workspace-board-file-format.js';

test('file board configuration is default-off and requires explicit owner/runtime policies', () => {
  assert.equal(parseFileBoardPolicy(undefined), undefined);
  const valid = { root: '/srv/task-files', policies: [{ owner: 'local:file-boards', runtime: 'codex' }] };
  assert.deepEqual(parseFileBoardPolicy(JSON.stringify(valid)), valid);
  for (const input of [null, {}, { ...valid, secret: 'do-not-print' },
    ...['/', homedir(), 'relative', '/a/../b', '/a\nb', '/' + 'a'.repeat(513)].map(root => ({ ...valid, root })),
    ...['*', 'local:daily', 'actor_foreign'].map(owner => ({ ...valid, policies: [{ owner, runtime: 'codex' }] })),
    { ...valid, policies: [...valid.policies, ...valid.policies] }, { ...valid, policies: [{ owner: 'owner', runtime: 'hermes' }] }]) {
    assert.throws(() => parseFileBoardPolicy(JSON.stringify(input)), error => error instanceof Error && !error.message.includes('do-not-print'));
  }
  assert.equal(fileBoardRuntime('ghcp:existing'), 'ghcp');
  assert.equal(fileBoardRuntime('hermes:existing'), undefined);
});

test('many file bindings share instructions and stay within the private context budget', () => {
  const paths = Array.from({ length: 64 }, (_, i) => '/srv/' + 'x'.repeat(500) + '/' + i + '/tasks.json');
  const text = boardFilesContext(paths);
  assert.ok(text.length < BOARD_CONTEXT_MAX_CHARS);
  for (const path of paths) assert.ok(text.includes(JSON.stringify(path)));
  assert.equal(text.match(/Read it before editing/g)?.length, 1);
  assert.equal(boardFilesContext([]), '');
  assert.throws(() => boardFilesContext(['/safe/first', '/unsafe\nsecond']));
});

test('SDK file boards require explicit edit policy, with no cross-runtime grants', () => {
  for (const runtime of ['claude-code', 'ghcp'] as const) {
    assert.equal(fileBoardWritable(runtime, {}), false);
    for (const policy of [undefined, 'none', 'workspace-read', 'workspace-edit', 'trusted-exec']) {
      const config = { [runtime === 'claude-code' ? 'claude' : 'copilot']: { toolPolicy: policy } };
      assert.equal(fileBoardWritable(runtime, config), policy === 'workspace-edit' || policy === 'trusted-exec');
      assert.equal(fileBoardWritable(runtime === 'ghcp' ? 'claude-code' : 'ghcp', config), false);
    }
  }
  assert.equal(fileBoardWritable('codex', {}), true);
});

test('runtime discovery is owner-scoped, default-off and follows each SDK edit policy', () => {
  const boardFiles: FileBoardPolicy = { root: '/srv/cards', policies: FILE_BOARD_RUNTIMES.map(runtime => ({ owner: 'owner', runtime })) };
  assert.deepEqual(fileBoardRuntimes('owner', {}), []);
  for (const claude of ['none', 'workspace-read', 'workspace-edit', 'trusted-exec']) {
    for (const copilot of ['none', 'workspace-read', 'workspace-edit', 'trusted-exec']) {
      const config = { boardFiles, claude: { toolPolicy: claude }, copilot: { toolPolicy: copilot } };
      const expected = ['codex', ...(['workspace-edit', 'trusted-exec'].includes(claude) ? ['claude-code'] : []),
        ...(['workspace-edit', 'trusted-exec'].includes(copilot) ? ['ghcp'] : [])];
      assert.deepEqual(fileBoardRuntimes('owner', config), expected);
      for (const foreign of ['other', 'local:daily', 'actor_foreign']) assert.deepEqual(fileBoardRuntimes(foreign, config), []);
    }
  }
  assert.deepEqual(fileBoardRuntimes('owner', { boardFiles: { ...boardFiles, policies: [] } }), []);
});
