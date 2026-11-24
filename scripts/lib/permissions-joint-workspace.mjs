import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Run only against the caller's disposable Hub and users. Session collaboration
// must never widen private workspace or machine-capability authority.
export async function verifyJointWorkspace({ api, alice, bob }) {
  const cardPath = '/api/hub/v1/workspace/cards/' + randomUUID();
  const boardPath = '/api/hub/v1/workspace/boards/' + randomUUID();
  const taskId = randomUUID(), hiddenId = randomUUID();
  const card = { title: 'Private Alice metric', value: '42', detail: 'Alice only', tone: 'green', progress: 42,
    revision: 0, mutationId: randomUUID() };
  assert.equal((await api(alice, cardPath, 'PUT', card)).title, card.title);
  await api(bob, cardPath, 'GET', undefined, 404);
  assert.ok(!(await api(bob, '/api/hub/v1/workspace/cards')).cards.some(item => item.title === card.title));
  const bobCard = { ...card, title: 'Private Bob metric', mutationId: randomUUID() };
  assert.equal((await api(bob, cardPath, 'PUT', bobCard)).title, bobCard.title);
  assert.equal((await api(alice, cardPath)).title, card.title, 'Same resource ID is owner scoped');

  const board = { title: 'Alice private board', revision: 0, mutationId: randomUUID(), tasks: [
    { id: taskId, title: 'Delegated task', detail: 'Private detail', status: 'todo' },
    { id: hiddenId, title: 'Hidden task', detail: 'Not delegated', status: 'todo' },
  ] };
  const document = await api(alice, boardPath, 'PUT', board);
  const bobBoard = await api(bob, boardPath);
  assert.deepEqual(bobBoard.tasks, []); assert.equal(bobBoard.revision, 0);
  assert.deepEqual((await api(bob, boardPath + '/capabilities')).capabilities, []);
  assert.deepEqual((await api(bob, boardPath + '/audit')).events, []);
  const issued = await api(alice, boardPath + '/capabilities', 'POST', {
    taskIds: [taskId], fields: ['status'], expiresAt: Date.now() + 600_000,
  }, 201);
  const machine = { token: issued.token }, machinePath = '/api/workspace-agent/v1/board';
  const view = await api(machine, machinePath);
  assert.deepEqual(view.tasks, [{ id: taskId, title: 'Delegated task', status: 'todo' }]);
  assert.equal(view.revision, document.revision);
  for (const path of ['/api/hub/v1/me', cardPath, boardPath, '/api/hub/v1/workspace/preferences']) {
    await api(machine, path, 'GET', undefined, 401);
  }
  await api(bob, boardPath + '/capabilities/' + issued.capability.id, 'DELETE', undefined, 404);
  const write = { revision: view.revision, mutationId: randomUUID(), tasks: [{ id: taskId, status: 'doing' }] };
  const receipt = await api(machine, machinePath, 'POST', write);
  assert.equal(receipt.revision, view.revision + 1);
  assert.deepEqual(await api(machine, machinePath, 'POST', write), receipt, 'Original machine retry receipt');
  await api(machine, machinePath, 'POST', { revision: receipt.revision, mutationId: randomUUID(),
    tasks: [{ id: hiddenId, status: 'done' }] }, 403);
  await api(machine, machinePath, 'POST', { revision: receipt.revision, mutationId: randomUUID(),
    tasks: [{ id: taskId, detail: 'Not granted' }] }, 403);
  await api(alice, boardPath + '/capabilities/' + issued.capability.id, 'DELETE');
  await api(machine, machinePath, 'GET', undefined, 401);
  await api(machine, machinePath, 'POST', write, 401);
  assert.ok((await api(alice, boardPath + '/audit')).events.length >= 2);
  assert.deepEqual((await api(bob, boardPath + '/audit')).events, []);

  const preferences = '/api/hub/v1/workspace/preferences';
  const before = await api(alice, preferences);
  await api(alice, preferences, 'PUT', { revision: before.revision,
    groups: [{ id: 'alice-private', name: 'Alice private group', collapsed: true }], sessions: {} });
  assert.ok(!(await api(bob, preferences)).groups.some(group => group.id === 'alice-private'));
  return {
    async afterRestart(recoveredBob = bob) {
      assert.equal((await api(alice, cardPath)).title, card.title);
      assert.equal((await api(recoveredBob, cardPath)).title, bobCard.title);
      const empty = await api(recoveredBob, boardPath);
      assert.deepEqual(empty.tasks, []); assert.equal(empty.revision, 0);
      await api(machine, machinePath, 'GET', undefined, 401);
      assert.equal((await api(alice, boardPath)).tasks.find(task => task.id === taskId).status, 'doing');
    },
  };
}
