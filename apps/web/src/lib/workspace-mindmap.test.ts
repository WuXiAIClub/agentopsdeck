import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { emptyDrawing, validDrawingContent, type DrawingContent } from '@agentopsdeck/shared';
import { addMindmapTopic, arrangeMindmap } from './workspace-mindmap.js';
import { exportDrawio, importDrawio } from './workspace-drawio.js';

const node = (text = 'Topic') => ({ id: randomUUID(), text, x: 0, y: 0, width: 160, height: 64, color: '#dbeafe' });
const link = (from: string, to: string) => ({ id: randomUUID(), from, to });
test('mind map layout is stable, nonoverlapping, content-preserving and bounded', () => {
  const nodes = [node('root'), node('child'), node('sibling'), node('other root')];
  const input: DrawingContent = { ...emptyDrawing(), nodes, edges: [link(nodes[0]!.id, nodes[1]!.id), link(nodes[0]!.id, nodes[2]!.id)] };
  const original = structuredClone(input), result = arrangeMindmap(input); assert.equal(result.ok, true); if (!result.ok) return;
  assert.deepEqual(input, original); assert.equal(validDrawingContent(result.content), true);
  assert.deepEqual(arrangeMindmap(result.content), result);
  assert.deepEqual(result.content.edges, input.edges);
  for (const a of result.content.nodes) for (const b of result.content.nodes) {
    if (a.id === b.id) continue;
    assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
  }
  assert.deepEqual(result.content.nodes.map(({ x, y, ...rest }) => rest), input.nodes.map(({ x, y, ...rest }) => rest));
});
test('cycles and multiple parents fail without discarding graph information', () => {
  const nodes = [node(), node(), node()];
  for (const edges of [[link(nodes[0]!.id, nodes[1]!.id), link(nodes[1]!.id, nodes[0]!.id)], [link(nodes[0]!.id, nodes[2]!.id), link(nodes[1]!.id, nodes[2]!.id)]]) {
    const input = { ...emptyDrawing(), nodes, edges }, before = structuredClone(input);
    assert.deepEqual(arrangeMindmap(input), { ok: false, reason: 'not-tree' }); assert.deepEqual(input, before);
  }
});
test('deep/wide/maximum-size graphs fail safely, without shrinking text or hiding branches', () => {
  for (const count of [20, 256]) {
    const nodes = Array.from({ length: count }, () => node());
    for (const edges of [nodes.slice(1).map((n, i) => link(nodes[i]!.id, n.id)), nodes.slice(1).map(n => link(nodes[0]!.id, n.id))]) {
      assert.deepEqual(arrangeMindmap({ ...emptyDrawing(), nodes, edges }), { ok: false, reason: 'too-large' });
    }
  }
  assert.deepEqual(arrangeMindmap(emptyDrawing()), { ok: true, content: emptyDrawing() });
});
test('child and sibling edits preserve parent and inherited color, and allow root siblings', () => {
  const root = node('root'); root.color = '#123456'; const child = randomUUID(), sibling = randomUUID();
  const a = addMindmapTopic({ ...emptyDrawing(), nodes: [root] }, root.id, 'child', 'Child', child, randomUUID());
  assert.ok(a.ok); if (!a.ok) return;
  assert.equal(a.content.nodes[1]!.color, root.color);
  const b = addMindmapTopic(a.content, child, 'sibling', 'Sibling', sibling, randomUUID());
  assert.ok(b.ok); if (!b.ok) return;
  assert.equal(b.content.edges.find(e => e.to === sibling)?.from, root.id);
  const c = addMindmapTopic(b.content, root.id, 'sibling', 'New root', randomUUID(), randomUUID());
  assert.ok(c.ok); if (c.ok) assert.equal(c.content.edges.length, b.content.edges.length);
  assert.equal(addMindmapTopic(a.content, 'missing', 'child', 'x', randomUUID(), randomUUID()).ok, false);
});
test('draw.io export is actual XML with plain text, escaped attributes and no resource metadata', () => {
  const first = node('"&<>\n\t\r 中文😀'), second = node('Second');
  const value = { ...emptyDrawing(), title: 'Sketch & "test"', nodes: [first, second], edges: [link(first.id, second.id)], resourceId: 'private-resource', revision: 9 };
  const xml = exportDrawio(value);
  assert.match(xml, /<mxfile><diagram/); assert.match(xml, /<mxGraphModel><root>/);
  assert.match(xml, /&quot;&amp;&lt;&gt;&#10;&#9;&#13; 中文😀/); assert.match(xml, /html=0/);
  assert.ok(!xml.includes('private-resource')); assert.ok(!xml.includes('revision'));
  assert.throws(() => exportDrawio({ ...value, title: 'control\u0000' }));
  assert.throws(() => exportDrawio({ ...value, title: '\ud800' }));
});
test('draw.io parser rejects entities, DTD, processing instructions and oversized input before XML parsing', () => {
  const parse = () => { throw Error('must not reach XML parser'); };
  for (const xml of ['<!DOCTYPE mxfile [<!ENTITY secret SYSTEM "file:///private">]><mxfile/>', '<!ENTITY x "y">', '<?xml-stylesheet href="http://private"?>', ' '.repeat(512 * 1024 + 1)]) {
    assert.throws(() => importDrawio(xml, parse), /Unsupported draw.io content/);
  }
});
