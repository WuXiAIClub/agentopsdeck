import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { OriginalJsonAuthCommandStore } from './original-json-command-store.js';
import { executeOriginalJsonAuthCommand, validOriginalJsonAuthCommand } from './original-json-command-domain.js';
import { PasskeyVerificationCapacityError } from './passkeys.js';
import { writePrivateAuthStore, AuthPersistenceError } from './private-store.js';
import { AsyncSqliteAuthRoutePort, type SqliteAuthRouteOwner } from './async-sqlite-route-port.js';
import { keyIdentityHash } from './security.js';

const accessKey = 'test-json-delivery-key', key = keyIdentityHash(accessKey)!;
const digest = createHash('sha256').update(accessKey).digest('hex'), origin = 'https://hub.example';
async function fixture(work: (f: {
  store: OriginalJsonAuthCommandStore; setNow(now: number): void;
  assertion(counter: number): Promise<AuthenticationResponseJSON>;
  reopen(): OriginalJsonAuthCommandStore; sessionsFile: string;
}) => Promise<void>, maxAuthenticationDeliveries = 256) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-json-delivery-'));
  const passkeysFile = join(root, 'passkeys.json'), sessionsFile = join(root, 'sessions.json');
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const publicCose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x!, 'base64url'),
    Buffer.from('225820', 'hex'), Buffer.from(jwk.y!, 'base64url')]);
  const id = Buffer.from('json-delivery-credential').toString('base64url');
  writePrivateAuthStore(passkeysFile, { credentials: [{ id, publicKey: publicCose.toString('base64url'),
    counter: 0, rpId: 'hub.example', keyIdentityHash: key, createdAt: 1 }] });
  let now = 1_000_000;
  const stores: OriginalJsonAuthCommandStore[] = [];
  const open = () => {
    const store = new OriginalJsonAuthCommandStore(passkeysFile, sessionsFile, key, { now: () => now, maxAuthenticationDeliveries });
    stores.push(store); return store;
  };
  const store = open();
  try {
    await work({ store, setNow: value => { now = value; }, sessionsFile,
      reopen: () => { store.close(); return open(); },
      assertion: async counter => {
        const options = await store.authenticationOptions(new Request(origin), key);
        const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin }));
        const authenticator = Buffer.alloc(37); createHash('sha256').update('hub.example').digest().copy(authenticator);
        authenticator[32] = 5; authenticator.writeUInt32BE(counter, 33);
        return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: {
          clientDataJSON: client.toString('base64url'), authenticatorData: authenticator.toString('base64url'),
          signature: sign('sha256', Buffer.concat([authenticator, createHash('sha256').update(client).digest()]), privateKey).toString('base64url'),
        } };
      },
    });
  } finally { for (const store of stores) store.close(); rmSync(root, { recursive: true, force: true }); }
}

test('JSON delivery retains the original challenge deadline, not verification time or durable session lifetime', () => fixture(async f => {
  const response = await f.assertion(1);
  f.setNow(1_299_999);
  const result = await f.store.verifyAuthentication(new Request(origin), response, key);
  assert.equal(result.verified, true); if (!result.verified) return;
  assert.equal(result.isCurrent(), true);
  assert.equal(executeOriginalJsonAuthCommand(f.store, digest, { kind: 'originalJsonSession',
    input: { action: 'authentication-current', token: result.sessionToken } }).value, true);
  f.setNow(1_300_000);
  assert.equal(result.isCurrent(), false);
  assert.equal(f.store.sessionAuthorized(result.sessionToken), true, 'delivery expiry must not log out a valid session');
  f.setNow(1_100_000);
  assert.equal(result.isCurrent(), false, 'a refused proof must not resurrect after a clock rollback');
}));

test('JSON owner restart preserves the login but never reconstructs an old delivery proof', () => fixture(async f => {
  const result = await f.store.verifyAuthentication(new Request(origin), await f.assertion(1), key);
  assert.equal(result.verified, true); if (!result.verified) return;
  assert.equal(result.isCurrent(), true);
  const reopened = f.reopen();
  assert.equal(reopened.sessionAuthorized(result.sessionToken), true);
  assert.equal(reopened.authenticationCurrent(result.sessionToken), false);
  assert.throws(() => result.isCurrent(), AuthPersistenceError);
}));

