import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, linkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { HubStore } from './hub-store.js';
import { LEGACY_HUB_PRINCIPAL } from './identity.js';
import { hubMemberEvidence, hubMemberOwnerConfig, HubMemberOwnerUnavailable, validHubMemberInput, validHubMemberOutput } from './member-owner-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { keyIdentityHash } from '../auth/security.js';
import { openSqliteAuth } from '../auth/sqlite-store.js';
import { AsyncSqliteAuthOwner } from '../auth/async-sqlite-owner.js';
import { PasskeyUnavailableError } from '../auth/passkeys.js';
import { startupDatabaseOwners } from '../storage/startup-owner.js';

const key = 'isolated-colocated-administrator', token = 'a'.repeat(43);
const quiet = new PerformanceDiagnostics(() => {});
async function fixture(work: (f: { root: string; file: string; authFile: string; scope: string; memberToken: string }) => Promise<void>, seedSession = true) {
  const root = mkdtempSync(join(tmpdir(), 'hub-colocated-auth-')), file = join(root, 'hub.sqlite'), authFile = join(root, 'auth.sqlite');
  const hub = new HubStore(file, 'isolated-colocated-secret', [], key), auth = openSqliteAuth(authFile, [], () => keyIdentityHash(key));
  const member = hub.createUser('isolated member'), memberKey = hub.identities.issueKey(member.id);
  const memberToken = hub.identities.createSession(memberKey.token)!;
  const scope = hub.identities.recoveryScope(LEGACY_HUB_PRINCIPAL); if (seedSession) auth.sessions.add(token);
  await hub.close(); await auth.close();
  try { await work({ root, file, authFile, scope, memberToken }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
const config = (f: { file: string; authFile: string }) => ({ file: f.file, encryptionSecret: 'isolated-colocated-secret',
  administratorKey: key, auth: { file: f.authFile, legacyFiles: [] } });
const document = (revision = 0) => ({ revision, groups: [], sessions: {}, ungroupedCollapsed: true });
test('empty session cookies remain anonymous evidence without discarding an explicit key', () => {
  const request = new Request('http://auth.invalid/', { headers: { cookie: 'agentopsdeck_session=', 'x-agentopsdeck-key': 'invalid-key' } });
  assert.deepEqual(hubMemberEvidence(request), { accessKey: 'invalid-key' });
  assert.equal(validHubMemberInput('memberSnapshot', hubMemberEvidence(request)), true);
  assert.deepEqual(hubMemberEvidence(new Request('http://auth.invalid/', { headers: { cookie: 'agentopsdeck_session=' } })), {});
});
test('one original worker preserves administrator cookie/key/member sessions; logout denies the next Hub write', () => fixture(async f => {
  const owner = new AsyncHubMemberOwner(config(f), quiet);
  try {
    await owner.open();
    assert.deepEqual(await owner.command('memberSnapshot', { sessionToken: token }), { principal: LEGACY_HUB_PRINCIPAL, recoveryScope: f.scope });
    assert.deepEqual(await owner.command('memberSnapshot', { accessKey: key }), { principal: LEGACY_HUB_PRINCIPAL, recoveryScope: f.scope });
    assert.ok(await owner.command('memberSnapshot', { sessionToken: f.memberToken }));
    assert.equal(await owner.authCommand('accessKeySession', { token }), true);
    assert.ok(await owner.command('workspaceSave', { evidence: { sessionToken: token }, expectedScope: f.scope, document: document() }));
    assert.equal(await owner.authCommand('deleteSession', { token }), true);
    assert.equal(await owner.command('memberSnapshot', { sessionToken: token }), null);
    assert.equal(await owner.command('workspaceSave', { evidence: { sessionToken: token }, expectedScope: f.scope, document: document(1) }), null);
    assert.ok(await owner.command('memberSnapshot', { sessionToken: f.memberToken }));
    assert.equal(owner.snapshot().unavailable, false);
  } finally { await owner.close(); }
  const original = new HubStore(f.file, 'isolated-colocated-secret', [], key);
  const originalAuth = openSqliteAuth(f.authFile, [], () => keyIdentityHash(key));
  try { assert.deepEqual(original.workspace.get('default'), document(1)); assert.equal(originalAuth.sessions.has(token), false); }
  finally { await original.close(); await originalAuth.close(); }
}));

test('original unavailable-passkey refusal survives worker transport without retiring the owner or leaking values', () => fixture(async f => {
  const logs: string[] = [], owner = new AsyncHubMemberOwner(config(f), new PerformanceDiagnostics(line => logs.push(line)));
  try {
    await owner.open();
    await assert.rejects(owner.authCommand('authenticationOptions', { origin: 'https://hub.example' }), PasskeyUnavailableError);
    assert.equal(await owner.authCommand('sessionCurrent', { token }), true);
    assert.ok(await owner.command('memberSnapshot', { sessionToken: token }));
    assert.equal(owner.snapshot().unavailable, false);
    for (const secret of [key, token, f.file, f.authFile, 'https://hub.example']) assert.equal(logs.join('').includes(secret), false);
    assert.ok(logs.some(line => line.includes('"deferred":1')));
  } finally { await owner.close(); }
}));

test('real signed original Passkey is checked by Hub until credential revocation; key-login classification stays separate', () => fixture(async f => {
  const auth = openSqliteAuth(f.authFile, [], () => keyIdentityHash(key));
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x!, 'base64url'),
    Buffer.from('225820', 'hex'), Buffer.from(jwk.y!, 'base64url')]);
  const id = Buffer.from('isolated-colocated-passkey').toString('base64url');
  auth.passkeys.importLegacy([{ id, publicKey: cose.toString('base64url'), counter: 0, rpId: 'hub.example',
    keyIdentityHash: keyIdentityHash(key), label: 'isolated offline credential', createdAt: 1 }], true);
  await auth.close();
  const owner = new AsyncHubMemberOwner(config(f), quiet);
  try {
    await owner.open();
    const origin = 'https://hub.example', options = await owner.authCommand('authenticationOptions', { origin });
    const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin }));
    const data = Buffer.alloc(37); createHash('sha256').update('hub.example').digest().copy(data); data[32] = 5; data.writeUInt32BE(1, 33);
    const response = { id, rawId: id, type: 'public-key' as const, clientExtensionResults: {}, response: {
      clientDataJSON: client.toString('base64url'), authenticatorData: data.toString('base64url'),
      signature: sign('sha256', Buffer.concat([data, createHash('sha256').update(client).digest()]), privateKey).toString('base64url') } };
    const result = await owner.authCommand('verifyAuthentication', { origin, response });
    assert.equal(result.verified, true); if (!result.verified) throw Error('isolated_authentication_failed');
    assert.equal(await owner.authCommand('accessKeySession', { token: result.sessionToken }), false);
    assert.ok(await owner.command('memberSnapshot', { sessionToken: result.sessionToken }));
    const credentials = await owner.authCommand('list', {});
    assert.equal(await owner.authCommand('revoke', { credentialHash: credentials[0]!.id,
      evidence: { suppliedKeyDigest: createHash('sha256').update(key).digest('hex') } }), true);
    assert.equal(await owner.command('memberSnapshot', { sessionToken: result.sessionToken }), null);
    assert.equal(await owner.authCommand('sessionCurrent', { token: result.sessionToken }), false);
    assert.ok(await owner.command('memberSnapshot', { accessKey: key }));
  } finally { await owner.close(); }
}, false));

