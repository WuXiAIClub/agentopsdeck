import assert from 'node:assert/strict';
import test from 'node:test';
import { reconciliationOrigin, reconcileLocalMaintenance, replacementReceiptProof } from './reconcile-local-maintenance.mjs';

test('replacement evidence binds completed deployment, actual service generation and real business acceptance', () => {
  const current = { revision: 'a'.repeat(40), manifestSha256: 'b'.repeat(64) };
  const service = { pid: '123', invocation: 'c'.repeat(32), startedAt: 2000 };
  const accepted = { stage: 'verified', finishedAt: new Date(3000).toISOString(), originalInputsDispatched: true,
    queue: [], newAssistantMessages: [{ id: 'reply' }], checks: [{ status: 200, preservedInputs: true, realNativeOutput: true }] };
  const deployed = { stage: 'verified', activated: true, admissionReleased: true, candidate: current,
    service: { MainPID: service.pid, InvocationID: service.invocation, ActiveState: 'active' },
    proofs: [{ nodeId: 'node', businessReadVerified: true, projectionVerified: true }],
    backups: [{ sha256: 'd'.repeat(64) }], liveAcceptance: accepted, finishedAt: new Date(4000).toISOString() };
  const run = (d = deployed, a = accepted, s = service) => replacementReceiptProof({ deployment: JSON.stringify(d),
    acceptance: JSON.stringify(a), current, service: s, nodeId: 'node', now: 5000 });
  assert.deepEqual(run().release, current); assert.match(run().deploymentSha256, /^[a-f0-9]{64}$/);
  for (const patch of [{ stage: 'observing' }, { activated: false }, { admissionReleased: false },
    { candidate: { ...current, manifestSha256: 'e'.repeat(64) } }, { backups: [] }, { proofs: [] },
    { finishedAt: new Date(6000).toISOString() }, { liveAcceptance: {} }]) assert.throws(() => run({ ...deployed, ...patch }));
  for (const patch of [{ stage: 'observing' }, { queue: ['pending'] }, { newAssistantMessages: [] },
    { originalInputsDispatched: false }, { checks: [{ status: 200 }] }, { finishedAt: new Date(1000).toISOString() }]) {
    const a = { ...accepted, ...patch }; assert.throws(() => run({ ...deployed, liveAcceptance: a }, a));
  }
  assert.throws(() => run(deployed, accepted, { ...service, invocation: 'e'.repeat(32) }));
  assert.throws(() => run(deployed, accepted, { ...service, pid: '124' }));
});

test('reconciliation never sends its private credential outside an explicit loopback origin', () => {
  assert.equal(reconciliationOrigin('http://127.0.0.1:8791'), 'http://127.0.0.1:8791');
  assert.equal(reconciliationOrigin('http://[::1]:8791/'), 'http://[::1]:8791');
  for (const value of ['https://example.com', 'http://10.0.0.1', 'http://localhost',
    'http://127.0.0.1/path', 'http://user:secret@127.0.0.1', 'http://127.0.0.1?token=x', 'http://127.0.0.1#x'])
    assert.throws(() => reconciliationOrigin(value));
});

test('reconciliation requires an operator-pinned immutable toolkit before opening configuration', async () => {
  for (const toolkitSha256 of [undefined, '', 'a'.repeat(40), 'x'.repeat(64)])
    await assert.rejects(reconcileLocalMaintenance({ toolkit: '/nonexistent', toolkitSha256 }));
});

test('operator actions cannot be guessed or forwarded to arbitrary toolkit methods', async () => {
  for (const action of ['replace', 'restart', 'stop', '', null])
    await assert.rejects(reconcileLocalMaintenance({ action }));
});
