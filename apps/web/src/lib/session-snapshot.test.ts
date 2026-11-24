import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionSnapshotGate, invalidatedSessionNodes, type SessionListSnapshot } from './session-snapshot.js';

const cursor = (seq: number, epoch = 1) => `ce1_00000000-0000-4000-8000-${String(epoch).padStart(12, '0')}:${seq}`;
function state(a: number, b: number, viewKey = 'default'): SessionListSnapshot {
  return { updatedAt: 1, revision: `r:${a}:${b}`, viewKey,
    sourceStates: ['a', 'b'].map((connectionId, index) => ({ connectionId, authority: 1, state: 'ready',
      cursor: cursor(index ? b : a), hiddenCount: index ? b : a, archivedCount: 0, pinnedCount: 0 })),
    groups: [{ agentId: 'same-agent', sessions: ['a', 'b'].map((envConnectionId, index) => ({
      sessionKey: `${envConnectionId}:session`, envConnectionId, agentId: 'same-agent', title: String(index ? b : a), status: 'idle', lastActiveAt: 1,
    })) }],
  };
}
function titles(value: SessionListSnapshot | undefined) { return value?.groups.flatMap(group => group.sessions.map(session => `${session.sessionKey.split(':')[0]}:${session.title}`)); }

test('detail revocation requires directory proof, not a same-authority transport failure', () => {
  const previous = state(1, 1).sourceStates!;
  for (const failure of ['denied', 'disabled', 'changed'] as const) {
    const next = state(2, 2).sourceStates!;
    next[0]!.state = failure;
    assert.deepEqual([...invalidatedSessionNodes(previous, next)], ['a']);
  }
  const unavailable = state(2, 2).sourceStates!;
  unavailable[0]!.state = 'unavailable';
  assert.equal(invalidatedSessionNodes(previous, unavailable).size, 0);
  unavailable[0]!.authority++;
  assert.deepEqual([...invalidatedSessionNodes(previous, unavailable)], ['a']);
  const changed = state(2, 2).sourceStates!;
  changed[0]!.authority++;
  assert.deepEqual([...invalidatedSessionNodes(previous, changed)], ['a']);
  assert.deepEqual([...invalidatedSessionNodes(previous, previous.slice(1))], ['a']);
  assert.deepEqual([...invalidatedSessionNodes(undefined, previous.slice(1), 'a:session')], ['a']);
  assert.equal(invalidatedSessionNodes(previous, undefined, 'a:session').size, 0);
});

test('list applies sources independently and sums counts from accepted node slices', () => {
  const gate = createSessionSnapshotGate();
  gate.begin().accept(state(10, 10));
  const next = gate.begin().accept(state(9, 11))!;
  assert.deepEqual(titles(next), ['a:10', 'b:11']);
  assert.equal(next.hiddenCount, 21);
  assert.equal(next.revision, undefined);
  assert.deepEqual(next.sources, [{ connectionId: 'a', cursor: cursor(10) }, { connectionId: 'b', cursor: cursor(11) }]);
  assert.deepEqual(titles(gate.begin().accept(state(12, 12))), ['a:12', 'b:12']);
});

test('list request fence rejects older aggregate across account changes and reset', () => {
  let account = 'one';
  const gate = createSessionSnapshotGate(() => account);
  const old = gate.begin(), current = gate.begin();
  current.accept(state(10, 10));
  assert.equal(old.accept(state(20, 20)), undefined);
  const priorAccount = gate.begin();
  account = 'two';
  assert.equal(priorAccount.accept(state(30, 30)), undefined);
  assert.deepEqual(titles(gate.begin().accept(state(1, 1))), ['a:1', 'b:1']);
  const preReset = gate.begin();
  gate.invalidate('a');
  assert.equal(preReset.accept(state(40, 40)), undefined);
  assert.deepEqual(titles(gate.begin().accept(state(0, 0))), ['a:0', 'b:1']);
});

for (const failure of ['denied', 'changed', 'disabled'] as const) {
  test(`list discards ${failure} node data and forgets its old watermark`, () => {
    const gate = createSessionSnapshotGate();
    gate.begin().accept(state(10, 10));
    const next = state(1, 11);
    next.sourceStates![0] = { ...next.sourceStates![0]!, state: failure, hiddenCount: 0 };
    assert.deepEqual(titles(gate.begin().accept(next)), ['b:11']);
    assert.deepEqual(titles(gate.begin().accept(state(1, 12))), ['a:1', 'b:12']);
  });
}

