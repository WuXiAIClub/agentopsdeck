import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { InteractionAnswer, InteractionKind, InteractionRequest, InteractionScope } from '@agentopsdeck/shared';
import { InteractionStore } from './interaction-store.js';
import { continuationFingerprint, type InteractionContinuation } from './interaction-continuation.js';
import { interactionGoalEvidence } from '../codex/interaction-goal.js';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';
import { observedTransaction } from '../storage/observed-transaction.js';

for (const operation of ['create', 'mode-interactive', 'mode-automatic', 'retire'] as const) {
  test(`interaction ${operation} async hook preserves original facts and fences late SQL`, async () => {
    const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
    db.exec('CREATE TABLE late_effect(value INTEGER)'); const insert = db.prepare('INSERT INTO late_effect VALUES(1)');
    let release!: () => void, late: Promise<void> | undefined, armed = false, calls = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    const hook = () => { if (!armed) return; calls++; return late = (async () => { await held; insert.run(); })(); };
    const store = new InteractionStore(db, 2048, hook, hook);
    try {
      if (operation === 'retire') seed(store);
      if (operation === 'mode-automatic') store.setMode(scope, 'interactive');
      const facts = raw.prepare('SELECT * FROM agent_interactions').all();
      const modes = raw.prepare('SELECT * FROM agent_interaction_modes').all();
      const audit = raw.prepare('SELECT * FROM agent_interaction_audit').all(); armed = true;
      assert.throws(() => operation === 'create' ? seed(store)
        : operation === 'retire' ? store.retireRun(scope, 150)
        : store.setMode(scope, operation === 'mode-interactive' ? 'interactive' : 'automatic'), /must be synchronous/);
      assert.equal(calls, 1); assert.equal(raw.isTransaction, false);
      assert.deepEqual(raw.prepare('SELECT * FROM agent_interactions').all(), facts);
      assert.deepEqual(raw.prepare('SELECT * FROM agent_interaction_modes').all(), modes);
      assert.deepEqual(raw.prepare('SELECT * FROM agent_interaction_audit').all(), audit);
      assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
      const rejected = assert.rejects(late!, StorageConnectionUnavailable); release(); await rejected;
      assert.deepEqual(raw.prepare('SELECT * FROM late_effect').all(), []);
    } finally { release(); if (late) await late.catch(() => {}); db.close(); }
  });
}

const scope = { ownerId: 'o', nodeId: 'n', sessionKey: 'codex:s', runId: 'run' };
const capabilities = { version: 1, kinds: ['approval', 'text', 'single-select', 'multi-select'], modes: ['automatic', 'interactive'] };
const continuation: InteractionContinuation = { connectionId: 'connection', goal: { status: 'active', version: 'goal-generation-1' } };
const request = (patch: Partial<InteractionRequest> = {}): InteractionRequest => ({ ...scope, version: 1,
  requestId: 'r', kind: 'text', prompt: 'Private question', createdAt: 100, expiresAt: 200, ...patch });
const answer = () => ({ scope, requestId: 'r', responseId: 'response', expectedRevision: 1,
  answer: { kind: 'text', text: 'Private answer' }, permissionAllowed: true, continuation, now: 120 });
const claim = () => ({ scope, requestId: 'r', expectedRevision: 2, continuation, permissionAllowed: true, now: 130 });
const conflict = (fn: () => unknown, code: string) => assert.throws(fn, (e: any) => e.code === code);

test('active to blocked preserves live goal identity, not changed goal or limits', () => {
  assert.equal(continuationFingerprint(continuation), continuationFingerprint({ ...continuation, goal: { ...continuation.goal, status: 'blocked' } }));
  assert.notEqual(continuationFingerprint(continuation), continuationFingerprint({ ...continuation, goal: { ...continuation.goal, version: 'replaced' } }));
  conflict(() => continuationFingerprint({ ...continuation, goal: { ...continuation.goal, status: 'paused' } }), 'continuation');
});

