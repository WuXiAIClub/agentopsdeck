import test from 'node:test';
import assert from 'node:assert/strict';
import { presetWorkspace, projectWorkspace, setDockFrame, resizePaneEdge, snapPaneRect, openResourcePane, restoreWorkspace, paneKey, previewResourceDrop, paneMinimum, fitFloating } from './workspace-layout.js';
import { layoutSnapshot, parseCurrentLayout } from './current-layout.js';
import { alignWorkspaceRect } from './workspace-snap.js';
test('file browser supports compact 240px minimums in split, free and floating layouts, bounded by viewport', () => {
  const browser = { id: 'files', kind: 'file-browser' as const, resourceId: '0e061bcc-f7f8-4a6d-8351-779b9aa6eaf0' };
  const layout = presetWorkspace([browser, { id: 'chat', sessionKey: 'chat' }], 'columns');
  assert.deepEqual(paneMinimum(browser), { width: 240, height: 240 });
  const tiny = setDockFrame(layout, 'files', { x: 900, y: 800, width: 10, height: 10 }, 1200, 900);
  assert.deepEqual(projectWorkspace(tiny, 1200, 900).panes.get('files'), { x: 900, y: 660, width: 240, height: 240 });
  const floating = fitFloating({ id: 'files', x: 0, y: 0, width: .1, height: .1 }, 1200, 900, browser);
  assert.equal(floating.width * 1200, 240); assert.equal(floating.height * 900, 240);
  const narrow = projectWorkspace(tiny, 320, 300).panes.get('files')!;
  assert.equal(narrow.width, 240); assert.equal(narrow.height, 240);
  if (layout.dock?.kind === 'split') layout.dock.ratio = .01;
  assert.equal(projectWorkspace(layout, 1200, 900).panes.get('files')!.width, 240);
});
test('all four edges resize independently including leftmost pane; normalized geometry restores', () => {
  const layout = presetWorkspace([{ id: 'a', sessionKey: 'one' }, { id: 'b', sessionKey: 'two' }], 'columns');
  const original = projectWorkspace(layout, 1400, 900), rect = original.panes.get('a')!;
  for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
    const resized = resizePaneEdge(rect, edge, edge === 'left' ? 80 : -80, edge === 'top' ? 80 : -80, 1400, 900);
    const next = setDockFrame(layout, 'a', resized, 1400, 900), projected = projectWorkspace(next, 1400, 900);
    assert.deepEqual(projected.panes.get('b'), original.panes.get('b'));
    assert.notDeepEqual(projected.panes.get('a'), rect); assert.equal(projected.dividers.length, 0);
    assert.deepEqual(parseCurrentLayout(JSON.stringify(layoutSnapshot(next, new Set())))?.workspace, next);
  }
});
test('translation snaps to neighbour gutter without moving other panes', () => {
  const neighbour = { x: 0, y: 0, width: 400, height: 600 };
  assert.equal(snapPaneRect({ x: 402, y: 5, width: 400, height: 600 }, [neighbour], 1400, 900).x, 404);
  assert.equal(snapPaneRect({ x: 480, y: 5, width: 400, height: 600 }, [neighbour], 1400, 900).x, 480);
});
test('4 through 12px facing gaps survive moves and every resize edge on both axes', () => {
  const other = { x: 500, y: 500, width: 300, height: 300 };
  for (const gap of [4, 5, 6, 8, 10, 12]) {
    for (const [rect, edge] of [
      [{ x: 800 + gap, y: 500, width: 300, height: 300 }, 'left'],
      [{ x: 200 - gap, y: 500, width: 300, height: 300 }, 'right'],
      [{ x: 500, y: 800 + gap, width: 300, height: 300 }, 'top'],
      [{ x: 500, y: 200 - gap, width: 300, height: 300 }, 'bottom'],
    ] as const) for (const action of [edge, 'move'] as const) {
      assert.deepEqual(alignWorkspaceRect(rect, [other], 1600, 1600, action).rect, rect, `${action}: ${gap}px`);
    }
  }
});
test('sub-4px positive gaps snap to 4px on every facing edge; other magnets cannot collapse a gap', () => {
  const other = { x: 500, y: 500, width: 300, height: 300 };
  for (const gap of [1, 2, 3]) {
    for (const [rect, edge, measure] of [
      [{ x: 800 + gap, y: 500, width: 300, height: 300 }, 'left', (r: typeof other) => r.x - 800],
      [{ x: 200 - gap, y: 500, width: 300, height: 300 }, 'right', (r: typeof other) => 500 - r.x - r.width],
      [{ x: 500, y: 800 + gap, width: 300, height: 300 }, 'top', (r: typeof other) => r.y - 800],
      [{ x: 500, y: 200 - gap, width: 300, height: 300 }, 'bottom', (r: typeof other) => 500 - r.y - r.height],
    ] as const) for (const action of [edge, 'move'] as const) {
      assert.equal(measure(alignWorkspaceRect(rect, [other], 1600, 1600, action).rect), 4, `${action}: ${gap}px`);
    }
  }
  const rect = { x: 805, y: 500, width: 300, height: 300 };
  assert.equal(alignWorkspaceRect(rect, [{ ...other, x: 802, y: 100 }, other], 1600, 1600).rect.x, 805);
  assert.equal(alignWorkspaceRect({ ...rect, x: 800 }, [other], 1600, 1600).rect.x, 800, 'explicit flush placement is preserved');
});
test('bottom-right corner changes both dimensions, anchors position and preserves neighbours and persistence', () => {
  const layout = presetWorkspace([{ id: 'a', sessionKey: 'one' }, { id: 'b', sessionKey: 'two' }], 'columns');
  const original = projectWorkspace(layout, 1400, 900), rect = original.panes.get('a')!;
  const resized = resizePaneEdge(rect, 'bottom-right', -80, -120, 1400, 900);
  assert.deepEqual(resized, { ...rect, width: rect.width - 80, height: rect.height - 120 });
  const next = setDockFrame(layout, 'a', resized, 1400, 900);
  assert.deepEqual(projectWorkspace(next, 1400, 900).panes.get('b'), original.panes.get('b'));
  assert.deepEqual(parseCurrentLayout(JSON.stringify(layoutSnapshot(next, new Set())))?.workspace, next);
  assert.deepEqual(resizePaneEdge(resized, 'bottom-right', -10000, -10000, 1400, 900), { ...rect, width: 240, height: 288 });
  assert.deepEqual(resizePaneEdge(resized, 'bottom-right', 10000, 10000, 1400, 900), { ...rect, width: 1400 - rect.x, height: 900 - rect.y });
  assert.deepEqual(resizePaneEdge({ x: 0, y: 0, width: 200, height: 200 }, 'bottom-right', -100, -100, 200, 200), { x: 0, y: 0, width: 200, height: 200 });
});
test('top corners resize both axes, preserve opposite corner and clamp docked/floating minima', () => {
  const rect = { x: 200, y: 150, width: 600, height: 650 };
  assert.deepEqual(resizePaneEdge(rect, 'top-left', 50, 70, 1400, 1000), { x: 250, y: 220, width: 550, height: 580 });
  assert.deepEqual(resizePaneEdge(rect, 'top-right', 50, 70, 1400, 1000), { x: 200, y: 220, width: 650, height: 580 });
  for (const minimum of [{ width: 240, height: 288 }, { width: 272, height: 384 }]) {
    for (const edge of ['top-left', 'top-right'] as const) {
      const small = resizePaneEdge(rect, edge, edge === 'top-left' ? 10000 : -10000, 10000, 1400, 1000, minimum);
      assert.equal(small.width, minimum.width); assert.equal(small.height, minimum.height);
      assert.equal(small.y + small.height, 800);
      assert.equal(edge === 'top-left' ? small.x + small.width : small.x, edge === 'top-left' ? 800 : 200);
      const large = resizePaneEdge(rect, edge, edge === 'top-left' ? -10000 : 10000, -10000, 1400, 1000, minimum);
      assert.equal(large.y, 0); assert.equal(large.height, 800);
      assert.equal(large.x, edge === 'top-left' ? 0 : 200);
      assert.equal(large.width, edge === 'top-left' ? 800 : 1200);
    }
  }
});
test('top-corner magnets align both leading and trailing edges without moving opposite corner', () => {
  const other = { x: 100, y: 100, width: 600, height: 600 };
  const left = alignWorkspaceRect({ x: 105, y: 106, width: 495, height: 494 }, [other], 1400, 1000, 'top-left');
  assert.deepEqual(left.rect, { x: 100, y: 100, width: 500, height: 500 });
  assert.equal(left.guides.length, 2);
  const right = alignWorkspaceRect({ x: 200, y: 106, width: 495, height: 494 }, [other], 1400, 1000, 'top-right');
  assert.deepEqual(right.rect, { x: 200, y: 100, width: 500, height: 500 });
  assert.equal(right.guides.length, 2);
  const outside = { x: 125, y: 126, width: 450, height: 450 };
  assert.deepEqual(alignWorkspaceRect(outside, [other], 1400, 1000, 'top-left').rect, outside);
});
test('media layout persists identity only, remains distinct from chat and overview', () => {
  const base = presetWorkspace([{ id: 'a', sessionKey: 'one' }], 'single');
  const next = openResourcePane(base, { id: 'media', kind: 'media', resourceId: 'library' }, 1400, 900);
  assert.equal(next.version, 2); assert.equal(paneKey(next.panes[1]!), '\u0000media:library');
  assert.deepEqual(restoreWorkspace(next, new Set(['one'])), next);
});
test('light alignment captures both axes across separated cards and releases beyond the radius', () => {
  const other = { x: 100, y: 700, width: 400, height: 300 };
  const near = { x: 106, y: 304, width: 394, height: 396 };
  const aligned = alignWorkspaceRect(near, [other], 1400, 1200);
  assert.equal(aligned.rect.x, 106, 'already-aligned trailing edge takes nearest precedence');
  assert.equal(aligned.guides.find(guide => guide.axis === 'x')?.position, 500);
  const resize = alignWorkspaceRect({ ...near, width: 399 }, [other], 1400, 1200, 'right');
  assert.equal(resize.rect.x + resize.rect.width, 500);
  assert.equal(resize.rect.x, near.x); assert.equal(resize.rect.height, near.height);
  const released = alignWorkspaceRect({ ...near, width: 420 }, [other], 1400, 1200, 'right');
  assert.equal(released.rect.width, 420); assert.equal(released.guides.length, 0);
  const both = alignWorkspaceRect({ x: 106, y: 305, width: 400, height: 390 }, [other], 1400, 1200, 'bottom-right');
  assert.equal(both.rect.width, 394); assert.equal(both.rect.height, 390, 'corner resize preserves the deliberate 5px gap');
  assert.deepEqual(both.guides.map(guide => guide.axis), ['x']);
});
test('leading edge alignment preserves opposite edge; minima reject invalid magnets', () => {
  const other = { x: 100, y: 700, width: 400, height: 300 };
  const rect = { x: 105, y: 100, width: 350, height: 400 };
  const left = alignWorkspaceRect(rect, [other], 1400, 1200, 'left');
  assert.equal(left.rect.x, 100); assert.equal(left.rect.x + left.rect.width, 455);
  const small = { x: 262, y: 0, width: 240, height: 288 };
  assert.deepEqual(alignWorkspaceRect(small, [other], 1400, 1200, 'right').rect, small);
  assert.deepEqual(alignWorkspaceRect(rect, [], 1400, 1200, 'top').rect, rect);
  const moved = alignWorkspaceRect({ x: 96, y: 390, width: 350, height: 300 }, [other], 1400, 1200);
  assert.equal(moved.rect.x, 100, 'separate rows align without overlap');
  assert.equal(moved.rect.y, 390, 'existing 10px gutter is retained');
});
test('sidebar drop fills free space and repeated translations preserve other frames and valid persistence', () => {
  let layout = setDockFrame(presetWorkspace([{ id: 'a', sessionKey: 'one' }], 'single'), 'a', { x: 0, y: 0, width: 650, height: 900 }, 1400, 900);
  const other = projectWorkspace(layout, 1400, 900).panes.get('a');
  const drop = previewResourceDrop(layout, { id: 'b', sessionKey: 'two' }, 1100, 500, 1400, 900);
  assert.equal(drop.blocked, false); assert.equal(drop.free, true); assert.equal(drop.rect.x, 660);
  layout = drop.layout;
  for (let i = 0; i < 80; i++) {
    layout = previewResourceDrop(layout, { id: 'b', sessionKey: 'two' }, 1100, 500, 1400, 900).layout;
    assert.deepEqual(projectWorkspace(layout, 1400, 900).panes.get('a'), other);
    assert.deepEqual(restoreWorkspace(layout, new Set(['one', 'two'])), layout);
  }
  assert.equal(previewResourceDrop(layout, { id: 'bad', sessionKey: 'bad' }, -10, 500, 1400, 900).blocked, true);
});
test('resizing does not convert occupied sidebar drops into docked overlays, including cancelled previews', () => {
  const base = presetWorkspace([{ id: 'a', sessionKey: 'one' }, { id: 'b', sessionKey: 'two' }], 'columns');
  const original = projectWorkspace(base, 1400, 900);
  const layout = setDockFrame(base, 'b', original.panes.get('b')!, 1400, 900);
  const before = structuredClone(layout);
  const target = original.panes.get('b')!;
  const x = target.x + target.width / 2, y = target.y + target.height / 2;
  for (let i = 0; i < 2; i++) {
    const preview = previewResourceDrop(layout, { id: `new-${i}`, sessionKey: 'three' }, x, y, 1400, 900);
    assert.equal(preview.blocked, false);
    assert.equal(preview.free, undefined);
    assert.equal(preview.floating?.id, `new-${i}`);
    assert.ok(preview.layout.floating.some(pane => pane.id === `new-${i}`));
    assert.deepEqual(projectWorkspace(preview.layout, 1400, 900).panes, original.panes);
    assert.deepEqual(layout, before, 'cancelled preview never mutates layout');
  }
  const swap = previewResourceDrop(layout, { id: 'unused', sessionKey: 'one' }, x, y, 1400, 900);
  assert.equal(swap.drop?.side, 'center');
  assert.equal(swap.layout.panes.length, 2);
  assert.deepEqual(restoreWorkspace(swap.layout, new Set(['one', 'two'])), swap.layout);
});