test('transient node failures retain only same-authority display rows, never current proof', () => {
  const gate = createSessionSnapshotGate();
  gate.begin().accept(state(10, 10));
  for (let i = 11; i < 14; i++) {
    const failed = state(0, i);
    failed.sourceStates![0] = { ...failed.sourceStates![0]!, state: 'unavailable', hiddenCount: 0 };
    const retained = gate.begin().accept(failed)!;
    assert.deepEqual(titles(retained), ['a:10', `b:${i}`]);
    assert.equal(retained.sourceStates![0]!.state, 'unavailable');
    assert.equal(retained.sourceStates![0]!.cursor, undefined);
    assert.deepEqual(retained.sources, [{ connectionId: 'b', cursor: cursor(i) }]);
    assert.equal(retained.hiddenCount, 10 + i);
    assert.equal(retained.revision, undefined);
  }
  assert.deepEqual(titles(gate.begin().accept(state(9, 14))), ['a:10', 'b:14']);
  assert.deepEqual(titles(gate.begin().accept(state(15, 15))), ['a:15', 'b:15']);
});

test('unavailable cannot recover rows across authority, view, scope, removal or explicit denial', () => {
  for (const boundary of ['authority', 'view', 'scope', 'removal', 'denied', 'disabled', 'changed', 'invalid'] as const) {
    let account = 'one';
    const gate = createSessionSnapshotGate(() => account);
    gate.begin().accept(state(10, 10));
    if (boundary === 'scope') account = 'two';
    if (boundary === 'removal') {
      const removed = state(0, 11); removed.sourceStates!.shift();
      gate.begin().accept(removed);
    } else if (['denied', 'disabled', 'changed'].includes(boundary)) {
      const revoked = state(0, 11);
      revoked.sourceStates![0]!.state = boundary as 'denied' | 'disabled' | 'changed';
      gate.begin().accept(revoked);
    }
    const failed = state(0, 12, boundary === 'view' ? 'other-view' : undefined);
    failed.sourceStates![0]!.state = 'unavailable';
    if (boundary === 'authority') failed.sourceStates![0]!.authority++;
    if (boundary === 'invalid') failed.sourceStates![0]!.authority = NaN;
    assert.deepEqual(titles(gate.begin().accept(failed)), ['b:12'], boundary);
  }
});

test('directory removal prunes node, authority or Hub preference changes prohibit old row retention', () => {
  const gate = createSessionSnapshotGate();
  gate.begin().accept(state(10, 10));
  const removed = state(1, 11);
  removed.sourceStates!.shift();
  assert.deepEqual(titles(gate.begin().accept(removed)), ['b:11']);
  assert.deepEqual(titles(gate.begin().accept(state(1, 12))), ['a:1', 'b:12']);
  const changed = state(0, 13);
  changed.sourceStates![0]!.authority++;
  assert.deepEqual(titles(gate.begin().accept(changed)), ['a:0', 'b:13']);
  assert.deepEqual(titles(gate.begin().accept(state(0, 0, 'hide-or-archive-changed'))), ['a:0', 'b:0']);
});

test('node watermarks cover events independently and bounded catchup cannot self-spin', () => {
  const gate = createSessionSnapshotGate();
  let catchups = 0;
  const unsubscribe = gate.subscribe(() => { catchups++; });
  gate.begin().accept(state(10, 10));
  assert.equal(gate.observe('a', cursor(10)), false);
  assert.equal(gate.observe('a', cursor(11)), true);
  assert.equal(gate.observe('a', cursor(11)), false);
  assert.equal(gate.observe('b', cursor(11)), true);
  for (let i = 12; i < 524; i++) gate.observe('a', cursor(i));
  gate.begin().accept(state(11, 11));
  assert.equal(catchups, 1);
  for (let i = 0; i < 100; i++) gate.begin().accept(state(11, 11));
  assert.equal(catchups, 1);
  gate.begin().accept(state(524, 12));
  assert.equal(gate.observe('a', cursor(523)), false);
  unsubscribe();
  gate.observe('a', cursor(525));
  gate.begin().accept(state(524, 12));
  assert.equal(catchups, 1);
});

test('legacy snapshots work initially but cannot silently remove negotiated metadata', () => {
  const gate = createSessionSnapshotGate();
  const legacy = state(1, 1);
  delete legacy.sourceStates; delete legacy.viewKey;
  assert.deepEqual(titles(gate.begin().accept(legacy)), ['a:1', 'b:1']);
  gate.begin().accept(state(10, 10));
  assert.deepEqual(titles(gate.begin().accept(legacy)), []);
  assert.deepEqual(titles(gate.begin().accept(legacy)), []);
  gate.invalidate();
  assert.deepEqual(titles(gate.begin().accept(legacy)), ['a:1', 'b:1']);
});

test('same-authority missing or malformed cursor cannot roll back established source; new epoch may start at zero', () => {
  const gate = createSessionSnapshotGate();
  gate.begin().accept(state(10, 10));
  for (const bad of [undefined, 'invalid', cursor(-1)]) {
    const next = state(1, 11);
    if (bad === undefined) delete next.sourceStates![0]!.cursor;
    else next.sourceStates![0]!.cursor = bad;
    assert.deepEqual(titles(gate.begin().accept(next)), ['a:10', 'b:11']);
  }
  const next = state(0, 12);
  next.sourceStates![0]!.cursor = cursor(0, 2);
  assert.deepEqual(titles(gate.begin().accept(next)), ['a:0', 'b:12']);
});