test('JSON revocation and logout invalidate exact retained delivery proofs', () => fixture(async f => {
  const first = await f.store.verifyAuthentication(new Request(origin), await f.assertion(1), key);
  assert.equal(first.verified, true); if (!first.verified) return;
  assert.equal(f.store.deleteSession(first.sessionToken), true); assert.equal(first.isCurrent(), false);
  const second = await f.store.verifyAuthentication(new Request(origin), await f.assertion(2), key);
  assert.equal(second.verified, true); if (!second.verified) return;
  assert.equal(f.store.revoke(key, second.credentialHash), true);
  assert.equal(second.isCurrent(), false); assert.equal(f.store.sessionAuthorized(second.sessionToken), false);
}));

test('JSON proof capacity reserves before crypto, never burns the rejected challenge and reclaims only ended deliveries', () => fixture(async f => {
  const firstResponse = await f.assertion(1), secondResponse = await f.assertion(2);
  const firstPending = f.store.verifyAuthentication(new Request(origin), firstResponse, key);
  await assert.rejects(f.store.verifyAuthentication(new Request(origin), secondResponse, key), PasskeyVerificationCapacityError);
  const first = await firstPending;
  assert.equal(first.verified, true); if (!first.verified) return;
  const before = readFileSync(f.sessionsFile, 'utf8');
  await assert.rejects(f.store.verifyAuthentication(new Request(origin), secondResponse, key), PasskeyVerificationCapacityError);
  assert.equal(readFileSync(f.sessionsFile, 'utf8'), before);
  assert.equal(first.isCurrent(), true, 'capacity refusal cannot evict a live proof');
  assert.equal(f.store.deleteSession(first.sessionToken), true);
  const second = await f.store.verifyAuthentication(new Request(origin), secondResponse, key);
  assert.equal(second.verified, true); if (!second.verified) return;
  f.setNow(1_300_000);
  const third = await f.store.verifyAuthentication(new Request(origin), await f.assertion(3), key);
  assert.equal(third.verified, true, 'expired proof frees capacity without a logout');
  assert.equal(f.store.sessionAuthorized(second.sessionToken), true);
}, 1));

test('JSON delivery fixed command accepts only an opaque token, never a caller-supplied proof', () => {
  const input = { action: 'authentication-current', token: 'a'.repeat(43) };
  assert.equal(validOriginalJsonAuthCommand({ kind: 'originalJsonSession', input }), true);
  for (const field of ['authorized', 'isCurrent', 'expiresAt']) {
    assert.equal(validOriginalJsonAuthCommand({ kind: 'originalJsonSession', input: { ...input, [field]: true } }), false);
  }
});

test('route port uses JSON delivery proof, while SQLite retains its original session-current check', async () => {
  for (const json of [false, true]) {
    const calls: string[] = [];
    const owner = {
      assertAccessKeyBinding: () => {}, snapshot: () => ({}),
      command: async (kind: string) => {
        calls.push(kind);
        if (kind === 'verifyAuthentication') return { verified: true, sessionToken: 'a'.repeat(43), credentialHash: 'b'.repeat(24) };
        return true;
      },
      ...(json ? { originalJson: { session: async ({ action }: { action: string }) => { calls.push(action); return false; },
        authorized: async () => false } } : {}),
    } as unknown as SqliteAuthRouteOwner;
    const port = new AsyncSqliteAuthRoutePort(owner, digest);
    const result = await port.passkeys.verifyAuthentication(new Request(origin), {} as AuthenticationResponseJSON, key);
    assert.equal(result.verified, true); if (!result.verified) return;
    assert.equal(await result.isCurrent(), !json);
    assert.deepEqual(calls, ['verifyAuthentication', json ? 'authentication-current' : 'sessionCurrent']);
  }
});
