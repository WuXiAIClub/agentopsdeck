import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { PasskeyManager } from './passkeys.js';
import { credentialHashForAudit, keyIdentityHash } from './security.js';

test('passkey manager exposes hashed management ids and revokes one credential only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cod040-passkeys-'));
  const file = join(dir, 'passkeys.json');
  const keyHash = keyIdentityHash('operator-key');
  const initial = {
    credentials: [
      {
        id: 'raw-laptop-credential-id',
        publicKey: Buffer.from('laptop-public-key').toString('base64url'),
        counter: 0,
        transports: ['internal'],
        rpId: 'localhost',
        keyIdentityHash: keyHash,
        label: 'Laptop',
        createdAt: 1000,
      },
      {
        id: 'raw-desktop-credential-id',
        publicKey: Buffer.from('desktop-public-key').toString('base64url'),
        counter: 0,
        transports: ['usb'],
        rpId: 'localhost',
        keyIdentityHash: keyHash,
        label: 'Desktop',
        createdAt: 2000,
      },
    ],
  };
  writeFileSync(file, `${JSON.stringify(initial)}\n`);

  const manager = new PasskeyManager(file);
  const listed = manager.list(keyHash);
  assert.equal(listed.length, 2);
  assert.deepEqual(listed.map((item) => item.label).sort(), ['Desktop', 'Laptop']);
  assert.equal(listed.some((item) => item.id === 'raw-laptop-credential-id'), false);

  const laptopId = credentialHashForAudit('raw-laptop-credential-id');
  const before = readFileSync(file, 'utf8');
  let checks = 0;
  assert.equal(manager.revoke(keyHash, laptopId, undefined, () => { checks++; return false; }), false);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(manager.list(keyHash).length, 2); assert.equal(checks, 1);
  assert.equal(manager.revoke(keyHash, laptopId), true);
  assert.deepEqual(manager.list(keyHash).map((item) => item.label), ['Desktop']);

  const persisted = readFileSync(file, 'utf8');
  assert.match(persisted, /"revokedAt"/);
});

test('registration challenge is single-use and bound to origin and operator identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-passkey-binding-'));
  const manager = new PasskeyManager(join(dir, 'keys.json'));
  const request = new Request('https://hub.example/api/auth', { headers: { origin: 'https://hub.example' } });
  const response = (challenge: string) => ({ response: { clientDataJSON: Buffer.from(JSON.stringify({ challenge })).toString('base64url') } }) as any;
  const first = await manager.registrationOptions(request, 'operator-a');
  assert.equal((await manager.verifyRegistration(request, response(first.challenge), { keyIdentityHash: 'operator-b' })).verified, false);
  assert.equal((await manager.verifyRegistration(request, response(first.challenge), { keyIdentityHash: 'operator-a' })).verified, false, 'mismatch consumes challenge');
  const second = await manager.registrationOptions(request, 'operator-a');
  const other = new Request('https://other.example/api/auth', { headers: { origin: 'https://other.example', 'x-forwarded-host': 'hub.example' } });
  assert.equal((await manager.verifyRegistration(other, response(second.challenge), { keyIdentityHash: 'operator-a' })).verified, false);
  assert.equal((await manager.verifyRegistration(request, response(second.challenge), { keyIdentityHash: 'operator-a' })).verified, false);
});

test('authentication options exclude credentials from another hostname or rotated operator key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-passkey-rotation-'));
  const file = join(dir, 'keys.json');
  const credential = { publicKey: 'ZmFrZQ', counter: 0, label: 'fixture', createdAt: 1 };
  writeFileSync(file, JSON.stringify({ credentials: [
    { ...credential, id: 'b2xk', rpId: 'hub.example', keyIdentityHash: 'old' },
    { ...credential, id: 'bmV3', rpId: 'hub.example', keyIdentityHash: 'new' },
    { ...credential, id: 'b3RoZXI', rpId: 'other.example', keyIdentityHash: 'new' },
  ] }));
  const manager = new PasskeyManager(file);
  const request = new Request('https://hub.example/api/auth', { headers: { origin: 'https://hub.example' } });
  const options = await manager.authenticationOptions(request, 'new');
  assert.deepEqual(options.allowCredentials?.map(item => item.id), ['bmV3']);
  await assert.rejects(manager.authenticationOptions(request, 'missing'), /No passkeys/);
});
