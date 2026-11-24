import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectorScope } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncLocalIssuerOperator } from './async-local-issuer-operator.js';
import { localIssuerPlan } from './local-issuer-plan.js';

const quiet = new PerformanceDiagnostics(() => {});
type Owner = Pick<AsyncConnectorOwner, 'command'>;
const owner = (command: (kind: string, input: unknown) => Promise<unknown>): Owner => ({ command: command as Owner['command'] });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function reply(hub = 'original-hub', creation = false) {
  return { token: `aod_conn_${'a'.repeat(32)}`, record: { id: 'tok_abcdefghij', createdAt: 1, ...localIssuerPlan(hub, creation) } };
}

test('original fixed plan preserves exact scopes and adds only explicit creation', () => {
  assert.deepEqual(localIssuerPlan('original-hub'), { label: 'Hub shared Codex execution', delegationHubId: 'original-hub',
    scopes: ['execution:delegate', 'messages:read', 'messages:send', 'queue:manage'] });
  assert.deepEqual(localIssuerPlan('original-hub', true).scopes, [...localIssuerPlan('original-hub').scopes, 'sessions:create']);
});

test('real sole worker persists local issuer, checks binding/scopes and revokes without closing borrowed owner', async t => {
  const root = mkdtempSync(join(tmpdir(), 'async-local-issuer-'));
  const original = new AsyncConnectorOwner({ file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json'), codexBoardTools: false }, quiet);
  t.after(async () => { await original.close(); rmSync(root, { recursive: true, force: true }); });
  await original.open();
  const operator = new AsyncLocalIssuerOperator(original, () => true, quiet);
  const first = await operator.create('original-hub'), second = await operator.create('original-hub', true);
  assert.notEqual(first.record.id, second.record.id);
  assert.equal(await original.command('tokenDelegationHub', { tokenId: first.record.id }), 'original-hub');
  assert.equal(await original.command('tokenHasScope', { tokenId: first.record.id, scope: 'sessions:create' }), false);
  assert.equal(await original.command('tokenHasScope', { tokenId: second.record.id, scope: 'sessions:create' }), true);
  assert.equal(await operator.revoke(first.record.id), true);
  assert.equal(await operator.revoke(first.record.id), false);
  await operator.close();
  assert.equal((await original.command('tokenAuthenticate', { authorization: `Bearer ${second.token}` }))?.tokenId, second.record.id);
  assert.equal(await original.command('tokenAuthenticate', { authorization: `Bearer ${first.token}` }), null);
  await assert.rejects(operator.create('original-hub'));
});

test('no Promise truthiness, invalid input or same-Hub overlap can dispatch issuance', async () => {
  let calls = 0; const wait = gate();
  const original = owner(async () => { calls++; await wait.promise; return reply(); });
  const invalid = new AsyncLocalIssuerOperator(original, (() => Promise.resolve(true)) as unknown as () => boolean, quiet);
  await assert.rejects(invalid.create('original-hub')); assert.equal(calls, 0); await invalid.close();
  const operator = new AsyncLocalIssuerOperator(original, () => true, quiet);
  await assert.rejects(operator.create('bad hub')); await assert.rejects(operator.create('original-hub', 'yes' as unknown as boolean));
  const pending = operator.create('original-hub');
  await assert.rejects(operator.create('original-hub')); assert.equal(calls, 1);
  let closed = false; const closing = operator.close().then(() => { closed = true; }); await tick();
  assert.equal(closed, false); wait.release(); await pending; await closing;
  assert.equal(calls, 1);
});

for (const corrupt of ['binding', 'scope', 'label', 'id', 'revoked', 'ambiguous', 'token', 'lost-ack'] as const) {
  test(`unknown ${corrupt} fences all future effects without replacement or replay`, async () => {
    let calls = 0;
    const operator = new AsyncLocalIssuerOperator(owner(async () => {
      calls++; if (corrupt === 'lost-ack') throw Error('secret path/token must not escape');
      const value = reply();
      if (corrupt === 'binding') value.record.delegationHubId = 'other-hub';
      if (corrupt === 'scope') value.record.scopes.push('users:write' as ConnectorScope);
      if (corrupt === 'label') value.record.label = 'other';
      if (corrupt === 'id') value.record.id = 'different-format';
      if (corrupt === 'revoked') Object.assign(value.record, { revokedAt: 2 });
      if (corrupt === 'ambiguous') Object.assign(value.record, { identityAmbiguous: true });
      if (corrupt === 'token') value.token = 'wrong';
      return value;
    }), () => true, quiet);
    await assert.rejects(operator.create('original-hub'), error => error instanceof Error && !error.message.includes('secret'));
    await assert.rejects(operator.create('other-hub')); await assert.rejects(operator.revoke('tok_abcdefghij'));
    await assert.rejects(operator.close()); assert.equal(calls, 1);
  });
}

test('diagnostic reentry closes before dispatch while retaining its published task', async () => {
  let calls = 0, closing: Promise<void> | undefined;
  const diagnostics = new PerformanceDiagnostics(() => {}), start = diagnostics.start.bind(diagnostics);
  const operator = new AsyncLocalIssuerOperator(owner(async () => { calls++; return reply(); }), () => true, diagnostics);
  diagnostics.start = (...args) => { closing = operator.close(); return start(...args); };
  await assert.rejects(operator.create('original-hub')); await closing;
  assert.equal(calls, 0);
});

test('owner reentry cannot release physical issuance or start another command during close', async () => {
  const wait = gate(); let closing: Promise<void> | undefined, completed = false;
  const operator = new AsyncLocalIssuerOperator(owner(async () => {
    closing = operator.close().then(() => { completed = true; }); await wait.promise; return reply();
  }), () => true, quiet);
  const pending = operator.create('original-hub'); await tick(); assert.equal(completed, false);
  await assert.rejects(operator.revoke('tok_abcdefghij')); wait.release(); await pending; await closing;
  assert.equal(completed, true);
});
