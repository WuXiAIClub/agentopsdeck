import assert from 'node:assert/strict';
import test from 'node:test';
import { bindDisplay, displayKey, emptyDisplayBindings, matchingDisplayLayout, parseDisplayBindings, validDisplay } from './display-layout.js';
const laptop = { width: 1440, height: 900 };
const monitor = { width: 2560, height: 1440, left: 1440, top: -100, label: 'External', internal: false };
test('display bindings roundtrip locally and distinguish equal-resolution monitors', () => {
  const state = bindDisplay(bindDisplay(emptyDisplayBindings(), 'laptop', laptop), 'monitor', monitor);
  assert.deepEqual(parseDisplayBindings(JSON.stringify(state)), state);
  assert.equal(matchingDisplayLayout(state, monitor, new Set(['monitor', 'laptop'])), 'monitor');
  assert.equal(matchingDisplayLayout(state, { ...monitor, left: -2560 }, new Set(['monitor'])), undefined);
  assert.notEqual(displayKey(monitor), displayKey({ ...monitor, label: 'Other' }));
});
test('rebinding replaces old display ownership without altering other layouts', () => {
  let state = bindDisplay(bindDisplay(emptyDisplayBindings(), 'laptop', laptop), 'monitor', monitor);
  state = bindDisplay(state, 'third', monitor);
  assert.deepEqual(state.bindings.map(b => b.layoutId), ['laptop', 'third']);
  state = bindDisplay(state, 'laptop', monitor);
  assert.deepEqual(state.bindings.map(b => b.layoutId), ['laptop']);
});
test('removed layouts, disabled switching and lost precise permission never guess', () => {
  const state = bindDisplay(emptyDisplayBindings(), 'monitor', monitor);
  assert.equal(matchingDisplayLayout(state, monitor, new Set()), undefined);
  assert.equal(matchingDisplayLayout({ ...state, enabled: false }, monitor, new Set(['monitor'])), undefined);
  assert.equal(matchingDisplayLayout(state, { width: monitor.width, height: monitor.height }, new Set(['monitor'])), undefined);
  const simple = bindDisplay(emptyDisplayBindings(), 'laptop', laptop);
  assert.equal(matchingDisplayLayout(simple, { ...laptop, label: 'Built-in', left: 0, internal: true }, new Set(['laptop'])), 'laptop');
});
test('untrusted display settings reject invalid geometry, duplicates, versions and huge input', () => {
  for (const value of [null, {}, { ...laptop, width: 0 }, { ...laptop, height: Infinity }, { ...laptop, width: 1.5 }, { ...laptop, left: NaN }, { ...laptop, label: 'a'.repeat(257) }]) assert.equal(validDisplay(value), false);
  for (const raw of ['{', 'x'.repeat(65537), JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, enabled: true, bindings: Array(51).fill({ layoutId: 'a', display: laptop }) }), JSON.stringify({ version: 1, enabled: true, bindings: [{ layoutId: 'a', display: laptop }, { layoutId: 'b', display: laptop }] })]) assert.deepEqual(parseDisplayBindings(raw), emptyDisplayBindings());
});
