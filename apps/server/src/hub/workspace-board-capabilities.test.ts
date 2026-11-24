import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceBoards } from './workspace-boards.js';
import { BOARD_CAPABILITY_TTL_MS, WorkspaceBoardCapabilities, validBoardAgentWrite, validBoardCapabilityInput } from './workspace-board-capabilities.js';

function fixture(file = ':memory:') {
  const db = new DatabaseSync(file), boards = new WorkspaceBoards(db);
  let now = 1_000_000;
  const caps = new WorkspaceBoardCapabilities(db, boards, () => now);
  const taskId = randomUUID(), hiddenId = randomUUID();
  boards.save('alice', 'default', { title: 'Private board title', revision: 0, mutationId: randomUUID(), tasks: [
    { id: taskId, title: 'Allowed task', detail: 'private details', status: 'todo', tags: ['private-tag'], priority: 'urgent', dueDate: '2026-12-31' },
    { id: hiddenId, title: 'Hidden title', detail: 'hidden details', status: 'todo' },
  ] });
  const grant = { taskIds: [taskId], fields: ['status'] as ['status'], expiresAt: now + 10_000 };
  const issued = caps.issue('alice', 'default', grant)!;
  assert.ok(issued);
  return { db, boards, caps, taskId, hiddenId, issued, grant, setNow: (value: number) => { now = value; } };
}

test('machine reads only selected tasks/fields and patches without replacing human content', () => {
  const f = fixture();
  try {
    const { caps, issued, taskId, hiddenId, boards } = f;
    assert.deepEqual(caps.read(issued.token), { resourceId: 'default', revision: 1, tasks: [{ id: taskId, title: 'Allowed task', status: 'todo' }] });
    assert.equal(caps.issue('bob', 'default', f.grant), undefined);
    assert.equal(caps.issue('alice', randomUUID(), f.grant), undefined);
    assert.equal(caps.issue('alice', 'default', { ...f.grant, taskIds: [randomUUID()] }), undefined);
    const write = { revision: 1, mutationId: randomUUID(), tasks: [{ id: taskId, status: 'doing' as const }] };
    assert.equal(caps.update(issued.token, { ...write, tasks: [{ id: hiddenId, status: 'done' }] }).status, 'denied');
    assert.equal(caps.update(issued.token, { ...write, tasks: [{ id: taskId, detail: 'forbidden' }] }).status, 'denied');
    assert.equal(caps.update(issued.token, write).status, 'saved');
    assert.deepEqual(boards.get('alice', 'default').tasks[0]?.tags, ['private-tag']);
    assert.equal(boards.get('alice', 'default').tasks[0]?.priority, 'urgent');
    assert.equal(boards.get('alice', 'default').tasks[0]?.dueDate, '2026-12-31');
    assert.deepEqual(boards.get('alice', 'default').tasks.map(t => [t.detail, t.status]), [['private details', 'doing'], ['hidden details', 'todo']]);
    assert.equal(boards.get('alice', 'default').title, 'Private board title');
    assert.equal(caps.update(issued.token, write).status, 'saved');
    assert.equal(boards.get('alice', 'default').revision, 2);
    assert.equal(caps.update(issued.token, { ...write, tasks: [{ id: taskId, status: 'done' }] }).status, 'mutation-reused');
    assert.equal(caps.update(issued.token, { ...write, mutationId: randomUUID() }).status, 'conflict');
    assert.deepEqual(caps.list('bob', 'default'), []);
    assert.deepEqual(caps.events('bob', 'default'), []);
    const audit = JSON.stringify(caps.events('alice', 'default'));
    for (const secret of [issued.token, 'private details', 'Hidden title', 'forbidden']) assert.ok(!audit.includes(secret));
    assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM hub_board_capabilities').all()).includes(issued.token));
    assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM hub_board_agent_receipts').all()).includes(issued.token));
    assert.equal(caps.events('alice', 'default').filter(e => e.event === 'updated').length, 1);
  } finally { f.db.close(); }
});

