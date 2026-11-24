import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectionControlJournal, connectionControlReceipt } from './connection-control-recovery.js';

function storage() {
  let value: string | null = null;
  return {getItem: (_key: string) => value, setItem: (_key: string, next: string) => {value = next;}};
}
const target = {connectionId: 'node', operation: 'reconcile' as const};
test('control intent survives reload and blocks another effect until original receipt is terminal', () => {
  const saved = storage(), journal = new ConnectionControlJournal(saved), row = journal.begin('owner', target);
  assert.equal(new ConnectionControlJournal(saved).list('owner')[0]?.key, row.key);
  assert.equal(row.state, 'outcome_unknown');
  assert.throws(() => journal.begin('owner', {...target, operation: 'updateCheck'}), /unresolved/);
  assert.throws(() => journal.dismiss(row), /original receipt/);
  journal.settle(row, {key: row.key, operation: row.operation, state: 'accepted', status: 202});
  assert.equal(journal.list('owner')[0]?.state, 'accepted');
  journal.begin('owner', {...target, operation: 'updateCheck'});
  journal.dismiss(row); assert.equal(journal.list('owner').length, 1);
  assert.deepEqual(Object.keys(journal.list('owner')[0]!).sort(), ['connectionId','createdAt','key','operation','scope','state']);
});
test('receipt recovery cannot accept mismatched, malformed or contradictory facts', () => {
  const journal = new ConnectionControlJournal(storage()), row = journal.begin('owner', target);
  const accepted = {key: row.key, operation: row.operation, state: 'accepted', status: 200};
  for (const extra of [{key: 'other'}, {operation: 'updateCheck'}, {state: 'outcome_unknown'}, {status: 503}, {status: 302}, {state: 'rejected'}, {token: 'private'}]) {
    assert.throws(() => connectionControlReceipt({...accepted, ...extra}, row), /unavailable/);
  }
  journal.settle(row, accepted);
  assert.throws(() => journal.settle(row, {...accepted, state: 'rejected', status: 403}), /Conflicting/);
  assert.equal(journal.list('owner')[0]?.state, 'accepted');
});
test('control journal is scoped, bounded, fail-closed for damaged or unwritable storage', () => {
  const saved = storage(), journal = new ConnectionControlJournal(saved);
  journal.begin('owner', target); journal.begin('other', target);
  assert.equal(journal.list('owner').length, 1); assert.equal(journal.list('unknown').length, 0);
  for (const raw of ['{', '{}', '[{}]', JSON.stringify(Array(129).fill({})), ' '.repeat(128 * 1024 + 1)]) {
    const bad = new ConnectionControlJournal({getItem: () => raw, setItem: () => assert.fail('must not replace damaged records')});
    assert.throws(() => bad.begin('owner', target));
  }
  const unavailable = new ConnectionControlJournal({getItem: () => null, setItem: () => {throw Error('quota');}});
  assert.throws(() => unavailable.begin('owner', target), /quota/);
  const duplicate = journal.list('owner')[0]!;
  saved.setItem('', JSON.stringify([duplicate, duplicate]));
  assert.throws(() => journal.list('owner'), /Duplicate/);
});
test('journal capacity never drops unresolved records to allow a new effect', () => {
  const journal = new ConnectionControlJournal(storage());
  for (let index = 0; index < 128; index++) journal.begin('owner', {...target, connectionId: `node-${index}`});
  assert.throws(() => journal.begin('owner', {...target, connectionId: 'extra'}), /full/);
  assert.equal(journal.list('owner').length, 128);
});
