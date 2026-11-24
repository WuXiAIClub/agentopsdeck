import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { AsyncSqliteAuthOwner } from './async-sqlite-owner.js';
import { AsyncSqliteAuthRoutePort } from './async-sqlite-route-port.js';
import { AsyncHubMemberOwner } from '../hub/async-member-owner.js';
import { AuthPersistenceError, writePrivateAuthStore } from './private-store.js';
import { openSqliteAuth } from './sqlite-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { startupDatabaseOwners } from '../storage/startup-owner.js';

const origin = 'https://hub.example', accessKey = 'original-private-config-key';
const digest = createHash('sha256').update(accessKey).digest('hex'), replacement = createHash('sha256').update('replacement-key').digest('hex');
const quiet = () => new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function directory(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-key-binding-')); chmodSync(root, 0o700);
  t.after(() => rmSync(root, { force: true, recursive: true })); return root;
}

for (const colocated of [false, true]) for (const format of ['sqlite', 'json'] as const) for (const fixed of [false, true])
test(`${colocated ? 'Auth+Hub' : 'standalone'} ${format}/${fixed ? 'Key' : 'noKey'} current identity barrier preserves original guard and durable sessions`, async t => {
  const root = directory(t), file = join(root, 'auth.sqlite'), passkeysFile = join(root, 'passkeys.json'), sessionsFile = join(root, 'sessions.json');
  const initial = fixed ? digest.slice(0, 24) : undefined;
  const legacyToken = 'l'.repeat(43), expiredToken = 'e'.repeat(43);
  if (format === 'json') {
    const expiresAt = Date.now() - 1;
    writePrivateAuthStore(sessionsFile, { sessions: [legacyToken, { token: expiredToken, administrator: true,
      ...(initial === undefined ? {} : { keyIdentityHash: initial }),
      issuedAt: expiresAt - 30 * 24 * 60 * 60 * 1000, expiresAt }] });
  }
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = publicKey.export({ format: 'jwk' });
  const id = Buffer.from('binding-signed-credential').toString('base64url');
  const credentials = [{ id, publicKey: Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x!, 'base64url'),
    Buffer.from('225820', 'hex'), Buffer.from(jwk.y!, 'base64url')]).toString('base64url'), counter: 0, rpId: 'hub.example',
    ...(initial === undefined ? {} : { keyIdentityHash: initial }), createdAt: 1, label: 'original passkey' }];
  if (format === 'json') writePrivateAuthStore(passkeysFile, { credentials });
  else {
    const offline = openSqliteAuth(file, [], () => initial);
    try { offline.passkeys.importLegacy(credentials, true); } finally { await offline.close(); }
  }
  const auth = format === 'json' ? { kind: 'json' as const, passkeysFile, sessionsFile } : { file, legacyFiles: [] };
  const owner = colocated
    ? new AsyncHubMemberOwner({ file: join(root, 'hub.sqlite'), encryptionSecret: 'isolated-secret', auth,
      ...(fixed ? { administratorKey: accessKey } : {}) }, quiet())
    : new AsyncSqliteAuthOwner({ ...auth, ...(fixed ? { accessKeyDigest: digest } : {}) }, quiet());
  t.after(() => owner.closeForShutdown()); await owner.open();
  const capability = owner instanceof AsyncHubMemberOwner ? owner.legacyAuth! : owner;
  const port = new AsyncSqliteAuthRoutePort(capability, fixed ? digest : undefined), request = new Request(origin);
  if (format === 'json') {
    assert.equal(await port.sessions.has!(legacyToken), false);
    assert.equal(await port.sessions.has!(expiredToken), false);
  }
  const adminToken = 'u'.repeat(43);
  await port.sessions.add(adminToken);
  assert.equal(await port.sessions.has!(adminToken), true);
  const options = await port.passkeys.authenticationOptions(request, initial);
  const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin }));
  const authenticator = Buffer.alloc(37); createHash('sha256').update('hub.example').digest().copy(authenticator);
  authenticator[32] = 5; authenticator.writeUInt32BE(1, 33);
  const response: AuthenticationResponseJSON = { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: {
    clientDataJSON: client.toString('base64url'), authenticatorData: authenticator.toString('base64url'),
    signature: sign('sha256', Buffer.concat([authenticator, createHash('sha256').update(client).digest()]), privateKey).toString('base64url'),
  } };
  const result = await port.passkeys.verifyAuthentication(request, response, initial);
  assert.equal(result.verified, true); if (!result.verified) throw Error('verification failed');
  assert.equal(await result.isCurrent!(), true);
  assert.ok('sessionToken' in result && typeof result.sessionToken === 'string');
  const token = result.sessionToken;
  assert.equal(await port.sessions.has!(token), true);

  // Accepted original work is not cancelled or replayed. Its old delivery is
  // refused even if the original SQL read succeeds before the update ACK.
  const oldRead = capability.command('sessionCurrent', { token });
  const stale = assert.rejects(oldRead, AuthPersistenceError);
  const update = owner.updateCurrentKeyIdentity(replacement.slice(0, 24));
  assert.throws(() => capability.currentKeyBinding!.capture(), AuthPersistenceError);
  await assert.rejects(capability.command('status', {}));
  await stale; await update;
  await assert.rejects(Promise.resolve().then(() => result.isCurrent!()), AuthPersistenceError);
  assert.equal(await port.sessions.has!(token), false);
  assert.equal(await port.sessions.has!(adminToken), false);
  assert.equal(await port.authority.authorize(new Request(origin, { headers: { 'x-agentopsdeck-key': accessKey } })), true);
  assert.equal(await port.authority.authorize(new Request(origin, { headers: { 'x-agentopsdeck-key': 'replacement-key' } })), !fixed);

  await owner.updateCurrentKeyIdentity(initial);
  assert.equal(await port.sessions.has!(token), true); // Original filter, no persistent deletion.
  assert.equal(await port.sessions.has!(adminToken), true);
  await assert.rejects(Promise.resolve().then(() => result.isCurrent!()), AuthPersistenceError);
  if (capability.originalJson) assert.equal(await capability.originalJson.session({ action: 'authentication-current', token }), false);
  if (owner instanceof AsyncHubMemberOwner) await assert.rejects(owner.command('legacyAuth', { kind: 'currentKeyBinding', input: { epoch: 3 } }));
  else await assert.rejects((owner.command as (kind: string, input: unknown) => Promise<unknown>)('currentKeyBinding', { epoch: 3 }));

  // Closing after an accepted update must drain the update, not reject it
  // because close has already synchronously frozen ordinary admission.
  const lastUpdate = owner.updateCurrentKeyIdentity(initial), close = owner.close();
  await lastUpdate; await close;
  assert.equal(owner.snapshot().ownerExitConfirmed, true);
});