test('revocation/expiry denies successful replays; cross-owner revoke cannot affect credentials', () => {
  const f = fixture();
  try {
    const write = { revision: 1, mutationId: randomUUID(), tasks: [{ id: f.taskId, status: 'done' as const }] };
    assert.equal(f.caps.update(f.issued.token, write).status, 'saved');
    assert.equal(f.caps.revoke('bob', 'default', f.issued.capability.id), false);
    assert.equal(f.caps.revoke('alice', randomUUID(), f.issued.capability.id), false);
    assert.equal(f.caps.revoke('alice', 'default', f.issued.capability.id), true);
    assert.equal(f.caps.revoke('alice', 'default', f.issued.capability.id), true);
    assert.equal(f.caps.update(f.issued.token, write).status, 'denied');
    assert.equal(f.caps.read(f.issued.token), undefined);
    assert.equal(f.caps.events('alice', 'default').filter(e => e.event === 'revoked').length, 1);
    const fresh = f.caps.issue('alice', 'default', f.grant)!;
    f.setNow(f.grant.expiresAt);
    assert.equal(f.caps.update(fresh.token, write).status, 'denied');
    assert.equal(f.caps.read(fresh.token), undefined);
    assert.equal(f.caps.issue('alice', 'default', f.grant), undefined);
    assert.equal(f.caps.issue('alice', 'default', { ...f.grant, expiresAt: f.grant.expiresAt + BOARD_CAPABILITY_TTL_MS + 1 }), undefined);
  } finally { f.db.close(); }
});

