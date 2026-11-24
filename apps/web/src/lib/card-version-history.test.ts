import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearCardVersionSnapshots,
  computeCardVersionDiff,
  computeCardVersionDiffSummary,
  formatCardSnapshotPreview,
  listCardVersionSnapshots,
  MAX_CARD_VERSION_SNAPSHOTS,
  recordCardVersionSnapshot,
  type CardVersionSnapshot,
} from './card-version-history.js';

// Polyfill in-memory localStorage for Node test environment
const memStore = new Map<string, string>();
if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => memStore.get(k) ?? null,
      setItem: (k: string, v: string) => memStore.set(k, v),
      removeItem: (k: string) => memStore.delete(k),
    },
    configurable: true,
  });
}

test('recordCardVersionSnapshot deduplicates identical content and bounds history to MAX_CARD_VERSION_SNAPSHOTS', () => {
  clearCardVersionSnapshots('scope-a', 'notebook', 'nb-1');
  const first = recordCardVersionSnapshot({
    scope: 'scope-a',
    kind: 'notebook',
    resourceId: 'nb-1',
    payload: '# Sprint Notes\n- Item 1',
    summary: 'Sprint Notes',
    revision: 1,
    timestamp: 1000,
  });
  assert.equal(first.length, 1);

  const duplicate = recordCardVersionSnapshot({
    scope: 'scope-a',
    kind: 'notebook',
    resourceId: 'nb-1',
    payload: '# Sprint Notes\n- Item 1',
    summary: 'Sprint Notes',
    revision: 1,
    timestamp: 2000,
  });
  assert.equal(duplicate.length, 1);

  for (let i = 2; i <= 25; i++) {
    recordCardVersionSnapshot({
      scope: 'scope-a',
      kind: 'notebook',
      resourceId: 'nb-1',
      payload: `# Sprint Notes v${i}`,
      summary: `v${i}`,
      revision: i,
      timestamp: i * 1000,
    });
  }
  const all = listCardVersionSnapshots('scope-a', 'notebook', 'nb-1');
  assert.equal(all.length, MAX_CARD_VERSION_SNAPSHOTS);
  assert.equal(all[0]?.payload, '# Sprint Notes v25');
});

test('computeCardVersionDiff and formatCardSnapshotPreview produce human-readable diffs', () => {
  const oldPayload = JSON.stringify({
    title: 'Release',
    tasks: [{ status: 'todo', title: 'Write unit tests' }],
  });
  const newPayload = JSON.stringify({
    title: 'Release',
    tasks: [{ status: 'done', title: 'Write unit tests' }],
  });
  const oldPreview = formatCardSnapshotPreview(oldPayload, 'taskboard');
  const newPreview = formatCardSnapshotPreview(newPayload, 'taskboard');
  assert.ok(oldPreview.includes('[TODO]'));
  assert.ok(newPreview.includes('[DONE]'));

  const diff = computeCardVersionDiff(oldPayload, newPayload, 'taskboard');
  assert.ok(diff.some((line) => line.type === 'remove' && line.text.includes('[TODO]')));
  assert.ok(diff.some((line) => line.type === 'add' && line.text.includes('[DONE]')));
});

test('computeCardVersionDiffSummary and force manual snapshots track line counters and source tags', () => {
  clearCardVersionSnapshots('scope-b', 'notebook', 'nb-2');
  const first: CardVersionSnapshot[] = recordCardVersionSnapshot({
    scope: 'scope-b',
    kind: 'notebook',
    resourceId: 'nb-2',
    payload: 'Line 1\nLine 2',
    summary: 'Initial note',
    source: 'initial',
  });
  assert.equal(first[0]?.source, 'initial');

  const forcedManual = recordCardVersionSnapshot({
    scope: 'scope-b',
    kind: 'notebook',
    resourceId: 'nb-2',
    payload: 'Line 1\nLine 2',
    summary: 'Milestone save',
    label: 'Milestone v1',
    source: 'manual',
    force: true,
  });
  assert.equal(forcedManual.length, 2);
  assert.equal(forcedManual[0]?.source, 'manual');
  assert.equal(forcedManual[0]?.label, 'Milestone v1');

  const summary = computeCardVersionDiffSummary('Line 1\nLine 2', 'Line 1\nLine 3', 'notebook');
  assert.equal(summary.unchangedCount, 1);
  assert.equal(summary.addedCount, 1);
  assert.equal(summary.removedCount, 1);
});
