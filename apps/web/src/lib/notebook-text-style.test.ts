import assert from 'node:assert/strict';
import test from 'node:test';
import { MarkdownManager } from '@tiptap/markdown';
import { marked } from 'marked';
import { getSchema, type JSONContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { TableKit } from '@tiptap/extension-table';
import { createNotebookMarkdownParser, NotebookStyleHtmlBlock, NotebookTextStyleMark, normalizeNoteStyle, noteStyleCss, noteStyleMarker, parseNoteStyle } from './notebook-text-style.js';

const extensions = [StarterKit, TaskList, TaskItem.configure({ nested: true }), TableKit, NotebookTextStyleMark, NotebookStyleHtmlBlock];
const manager = () => new MarkdownManager({ extensions, marked: createNotebookMarkdownParser() });
// ProseMirror normalizes mark order/default attributes when loading Markdown.
const canonical = (doc: JSONContent) => getSchema(extensions).nodeFromJSON(doc).toJSON();
const span = (text: string, style = 'v1;135;#1d4ed8;#fef08a') => `<span data-agentopsdeck-note="${style}">${text}</span>`;
test('note styles accept only bounded relative sizes and opaque hex colors', () => {
  assert.equal(noteStyleMarker({ size: 135, color: '#ABCDEF', highlight: '#fef08a' }), 'v1;135;#abcdef;#fef08a');
  assert.deepEqual(normalizeNoteStyle({ size: 201, color: 'url(https://tracker)', highlight: 'red;position:fixed' }), { size: null, color: null, highlight: null });
  for (const marker of ['v2;100;-;-', 'v1;999;-;-', 'v1;69;-;-', 'v1;100;red;-', 'v1;100;#123;-', 'v1;100;-;-;onclick']) assert.equal(parseNoteStyle(marker), null);
  assert.deepEqual(parseNoteStyle('v1;70;-;-'), { size: 70, color: null, highlight: null });
  assert.equal(noteStyleCss({ size: 135, color: '#1d4ed8', highlight: '#fef08a' }), 'font-size:135%;color:#1d4ed8;background-color:#fef08a');
});
test('font markers keep v1 backward compatibility and allow only local font families', () => {
  assert.equal(noteStyleMarker({ font: 'serif' }), 'v2;-;-;-;serif');
  assert.equal(noteStyleMarker({ font: 'url(https://tracker)' }), 'v1;-;-;-');
  assert.equal(noteStyleMarker({ font: 'constructor' }), 'v1;-;-;-');
  assert.equal(parseNoteStyle('v1;-;-;-;serif'), null);
  assert.equal(parseNoteStyle('v2;-;-;-;ComicSans'), null);
  assert.equal(parseNoteStyle('v2;-;-;-;serif')?.font, 'serif');
  assert.match(noteStyleCss({ font: 'mono' }), /font-family:ui-monospace, monospace/);
  const md = manager(), source = span('**font** 中文', 'v2;115;#1d4ed8;-;serif');
  const parsed = md.parse(source);
  assert.deepEqual(canonical(md.parse(md.serialize(parsed))), canonical(parsed));
});
test('styled Markdown round trips paragraph starts, inline spans, lists, TODOs and tables', () => {
  const md = manager();
  for (const source of [span('Hello **bold** and _italic_'), `Before ${span('中文 **加粗**')} after`,
    `${span('one')} ${span('two', 'v1;85;#b91c1c;-')}`, `## ${span('Heading')}`,
    `- [ ] ${span('Ship **now**')}\n  - [x] nested`, `| task | owner |\n| --- | --- |\n| ${span('ship')} | me |`,
    `${span('first')}\n\nPlain paragraph\n\n${span('last')}`, `${span('line')}\nplain next line`,
    `**${span('bold')}**`, span('[safe link](https://example.invalid)'), span('`inline code`'), span('one  \ntwo'),
    span('HTML &lt;script&gt; and &amp; &lt;/span&gt;')]) {
    const parsed = md.parse(source), saved = md.serialize(parsed);
    assert.match(JSON.stringify(parsed), /notebookTextStyle/, source);
    assert.deepEqual(canonical(md.parse(saved)), canonical(parsed), `${source}\nserialized: ${saved}`);
    assert.equal(md.serialize(md.parse(saved)), saved, 'normalization stabilizes after the first edit');
  }
});
test('plain Markdown and marker-looking code remain plain; malformed marker cannot become CSS', () => {
  const md = manager();
  for (const source of ['# Tips\n\n**bold** and _italic_', `\`${span('literal')}\``, `\`\`\`html\n${span('literal')}\n\`\`\``]) {
    assert.doesNotMatch(JSON.stringify(md.parse(source)), /"type":"notebookTextStyle"/);
    assert.deepEqual(md.parse(md.serialize(md.parse(source))), md.parse(source));
  }
  assert.doesNotMatch(JSON.stringify(md.parse(span('bad', 'v1;999;red;-'))), /"type":"notebookTextStyle"/);
});

test('repeated notebook mounts do not accumulate shared Markdown tokenizers', () => {
  const original = marked.defaults.extensions;
  const firstParser = createNotebookMarkdownParser();
  const first = new MarkdownManager({ extensions, marked: firstParser });
  const count = firstParser.defaults.extensions?.inline?.length;
  const expected = canonical(first.parse(span('**independent**')));
  for (let i = 0; i < 40; i++) {
    const parser = createNotebookMarkdownParser();
    assert.notEqual(parser, firstParser);
    const next = new MarkdownManager({ extensions, marked: parser });
    assert.deepEqual(canonical(next.parse(span('**independent**'))), expected);
    assert.equal(parser.defaults.extensions?.inline?.length, count);
  }
  assert.equal(marked.defaults.extensions, original);
  assert.equal(firstParser.defaults.extensions?.inline?.length, count);
});

test('near-limit many-span notes round trip without recursive marks', () => {
  const md = manager();
  const source = Array.from({ length: 230 }, (_, i) => span(`item ${i} **text**`)).join(' ');
  assert.ok(source.length < 20_000);
  const parsed = md.parse(source);
  assert.deepEqual(canonical(md.parse(md.serialize(parsed))), canonical(parsed));
  const nested = span(span('nested'));
  const visit = (node: JSONContent) => {
    assert.ok((node.marks?.filter(mark => mark.type === 'notebookTextStyle').length ?? 0) <= 1);
    node.content?.forEach(visit);
  };
  visit(md.parse(nested));
});