test('both original files are reserved against mixed owners until the original worker exit', () => fixture(async f => {
  const owner = new AsyncHubMemberOwner(config(f), quiet);
  try {
    await owner.open();
    assert.throws(() => new HubStore(f.file, undefined));
    assert.throws(() => openSqliteAuth(f.authFile, [], () => undefined));
    assert.throws(() => new AsyncSqliteAuthOwner({ file: f.authFile, legacyFiles: [] }, quiet));
    assert.throws(() => new AsyncHubMemberOwner({ file: f.authFile }, quiet));
  } finally { await owner.close(); }
  const releaseHub = startupDatabaseOwners.reserveExclusive(f.file), releaseAuth = startupDatabaseOwners.reserveExclusive(f.authFile);
  releaseHub(); releaseAuth();
}));

for (const alias of ['same', 'hardlink', 'symlink'] as const) {
  test(`colocated ${alias} Auth/Hub alias refuses construction and releases the partial reservation`, () => fixture(async f => {
    const authFile = alias === 'same' ? f.file : join(f.root, alias + '.sqlite');
    if (alias === 'hardlink') linkSync(f.file, authFile);
    if (alias === 'symlink') symlinkSync(f.file, authFile);
    assert.throws(() => new AsyncHubMemberOwner({ ...config(f), auth: { file: authFile, legacyFiles: [] } }, quiet), HubMemberOwnerUnavailable);
    const release = startupDatabaseOwners.reserveExclusive(f.file); release();
  }));
}

