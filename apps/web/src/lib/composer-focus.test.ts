import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mayRestoreComposerFocus,
  mayHoverComposerFocus,
  isComposerRevealZone,
  isPeerEditor,
  mayHideIdleComposer,
  isPaneEnlargedForComposer,
  shouldShowComposerByDefault,
} from './composer-focus.js';

test('idle collapse only affects a split composer outside the stationary pointer, without interrupting interaction or enlarged panes', () => {
  const ready = { split: true, pointerInPane: true, pointerInComposer: false, composing: false, selectedText: false, busy: false, overlay: false };
  assert.equal(mayHideIdleComposer(ready), true);
  assert.equal(mayHideIdleComposer({ ...ready, enlarged: true }), false);
  for (const key of ['split', 'pointerInPane'] as const) assert.equal(mayHideIdleComposer({ ...ready, [key]: false }), false);
  for (const key of ['pointerInComposer', 'composing', 'selectedText', 'busy', 'overlay'] as const) assert.equal(mayHideIdleComposer({ ...ready, [key]: true }), false);
});

test('enlarged or maximized session panes show the composer by default unless explicitly collapsed', () => {
  assert.equal(isPaneEnlargedForComposer({ dense: false, maximized: false }), true);
  assert.equal(isPaneEnlargedForComposer({ dense: true, maximized: true }), true);
  assert.equal(isPaneEnlargedForComposer({ dense: true, maximized: false }), false);
  assert.equal(shouldShowComposerByDefault({ dense: false, maximized: false, explicitlyCollapsed: false }), true);
  assert.equal(shouldShowComposerByDefault({ dense: true, maximized: true, explicitlyCollapsed: false }), true);
  assert.equal(shouldShowComposerByDefault({ dense: false, maximized: true, explicitlyCollapsed: true }), false);
  assert.equal(shouldShowComposerByDefault({ dense: true, maximized: false, explicitlyCollapsed: false }), false);
});

test('only session composers and editable notebook content are peer focus surfaces', () => {
  assert.equal(isPeerEditor(null), false);
  const element = (selector: string) => ({ matches: (list: string) => list.split(', ').includes(selector) }) as Element;
  assert.equal(isPeerEditor(element('.desktop-composer-textarea')), true);
  assert.equal(isPeerEditor(element('.notebook-rich-content[contenteditable="true"]')), true);
  for (const selector of ['input', 'textarea', '.notebook-title', '.notebook-rich-content[contenteditable="false"]']) {
    assert.equal(isPeerEditor(element(selector)), false, selector);
  }
});

test('delayed acknowledgements never steal focus from another editor or dialog', () => {
  const body = {} as HTMLElement, other = {} as HTMLElement;
  let active = 'true';
  const input = { isConnected: true, closest: () => ({ getAttribute: () => active }) } as unknown as HTMLElement;
  assert.equal(mayRestoreComposerFocus(input, input, body), true);
  assert.equal(mayRestoreComposerFocus(input, body, body), true);
  assert.equal(mayRestoreComposerFocus(input, other, body), false);
  active = 'false';
  assert.equal(mayRestoreComposerFocus(input, body, body), false);
  assert.equal(mayRestoreComposerFocus(null, body, body), false);
});

test('mouse hover can focus another composer but never interrupts existing interactions', () => {
  const ready = { mouse: true, buttons: 0, composing: false, dragging: false, selectedText: false, overlay: false, otherEditor: false, collapsed: false };
  assert.equal(mayHoverComposerFocus(ready), true);
  assert.equal(mayHoverComposerFocus({ ...ready, mouse: false }), false);
  assert.equal(mayHoverComposerFocus({ ...ready, buttons: 1 }), false);
  for (const key of ['composing', 'dragging', 'selectedText', 'overlay', 'otherEditor', 'collapsed'] as const) {
    assert.equal(mayHoverComposerFocus({ ...ready, [key]: true }), false, key);
  }
});

test('composer reveal uses precisely the bottom 15 percent in pane coordinates', () => {
  assert.equal(isComposerRevealZone(609, 100, 600), false);
  assert.equal(isComposerRevealZone(610, 100, 600), true);
  assert.equal(isComposerRevealZone(700, 100, 600), true);
  assert.equal(isComposerRevealZone(701, 100, 600), false);
  assert.equal(isComposerRevealZone(100, 100, 0), false);
  assert.equal(isComposerRevealZone(NaN, 0, 600), false);
});