test('terminal retention recycles capacity only after seven days; unresolved and audit are kept', t => {
  const { store } = fixture(t, 2); seed(store);
  store.create(request({ requestId: 'closed' }), capabilities, scope, continuation, 100);
  store.closeRequest(scope, 'closed', 'stopped', 120);
  const now = 8 * 24 * 60 * 60_000;
  store.create(request({ requestId: 'fresh', createdAt: now, expiresAt: now + 100 }), capabilities, scope, continuation, now);
  assert.ok(store.get(scope, 'r'), 'even old expired unresolved records are not silently evicted');
  assert.equal(store.get(scope, 'closed'), undefined);
  assert.equal(store.auditTrail(scope, 'closed').length, 0);
  assert.equal(store.auditTrail(scope, 'r').length, 1);
});

test('native completion retires only original run without confirming uncertain delivery', t => {
  const { store } = fixture(t); seed(store); store.answer(answer()); store.claim(claim());
  store.closeRun(scope, 'disconnected', 140);
  assert.equal(store.hasUnresolvedSession(scope), true);
  assert.equal(store.retireRun({ ...scope, runId: 'other' }, 150), 0);
  assert.equal(store.hasUnresolvedSession(scope), true);
  assert.equal(store.retireRun(scope, 150), 1);
  assert.equal(store.hasUnresolvedSession(scope), false);
  assert.equal(store.get(scope, 'r')?.delivery, 'unknown');
  assert.equal(store.get(scope, 'r')?.retiredAt, 150);
  assert.equal(store.retireRun(scope, 151), 0);
  assert.equal(store.answer({ ...answer(), now: 160 }).delivery, 'unknown', 'receipt only; never requeued');
  assert.equal(store.auditTrail(scope, 'r').at(-1)?.event, 'native-run-ended');
});

test('snapshot prioritizes old pending question over recent terminal records', t => {
  const { store } = fixture(t); seed(store);
  for (let i = 0; i < 80; i++) {
    const id = `closed-${i}`;
    store.create(request({ requestId: id }), capabilities, scope, continuation, 100);
    store.closeRequest(scope, id, 'stopped', 120);
  }
  assert.equal(store.list(scope).length, 64);
  assert.equal(store.list(scope)[0]?.state.request.requestId, 'r');
});
function fixture(t: test.TestContext, max = 2048) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  return { db, store: new InteractionStore(db, max) };
}
function seed(store: InteractionStore, proof = continuation) { return store.create(request(), capabilities, scope, proof, 100); }

test('retirement savepoint belongs only to an observed owner and cannot commit its outer transaction', t => {
  const { db, store } = fixture(t); seed(store);
  const fact = store.get(scope, 'r'), audit = store.auditTrail(scope, 'r');
  db.exec('BEGIN');
  try { assert.throws(() => store.retireRun(scope, 150), /owning database boundary/); }
  finally { db.exec('ROLLBACK'); }
  assert.throws(() => observedTransaction(db, 'connector-maintenance-change', () => {
    assert.equal(store.retireRun(scope, 150), 1);
    assert.equal(db.isTransaction, true, 'inner RELEASE cannot commit original owner');
    throw Error('original authority revoked');
  }), /authority revoked/);
  assert.equal(db.isTransaction, false);
  assert.deepEqual(store.get(scope, 'r'), fact);
  assert.deepEqual(store.auditTrail(scope, 'r'), audit);
});

test('durable acceptance, exclusive claim, native ACK and bounded content-free audit', t => {
  const { store } = fixture(t);
  seed(store); assert.equal(store.hasUnresolved(scope), true);
  const accepted = store.answer(answer());
  assert.equal(accepted.delivery, 'queued'); assert.equal(accepted.revision, 2);
  assert.equal(store.hasUnresolved(scope), true, 'answer acceptance is not native delivery');
  const claimed = store.claim(claim())!;
  assert.equal(claimed.delivery, 'claimed'); assert.ok(claimed.claimId);
  assert.equal(store.claim(claim()), undefined, 'claim never hands out a second payload');
  const ack = store.settle(scope, 'r', claimed.claimId!, 'confirmed', 140);
  assert.equal(store.hasUnresolved(scope), false);
  assert.deepEqual(store.settle(scope, 'r', claimed.claimId!, 'confirmed', 141), ack);
  assert.equal(store.auditTrail(scope, 'r').length, 4);
  assert.equal(JSON.stringify(store.auditTrail(scope, 'r')).includes('Private'), false);
  assert.equal(store.claim({ ...claim(), now: 145 }), undefined);
  assert.equal(ack.state.status, 'answered', 'ACK is not tool execution success or goal completion');
});