class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = [];
  postMessage(message: { id: number; kind: string; body: string }) { this.messages.push(message); }
  terminate() { return Promise.resolve(1); } // Not proof of actual exit.
  reply(index: number, value: unknown) {
    const message = this.messages[index]!;
    this.emit('message', { id: message.id, kind: message.kind, ok: true, body: JSON.stringify(value) });
  }
}
for (const colocated of [false, true]) for (const unknown of [false, true])
test(`${colocated ? 'Auth+Hub' : 'standalone'} ${unknown ? 'unknown update' : 'update ACK'} never releases original file reservations before exit`, async t => {
  const root = directory(t), file = join(root, 'auth.sqlite'), hubFile = join(root, 'hub.sqlite'), fake = new FakeWorker();
  const owner = colocated
    ? new AsyncHubMemberOwner({ file: hubFile, auth: { file, legacyFiles: [] } }, quiet(), () => fake as unknown as Worker)
    : new AsyncSqliteAuthOwner({ file, legacyFiles: [] }, quiet(), () => fake as unknown as Worker);
  t.after(async () => { fake.emit('exit', 1); await owner.closeForShutdown(); });
  fake.emit('message', { kind: 'ready' }); await owner.open();
  const update = owner.updateCurrentKeyIdentity(replacement.slice(0, 24));
  const result = unknown ? assert.rejects(update) : update;
  const close = owner.close(), closed = unknown ? assert.rejects(close) : close;
  await tick(); assert.equal(fake.messages.length, 1);
  const input = JSON.parse(fake.messages[0]!.body);
  const binding = colocated ? input.input : input;
  const ack = { ...binding, epoch: unknown ? 99 : binding.epoch };
  fake.reply(0, colocated ? { kind: 'currentKeyBinding', value: ack } : ack);
  await result; await tick();
  assert.throws(() => startupDatabaseOwners.reserveExclusive(file));
  if (colocated) assert.throws(() => startupDatabaseOwners.reserveExclusive(hubFile));
  if (!unknown) {
    assert.equal(fake.messages.length, 2); assert.equal(fake.messages[1]!.kind, 'close');
    fake.reply(1, null); await tick();
  } else {
    const capability = owner instanceof AsyncHubMemberOwner ? owner.legacyAuth! : owner;
    assert.throws(() => capability.currentKeyBinding!.capture(), AuthPersistenceError);
    await assert.rejects(owner.updateCurrentKeyIdentity());
  }
  assert.equal(owner.snapshot().ownerExitConfirmed, false);
  fake.emit('exit', unknown ? 1 : 0); await closed;
  const release = startupDatabaseOwners.reserveExclusive(file); release();
});
