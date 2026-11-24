import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createApplicationTransactionClient, createApplicationTransactionLink, serveApplicationTransactions,
  validApplicationTransactionEvidence, type ApplicationTransactionBinding } from './application-transaction-gate.js';
import { HubMemberOwnerScheduler } from '../hub/member-owner-scheduler.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
const binding: ApplicationTransactionBinding = { runtime: 'ghcp', resource: 'ghcp:original', commandKey: 'message',
  payloadDigest: 'a'.repeat(64), phase: 'claim', evidence: { cookie: 'agentopsdeck_session=original' } };
function fixture(authorize: () => boolean = () => true) {
  const link = createApplicationTransactionLink(), scheduler = new HubMemberOwnerScheduler();
  serveApplicationTransactions(link.auth, { schedule: work => scheduler.schedule('barrier', work), authorize, available: () => true, diagnostics: quiet });
  const client = createApplicationTransactionClient(link.connector.data);
  link.auth.data.ref(); link.connector.data.ref();
  // This fixture is the peer supervisor: after a data-port fault it must keep
  // the loop alive until the original peer's exit acknowledgement arrives.
  link.auth.lifetime.ref();
  return { link, scheduler, client, close() { link.connector.confirmExit(); link.closeUnused(); } };
}

test('fixed raw evidence rejects principals, cached grants and control characters', () => {
  assert.equal(validApplicationTransactionEvidence({}), true);
  assert.equal(validApplicationTransactionEvidence({ cookie: 'original' }), true);
  assert.equal(validApplicationTransactionEvidence({ cookie: 'x'.repeat(65_536) }), true);
  for (const value of [{ authorized: true }, { actorId: 'local:daily' }, { cookie: 'bad\r\nvalue' }, { accessKey: 'x'.repeat(65_537) },
    { cookie: 'x'.repeat(32_769), authorization: 'x'.repeat(32_768) }]) {
    assert.equal(validApplicationTransactionEvidence(value), false);
  }
});

test('Auth exit retains its original file lease until the actual original Connector exits', () => {
  const link = createApplicationTransactionLink(); let released = 0;
  try {
    link.connector.begin();
    link.auth.retire(() => { released++; });
    assert.equal(released, 0);
    link.closeUnused(); // Closing ports is never physical peer exit.
    assert.equal(released, 0);
    assert.throws(() => link.connector.begin(), /application_transaction_unavailable/);
    link.connector.confirmExit(); assert.equal(released, 1);
    link.connector.confirmExit(); assert.equal(released, 1);
  } finally { link.closeUnused(); }
});

test('never-started or already-exited peer cannot retain an Auth lease or restart after Auth exit', () => {
  for (const started of [false, true]) {
    const link = createApplicationTransactionLink(); let released = false;
    try {
      if (started) { link.connector.begin(); link.connector.confirmExit(); }
      link.auth.retire(() => { released = true; });
      assert.equal(released, true);
      assert.throws(() => link.connector.begin(), /application_transaction_unavailable/);
    } finally { link.closeUnused(); }
  }
});

test('current Auth is rechecked after prior work; refusal never invokes SQL writer', async () => {
  let allowed = true, checks = 0, writes = 0;
  const f = fixture(() => { checks++; return allowed; }), before = deferred();
  try {
    const revoke = f.scheduler.schedule('auth', async () => { await before.promise; allowed = false; });
    const original = f.client.run(binding, () => { writes++; return 'invalid'; });
    const refused = assert.rejects(original, /application_transaction_unavailable/);
    await tick(); assert.equal(writes, 0); assert.equal(checks, 0);
    before.release(); await revoke; await refused;
    assert.equal(writes, 0); assert.equal(checks, 1);
    allowed = true;
    assert.equal(await f.client.run(binding, () => ++writes), 1);
  } finally { before.release(); f.close(); }
});

for (const throws of [false, true]) test(`original synchronous writer ${throws ? 'rollback' : 'commit'} settles before later Auth/Hub work`, async () => {
  const f = fixture(), events: string[] = []; let revoke: Promise<void> | undefined;
  try {
    const work = f.client.run(binding, () => {
      events.push('sql');
      revoke = f.scheduler.schedule('auth', async () => { events.push('revoke'); });
      if (throws) throw Error('original-rollback');
      return 42;
    });
    if (throws) await assert.rejects(work, /original-rollback/); else assert.equal(await work, 42);
    await revoke;
    assert.deepEqual(events, ['sql', 'revoke']);
    assert.equal(await f.client.run({ ...binding, phase: 'queue' }, () => 43), 43);
  } finally { f.close(); }
});

for (const fault of ['data-close', 'invalid-settlement', 'control-close'] as const) test(`${fault} is not SQL settlement; actual original peer exit releases the reserved control lane`, async () => {
  const link = createApplicationTransactionLink(), scheduler = new HubMemberOwnerScheduler();
  serveApplicationTransactions(link.auth, { schedule: work => scheduler.schedule('barrier', work), authorize: () => true, available: () => true, diagnostics: quiet });
  link.auth.data.ref(); link.connector.data.ref(); link.auth.lifetime.ref();
  let updated = false;
  try {
    const grant = once(link.connector.data, 'message');
    link.connector.data.postMessage({ kind: 'acquire', id: 1, binding });
    assert.deepEqual((await grant)[0], { kind: 'grant', id: 1, allowed: true });
    const update = scheduler.schedule('auth', async () => { updated = true; });
    if (fault === 'data-close') link.connector.data.close();
    else if (fault === 'invalid-settlement') link.connector.data.postMessage({ kind: 'settled', id: 2 });
    else link.auth.lifetime.close();
    await tick(); await tick(); assert.equal(updated, false);
    if (fault === 'control-close') {
      // A broken supervisor control port must NOT claim the peer has exited.
      // This isolated fixture cannot deliver further evidence: retain the
      // unresolved barrier, just as production must retain its reservation.
      link.connector.confirmExit(); await tick(); assert.equal(updated, false);
    } else {
      link.connector.confirmExit(); await update; assert.equal(updated, true);
    }
  } finally { link.closeUnused(); }
});

test('accidentally asynchronous writer poisons the lane without releasing the original Auth fence', async () => {
  const f = fixture(), physical = deferred(); let updated = false;
  try {
    await assert.rejects(f.client.run(binding, () => physical.promise), /application_transaction_unavailable/);
    const update = f.scheduler.schedule('auth', async () => { updated = true; });
    physical.release(); await tick(); assert.equal(updated, false);
    await assert.rejects(f.client.run(binding, () => 1));
    f.link.connector.confirmExit(); await update; assert.equal(updated, true);
  } finally { physical.release(); f.close(); }
});

test('transport capacity is single-flight; rejected extra acquire cannot replace the original waiter', async () => {
  const f = fixture(), held = deferred();
  try {
    const prior = f.scheduler.schedule('auth', async () => { await held.promise; });
    const original = f.client.run(binding, () => 1);
    await assert.rejects(f.client.run(binding, () => 2));
    held.release(); await prior;
    assert.equal(await original, 1);
  } finally { held.release(); f.close(); }
});
