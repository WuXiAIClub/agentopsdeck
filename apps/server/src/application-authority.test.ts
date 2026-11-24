import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from './application.js';
import { loadConfig } from './config.js';
import { HubIdentities, type HubPrincipal } from './hub/identity.js';
import { OriginalHubAdministrativeCommands } from './hub/original-administrative-commands.js';

function configuration() {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-application-authority-'));
  const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: 'synthetic-application-key',
    AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'synthetic-vault',
    AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'auth.json'),
    AOD_SESSION_TITLES_FILE: join(root, 'titles.json') });
  return { root, config };
}
async function until(check: () => boolean) {
  const deadline = AbortSignal.timeout(3000);
  while (!check()) { deadline.throwIfAborted(); await new Promise<void>(resolve => setImmediate(resolve)); }
}

for (const outcome of ['success', 'cancel', 'reject'] as const) {
  test(`actual application HTTP principal ${outcome} uses awaited read, not synchronous transaction callback`, async t => {
    const f = configuration(), controller = new AbortController();
    let resolve!: (value: HubPrincipal | undefined) => void, reject!: (error: Error) => void, lookups = 0;
    const pending = new Promise<HubPrincipal | undefined>((yes, no) => { resolve = yes; reject = no; });
    const original = OriginalHubAdministrativeCommands.prototype.command;
    // Hold the production awaited command, never return a Promise from an
    // original SQL transaction's synchronous authority callback.
    t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
      if (kind === 'memberSnapshot') {
        lookups++;
        return pending.then(principal => principal ? { principal, recoveryScope: 'a'.repeat(64) } : null);
      }
      return original.call(this, kind, input);
    });
    const app = createApplication(f.config);
    const request = app.app.request('/api/health', { signal: controller.signal });
    try {
      await until(() => lookups === 1);
      if (outcome === 'success') resolve({ userId: 'default', admin: true });
      else if (outcome === 'cancel') controller.abort();
      else reject(Error('private-original-owner-read-error'));
      const response = await request;
      assert.equal(response.status, outcome === 'success' ? 200 : outcome === 'cancel' ? 408 : 503);
      assert.equal(lookups, 1);
      if (outcome !== 'success') assert.deepEqual(await response.json(), {
        error: outcome === 'cancel' ? 'request_cancelled' : 'auth_persistence_failed',
      });
    } finally {
      resolve(undefined); await request; await app.close(); rmSync(f.root, { recursive: true, force: true });
    }
  });
}

test('actual application retains original activity ACK and rechecks authority before auth handler', async t => {
  const f = configuration(), controller = new AbortController(); let resolve!: () => void, writes = 0, completed = false;
  const pending = new Promise<void>(yes => { resolve = yes; });
  const original = OriginalHubAdministrativeCommands.prototype.command;
  t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
    if (kind === 'memberActivity') { writes++; return pending.then(() => ({ ok: true })); }
    return original.call(this, kind, input);
  });
  const app = createApplication(f.config);
  const request = Promise.resolve(app.app.request('/api/auth/status', { headers: { 'x-agentopsdeck-key': 'synthetic-application-key' }, signal: controller.signal }))
    .finally(() => { completed = true; });
  try {
    await until(() => writes === 1);
    controller.abort(); await new Promise<void>(yes => setImmediate(yes));
    assert.equal(completed, false, 'abort cannot settle original activity mutation');
    resolve(); const response = await request;
    assert.equal(response.status, 408); assert.equal(writes, 1);
    assert.equal(response.headers.get('set-cookie'), null);
  } finally { resolve(); await request; await app.close(); rmSync(f.root, { recursive: true, force: true }); }
});

