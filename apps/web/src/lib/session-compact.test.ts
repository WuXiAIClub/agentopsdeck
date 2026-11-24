import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommandReceipt } from '@agentopsdeck/shared';
import { CommandJournal, CommandNotSubmittedError, CompactOutcomeUnknownError, compactWithJournal, recoverSavedCommand } from './command-recovery.js';

const scope = 'a'.repeat(64), session = 'node:session';
const accepted = (key: string): CommandReceipt => ({ id: key, key, state: 'accepted', createdAt: 1, updatedAt: 2,
  result: { status: 200, body: { ok: true, status: 'compacting', runId: '12345678-1234-1234-1234-123456789012' } } });
function storage() { const values = new Map<string, string>(); return {
  getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
}; }

test('compact response loss recovers original admission without another POST or message receipt', async () => {
  const saved = storage(), journal = new CommandJournal(saved); let posts = 0, reads = 0;
  const result = await compactWithJournal(journal, scope, session, 'original', async () => {
    posts++; assert.equal(journal.list(scope, session, 'all')[0]?.compact, true);
    assert.equal(journal.list(scope, session).length, 0);
    throw new Error('connection lost');
  }, async () => { reads++; return accepted('original'); });
  assert.equal(result.status, 'compacting'); assert.equal(posts, 1); assert.equal(reads, 1);
  assert.deepEqual(new CommandJournal(saved).list(scope, session, 'all'), []);
});

test('unknown compact survives refresh, prevents resubmission, and recovers by GET only', async () => {
  const saved = storage(), journal = new CommandJournal(saved); let posts = 0;
  await assert.rejects(compactWithJournal(journal, scope, session, 'original', async () => {
    posts++; throw new Error('lost');
  }, async () => { throw new Error('offline'); }), CompactOutcomeUnknownError);
  const reopened = new CommandJournal(saved), row = reopened.list(scope, session, 'all')[0]!;
  assert.deepEqual(Object.keys(row).sort(), ['compact', 'createdAt', 'key', 'scope', 'sessionKey', 'state']);
  assert.equal(reopened.list('b'.repeat(64), session, 'all').length, 0);
  await assert.rejects(compactWithJournal(reopened, scope, session, 'new', async () => {
    posts++; assert.fail();
  }, async () => assert.fail()), CommandNotSubmittedError);
  assert.equal(await recoverSavedCommand(reopened, row, async () => accepted('original')), 'accepted');
  assert.equal(posts, 1);
});

test('compact rejects unrelated or malformed completion claims and never treats ordinary message ACK as compact', async () => {
  for (const receipt of [accepted('other'), { ...accepted('original'), result: { status: 200, body: { ok: true, status: 'sent' } } },
    { ...accepted('original'), result: { status: 200, body: { ok: true, status: 'compacting', runId: 'other' } } }]) {
    const journal = new CommandJournal(storage());
    await assert.rejects(compactWithJournal(journal, scope, session, 'original', async () => { throw new Error('lost'); },
      async () => receipt), CompactOutcomeUnknownError);
    await assert.rejects(recoverSavedCommand(journal, journal.list(scope, session, 'all')[0]!, async () => receipt));
  }
});

test('failed local recovery persistence prevents compact POST', async () => {
  const journal = new CommandJournal({ getItem: () => null, setItem: () => { throw new Error('quota'); } });
  await assert.rejects(compactWithJournal(journal, scope, session, 'original', async () => assert.fail(), async () => assert.fail()), CommandNotSubmittedError);
});