test('throwing original native construction releases BOTH reservations, without opening a replacement', () => fixture(async f => {
  assert.throws(() => new AsyncHubMemberOwner(config(f), quiet, () => { throw Error('isolated'); }), HubMemberOwnerUnavailable);
  const releaseHub = startupDatabaseOwners.reserveExclusive(f.file), releaseAuth = startupDatabaseOwners.reserveExclusive(f.authFile);
  releaseHub(); releaseAuth();
}));

class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = [];
  postMessage(value: { id: number; kind: string; body: string }) { this.messages.push(value); }
  terminate() { return Promise.resolve(1); }
  reply(index: number, value: unknown) { const r = this.messages[index]!;
    this.emit('message', { id: r.id, kind: r.kind, ok: true, body: JSON.stringify(value) }); }
}
const tick = () => new Promise<void>(done => setImmediate(done));
test('close ACK alone releases neither file; only original native exit can do so', () => fixture(async f => {
  const fake = new FakeWorker(), owner = new AsyncHubMemberOwner(config(f), quiet, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' });
  const work = owner.authCommand('sessionCurrent', { token }); const close = owner.close();
  await tick(); assert.equal(fake.messages.length, 1);
  fake.reply(0, { kind: 'sessionCurrent', value: true }); await work; await tick();
  assert.equal(fake.messages[1]!.kind, 'close'); fake.reply(1, null); await tick();
  assert.throws(() => startupDatabaseOwners.reserveExclusive(f.file));
  assert.throws(() => startupDatabaseOwners.reserveExclusive(f.authFile));
  assert.equal(owner.snapshot().ownerExitConfirmed, false);
  fake.emit('exit', 0); await close;
  const releaseHub = startupDatabaseOwners.reserveExclusive(f.file), releaseAuth = startupDatabaseOwners.reserveExclusive(f.authFile);
  releaseHub(); releaseAuth();
}));

test('a same-shape reply for a different original Auth command is a protocol fault, not an authority grant', () => fixture(async f => {
  const fake = new FakeWorker(), owner = new AsyncHubMemberOwner(config(f), quiet, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' });
  const work = owner.authCommand('sessionCurrent', { token }); const rejection = assert.rejects(work, HubMemberOwnerUnavailable);
  await tick(); fake.reply(0, { kind: 'authorized', value: true }); await rejection;
  assert.equal(owner.snapshot().unavailable, true); assert.throws(() => startupDatabaseOwners.reserveExclusive(f.authFile));
  fake.emit('exit', 1); await assert.rejects(owner.close(), HubMemberOwnerUnavailable);
}));

test('Auth config and vocabulary reject paths/callbacks/observed grants on the runtime wire', () => {
  for (const auth of [{ file: ':memory:', legacyFiles: [] }, { file: '/isolated', legacyFiles: [], authorized: true },
    { file: '/isolated', legacyFiles: ['bad\0path'] }]) {
    assert.throws(() => hubMemberOwnerConfig({ file: '/isolated-hub', auth }), HubMemberOwnerUnavailable);
  }
  for (const value of [{ kind: 'sql', input: {} }, { kind: 'authorized', input: { authorized: true } },
    { kind: 'sessionCurrent', input: { token, file: '/other' } }, { kind: 'status', input: {}, granted: true }]) {
    assert.equal(validHubMemberInput('legacyAuth', value), false);
  }
  assert.equal(validHubMemberInput('legacyAuth', { kind: 'sessionCurrent', input: { token } }), true);
  assert.equal(validHubMemberOutput('legacyAuth', { kind: 'sessionCurrent', value: true, authorized: true }), false);
});
