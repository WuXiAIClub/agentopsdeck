import assert from 'node:assert/strict';
import test from 'node:test';
import { projectAntigravityUpdate } from './message-projection.js';
import {
  classifyAntigravityTool,
  extractAntigravitySourceFiles,
  formatAntigravityToolCallDetail,
  formatAntigravityToolResultDetail,
  type AntigravityToolUpdate,
} from './tool-formatting.js';

test('projectAntigravityUpdate extracts safe locations, inputParams, diffs, and exitCode while stripping secrets', () => {
  const projected = projectAntigravityUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool-edit-1',
    title: 'Edit apps/web/src/App.tsx',
    status: 'completed',
    kind: 'edit',
    locations: [{ path: 'apps/web/src/App.tsx', line: 42 }],
    rawInput: {
      path: 'apps/web/src/App.tsx',
      StartLine: 40,
      secretToken: 'must-not-leak',
    },
    content: [
      { type: 'diff', path: 'apps/web/src/App.tsx', oldText: 'const a = 1;', newText: 'const a = 2;' },
    ],
    rawOutput: { exitCode: 0, output: 'Updated 1 file' },
  });
  assert.ok(projected && projected.sessionUpdate === 'tool_call_update');
  assert.deepEqual(projected.locations, [{ path: 'apps/web/src/App.tsx', line: 42 }]);
  assert.deepEqual(projected.inputParams, { path: 'apps/web/src/App.tsx', StartLine: 40 });
  assert.equal('secretToken' in (projected.inputParams ?? {}), false);
  assert.deepEqual(projected.diffs, [{ path: 'apps/web/src/App.tsx', oldText: 'const a = 1;', newText: 'const a = 2;' }]);
  assert.equal(projected.exitCode, 0);
  assert.equal(projected.outputText, 'Updated 1 file');
});

test('classifyAntigravityTool categorizes read, edit, write, search, git, command, and subagent tools like Codex', () => {
  const readMeta = classifyAntigravityTool({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-1',
    title: 'Read apps/web/src/main.tsx',
    kind: 'read',
    locations: [{ path: 'apps/web/src/main.tsx', line: 10 }],
  });
  assert.equal(readMeta.canonicalName, 'read_file');
  assert.equal(readMeta.toolName, 'read_file:main.tsx');
  assert.equal(readMeta.fileOperation, 'read');

  const editMeta = classifyAntigravityTool({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-2',
    title: 'Edit apps/server/src/antigravity/sdk-runtime.ts',
    kind: 'edit',
    locations: [{ path: 'apps/server/src/antigravity/sdk-runtime.ts' }],
  });
  assert.equal(editMeta.canonicalName, 'edit_file');
  assert.equal(editMeta.toolName, 'edit_file:sdk-runtime.ts');
  assert.equal(editMeta.fileOperation, 'edit');

  const writeMeta = classifyAntigravityTool({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-3',
    title: 'Run write_file',
    kind: 'edit',
    diffs: [{ path: 'docs/new-guide.md', newText: '# Guide' }],
  });
  assert.equal(writeMeta.canonicalName, 'write_file');
  assert.equal(writeMeta.toolName, 'write_file:new-guide.md');

  const gitMeta = classifyAntigravityTool({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-4',
    title: 'Run command',
    kind: 'execute',
    inputParams: { CommandLine: 'git status --short' },
  });
  assert.equal(gitMeta.canonicalName, 'git');

  const execMeta = classifyAntigravityTool({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-5',
    title: 'Run command',
    kind: 'execute',
    inputParams: { CommandLine: 'pnpm typecheck' },
  });
  assert.equal(execMeta.canonicalName, 'commandExecution');

  const subagentMeta = classifyAntigravityTool({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-6',
    title: 'Run invoke_subagent',
    kind: 'other',
  });
  assert.equal(subagentMeta.canonicalName, 'spawn_agent');
});

test('formatAntigravityToolCallDetail, ResultDetail and SourceFiles produce Codex-compatible structured blocks', () => {
  const editUpdate: AntigravityToolUpdate = {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc-edit',
    title: 'Edit apps/web/src/App.tsx',
    kind: 'edit',
    status: 'completed',
    locations: [{ path: 'apps/web/src/App.tsx', line: 12 }],
    inputParams: { path: 'apps/web/src/App.tsx', StartLine: 10 },
    diffs: [{ path: 'apps/web/src/App.tsx', oldText: 'oldLine()', newText: 'newLine()' }],
  };
  const meta = classifyAntigravityTool(editUpdate);
  const callDetail = formatAntigravityToolCallDetail(meta, editUpdate);
  assert.ok(callDetail);
  assert.match(callDetail.text, /^\[tool edit_file\]\nTool input:\n```json/);
  assert.match(callDetail.text, /"path": "apps\/web\/src\/App\.tsx"/);

  const resultDetail = formatAntigravityToolResultDetail(meta, editUpdate);
  assert.ok(resultDetail);
  assert.match(resultDetail.text, /^\[tool edit_file\]\nstatus: completed\noutput:/);
  assert.match(resultDetail.text, /--- apps\/web\/src\/App\.tsx/);
  assert.match(resultDetail.text, /- oldLine\(\)/);
  assert.match(resultDetail.text, /\+ newLine\(\)/);

  const files = extractAntigravitySourceFiles(meta, editUpdate, '/workspace/repo');
  assert.deepEqual(files, [{ path: '/workspace/repo/apps/web/src/App.tsx', kind: 'modified' }]);

  const absEditUpdate: AntigravityToolUpdate = {
    ...editUpdate,
    diffs: [{ path: '/workspace/repo/apps/web/src/NewFile.tsx', newText: 'export const x = 1;' }],
  };
  assert.deepEqual(
    extractAntigravitySourceFiles(meta, absEditUpdate),
    [{ path: '/workspace/repo/apps/web/src/NewFile.tsx', kind: 'added' }],
  );
});
