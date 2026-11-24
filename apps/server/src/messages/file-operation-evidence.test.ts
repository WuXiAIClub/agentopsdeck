import assert from 'node:assert/strict';
import test from 'node:test';
import { FileOperationEvidence } from './file-operation-evidence.js';

test('file evidence only pairs known structured tools and successful exact-scope results', () => {
  for (const runtime of ['claude-code', 'ghcp'] as const) {
    const tracker = new FileOperationEvidence(runtime), name = runtime === 'ghcp' ? 'edit' : 'Edit';
    const args = runtime === 'ghcp' ? { path: '/project/test.ts' } : { file_path: '/project/test.ts' };
    tracker.start([null, 'call'], 'start', name, args);
    assert.deepEqual(tracker.complete(['child', 'call'], 'foreign', true), []);
    assert.deepEqual(tracker.complete([null, 'call'], 'end', true), [{ path: '/project/test.ts', kind: 'modified' }]);
    assert.deepEqual(tracker.complete([null, 'call'], 'end', true), [{ path: '/project/test.ts', kind: 'modified' }]);
    assert.deepEqual(tracker.complete([null, 'call'], 'other-end', true), []);
    tracker.start([null, 'failed'], 'start-f', name, args);
    assert.deepEqual(tracker.complete([null, 'failed'], 'end-f', false), []);
    assert.deepEqual(tracker.complete([null, 'failed'], 'end-f', true), []);
    for (const [i, tool] of ['bash', 'Bash', 'Read', 'view', 'mcp:edit', 'apply_patch'].entries()) {
      tracker.start([null, `unknown-${i}`], 'start', tool, args);
      assert.deepEqual(tracker.complete([null, `unknown-${i}`], 'end', true), []);
    }
    tracker.close();
    tracker.start([null, 'late'], 'start', name, args);
    assert.deepEqual(tracker.complete([null, 'late'], 'end', true), []);
  }
});

test('relative/malformed paths, ambiguous calls, reversed order and overflow fail closed', () => {
  const tracker = new FileOperationEvidence('claude-code');
  for (const [i, file_path] of ['relative.ts', '/p/../secret', '/p/a.ts:2', '/p/' + 'a'.repeat(2049), null].entries()) {
    tracker.start([`${i}`], 'start', 'Write', { file_path });
    assert.deepEqual(tracker.complete([`${i}`], 'end', true), []);
  }
  tracker.start(['duplicate'], 'start', 'Edit', { file_path: '/p/a.ts' });
  tracker.start(['duplicate'], 'different-start', 'Edit', { file_path: '/p/b.ts' });
  assert.deepEqual(tracker.complete(['duplicate'], 'end', true), []);
  tracker.complete(['reversed'], 'end', true);
  tracker.start(['reversed'], 'start', 'Edit', { file_path: '/p/a.ts' });
  assert.deepEqual(tracker.complete(['reversed'], 'end2', true), []);
  for (let i = 0; i < 1100; i++) tracker.start([`call-${i}`], 'start', 'Edit', { file_path: '/p/a.ts' });
  assert.deepEqual(tracker.complete(['call-1099'], 'end', true), []);
  assert.deepEqual(tracker.complete(['call-0'], 'end', true), []);
});

test('a repeated start is idempotent, changed input invalidates evidence, executions stay isolated', () => {
  const first = new FileOperationEvidence('ghcp'), second = new FileOperationEvidence('ghcp');
  first.start(['call'], 'start', 'create', { path: 'C:\\project\\a.ts', content: 'PRIVATE_BODY' });
  first.start(['call'], 'start', 'create', { path: 'C:\\project\\a.ts', content: 'PRIVATE_BODY' });
  assert.deepEqual(second.complete(['call'], 'end', true), []);
  assert.deepEqual(first.complete(['call'], 'end', true), [{ path: 'C:\\project\\a.ts', kind: 'modified' }]);
  first.start(['changed'], 'start', 'edit', { path: '/p/a.ts' });
  first.start(['changed'], 'start', 'edit', { path: '/p/b.ts' });
  assert.deepEqual(first.complete(['changed'], 'end', true), []);
});
