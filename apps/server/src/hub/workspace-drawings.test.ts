import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyDrawing, validDrawingWrite, DRAWING_MAX_DOCUMENTS, type DrawingWrite } from '@agentopsdeck/shared';
import { WorkspaceDrawings } from './workspace-drawings.js';
const input = (): DrawingWrite => ({ ...emptyDrawing(), revision: 0, mutationId: randomUUID(), strokes: [{ id: randomUUID(), color: '#60a5fa', width: 4, points: [[0, 0], [1600, 1000]] }], nodes: [{ id: randomUUID(), x: 0, y: 0, width: 200, height: 100, text: '<script>text only</script>', color: '#dbeafe' }] });

test('drawing CAS and bounded receipts survive reopening; users and catalogs isolate content', () => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-drawings-')), path = join(root, 'db.sqlite');
  let db = new DatabaseSync(path), drawings = new WorkspaceDrawings(db);
  try {
    const body = input(), result = drawings.save('alice', 'default', body);
    assert.equal(result.status, 'saved'); assert.deepEqual(drawings.save('alice', 'default', body), result);
    assert.deepEqual(drawings.get('alice', 'default').strokes, body.strokes);
    assert.equal(JSON.stringify(drawings.list('alice')).includes('points'), false);
    assert.equal(JSON.stringify(drawings.revisions('alice')).includes('points'), false);
    assert.equal(drawings.get('bob', 'default').revision, 0); assert.deepEqual(drawings.list('bob'), []);
    assert.equal(JSON.stringify(drawings.list('alice')).includes('script'), false);
    assert.equal(drawings.save('alice', 'default', { ...body, title: 'Changed' }).status, 'mutation-reused');
    assert.equal(drawings.save('alice', 'default', { ...body, mutationId: randomUUID() }).status, 'conflict');
    db.close(); db = new DatabaseSync(path); drawings = new WorkspaceDrawings(db);
    assert.deepEqual(drawings.get('alice', 'default').strokes, body.strokes);
    assert.deepEqual(drawings.save('alice', 'default', body), result);
    for (let revision = 1; revision < 12; revision++) assert.equal(drawings.save('alice', 'default', { ...body, revision, mutationId: randomUUID() }).status, 'saved');
    assert.equal((db.prepare('SELECT count(*) AS n FROM hub_workspace_drawing_receipts').get() as { n: number }).n, 8);
    assert.equal(drawings.save('alice', 'default', body).status, 'conflict');
    assert.equal(drawings.get('alice', 'default').revision, 12);
    for (let i = 1; i < DRAWING_MAX_DOCUMENTS; i++) assert.equal(drawings.save('alice', randomUUID(), input()).status, 'saved');
    assert.equal(drawings.save('alice', randomUUID(), input()).status, 'limit');
    assert.equal(drawings.save('bob', randomUUID(), input()).status, 'saved');
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
test('drawing validation rejects active content, invalid geometry, dangling and duplicate links, and oversized data', () => {
  const body = input(), node = body.nodes[0]!;
  for (const bad of [null, [], { ...body, userId: 'bob' }, { ...body, version: 2 }, { ...body, format: 'svg' }, { ...body, revision: Number.MAX_SAFE_INTEGER },
    { ...body, nodes: [{ ...node, x: NaN }] }, { ...body, nodes: [{ ...node, y: Infinity }] }, { ...body, nodes: [{ ...node, x: 1500 }] },
    { ...body, nodes: [{ ...node, url: 'http://private' }] }, { ...body, nodes: [{ ...node, color: 'url(http://private)' }] },
    { ...body, nodes: [node, node] }, { ...body, nodes: [{ ...node, text: 'x'.repeat(2001) }] },
    { ...body, nodes: Array.from({ length: 257 }, () => ({ ...node, id: randomUUID() })) },
    { ...body, nodes: Array.from({ length: 33 }, () => ({ ...node, id: randomUUID(), text: 'x'.repeat(2000) })) },
    { ...body, edges: [{ id: randomUUID(), from: node.id, to: randomUUID() }] },
    { ...body, edges: [{ id: randomUUID(), from: node.id, to: node.id }] }]) assert.equal(validDrawingWrite(bad), false);
  const second = { ...node, id: randomUUID() }, edge = { id: randomUUID(), from: node.id, to: second.id };
  assert.equal(validDrawingWrite({ ...body, nodes: [node, second], edges: [edge] }), true);
  assert.equal(validDrawingWrite({ ...body, nodes: [node, second], edges: [edge, { ...edge, id: randomUUID() }] }), false);
});
test('receipt insertion failure rolls back content and metadata', () => {
  const db = new DatabaseSync(':memory:'), drawings = new WorkspaceDrawings(db);
  try {
    db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON hub_workspace_drawing_receipts BEGIN SELECT RAISE(ABORT, 'synthetic'); END");
    assert.throws(() => drawings.save('alice', 'default', input()), /synthetic/);
    assert.equal(drawings.get('alice', 'default').revision, 0); assert.deepEqual(drawings.list('alice'), []);
  } finally { db.close(); }
});
