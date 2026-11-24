import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSessionRevocation, SessionRevocationJournal } from './session-revocation.js';

const reference = { scope: 'a'.repeat(64), sessionKey: '["shared-session-v1","owner","same-session"]', grantId: 'grant', version: 4, userId: 'member' };
const key = 'agentopsdeck.session-revocation.v1';
function fixture() {
  const saved = new Map<string, string>();
  const storage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => { saved.set(k, v); } };
  return { saved, storage, journal: new SessionRevocationJournal(storage) };
}
test('revocation envelopes distinguish pending, remote ACK and no execution lease', () => {
  for (const revocation of [{ state: 'pending', pending: 2, confirmed: 1 }, { state: 'confirmed', pending: 0, confirmed: 1 }, { state: 'confirmed', pending: 0, confirmed: 0 }]) {
    assert.deepEqual(parseSessionRevocation({ revocation }), revocation);
    assert.deepEqual(parseSessionRevocation({ ok: true, revocation }, true), revocation);
  }
});
test('missing, contradictory, coercive and forged ACKs never confirm revocation', () => {
  for (const value of [null, {}, { ok: true }, { revocation: {} },
    { revocation: { state: 'confirmed', pending: 1, confirmed: 0 } },
    { revocation: { state: 'pending', pending: 0, confirmed: 1 } },
    ...['1', -1, 1.5, 10001, Number.MAX_SAFE_INTEGER].map(pending => ({ revocation: { state: 'pending', pending, confirmed: 0 } })),
    { revocation: { state: 'confirmed', pending: 0, confirmed: 1, elapsed: true } }]) {
    assert.throws(() => parseSessionRevocation(value));
  }
  assert.throws(() => parseSessionRevocation({ ok: false, revocation: { state: 'confirmed', pending: 0, confirmed: 0 } }, true));
});
test('refresh retains the exact original account, session, grant and version only', () => {
  const f = fixture(); f.journal.remember(reference);
  const next = new SessionRevocationJournal(f.storage);
  assert.deepEqual(next.list(reference.scope, reference.sessionKey), [reference]);
  assert.deepEqual(next.list('b'.repeat(64), reference.sessionKey), []);
  assert.deepEqual(next.list(reference.scope, 'another-owner-session'), []);
  assert.throws(() => next.remember(reference));
  next.forget({ ...reference, version: 5 }); next.forget({ ...reference, scope: 'b'.repeat(64) });
  assert.deepEqual(next.list(reference.scope, reference.sessionKey), [reference]);
  next.forget(reference); assert.deepEqual(next.list(reference.scope, reference.sessionKey), []);
});
test('full journal never evicts unresolved operations to admit another DELETE', () => {
  const f = fixture();
  for (let i = 0; i < 32; i++) f.journal.remember({ ...reference, grantId: `grant-${i}` });
  const before = f.saved.get(key);
  assert.throws(() => f.journal.remember(reference)); assert.equal(f.saved.get(key), before);
});
test('corrupt journal and failed storage writes fail closed', () => {
  const f = fixture();
  for (const raw of ['{', JSON.stringify({ version: 2, items: [] }), JSON.stringify({ version: 1, items: [reference, reference] }),
    JSON.stringify({ version: 1, items: [{ ...reference, version: 0 }] }), ' '.repeat(65537)]) {
    f.saved.set(key, raw); assert.throws(() => f.journal.remember(reference)); assert.equal(f.saved.get(key), raw);
  }
  const journal = new SessionRevocationJournal({ getItem: () => null, setItem: () => { throw new Error('quota'); } });
  assert.throws(() => journal.remember(reference));
});