for (const outcome of ['success', 'cancel', 'reject', 'revoke'] as const) {
  test(`actual auth status awaits original credential snapshot and scope ${outcome}`, async t => {
    const f = configuration(), controller = new AbortController();
    let actor: HubPrincipal | undefined = { userId: 'default', admin: true }, reads = 0;
    let resolve!: (value: string) => void, reject!: (error: Error) => void;
    const pending = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    // Each observation goes through original credential evidence. Hold the
    // first command; subsequent reads must observe current identity, not a
    // cached grant or a principal supplied to the transaction.
    const original = OriginalHubAdministrativeCommands.prototype.command;
    t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
      if (kind === 'memberActivity') return Promise.resolve({ ok: true });
      if (kind === 'memberSnapshot') {
        if (reads++ === 0) return pending.then(scope => actor ? { principal: actor, recoveryScope: scope } : null);
        return Promise.resolve(actor ? { principal: actor, recoveryScope: 'a'.repeat(64) } : null);
      }
      return original.call(this, kind, input);
    });
    const app = createApplication(f.config);
    const flight = app.app.request('/api/auth/status', { signal: controller.signal });
    try {
      await until(() => reads === 1);
      if (outcome === 'cancel') controller.abort();
      else if (outcome === 'reject') reject(Error('private-original-scope-error'));
      else { if (outcome === 'revoke') actor = undefined; resolve('a'.repeat(64)); }
      const response = await flight;
      assert.equal(response.status, outcome === 'cancel' ? 408 : outcome === 'reject' ? 503 : 200);
      const body = await response.json();
      if (outcome === 'success') { assert.equal(body.authenticated, true); assert.equal(body.recoveryScope, 'a'.repeat(64)); }
      if (outcome === 'revoke') { assert.equal(body.authenticated, false); assert.equal(body.recoveryScope, undefined); }
      assert.equal(response.headers.get('set-cookie'), null); assert.ok(reads >= 1);
    } finally { resolve('a'.repeat(64)); await flight; await app.close(); rmSync(f.root, { recursive: true, force: true }); }
  });
}

for (const outcome of ['success', 'deny', 'cancel', 'reject'] as const) {
  test(`actual member login final session lookup ${outcome} never tests Promise truthiness`, async t => {
    const f = configuration(), controller = new AbortController(); let reads = 0, issued = 0;
    const key = 'hub_key_' + 'x'.repeat(43), token = 'hub_session_' + 'y'.repeat(43);
    let resolve!: (value: { userId: string; keyId: string } | undefined) => void, reject!: (error: Error) => void;
    const pending = new Promise<{ userId: string; keyId: string } | undefined>((yes, no) => { resolve = yes; reject = no; });
    t.mock.method(HubIdentities.prototype, 'requestPrincipal', () => undefined);
    const original = OriginalHubAdministrativeCommands.prototype.command;
    // Delay the actual application's awaited identity port, not a synchronous
    // method inside the original SQL owner. Both audit metadata and final
    // session proof must pass through this fixed domain.
    t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
      if (kind === 'memberSessionCreate') { assert.deepEqual(input, { key }); issued++; return Promise.resolve({ token }); }
      if (kind === 'memberSnapshot' && (input as { sessionToken?: string }).sessionToken === token)
        return Promise.resolve({ principal: { userId: 'member', admin: false }, recoveryScope: 'a'.repeat(64) });
      if (kind === 'memberIdentity') {
        const proof = input as { action: string; key?: string; evidence?: { sessionToken?: string; accessKey?: string } };
        if (proof.action === 'key') {
          assert.equal(proof.key, key);
          return Promise.resolve({ userId: 'member', keyId: 'key' });
        }
        reads++; assert.deepEqual(proof.evidence, { sessionToken: token });
        return pending.then(value => value ?? null);
      }
      return original.call(this, kind, input);
    });
    const app = createApplication(f.config);
    const flight = app.app.request('/api/auth/login', { method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey: key }) });
    try {
      await until(() => reads === 1); assert.equal(issued, 1);
      if (outcome === 'cancel') controller.abort();
      else if (outcome === 'reject') reject(Error('private-original-member-proof'));
      else resolve(outcome === 'success' ? { userId: 'member', keyId: 'key' } : undefined);
      const response = await flight;
      assert.equal(response.status, outcome === 'success' ? 200 : outcome === 'cancel' ? 408 : outcome === 'reject' ? 503 : 401);
      if (outcome === 'success') assert.ok(response.headers.get('set-cookie')!.includes('agentopsdeck_session=' + token));
      else assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(issued, 1, 'read failure must never replay original issuance');
    } finally { resolve(undefined); await flight; await app.close(); rmSync(f.root, { recursive: true, force: true }); }
  });
}
