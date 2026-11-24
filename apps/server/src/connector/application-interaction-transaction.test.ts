import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import type { ApplicationTransactionBinding, ApplicationTransactionClient } from '../auth/application-transaction-gate.js';
import { applicationInteractionIntent, createApplicationInteractionTransactions } from './application-interaction-transaction.js';
import { createApplicationCommandScopes } from '../auth/application-command-scope.js';

for (const runtime of ['codex', 'claude-code', 'ghcp'] as const) {
  test(`${runtime}: original identity and payload are retained across Claim/Deliverable, never Settle authorization`, async () => {
    const bindings: ApplicationTransactionBinding[] = [];
    const client: ApplicationTransactionClient = { async run(binding, write) { bindings.push(structuredClone(binding)); return write(); } };
    const gate = createApplicationInteractionTransactions(client), key = `${runtime}:original`, application = { cookie: 'original-cookie' };
    const bound = runtime === 'codex' ? { sessionKey: key, commandId: 'original-command', connectionId: 'original-connection', bindingId: 'original-binding', runId: 'original-run' }
      : { runtime, bindingId: 'original-binding', ref: { key, id: 'original-run', epoch: 'original-epoch', nativeSessionId: 'original-native' } };
    const input = { key, requestId: 'original-request', submission: { original: 'answer' }, application, binding: bound };
    let writes = 0;
    await gate.run('interactionAnswer', runtime, input, () => { writes++; return { ok: true }; });
    application.cookie = 'replaced-cookie';
    for (const kind of ['interactionClaim', 'interactionDeliverable'])
      await gate.run(kind, runtime, { ...bound, requestId: input.requestId }, () => { writes++; return { ok: true }; });
    assert.deepEqual(bindings.map(b => b.phase), ['control-claim', 'control-ready', 'control-ready']);
    assert.ok(bindings.every(b => b.evidence.cookie === 'original-cookie' && b.resource === key));
    assert.equal(bindings[0]!.payloadDigest, createHash('sha256').update(JSON.stringify({ requestId: input.requestId, submission: input.submission })).digest('hex'));
    await gate.run('interactionSettle', runtime, { ...bound, requestId: input.requestId }, () => { writes++; return { ok: true }; });
    assert.equal(bindings.length, 3); assert.equal(writes, 4);
    gate.dispose(); await assert.rejects(gate.run('interactionMode', runtime, { key, mode: 'interactive' }, () => ({ ok: true })));
  });

  test(`${runtime}: Mode uses Ready; duplicate observation cannot mint authority and denied transaction cannot write`, async () => {
    let writes = 0, checks = 0, allowed = true;
    const gate = createApplicationInteractionTransactions({ async run(binding, write) {
      checks++; if (!allowed) throw Error('isolated revoked'); assert.equal(binding.phase, 'control-ready'); return write();
    } });
    const key = `${runtime}:original`, write = () => { writes++; return { ok: true }; };
    await gate.run('interactionMode', runtime, { key, mode: 'interactive', application: {} }, write);
    assert.equal(writes, 1); allowed = false;
    await assert.rejects(gate.run('interactionMode', runtime, { key, mode: 'automatic', application: {} }, write)); assert.equal(writes, 1);
    await gate.run('interactionAnswer', runtime, { key, requestId: 'original', application: {} }, write);
    assert.equal(checks, 2, 'unbound Answer is only an original receipt probe');
    const intent = applicationInteractionIntent(runtime, { key, mode: 'interactive' });
    assert.equal(intent.payloadDigest, createHash('sha256').update('{"mode":"interactive"}').digest('hex'));
    const scopes = createApplicationCommandScopes({ authorize: () => true, assertAvailable() {} });
    try {
      assert.equal(await scopes.run(new Request('http://original.invalid'), intent, async scope => {
        await scope.authorize('prepare'); scope.local(); return 'original';
      }), 'original', 'intent must satisfy the original exact-field scope contract');
    } finally { await scopes.close(); }
    gate.dispose();
  });
}