test('same request notification is idempotent even with reordered fields; changed body or continuation is rejected', t => {
  const { store } = fixture(t); const first = seed(store);
  assert.deepEqual(store.create(Object.fromEntries(Object.entries(request()).reverse()), capabilities, scope, continuation, 101), first);
  conflict(() => store.create(request({ prompt: 'different' }), capabilities, scope, continuation, 101), 'continuation');
  conflict(() => store.create(request(), capabilities, scope, { ...continuation, connectionId: 'other' }, 101), 'continuation');
  assert.equal(store.auditTrail(scope, 'r').length, 1);
});

test('same answer retry returns receipt but does not requeue after goal or connection changes', t => {
  const { store } = fixture(t); seed(store); const accepted = store.answer(answer());
  assert.deepEqual(store.answer({ ...answer(), continuation: { ...continuation, connectionId: 'new' } }), accepted);
  conflict(() => store.answer({ ...answer(), permissionAllowed: false }), 'permission');
  conflict(() => store.answer({ ...answer(), responseId: 'competitor' }), 'answered');
  conflict(() => store.answer({ ...answer(), answer: { kind: 'text', text: 'Changed' } }), 'answered');
  assert.equal(store.auditTrail(scope, 'r').length, 2);
});

test('stale CAS and authorization do not mutate the record', t => {
  const { store } = fixture(t); const before = seed(store);
  conflict(() => store.answer({ ...answer(), expectedRevision: 0 }), 'revision');
  conflict(() => store.answer({ ...answer(), permissionAllowed: false }), 'permission');
  assert.deepEqual(store.get(scope, 'r'), before);
  store.answer(answer());
  conflict(() => store.claim({ ...claim(), expectedRevision: 1 }), 'revision');
  conflict(() => store.claim({ ...claim(), permissionAllowed: false }), 'permission');
  assert.equal(store.get(scope, 'r')?.delivery, 'queued');
});

for (const field of ['ownerId', 'nodeId', 'sessionKey', 'runId'] as const) test(`scope isolation: ${field}`, t => {
  const { store } = fixture(t); seed(store);
  const other = { ...scope, [field]: 'other' };
  assert.equal(store.get(other, 'r'), undefined); assert.equal(store.hasUnresolved(other), false);
  assert.deepEqual(store.auditTrail(other, 'r'), []);
  conflict(() => store.answer({ ...answer(), scope: other }), 'missing');
  assert.equal(store.closeRun(other, 'stopped', 125), 0);
  assert.equal(store.get(scope, 'r')?.state.status, 'pending');
});

for (const status of ['absent', 'active', 'blocked', 'complete'] as const) test(`goal ${status}: explicit native answer only, no goal mutation`, t => {
  const { store } = fixture(t); const proof: InteractionContinuation = { ...continuation, goal: { status, version: status } };
  const original = structuredClone(proof);
  seed(store, proof); store.answer({ ...answer(), continuation: proof });
  const fact = store.claim({ ...claim(), continuation: proof });
  assert.equal(fact?.delivery, 'claimed'); assert.deepEqual(proof, original);
  assert.equal(store.hasUnresolved(scope), true);
});

for (const status of ['paused', 'usageLimited', 'budgetLimited', 'unknown'] as const) {
  test(`goal ${status} never grants initial interaction or later continuation`, t => {
    const { store } = fixture(t); const unsafe: InteractionContinuation = { ...continuation, goal: { status, version: 'v' } };
    conflict(() => seed(store, unsafe), 'continuation'); assert.equal(store.get(scope, 'r'), undefined);
    seed(store); conflict(() => store.answer({ ...answer(), continuation: unsafe }), 'continuation');
    assert.equal(store.get(scope, 'r')?.state.status, 'pending');
    store.answer(answer()); conflict(() => store.claim({ ...claim(), continuation: unsafe }), 'continuation');
    assert.equal(store.get(scope, 'r')?.delivery, 'queued');
  });
}

