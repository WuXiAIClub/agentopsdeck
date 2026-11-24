import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessageItemProjector, type MessageItem } from './incremental-message-items.js';
import {
  INITIAL_TAIL_RENDER_ITEMS,
  nextProgressiveTailCount,
  resolveProgressivePrependScrollTop,
  sliceTailRenderItems,
} from './progressive-tail-render.js';

type Row = { id: number; kind: 'hidden' | 'tool' | 'chat'; text: string };
const row = (id: number, kind: Row['kind'] = 'chat'): Row => ({ id, kind, text: `row ${id}` });

test('nextProgressiveTailCount steps from latest tail batch toward full message list', () => {
  assert.equal(nextProgressiveTailCount(32, 0), 0);
  assert.equal(nextProgressiveTailCount(32, 20), 20);
  assert.equal(nextProgressiveTailCount(32, 200), 96);
  assert.equal(nextProgressiveTailCount(96, 200), 200);
  assert.equal(nextProgressiveTailCount(200, 200), 200);
});

test('sliceTailRenderItems renders newest tail items first and preserves object identities as head expands backwards', () => {
  const items: MessageItem<Row>[] = Array.from({ length: 150 }, (_, index) => ({
    kind: 'message',
    message: row(index),
    index,
  }));

  const firstFrame = sliceTailRenderItems(items, INITIAL_TAIL_RENDER_ITEMS, false);
  assert.equal(firstFrame.length, INITIAL_TAIL_RENDER_ITEMS);
  assert.equal(firstFrame[0], items[150 - INITIAL_TAIL_RENDER_ITEMS]);
  assert.equal(firstFrame.at(-1), items[149]);

  const secondLimit = nextProgressiveTailCount(INITIAL_TAIL_RENDER_ITEMS, items.length);
  const secondFrame = sliceTailRenderItems(items, secondLimit, false);
  assert.equal(secondFrame.length, 96);
  for (let offset = 1; offset <= INITIAL_TAIL_RENDER_ITEMS; offset++) {
    assert.equal(
      secondFrame[secondFrame.length - offset],
      firstFrame[firstFrame.length - offset],
      'already mounted tail items must keep identical object references',
    );
  }

  const finalLimit = nextProgressiveTailCount(secondLimit, items.length);
  const finalFrame = sliceTailRenderItems(items, finalLimit, false);
  assert.equal(finalFrame, items);
});

test('projector suffix reuse avoids re-classifying or rebuilding attachedTools when older history is prepended', () => {
  let classifications = 0;
  const project = createMessageItemProjector<Row>(message => {
    classifications++;
    return message.kind;
  });

  // Initial tail window of 100 chat+tool pairs (200 rows)
  const tailRows = Array.from({ length: 100 }, (_, i) => [row(200 + i * 2, 'tool'), row(200 + i * 2 + 1, 'chat')]).flat();
  const initialItems = project(tailRows);
  assert.equal(initialItems.length, 100);
  assert.equal(classifications, 200);

  // Prepend 50 older chat+tool pairs (100 rows) at the front
  classifications = 0;
  const olderRows = Array.from({ length: 50 }, (_, i) => [row(i * 2, 'tool'), row(i * 2 + 1, 'chat')]).flat();
  const expandedItems = project([...olderRows, ...tailRows]);

  assert.equal(expandedItems.length, 150);
  assert.equal(classifications, 100, 'only newly prepended rows are classified');

  // All suffix attachedTools arrays after the join boundary reuse exact identity
  for (let tailIdx = 1; tailIdx < initialItems.length; tailIdx++) {
    const prevItem = initialItems[tailIdx]!;
    const nextItem = expandedItems[50 + tailIdx]!;
    assert.equal(prevItem.kind, 'message');
    assert.equal(nextItem.kind, 'message');
    if (prevItem.kind === 'message' && nextItem.kind === 'message') {
      assert.equal(nextItem.message, prevItem.message);
      assert.equal(nextItem.attachedTools, prevItem.attachedTools);
      assert.equal(nextItem.index, prevItem.index + 100);
    }
  }
});

test('resolveProgressivePrependScrollTop pins to scrollHeight when following and restores anchor delta when auto-scroll is off', () => {
  assert.equal(
    resolveProgressivePrependScrollTop({
      scrollTop: 2400,
      scrollHeight: 9600,
      clientHeight: 600,
      following: true,
      anchorDeltaTop: 4800,
    }),
    9600,
  );
  assert.equal(
    resolveProgressivePrependScrollTop({
      scrollTop: 1200,
      scrollHeight: 9600,
      clientHeight: 600,
      following: false,
      anchorDeltaTop: 3200,
    }),
    4400,
  );
  assert.equal(
    resolveProgressivePrependScrollTop({
      scrollTop: 200,
      scrollHeight: 4000,
      clientHeight: 0,
      following: true,
    }),
    undefined,
  );
});
