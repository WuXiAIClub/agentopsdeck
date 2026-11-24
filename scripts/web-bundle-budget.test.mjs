import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { bundleBudget, staticClosure } from './web-bundle-budget.mjs';
const fixture = () => Object.fromEntries([
  ['index.html', { file: 'index.js', imports: ['_runtime'], dynamicImports: ['src/hub-connections.tsx'] }],
  ['_runtime', { file: 'runtime.js', imports: ['index.html'] }],
  ...['hub-connections', 'NotebookEditor', 'NotebookArchive', 'MediaLibrary', 'WorkspaceDrawing', 'WorkspaceTerminal', 'WorkspaceBrowser', 'SessionGoalPanel', 'WorkspaceTaskboard', 'QuickChatPanel', 'NotebookAgentAccess', 'SourceReferencePreviewContent', 'SessionFilePanel', 'GatewayStatus', 'SharedSessionView', 'SessionSharing', 'SessionPeek', 'QuickSessionMessage', 'MessageVideoPreview', 'VideoPlayer', 'ResendMessage', 'CommandRecoveryNotice', 'SessionGoal', 'SessionSubagents', 'CardVersionHistoryModal', 'MultiScreenToolbar', 'WorkspaceOsDesktop'].map(name => [`src/${name}.tsx`, { file: `${name}.js`, imports: ['_runtime'] }]),
]);
test('static closure handles cycles without counting dynamic features', () => {
  assert.deepEqual([...staticClosure(fixture(), 'index.html')], ['index.html', '_runtime']);
  assert.throws(() => staticClosure({ 'index.html': { imports: ['absent'] } }, 'index.html'), /Missing/);
});
test('budget reports distinct initial and incremental optional bytes', () => {
  const result = bundleBudget(fixture(), () => Buffer.alloc(10));
  assert.equal(result.initial.bytes, 20); assert.equal(result.features.NotebookEditor.bytes, 10);
});
test('eager optional dependency is rejected even when all chunks are tiny', () => {
  const manifest = fixture(); manifest['index.html'].imports.push('src/NotebookEditor.tsx');
  assert.throws(() => bundleBudget(manifest, () => Buffer.alloc(10)), /eagerly/);
});
for (const name of ['SessionGoalPanel', 'WorkspaceTaskboard', 'QuickChatPanel', 'NotebookAgentAccess', 'SourceReferencePreviewContent', 'SessionFilePanel', 'GatewayStatus', 'SharedSessionView', 'SessionSharing', 'SessionPeek', 'QuickSessionMessage', 'MessageVideoPreview', 'VideoPlayer', 'ResendMessage', 'CommandRecoveryNotice', 'SessionGoal', 'SessionSubagents', 'CardVersionHistoryModal', 'MultiScreenToolbar', 'WorkspaceOsDesktop']) {
  test(`${name} must remain available but outside the initial static graph`, () => {
    const manifest = fixture();
    manifest._runtime.imports.push(`src/${name}.tsx`);
    assert.throws(() => bundleBudget(manifest, () => Buffer.alloc(10)), /eagerly/);
  });
}
test('entry or total byte growth cannot be hidden by splitting chunks', () => {
  assert.throws(() => bundleBudget(fixture(), file => Buffer.alloc(file === 'index.js' ? 450_001 : 10)), /budget exceeded/);
  assert.throws(() => bundleBudget(fixture(), file => Buffer.alloc(file === 'runtime.js' ? 1_375_001 : 10)), /budget exceeded/);
});
test('compressed transfer growth is rejected independently of raw parse size', () => {
  const blocks = Array.from({ length: 14063 }, (_, index) => createHash('sha256').update(String(index)).digest());
  const content = Buffer.concat(blocks).subarray(0, 310_000);
  assert.throws(() => bundleBudget(fixture(), file => file === 'runtime.js' ? content : Buffer.alloc(10)), /budget exceeded/);
});
test('missing optional entry cannot silently remove its eager-loading guard', () => {
  const manifest = fixture(); delete manifest['src/WorkspaceBrowser.tsx'];
  assert.throws(() => bundleBudget(manifest, () => Buffer.alloc(10)), /Missing optional feature/);
});