for (const proof of [{ ...continuation, connectionId: 'replacement' },
  { ...continuation, goal: { status: 'active' as const, version: 'replacement' } },
  { ...continuation, goal: { status: 'complete' as const, version: continuation.goal.version } }]) {
  test(`connection/goal generation drift is fenced: ${JSON.stringify(proof)}`, t => {
    const { store } = fixture(t); seed(store);
    conflict(() => store.answer({ ...answer(), continuation: proof }), 'continuation');
    store.answer(answer()); conflict(() => store.claim({ ...claim(), continuation: proof }), 'continuation');
    assert.equal(store.get(scope, 'r')?.revision, 2);
  });
}

test('interaction goal identity tolerates accounting, fences replacement and stores no plaintext', () => {
  const result = { goal: { threadId: 's', createdAt: 1, updatedAt: 2, status: 'active', objective: 'SECRET', tokenBudget: null, tokensUsed: 1, timeUsedSeconds: 0 } };
  const proof = { connectionId: 'c', goal: interactionGoalEvidence(result, 's') } as InteractionContinuation;
  const digest = continuationFingerprint(proof);
  result.goal.tokensUsed++;
  assert.equal(continuationFingerprint({ ...proof, goal: interactionGoalEvidence(result, 's') }), digest);
  result.goal.objective = 'NEW SECRET';
  assert.notEqual(continuationFingerprint({ ...proof, goal: interactionGoalEvidence(result, 's') }), digest);
  for (const goal of [interactionGoalEvidence(result, 'other'), interactionGoalEvidence({}, 's')]) {
    conflict(() => continuationFingerprint({ ...proof, goal } as InteractionContinuation), 'continuation');
  }
  assert.equal(digest.includes('SECRET'), false);
});

test('queued answer survives normal goal progress but never crosses a same-timestamp replacement', t => {
  const { store } = fixture(t);
  const goal = { threadId: 's', createdAt: 1, updatedAt: 2, status: 'active', objective: 'Original', tokenBudget: 1000, tokensUsed: 1, timeUsedSeconds: 0 };
  const observed = () => ({ connectionId: 'c', goal: interactionGoalEvidence({ goal }, 's') });
  store.create(request(), capabilities, scope, observed(), 100);
  goal.tokensUsed = 50;
  goal.status = 'blocked';
  store.answer({ ...answer(), continuation: observed() });
  for (const replacement of [{ objective: 'Different', tokenBudget: 1000 }, { objective: 'Original', tokenBudget: 2000 }]) {
    Object.assign(goal, replacement);
    conflict(() => store.claim({ ...claim(), continuation: observed() }), 'continuation');
    assert.equal(store.get(scope, 'r')?.delivery, 'queued');
  }
});

for (const reason of ['stopped', 'disconnected', 'revoked', 'restarted'] as const) {
  for (const stage of ['pending', 'queued', 'claimed'] as const) test(`${reason} while ${stage}: preserve answer/history, no native replay`, t => {
    const { store } = fixture(t); seed(store);
    if (stage !== 'pending') store.answer(answer());
    const token = stage === 'claimed' ? store.claim(claim())!.claimId : undefined;
    assert.equal(store.closeRun(scope, reason, 140), 1);
    assert.equal(store.closeRun(scope, reason, 140), 0);
    const after = store.get(scope, 'r')!;
    assert.equal(after.delivery, stage === 'claimed' ? 'unknown' : 'cancelled');
    assert.equal(store.hasUnresolved(scope), stage === 'claimed', 'unknown continuation requires explicit recovery, not new work');
    assert.equal(store.claim({ ...claim(), expectedRevision: after.revision, now: 145 }), undefined);
    if (token) conflict(() => store.settle(scope, 'r', token, 'confirmed', 150), 'delivery');
    if (stage !== 'pending') assert.equal(after.state.status, 'answered', 'accepted human answer is retained');
  });
}

test('expiry persists closure; accepted-but-not-delivered answers expire without sending', t => {
  const { store } = fixture(t); seed(store);
  const expired = store.answer({ ...answer(), now: 200 });
  assert.equal(expired.state.status, 'closed'); assert.equal(expired.delivery, 'cancelled');
  const other: InteractionScope = { ...scope, runId: 'next' };
  store.create(request({ ...other }), capabilities, other, continuation, 100);
  store.answer({ ...answer(), scope: other });
  assert.equal(store.claim({ ...claim(), scope: other, now: 200 }), undefined);
  assert.equal(store.get(other, 'r')?.delivery, 'cancelled');
});

