import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { getSchema } from '@tiptap/react';
import { MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { NotebookTextStyleMark, NotebookStyleHtmlBlock, createNotebookMarkdownParser } from './notebook-text-style.js';
import { notebookSelectionRange } from './notebook-selection.js';

const extensions = [StarterKit, NotebookTextStyleMark, NotebookStyleHtmlBlock];
const schema = getSchema(extensions);
const md = new MarkdownManager({ extensions, marked: createNotebookMarkdownParser() });
function fixture(source: string) {
  const doc = schema.nodeFromJSON(md.parse(source));
  const serialize = (node: typeof doc) => md.serialize(node.toJSON());
  return { doc, serialize, source: serialize(doc) };
}
function select(source: string, phrase: string, occurrence = 0) {
  const data = fixture(source);
  const positions: number[] = [];
  data.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    let at = node.text.indexOf(phrase);
    while (at >= 0) { positions.push(pos + at); at = node.text.indexOf(phrase, at + phrase.length); }
  });
  const from = positions[occurrence]!;
  const range = notebookSelectionRange(data.doc, from, from + phrase.length, data.serialize, data.source);
  assert.ok(range, data.source);
  return { ...data, range, moved: data.source.slice(range.start, range.end) };
}
test('actual rich-text positions identify the second identical phrase', () => {
  const selected = select('repeat then repeat', 'repeat', 1);
  assert.equal(selected.range.start, selected.source.lastIndexOf('repeat'));
  assert.equal(selected.moved, 'repeat');
});
test('whole selected bold/style marks move with the text; partial marks stay with surrounding text', () => {
  assert.equal(select('before **move** after', 'move').moved, '**move**');
  assert.equal(select('**keep move keep**', 'move').moved, 'move');
  const span = '<span data-agentopsdeck-note="v2;135;#1d4ed8;-;serif">move</span>';
  assert.equal(select(`before ${span} after`, 'move').moved, span);
});
test('Markdown escaping, Unicode offsets and boundary-like text stay exact', () => {
  assert.equal(select('😀 before 中文 after', '中文').moved, '中文');
  const selected = select('AgentOpsDeckSelectionBoundary then move', 'move');
  assert.equal(selected.moved, 'move');
  assert.equal(select('before a\\*b after', 'a*b').moved, 'a\\*b');
});
test('empty, invalid, oversized and noncanonical selections never yield unsafe offsets', () => {
  const data = fixture('**word**');
  for (const [from, to] of [[1,1], [-1,2], [1,100]]) {
    assert.equal(notebookSelectionRange(data.doc, from!, to!, data.serialize, data.source), undefined);
  }
  assert.equal(notebookSelectionRange(data.doc, 1, 5, data.serialize, '__word__'), undefined);
  const long = fixture('x'.repeat(16001));
  assert.equal(notebookSelectionRange(long.doc, 1, 16002, long.serialize, long.source), undefined);
  const blocks = fixture('first\n\nsecond');
  assert.equal(notebookSelectionRange(blocks.doc, 1, blocks.doc.content.size - 1, blocks.serialize, blocks.source), undefined);
});
test('selection menu captures native events and guards stale editor selection and readonly actions', () => {
  const editor = readFileSync('src/components/NotebookEditor.tsx', 'utf8');
  assert.match(editor, /addEventListener\('contextmenu', open, true\)/);
  assert.match(editor, /context\.doc !== editor\.state\.doc \|\| context\.source !== text/);
  assert.match(editor, /context\.scope !== recoveryScope\(\) \|\| context\.epoch !== recoveryEpoch\(\) \|\| context\.resourceId !== resourceId/);
  assert.match(editor, /navigator\.clipboard\.writeText\(context\.selectedText\)/);
  assert.match(editor, /navigator\.clipboard\?\.writeText/);
  assert.match(editor, /editor\.view\.focus\(\)/);
  assert.match(editor, /event\.clipboardData\.setData\('text\/plain', context\.selectedText\)/);
  assert.match(editor, /finally \{ document\.removeEventListener\('copy', plainCopy\); \}/);
  assert.match(editor, /disabled=\{disabled \|\| reading \|\| !archiveRange\}/);
  assert.match(editor, /onArchive\(\{ source: context\.source, \.\.\.archiveRange/);
  assert.match(editor, /Copy unavailable\. Use Ctrl\/Cmd\+C\./);
  assert.match(editor, /if \(cut && restoreSelection\(\)\) editor\.chain\(\)\.focus\(\)\.deleteSelection\(\)\.run\(\)/);
  assert.match(editor, /live\.contextMenu !== context \|\| live\.disabled \|\| live\.reading \|\| editor\.isDestroyed/);
});
test('quick archive uses the atomic move after original save, preserves receipts and never deletes locally', () => {
  const archive = readFileSync('src/components/NotebookArchive.tsx', 'utf8');
  assert.match(archive, /await hotController\.settled\(\); await hotController\.flush\(\)/);
  assert.match(archive, /source !== expectedSource/);
  assert.match(archive, /hotController\.get\(\) !== freshHot \|\| controller\.get\(\) !== freshCold/);
  assert.match(archive, /remember\(requestId\);[\s\S]*await api\.moveNotebook/);
  assert.match(archive, /handled\.current = selection\.requestId; onSelectionHandled\(\)/);
  assert.match(archive, /selection\.scope !== scope \|\| selection\.epoch !== epoch \|\| selection\.resourceId !== hotController\.get\(\)\.document\?\.resourceId/);
  assert.doesNotMatch(archive, /hotController\.edit\(/);
  assert.match(archive, /busy \|\| !!pending/);
  assert.match(archive, /onBusyChange\(busy \|\| !!pending\)/);
  assert.doesNotMatch(archive, /onBusyChange\(false\)/);
  assert.match(archive, /mounted\.current && !live\.current\.paused/);
  assert.match(archive, /return \(\) => \{ mounted\.current = false; \}/);
});
