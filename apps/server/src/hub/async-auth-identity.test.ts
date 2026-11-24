import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubAuthIdentity } from './async-auth-identity.js';
import { AuthPersistenceError } from '../auth/private-store.js';
import { validHubMemberInput, validHubMemberOutput, executeHubMemberCommand, hubMemberCommandSteps,
  hubMemberFailureSteps } from './member-owner-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const request = (headers: HeadersInit = {}, signal?: AbortSignal) => new Request('http://fixture.invalid/', {
  headers, ...(signal === undefined ? {} : { signal }),
});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('identity command has fixed original evidence actions, bounded metadata and unique append-only telemetry', () => {
  for (const input of [{ action: 'key' }, { action: 'key', key: 'not-a-member-key' }, { action: 'request', evidence: {} }])
    assert.equal(validHubMemberInput('memberIdentity', input), true);
  for (const input of [{ action: 'other' }, { action: 'key', authorized: true },
    { action: 'request', evidence: {}, userId: 'forged' }, { action: 'request', evidence: { principal: 'forged' } },
    { action: 'key', key: 'x'.repeat(8193) }]) assert.equal(validHubMemberInput('memberIdentity', input), false);
  const identity = { userId: 'member', keyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
  assert.equal(validHubMemberOutput('memberIdentity', identity), true);
  assert.equal(validHubMemberOutput('memberIdentity', null), true);
  for (const output of [{ ...identity, authorized: true }, { ...identity, token: 'private' }, { ...identity, userId: '' },
    { ...identity, keyId: 'not-a-key-id' }]) assert.equal(validHubMemberOutput('memberIdentity', output), false);
  for (const mapping of [hubMemberCommandSteps, hubMemberFailureSteps])
    assert.equal(new Set(Object.values(mapping)).size, Object.keys(mapping).length);
});

test('whole original owner preserves key/session identity precedence, revocation and reopen metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-auth-identity-')), file = join(root, 'hub.sqlite');
  const original = new HubStore(file, 'isolated-vault'); let owner: AsyncHubMemberOwner | undefined;
  try {
    const member = original.createUser('Original member'), key = original.identities.issueKey(member.id);
    const token = original.identities.createSession(key.token)!;
    const originalIdentity = original.identities.keyIdentity(key.token)!;
    const identity = { userId: originalIdentity.userId, keyId: originalIdentity.keyId };
    const cookie = { cookie: `agentopsdeck_session=${token}` };
    const principal = original.identities.requestPrincipal(request(cookie), () => false)!;
    const scope = original.identities.recoveryScope(principal);
    const cases = [{ action: 'key' as const }, { action: 'key' as const, key: 'wrong' },
      { action: 'key' as const, key: key.token }, { action: 'request' as const, evidence: { sessionToken: token } },
      { action: 'request' as const, evidence: { sessionToken: token, accessKey: 'hub_key_' + 'z'.repeat(43) } }];
    const expected = cases.map(input => executeHubMemberCommand(original, 'memberIdentity', input));
    assert.deepEqual(JSON.parse(JSON.stringify(expected)), [null, null, identity, identity, null]);
    await original.close(); owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'isolated-vault' }, quiet);
    for (let i = 0; i < cases.length; i++)
      assert.deepEqual(await owner.command('memberIdentity', cases[i]!), expected[i]);
    const caller = new AsyncHubAuthIdentity(owner, quiet);
    assert.deepEqual(await caller.requestPrincipal(request(cookie)), principal);
    assert.equal(Object.isFrozen(await caller.requestPrincipal(request(cookie))), true);
    assert.equal(await caller.recoveryScope(request(cookie), principal), scope);
    assert.equal(await caller.recoveryScope(request(cookie), { ...principal, admin: !principal.admin }), undefined);
    assert.equal(await caller.recoveryScope(request(cookie), { ...principal, userId: 'other' }), undefined);
    assert.deepEqual(await caller.keyIdentity(key.token), identity);
    assert.deepEqual(await caller.memberIdentity(request(cookie)), identity);
    assert.equal(await caller.memberIdentity(request({ ...cookie, 'x-agentopsdeck-key': 'hub_key_' + 'z'.repeat(43) })), undefined);
    assert.equal(await caller.requestPrincipal(request({ ...cookie, 'x-agentopsdeck-key': 'hub_key_' + 'z'.repeat(43) })), undefined);
    assert.equal(await caller.keyIdentity(undefined), undefined);
    await owner.command('memberSessionDelete', { token });
    assert.equal(await caller.memberIdentity(request(cookie)), undefined);
    assert.equal(await caller.requestPrincipal(request(cookie)), undefined);
    assert.equal(await caller.recoveryScope(request(cookie), principal), undefined);
    assert.deepEqual(await caller.keyIdentity(key.token), identity);
    await caller.close(); await owner.close();
    const reopened = new HubStore(file, 'isolated-vault');
    try {
      const after = reopened.identities.keyIdentity(key.token)!;
      assert.deepEqual({ userId: after.userId, keyId: after.keyId }, identity);
      assert.equal(reopened.identities.requestIdentity(request(cookie)), undefined);
    } finally { await reopened.close(); }
  } finally { await owner?.close(); await original.close(); rmSync(root, { recursive: true, force: true }); }
});

test('identity timeout retains original budget, drain and no late metadata delivery or replacement read', async () => {
  const original = deferred<null>(); let calls = 0;
  const owner = { command: async () => { calls++; return original.promise; } } as unknown as Pick<AsyncHubMemberOwner, 'command'>;
  const caller = new AsyncHubAuthIdentity(owner, quiet, 5, 5);
  await assert.rejects(caller.memberIdentity(request()), AuthPersistenceError);
  assert.equal(caller.pending, 1);
  let settled = false; const closing = caller.close(); void closing.then(() => { settled = true; });
  assert.equal(caller.close(), closing); await tick(); assert.equal(settled, false);
  await assert.rejects(caller.keyIdentity(undefined), AuthPersistenceError);
  original.resolve(null); await closing;
  assert.equal(calls, 1); assert.equal(caller.pending, 0);
});

test('close before identity ACK denies delivery; pre-aborted request never dispatches', async () => {
  const original = deferred<null>(); let calls = 0;
  const owner = { command: async () => { calls++; return original.promise; } } as unknown as Pick<AsyncHubMemberOwner, 'command'>;
  const caller = new AsyncHubAuthIdentity(owner, quiet);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(caller.memberIdentity(request({}, controller.signal)), AuthPersistenceError);
  assert.equal(calls, 0);
  const operation = assert.rejects(caller.keyIdentity('wrong'), AuthPersistenceError);
  const closing = caller.close(); original.resolve(null); await operation; await closing;
  assert.equal(calls, 1);
});