test('run expiry closes only expired requests without hiding later live questions', t => {
  const { store } = fixture(t); seed(store);
  store.create(request({ requestId: 'later', expiresAt: 300 }), capabilities, scope, continuation, 150);
  assert.equal(store.closeRun(scope, 'expired', 200), 1);
  assert.equal(store.get(scope, 'r')?.state.status, 'closed');
  assert.equal(store.get(scope, 'later')?.state.status, 'pending');
  assert.equal(store.hasUnresolvedSession(scope), true);
  assert.equal(store.closeRun(scope, 'expired', 300), 1);
  assert.equal(store.hasUnresolvedSession(scope), false);
});

for (const [kind, response] of [
  ['approval', { kind: 'approval', decision: 'allow-once' }],
  ['approval', { kind: 'approval', decision: 'deny' }],
  ['text', { kind: 'text', text: 'Answer with 中文 and a Windows path C:\\Projects\\work' }],
  ['single-select', { kind: 'single-select', optionIds: ['a'] }],
  ['multi-select', { kind: 'multi-select', optionIds: ['b', 'a'] }],
] as [InteractionKind, InteractionAnswer][]) test(`answer payload roundtrip: ${JSON.stringify(response)}`, t => {
  const { store } = fixture(t);
  store.create(request({ kind, ...(kind.endsWith('select') ? { options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } : {}) }), capabilities, scope, continuation, 100);
  store.answer({ ...answer(), answer: response });
  const claimed = store.claim(claim())!;
  assert.equal(claimed.state.status, 'answered');
  const expected = response.kind === 'multi-select' ? { ...response, optionIds: ['a', 'b'] } : response;
  if (claimed.state.status === 'answered') assert.deepEqual(claimed.state.answer, expected);
  assert.equal(store.auditTrail(scope, 'r').length, 3);
});

test('admission checks use small indexed metadata, not deserialization of prompt/answer bodies', t => {
  const { db, store } = fixture(t); seed(store);
  const plans = db.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM agent_interactions WHERE session_scope = ? AND unresolved = 1 LIMIT 1').all('session');
  assert.match(JSON.stringify(plans), /agent_interactions_pending_session/);
  assert.equal(store.hasUnresolvedSession(scope), true);
});

test('invalid/reversed clocks and unknown native ACK cannot alter records', t => {
  const { store } = fixture(t); seed(store); store.answer(answer());
  for (const now of [119, NaN, Infinity, 130.5]) conflict(() => store.claim({ ...claim(), now }), 'invalid');
  conflict(() => store.answer({ ...answer(), now: 119 }), 'invalid');
  const fact = store.claim(claim())!;
  conflict(() => store.settle(scope, 'r', 'wrong', 'confirmed', 140), 'delivery');
  store.settle(scope, 'r', fact.claimId!, 'unknown', 140);
  conflict(() => store.settle(scope, 'r', fact.claimId!, 'confirmed', 145), 'delivery');
  assert.equal(store.hasUnresolved(scope), true);
});

test('bounded storage fails closed, never evicts an unresolved interaction', t => {
  const { store } = fixture(t, 1); const first = seed(store);
  conflict(() => store.create(request({ requestId: 'extra' }), capabilities, scope, continuation, 100), 'capacity');
  assert.deepEqual(store.get(scope, 'r'), first);
  store.closeRun(scope, 'stopped', 120);
  conflict(() => store.create(request({ requestId: 'extra' }), capabilities, scope, continuation, 120), 'capacity');
});

test('new run identity cannot hide an older unknown interaction in the same session', t => {
  const { store } = fixture(t); seed(store); store.answer(answer()); store.claim(claim());
  store.closeRun(scope, 'restarted', 140);
  assert.equal(store.hasUnresolved({ ...scope, runId: 'successor' }), false);
  assert.equal(store.hasUnresolvedSession({ ...scope, runId: 'successor' } as InteractionScope), true);
  for (const field of ['ownerId', 'nodeId', 'sessionKey'] as const) {
    assert.equal(store.hasUnresolvedSession({ ...scope, [field]: 'other' }), false);
  }
});

