import assert from 'node:assert/strict';
import test from 'node:test';
import { Schema } from '@tiptap/pm/model';
import { notebookHeadings, readNotebookFolds } from './notebook-folding.js';

const schema = new Schema({ nodes: {
  doc: { content: 'block*' }, text: { group: 'inline' }, paragraph: { group: 'block', content: 'inline*' },
  heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 } } },
} });
const h = (level: number, text: string) => schema.node('heading', { level }, schema.text(text));
const p = (text: string) => schema.node('paragraph', null, schema.text(text));
test('fold boundaries follow heading hierarchy and distinguish duplicate titles', () => {
  const doc = schema.node('doc', null, [h(1, 'Parent'), p('body'), h(2, 'Same'), p('one'), h(3, 'Nested'), p('leaf'), h(2, 'Same'), p('two'), h(1, 'Next')]);
  const headings = notebookHeadings(doc);
  assert.equal(headings.length, 5);
  assert.equal(headings[0]!.end, headings[4]!.position);
  assert.equal(headings[1]!.end, headings[3]!.position);
  assert.equal(headings[2]!.end, headings[3]!.position);
  assert.equal(new Set(headings.map(item => item.key)).size, 5);
  const edited = schema.node('doc', null, [h(1, 'Parent'), p('longer replacement paragraph'), h(2, 'Same'), p('one'), h(3, 'Nested'), p('leaf'), h(2, 'Same'), p('two'), h(1, 'Next')]);
  assert.deepEqual(notebookHeadings(edited).map(item => item.key), headings.map(item => item.key));
});
test('heading budget closes fold boundaries at later headings, rather than hiding the remainder', () => {
  const headings = notebookHeadings(schema.node('doc', null, Array.from({ length: 202 }, (_, i) => h(1, `Heading ${i}`))));
  assert.equal(headings.length, 200);
  assert.equal(headings[199]!.end, headings[199]!.position + h(1, 'Heading 199').nodeSize);
});
test('fold preferences tolerate unavailable, corrupted and excessive storage', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let raw: string | null = null;
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => raw } });
    for (const input of [null, 'null', '{', 'x'.repeat(8001)]) { raw = input; assert.deepEqual(readNotebookFolds('a'), { reading: false, folded: [] }); }
    raw = JSON.stringify({ reading: true, folded: ['123:1', 'private heading', 42, ...Array(300).fill('456:2')] });
    assert.equal(readNotebookFolds('a').folded.length, 200);
    assert.equal(readNotebookFolds('a').folded.includes('private heading'), false);
    assert.deepEqual(readNotebookFolds(), { reading: false, folded: [] });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw Error('Denied'); } });
    assert.deepEqual(readNotebookFolds('a'), { reading: false, folded: [] });
  } finally { if (original) Object.defineProperty(globalThis, 'localStorage', original); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});
