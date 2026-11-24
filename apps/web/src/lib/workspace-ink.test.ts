import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { emptyDrawing, drawingContent, validDrawingContent, DRAWING_MAX_BODY_BYTES, type DrawingStroke, type DrawingPoint } from '@agentopsdeck/shared';
import { appendInkPoint, inkBudget, inkPath } from './workspace-ink.js';
import { importDrawing, drawingEqual, reconcileDrawing } from './workspace-drawing.js';
import { exportDrawio } from './workspace-drawio.js';
import { arrangeMindmap } from './workspace-mindmap.js';
const stroke = (count = 2): DrawingStroke => ({ id: randomUUID(), color: '#60a5fa', width: 4, points: Array.from({ length: count }, (_, i) => [i % 1601, i % 1001]) });

test('optional ink keeps legacy canonical fingerprints and deeply copies new data', () => {
  const legacy = emptyDrawing(), data = { ...legacy, strokes: [stroke()] };
  assert.deepEqual(drawingContent({ ...legacy, strokes: [] }), legacy);
  assert.equal(drawingEqual(legacy, { ...legacy, strokes: [] }), true);
  const copy = drawingContent(data); copy.strokes![0]!.points[0]![0] = 100;
  assert.equal(data.strokes[0]!.points[0]![0], 0);
  assert.deepEqual(importDrawing(JSON.stringify(data)), data);
  const draft = { ...data, revision: 1, mutationId: randomUUID() };
  assert.deepEqual(reconcileDrawing({ ...legacy, resourceId: 'default', revision: 2, updatedAt: 1 }, draft, randomUUID()), { draft, conflict: true });
  assert.throws(() => exportDrawio(data));
  assert.match(exportDrawio({ ...legacy, strokes: [] }), /mxfile/);
  const arranged = arrangeMindmap(data);
  assert.equal(arranged.ok, true);
  if (arranged.ok) assert.deepEqual(arranged.content.strokes, data.strokes);
});

test('ink rejects malformed, active and over-budget content without truncation', () => {
  const s = stroke(), data = { ...emptyDrawing(), strokes: [s] };
  assert.equal(validDrawingContent(data), true);
  for (const bad of [null, {}, { ...s, points: [] }, { ...s, points: [[0, 0, 1]] }, { ...s, points: [[NaN, 0]] },
    { ...s, points: [[0.5, 0]] }, { ...s, points: [[-1, 0]] }, { ...s, points: [[1601, 0]] }, { ...s, points: [[0, 1001]] },
    { ...s, color: 'url(http://private)' }, { ...s, width: 0 }, { ...s, width: 13 }, { ...s, width: 1.5 }, { ...s, href: 'http://private' }, stroke(513)]) {
    assert.equal(validDrawingContent({ ...data, strokes: [bad] }), false);
  }
  assert.equal(validDrawingContent({ ...data, strokes: [s, s] }), false);
  assert.equal(validDrawingContent({ ...data, strokes: Array.from({ length: 129 }, () => stroke(1)) }), false);
  const max = Array.from({ length: 16 }, () => stroke(512));
  assert.equal(validDrawingContent({ ...data, strokes: max }), true);
  assert.equal(inkBudget({ ...data, strokes: max }), 0);
  assert.equal(validDrawingContent({ ...data, strokes: [...max, stroke(1)] }), false);
});

test('sampling is bounded and paths contain only numeric coordinates', () => {
  const points: DrawingPoint[] = [];
  assert.equal(appendInkPoint(points, NaN, 1, 512), false);
  assert.equal(appendInkPoint(points, 0, 0, NaN), false);
  assert.equal(appendInkPoint(points, -50, 2000, 2), true);
  assert.equal(inkPath(points), 'M0,1000l0,0');
  assert.equal(appendInkPoint(points, 1, 1000, 2), false);
  assert.equal(appendInkPoint(points, 1601, -20, 2), true);
  assert.equal(appendInkPoint(points, 200, 200, 2), false);
  assert.equal(inkPath(points), 'M0,1000L1600,0');
  assert.equal(inkPath([]), '');
  assert.equal(inkBudget(emptyDrawing()), 512);
});

test('maximum ink plus maximum escaped text stays inside the JSON transport budget', () => {
  const data = { ...emptyDrawing(), title: '\u0000'.repeat(160),
    nodes: Array.from({ length: 32 }, () => ({ id: randomUUID(), x: 0, y: 0, width: 200, height: 100, text: '\u0000'.repeat(1995), color: '#000000' })),
    strokes: Array.from({ length: 128 }, () => ({ ...stroke(64), points: Array.from({ length: 64 }, (): DrawingPoint => [1600, 1000]) })) };
  assert.equal(validDrawingContent(data), true);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...data, revision: 1, mutationId: randomUUID() })) < DRAWING_MAX_BODY_BYTES);
  assert.deepEqual(importDrawing(JSON.stringify(data)), data);
  const nodes = Array.from({ length: 256 }, (_, i) => ({ id: randomUUID(), x: 0, y: 0, width: 200, height: 100, text: i < 32 ? '\u0000'.repeat(1995) : '', color: '#000000' }));
  const oversized = { ...data, nodes, edges: Array.from({ length: 512 }, (_, i) => ({ id: randomUUID(), from: nodes[Math.floor(i / 2)]!.id, to: nodes[(Math.floor(i / 2) + 1 + i % 2) % 256]!.id })) };
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > DRAWING_MAX_BODY_BYTES);
  assert.equal(validDrawingContent(oversized), false, 'combined budgets must not admit a non-roundtrippable document');
  assert.throws(() => importDrawing(JSON.stringify(oversized)));
});