test('one long goal run can exceed 32 completed questions but not 32 unresolved questions', t => {
  const { store } = fixture(t);
  for (let i = 0; i < 40; i++) {
    const requestId = `finished-${i}`;
    store.create(request({ requestId }), capabilities, scope, continuation, 100);
    store.answer({ ...answer(), requestId });
    const claimed = store.claim({ ...claim(), requestId })!;
    store.settle(scope, requestId, claimed.claimId!, 'confirmed', 140);
  }
  for (let i = 0; i < 32; i++) store.create(request({ requestId: `pending-${i}` }), capabilities, scope, continuation, 150);
  conflict(() => seed(store), 'capacity');
  assert.equal(store.auditTrail(scope, 'finished-39').length, 4);
});

test('audit failure rolls back state mutation atomically', t => {
  const { store, db } = fixture(t); const before = seed(store);
  db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON agent_interaction_audit BEGIN SELECT RAISE(ABORT, 'test fault'); END");
  assert.throws(() => store.answer(answer()), /test fault/);
  assert.deepEqual(store.get(scope, 'r'), before);
  assert.equal(store.auditTrail(scope, 'r').length, 1);
});
test('interaction rollback reporting preserves original audit failure and state', t => {
  const { store, db } = fixture(t), before = seed(store), exec = db.exec.bind(db);
  db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON agent_interaction_audit BEGIN SELECT RAISE(ABORT, 'original-audit'); END");
  db.exec = sql => { exec(sql); if (sql === 'ROLLBACK') throw Error('cleanup-report'); };
  assert.throws(() => store.answer(answer()), /original-audit/);
  assert.equal(db.isTransaction, false); assert.deepEqual(store.get(scope, 'r'), before);
});

test('reopen preserves pending/accepted/claimed records; explicit old-run recovery never replays', t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-interactions-reopen-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'interactions.sqlite');
  let db = new DatabaseSync(path); let store = new InteractionStore(db);
  try {
    seed(store); store.answer(answer()); const token = store.claim(claim())!.claimId!;
    const prior = store.get(scope, 'r');
    db.close(); db = new DatabaseSync(path); store = new InteractionStore(db);
    assert.deepEqual(store.get(scope, 'r'), prior, 'opening a reader is not recovery authority');
    assert.equal(store.claim({ ...claim(), now: 140 }), undefined);
    store.closeRun(scope, 'restarted', 140);
    conflict(() => store.settle(scope, 'r', token, 'confirmed', 150), 'delivery');
    assert.equal(store.get(scope, 'r')?.delivery, 'unknown');
  } finally { db.close(); }
});

test('independent OS processes racing answers and claims have exactly one accepted answer and one claim', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-interactions-race-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'interactions.sqlite');
  const db = new DatabaseSync(path); seed(new InteractionStore(db)); db.close();
  const source = import.meta.url.endsWith('.ts');
  const moduleUrl = new URL(source ? './interaction-store.ts' : './interaction-store.js', import.meta.url).href;
  const run = async (operation: string, input: unknown) => {
    const code = `import { DatabaseSync } from 'node:sqlite'; import { InteractionStore } from ${JSON.stringify(moduleUrl)};
      console.info = line => process.stderr.write(line + '\\n');
      const db = new DatabaseSync(${JSON.stringify(path)}); db.exec('PRAGMA busy_timeout = 5000');
      try { const store = new InteractionStore(db); const result = store[${JSON.stringify(operation)}](${JSON.stringify(input)});
      console.log(JSON.stringify({ok:!!result, delivery:result?.delivery})); }
      catch(e) { console.log(JSON.stringify({error:e.code ?? e.message})); } finally { db.close(); }`;
    const output = await promisify(execFile)(process.execPath, [...(source ? ['--import', import.meta.resolve('tsx')] : []), '--input-type=module', '-e', code], { timeout: 15_000 });
    return JSON.parse(output.stdout.trim());
  };
  const answers = await Promise.all([run('answer', answer()), run('answer', { ...answer(), responseId: 'other' })]);
  assert.equal(answers.filter(x => x.ok).length, 1); assert.equal(answers.filter(x => x.error === 'answered').length, 1);
  const claims = await Promise.all([run('claim', claim()), run('claim', claim())]);
  assert.equal(claims.filter(x => x.ok).length, 1); assert.equal(claims.filter(x => !x.ok && !x.error).length, 1);
});