test('audit/receipt failures roll back board mutation and owner revocation together', () => {
  const f = fixture();
  try {
    const write = { revision: 1, mutationId: randomUUID(), tasks: [{ id: f.taskId, status: 'done' as const }] };
    for (const table of ['hub_board_agent_receipts', 'hub_board_agent_audit']) {
      f.db.exec(`CREATE TRIGGER reject_machine_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
      assert.throws(() => f.caps.update(f.issued.token, write), /test failure/);
      assert.equal(f.boards.get('alice', 'default').revision, 1);
      assert.equal((f.db.prepare('SELECT count(*) AS n FROM hub_board_agent_receipts').get() as { n: number }).n, 0);
      assert.equal((f.db.prepare('SELECT count(*) AS n FROM hub_workspace_board_receipts').get() as { n: number }).n, 1);
      f.db.exec('DROP TRIGGER reject_machine_write');
    }
    f.db.exec(`CREATE TRIGGER reject_machine_audit BEFORE INSERT ON hub_board_agent_audit BEGIN SELECT RAISE(ABORT, 'audit failure'); END`);
    assert.throws(() => f.caps.revoke('alice', 'default', f.issued.capability.id), /audit failure/);
    assert.equal(f.caps.authorized(f.issued.token), true);
    assert.throws(() => f.caps.issue('alice', 'default', f.grant), /audit failure/);
    assert.equal(f.caps.list('alice', 'default').length, 1);
  } finally { f.db.close(); }
});

test('restart preserves capability, exact receipt, audit and revocation', () => {
  const root = mkdtempSync(join(tmpdir(), 'board-capability-')), path = join(root, 'test.sqlite'), f = fixture(path);
  let db = f.db;
  try {
    const write = { revision: 1, mutationId: randomUUID(), tasks: [{ id: f.taskId, status: 'done' as const }] };
    const saved = f.caps.update(f.issued.token, write);
    db.close(); db = new DatabaseSync(path);
    const caps = new WorkspaceBoardCapabilities(db, new WorkspaceBoards(db), () => 1_000_000);
    assert.deepEqual(caps.update(f.issued.token, write), saved);
    assert.equal(caps.events('alice', 'default').filter(e => e.event === 'updated').length, 1);
    assert.equal(caps.revoke('alice', 'default', f.issued.capability.id), true);
    db.close(); db = new DatabaseSync(path);
    assert.equal(new WorkspaceBoardCapabilities(db, new WorkspaceBoards(db), () => 1_000_000).update(f.issued.token, write).status, 'denied');
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('strict schemas reject unknown authority fields, duplicate tasks and oversized updates', () => {
  const id = randomUUID(), grant = { taskIds: [id], fields: ['status'], expiresAt: Date.now() + 1000 };
  assert.equal(validBoardCapabilityInput(grant), true);
  for (const value of [null, { ...grant, userId: 'other' }, { ...grant, taskIds: [] }, { ...grant, taskIds: [id, id] },
    { ...grant, fields: [] }, { ...grant, fields: ['status', 'status'] }, { ...grant, fields: ['title'] }, { ...grant, expiresAt: Infinity }]) assert.equal(validBoardCapabilityInput(value), false);
  const body = { revision: 1, mutationId: randomUUID(), tasks: [{ id, status: 'done' }] };
  assert.equal(validBoardAgentWrite(body), true);
  for (const value of [null, { ...body, userId: 'other' }, { ...body, revision: 0 }, { ...body, revision: Number.MAX_SAFE_INTEGER },
    { ...body, tasks: [] }, { ...body, tasks: [body.tasks[0], body.tasks[0]] }, { ...body, tasks: [{ id }] },
    { ...body, tasks: [{ id, title: 'overwrite' }] }, { ...body, tasks: [{ id, status: 'run' }] }, { ...body, tasks: [{ id, detail: 'x'.repeat(4001) }] }]) assert.equal(validBoardAgentWrite(value), false);
});

test('human saves and other capabilities cannot collide with machine mutation IDs', () => {
  const f = fixture();
  try {
    const body = f.boards.get('alice', 'default'), mutationId = randomUUID();
    f.boards.save('alice', 'default', { title: body.title, tasks: body.tasks, revision: 1, mutationId });
    const write = { revision: 2, mutationId, tasks: [{ id: f.taskId, status: 'done' as const }] };
    assert.equal(f.caps.update(f.issued.token, write).status, 'saved');
    const other = f.caps.issue('alice', 'default', f.grant)!;
    assert.equal(f.caps.update(other.token, write).status, 'conflict');
    const latest = f.boards.get('alice', 'default');
    f.boards.save('alice', 'default', { title: latest.title, tasks: latest.tasks.filter(t => t.id !== f.taskId), revision: latest.revision, mutationId: randomUUID() });
    assert.equal(f.caps.update(other.token, { ...write, revision: 4, mutationId: randomUUID() }).status, 'denied');
  } finally { f.db.close(); }
});

test('capability/receipt quotas and audit retention are bounded without reviving old tokens', () => {
  const f = fixture();
  try {
    for (let i = 1; i < 256; i++) assert.ok(f.caps.issue('alice', 'default', f.grant));
    assert.equal(f.caps.issue('alice', 'default', f.grant), undefined);
    const insert = f.db.prepare('INSERT INTO hub_board_agent_receipts VALUES (?, ?, ?, ?)');
    for (let i = 0; i < 1000; i++) insert.run(f.issued.capability.id, randomUUID(), 'synthetic', i + 1);
    const write = { revision: 1, mutationId: randomUUID(), tasks: [{ id: f.taskId, status: 'done' as const }] };
    assert.equal(f.caps.update(f.issued.token, write).status, 'limit');
    assert.equal(f.boards.get('alice', 'default').revision, 1);
    const audit = f.db.prepare('INSERT INTO hub_board_agent_audit (user_id, resource_id, capability_id, event, created_at) VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < 10001; i++) audit.run('alice', 'default', f.issued.capability.id, 'synthetic', 1_000_000);
    f.caps.revoke('alice', 'default', f.issued.capability.id);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM hub_board_agent_audit').get() as { n: number }).n, 10000);
    const page = f.caps.events('alice', 'default');
    assert.equal(page.length, 100);
    const next = f.caps.events('alice', 'default', Number(page.at(-1)!.sequence));
    assert.equal(next.length, 100); assert.ok(Number(next[0]!.sequence) < Number(page.at(-1)!.sequence));
    f.setNow(f.grant.expiresAt + 91 * BOARD_CAPABILITY_TTL_MS);
    assert.ok(f.caps.issue('alice', 'default', { ...f.grant, expiresAt: f.grant.expiresAt + 92 * BOARD_CAPABILITY_TTL_MS }));
    assert.equal(f.caps.list('alice', 'default').length, 1);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM hub_board_agent_receipts').get() as { n: number }).n, 0);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM hub_board_agent_audit').get() as { n: number }).n, 1);
    assert.equal(f.caps.update(f.issued.token, write).status, 'denied');
  } finally { f.db.close(); }
});

test('detail updates enforce total board limits, and semantic retries ignore object/task ordering', () => {
  const f = fixture();
  try {
    const issued = f.caps.issue('alice', 'default', { ...f.grant, taskIds: [f.taskId, f.hiddenId], fields: ['detail', 'status'] })!;
    const write = { revision: 1, mutationId: randomUUID(), tasks: [{ id: f.taskId, detail: 'updated', status: 'doing' as const }, { id: f.hiddenId, detail: 'second' }] };
    const result = f.caps.update(issued.token, write);
    assert.equal(result.status, 'saved');
    assert.deepEqual(f.caps.update(issued.token, { ...write, tasks: [{ detail: 'second', id: f.hiddenId }, { status: 'doing', id: f.taskId, detail: 'updated' }] }), result);
    assert.equal(f.caps.read(issued.token)?.tasks[0]?.detail, 'updated');
    const current = f.boards.get('alice', 'default');
    const extra = Array.from({ length: 64 }, () => ({ id: randomUUID(), title: 't', detail: 'x'.repeat(3990), status: 'todo' as const }));
    assert.equal(f.boards.save('alice', 'default', { title: current.title, tasks: [...current.tasks, ...extra], revision: 2, mutationId: randomUUID() }).status, 'saved');
    assert.equal(f.caps.update(issued.token, { revision: 3, mutationId: randomUUID(), tasks: [{ id: f.taskId, detail: 'x'.repeat(4000) }] }).status, 'invalid');
    assert.equal(f.boards.get('alice', 'default').revision, 3);
  } finally { f.db.close(); }
});
