import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { AsyncSqliteAuthOwner, encodeSqliteAuthJson } from './async-sqlite-owner.js';
import { sqliteAuthEvidenceFromRequest } from './sqlite-owner-domain.js';
import { SqlitePasskeys } from './sqlite-passkeys.js';
import { createDeckSession, PasskeyChallengeCapacityError, PasskeyVerificationCapacityError, PasskeyVerificationRateError, PasskeyVerificationRejectedError } from './passkeys.js';
import { credentialHashForAudit } from './security.js';
import { AuthPersistenceError } from './private-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const accessKeyDigest = 'a'.repeat(64), key = accessKeyDigest.slice(0, 24), origin = 'https://hub.example';
test('real auth exit fences late stop rejection without false cleanup-unknown evidence', async () => {
  let reject!: (error: Error) => void;
  const original = new Promise<number>((_, no) => { reject = no; });
  class Transport extends EventEmitter {
    stops = 0;
    terminate() { this.stops++; return original; }
    postMessage() { assert.fail('A failed original owner cannot dispatch SQL'); }
  }
  const worker = new Transport(), events: Record<string, unknown>[] = [];
  const owner = new AsyncSqliteAuthOwner({ file: 'isolated-late-stop', legacyFiles: [] },
    new PerformanceDiagnostics(line => events.push(JSON.parse(line))), () => worker as unknown as Worker);
  worker.emit('error', Error('private-original-error'));
  const close = owner.close(); void close.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.stops, 1);
  worker.emit('exit', 1); await owner.closeForShutdown();
  const exitIndex = events.findIndex(event => event.operation === 'auth-sqlite-owner' && event.step === 2);
  assert.ok(exitIndex >= 0);
  reject(Error('private-late-stop-error'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.slice(exitIndex + 1).some(event => event.operation === 'auth-sqlite-owner'
    && event.step === 4), false);
  assert.equal(worker.stops, 1);
  assert.equal(JSON.stringify(events).includes('private-'), false);
});
async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-async-auth-owner-')); chmodSync(dir, 0o700);
  const file = join(dir, 'auth.sqlite');
  const db = new DatabaseSync(file); chmodSync(file, 0o600);
  const store = new SqlitePasskeys(db, () => key);
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x!, 'base64url'),
    Buffer.from('225820', 'hex'), Buffer.from(jwk.y!, 'base64url')]);
  const id = Buffer.from('async-auth-worker-fixture').toString('base64url');
  store.importLegacy([{ id, publicKey: cose.toString('base64url'), counter: 0, rpId: 'hub.example',
    keyIdentityHash: key, createdAt: 1, label: 'fixture' }], true);
  db.close(); // Offline fixture owner is CLOSED before the new complete owner.
  const logs: string[] = [];
  const owner = new AsyncSqliteAuthOwner({ file, legacyFiles: [], accessKeyDigest }, new PerformanceDiagnostics(line => logs.push(line)));
  t.after(async () => { await owner.closeForShutdown(); rmSync(dir, { recursive: true, force: true }); });
  await owner.open();
  const assertion = (challenge: string, counter = 1): AuthenticationResponseJSON => {
    const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin })), auth = Buffer.alloc(37);
    createHash('sha256').update('hub.example').digest().copy(auth); auth[32] = 5; auth.writeUInt32BE(counter, 33);
    return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: {
      clientDataJSON: client.toString('base64url'), authenticatorData: auth.toString('base64url'),
      signature: sign('sha256', Buffer.concat([auth, createHash('sha256').update(client).digest()]), privateKey).toString('base64url'),
    } };
  };
  const registration = (challenge: string) => {
    const credentialId = Buffer.from('new-async-auth-worker-fixture'), auth = Buffer.alloc(55);
    createHash('sha256').update('hub.example').digest().copy(auth); auth[32] = 69; auth.writeUInt16BE(credentialId.length, 53);
    const attestation = isoCBOR.encode(new Map<string, string | Map<string, string> | Uint8Array>([
      ['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(Buffer.concat([auth, credentialId, cose]))],
    ]));
    return { id: credentialId.toString('base64url'), rawId: credentialId.toString('base64url'), type: 'public-key' as const,
      clientExtensionResults: {}, response: { clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin })).toString('base64url'),
        attestationObject: Buffer.from(attestation).toString('base64url') } };
  };
  return { owner, file, logs, id, assertion, registration };
}
test('real registration consumes its original challenge and retains credential/audit in one worker owner', async t => {
  const h = await fixture(t), evidence = { suppliedKeyDigest: accessKeyDigest };
  const options = await h.owner.command('registrationOptions', { origin, evidence });
  const response = h.registration(options.challenge);
  const result = await h.owner.command('verifyRegistration', { origin, evidence, response, label: 'new key' });
  assert.ok(result.verified); assert.equal(result.count, 2);
  assert.equal(await h.owner.command('credentialCurrent', { credentialHash: result.credentialHash }), true);
  assert.equal((await h.owner.command('verifyRegistration', { origin, evidence, response })).verified, false);
  assert.equal((await h.owner.command('list', {})).length, 2);
});
test('registration final transaction rejects evidence revoked after challenge issuance and burns challenge', async t => {
  const h = await fixture(t), options = await h.owner.command('authenticationOptions', { origin });
  const session = await h.owner.command('verifyAuthentication', { origin, response: h.assertion(options.challenge) }); assert.ok(session.verified);
  const evidence = { sessionToken: session.sessionToken };
  const creation = await h.owner.command('registrationOptions', { origin, evidence });
  await h.owner.command('revoke', { credentialHash: session.credentialHash, evidence: { suppliedKeyDigest: accessKeyDigest } });
  const response = h.registration(creation.challenge);
  assert.equal((await h.owner.command('verifyRegistration', { origin, evidence, response })).verified, false);
  assert.equal((await h.owner.command('verifyRegistration', { origin, evidence: { suppliedKeyDigest: accessKeyDigest }, response })).verified, false);
  assert.equal((await h.owner.command('status', {})).count, 0);
});
test('real threaded SQL verifies signed assertion and commits digest session/counter/audit together', async t => {
  const h = await fixture(t);
  const options = await h.owner.command('authenticationOptions', { origin });
  const result = await h.owner.command('verifyAuthentication', { origin, response: h.assertion(options.challenge) });
  assert.ok(result.verified);
  assert.equal(await h.owner.command('sessionCurrent', { token: result.sessionToken }), true);
  assert.equal(await h.owner.command('accessKeySession', { token: result.sessionToken }), false);
  assert.equal(await h.owner.command('authorized', { sessionToken: result.sessionToken }), true);
  assert.equal('isCurrent' in result, false);
  assert.equal((await h.owner.command('verifyAuthentication', { origin, response: h.assertion(options.challenge) })).verified, false);
  await h.owner.close();
  const db = new DatabaseSync(h.file, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) n FROM shared_auth_sessions').get()!.n, 1);
    assert.equal(JSON.parse(db.prepare('SELECT payload FROM shared_auth_credentials').get()!.payload as string).counter, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM shared_auth_audit WHERE kind='issued'").get()!.n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM shared_auth_challenges').get()!.n, 0);
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM shared_auth_sessions').all()).includes(result.sessionToken));
  } finally { db.close(); }
  assert.ok(h.logs.some(line => JSON.parse(line).operation === 'auth-sqlite-command'));
  assert.ok(!h.logs.join('').includes(result.sessionToken));
  assert.ok(!h.logs.join('').includes(h.file));
});
test('revocation uses original SQL session evidence and blocks stale authorized decisions', async t => {
  const h = await fixture(t), options = await h.owner.command('authenticationOptions', { origin });
  const result = await h.owner.command('verifyAuthentication', { origin, response: h.assertion(options.challenge) }); assert.ok(result.verified);
  const stale = { sessionToken: result.sessionToken };
  assert.equal(await h.owner.command('authorized', stale), true);
  const credentialHash = credentialHashForAudit(h.id);
  assert.equal(await h.owner.command('revoke', { credentialHash, evidence: stale }), true);
  assert.equal(await h.owner.command('authorized', stale), false);
  assert.equal(await h.owner.command('clearSessions', { evidence: stale }), false);
  assert.equal(await h.owner.command('credentialCurrent', { credentialHash }), false);
  await assert.rejects(h.owner.command('registrationOptions', { origin, evidence: stale }), AuthPersistenceError);
});
test('administrator issuance requires key evidence, does not elevate a passkey or unknown session', async t => {
  const h = await fixture(t), token = createDeckSession();
  await assert.rejects(h.owner.command('issueAdministratorSession', { token, evidence: {} }), AuthPersistenceError);
  await assert.rejects(h.owner.command('issueAdministratorSession', { token, evidence: { suppliedKeyDigest: 'b'.repeat(64) } }), AuthPersistenceError);
  assert.equal(await h.owner.command('sessionCurrent', { token }), false);
  await h.owner.command('issueAdministratorSession', { token, evidence: { suppliedKeyDigest: accessKeyDigest } });
  assert.equal(await h.owner.command('accessKeySession', { token }), true);
  assert.equal(await h.owner.command('clearSessions', { evidence: { sessionToken: token } }), true);
  assert.equal(await h.owner.command('sessionCurrent', { token }), false);
});
test('SQL body refusal rolls back session and audit without poisoning or replaying the owner', async t => {
  const h = await fixture(t), token = createDeckSession();
  const db = new DatabaseSync(h.file);
  try { db.exec("CREATE TRIGGER reject_session BEFORE INSERT ON shared_auth_sessions BEGIN SELECT RAISE(ABORT,'private-fixture'); END"); }
  finally { db.close(); }
  await assert.rejects(h.owner.command('issueAdministratorSession', { token, evidence: { suppliedKeyDigest: accessKeyDigest } }), AuthPersistenceError);
  assert.equal(await h.owner.command('sessionCurrent', { token }), false);
  await h.owner.close();
  const observation = new DatabaseSync(h.file, { readOnly: true });
  try {
    assert.equal(observation.prepare('SELECT count(*) n FROM shared_auth_sessions').get()!.n, 0);
    assert.equal(observation.prepare("SELECT count(*) n FROM shared_auth_audit WHERE kind='administrator-issued'").get()!.n, 0);
  } finally { observation.close(); }
  assert.ok(!h.logs.join('').includes('private-fixture'));
});
test('a real SQLite writer lock waits in the owner thread while main loop can release its fixture lock', async t => {
  const h = await fixture(t), blocker = new DatabaseSync(h.file), token = createDeckSession();
  blocker.exec('BEGIN IMMEDIATE');
  let timerRan = false;
  const release = setTimeout(() => { timerRan = true; blocker.exec('ROLLBACK'); }, 50);
  try {
    await h.owner.command('issueAdministratorSession', { token, evidence: { suppliedKeyDigest: accessKeyDigest } });
    assert.equal(timerRan, true);
    assert.equal(await h.owner.command('sessionCurrent', { token }), true);
  } finally { clearTimeout(release); if (blocker.isTransaction) blocker.exec('ROLLBACK'); blocker.close(); }
});
test('same-data reopening after proven exit preserves revocation, never restores an old session', async t => {
  const h = await fixture(t), token = createDeckSession();
  await h.owner.command('issueAdministratorSession', { token, evidence: { suppliedKeyDigest: accessKeyDigest } });
  await h.owner.command('deleteSession', { token });
  await h.owner.close(); assert.equal(h.owner.snapshot().ownerExitConfirmed, true);
  const next = new AsyncSqliteAuthOwner({ file: h.file, legacyFiles: [], accessKeyDigest });
  try { await next.open(); assert.equal(await next.command('sessionCurrent', { token }), false); }
  finally { await next.closeForShutdown(); }
});

test('real SQL commit with damaged ACK stays unknown; stopped-data reconciliation finds one original issuance without replay', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-auth-lost-ack-')); chmodSync(dir, 0o700);
  const file = join(dir, 'auth.sqlite'), token = createDeckSession(), logs: string[] = [];
  const entry = new URL(import.meta.url.endsWith('.ts') ? './sqlite-owner-worker.ts' : './sqlite-owner-worker.js', import.meta.url);
  const original = new Worker(`(async () => {
    const { workerData } = require('node:worker_threads');
    if (workerData.loader) { const { tsImport } = await import(workerData.loader); await tsImport(workerData.entry, workerData.entry); }
    else await import(workerData.entry);
  })().catch(() => process.exit(1));`, { eval: true, execArgv: [], workerData: {
    file, legacyFiles: [], accessKeyDigest, entry: entry.href,
    loader: import.meta.url.endsWith('.ts') ? import.meta.resolve('tsx/esm/api') : undefined,
  } });
  // Test-owned transport injection only. SQL still runs in the real complete
  // production worker; never expose a fault-injection command to the app.
  const transport = new EventEmitter(); let committed = false, issues = 0, stops = 0;
  Object.assign(transport, {
    postMessage(message: { kind: string }) { if (message.kind === 'issueAdministratorSession') issues++; original.postMessage(message); },
    terminate() { stops++; return original.terminate(); },
  });
  original.on('message', message => {
    if (message.kind === 'issueAdministratorSession' && message.ok === true) {
      committed = true; transport.emit('message', { ...message, unexpected: 'private-ack-fixture' });
    } else transport.emit('message', message);
  });
  original.on('error', error => transport.emit('error', error));
  original.on('exit', code => transport.emit('exit', code));
  const owner = new AsyncSqliteAuthOwner({ file, legacyFiles: [], accessKeyDigest },
    new PerformanceDiagnostics(line => logs.push(line)), () => transport as unknown as Worker);
  t.after(async () => { await owner.closeForShutdown(); rmSync(dir, { recursive: true, force: true }); });
  await owner.open();
  await assert.rejects(owner.command('issueAdministratorSession', { token, evidence: { suppliedKeyDigest: accessKeyDigest } }), AuthPersistenceError);
  assert.equal(committed, true); assert.equal(issues, 1); assert.equal(owner.snapshot().unavailable, true);
  await assert.rejects(owner.command('sessionCurrent', { token }), AuthPersistenceError);
  assert.equal(stops, 0); assert.equal(owner.snapshot().ownerExitConfirmed, false);
  await owner.closeForShutdown(); assert.equal(stops, 1); assert.equal(owner.snapshot().ownerExitConfirmed, true);
  await assert.rejects(owner.close(), AuthPersistenceError); // Physical exit is not SQL success.
  const next = new AsyncSqliteAuthOwner({ file, legacyFiles: [], accessKeyDigest }, new PerformanceDiagnostics(() => {}));
  try {
    await next.open(); assert.equal(await next.command('sessionCurrent', { token }), true);
    await next.command('deleteSession', { token });
  } finally { await next.closeForShutdown(); }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) n FROM shared_auth_audit WHERE kind='administrator-issued'").get()!.n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM shared_auth_sessions').get()!.n, 0);
  } finally { db.close(); }
  assert.equal(issues, 1);
  assert.ok(logs.some(line => { const e = JSON.parse(line); return e.operation === 'auth-sqlite-command' && e.step === 6 && e.unknown === 1; }));
  for (const secret of [token, accessKeyDigest, dir, 'private-ack-fixture']) assert.equal(logs.join('').includes(secret), false);
});

class FakeOwner extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = [];
  stops = 0;
  dispatchFails = false;
  stopMode: 'resolved' | 'thrown' | 'rejected' = 'resolved';
  postMessage(value: { id: number; kind: string; body: string }) {
    if (this.dispatchFails) throw Error('private-dispatch');
    this.messages.push(value);
  }
  terminate() {
    this.stops++;
    if (this.stopMode === 'thrown') throw Error('private-stop');
    return this.stopMode === 'rejected' ? Promise.reject(Error('private-stop')) : Promise.resolve(1);
  } // Deliberately not exit proof.
  reply(index: number, body = 'false') {
    const m = this.messages[index]!; this.emit('message', { id: m.id, kind: m.kind, ok: true, body });
  }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function fake(t: TestContext, warningMs = 30_000) {
  const worker = new FakeOwner(), lines: string[] = [];
  const owner = new AsyncSqliteAuthOwner({ file: 'private-path', legacyFiles: [], accessKeyDigest },
    new PerformanceDiagnostics(line => lines.push(line)), () => worker as unknown as Worker, warningMs);
  t.after(async () => { worker.emit('exit', 1); await owner.closeForShutdown(); });
  return { owner, worker, lines };
}
test('fixed-key binding uses the immutable original configuration and never publishes the private digest', async t => {
  const worker = new FakeOwner(), lines: string[] = [];
  const config = { file: 'private-binding-path', legacyFiles: [], accessKeyDigest };
  const owner = new AsyncSqliteAuthOwner(config, new PerformanceDiagnostics(line => lines.push(line)), () => worker as unknown as Worker);
  t.after(async () => { worker.emit('exit', 1); await owner.closeForShutdown(); });
  config.accessKeyDigest = 'b'.repeat(64);
  assert.doesNotThrow(() => owner.assertAccessKeyBinding(accessKeyDigest));
  assert.throws(() => owner.assertAccessKeyBinding(config.accessKeyDigest), AuthPersistenceError);
  assert.throws(() => owner.assertAccessKeyBinding(key + 'b'.repeat(40)), AuthPersistenceError);
  assert.equal(owner.snapshot().accepted, 0); assert.equal(worker.messages.length, 0);
  assert.equal(owner.snapshot().unavailable, false);
  assert.doesNotThrow(() => owner.assertAccessKeyBinding(accessKeyDigest));
  const events = lines.map(line => JSON.parse(line)).filter(e => e.step === 6);
  assert.equal(events.length, 2);
  for (const e of events) { assert.equal(e.deferred, 1); assert.equal(e.unknown, undefined); }
  for (const secret of [accessKeyDigest, config.accessKeyDigest, config.file]) {
    assert.equal(lines.join('').includes(secret), false); assert.equal(JSON.stringify(owner.snapshot()).includes(secret), false);
  }
});
test('a keyless original owner cannot acquire an adapter key without a complete owner replacement', async t => {
  const worker = new FakeOwner();
  const owner = new AsyncSqliteAuthOwner({ file: 'private-keyless-path', legacyFiles: [] },
    new PerformanceDiagnostics(() => {}), () => worker as unknown as Worker);
  t.after(async () => { worker.emit('exit', 1); await owner.closeForShutdown(); });
  assert.throws(() => owner.assertAccessKeyBinding(accessKeyDigest), AuthPersistenceError);
  assert.equal(worker.messages.length, 0); assert.equal(owner.snapshot().unavailable, false);
});
for (const ready of [false, true]) test(`close-wait observation includes original command drain (worker ready=${ready}) without a forced release`, async t => {
  const h = fake(t, 10);
  if (ready) h.worker.emit('message', { kind: 'ready' });
  const command = h.owner.command('sessionCurrent', { token: createDeckSession() }), close = h.owner.close();
  let closed = false; void close.then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 40));
  const waiting = h.lines.map(line => JSON.parse(line)).find(e => e.operation === 'auth-sqlite-owner' && e.step === 5);
  assert.ok(waiting); assert.equal(waiting.pending, 1); assert.equal(waiting.unknown, 1);
  assert.equal(closed, false); assert.equal(h.owner.snapshot().accepted, 1);
  assert.equal(h.worker.stops, 0); assert.equal(h.worker.messages.length, ready ? 1 : 0);
  assert.equal(h.owner.close(), close);
  if (!ready) h.worker.emit('message', { kind: 'ready' });
  await turn(); h.worker.reply(0); assert.equal(await command, false); await turn();
  assert.equal(h.worker.messages.length, 2); assert.equal(h.worker.messages[1]!.kind, 'close');
  h.worker.reply(1, 'null'); await turn(); assert.equal(closed, false);
  h.worker.emit('exit', 0); await close;
});
for (const kind of ['verifyRegistration', 'verifyAuthentication'] as const)
  test(`cryptographic refusal is allowed only for ${kind}, stays sanitized and does not retire the original owner`, async t => {
    const h = fake(t); h.worker.emit('message', { kind: 'ready' });
    // Input is generated from the offline signed fixture, never a test bypass
    // in the production worker protocol.
    const real = await fixture(t), evidence = { suppliedKeyDigest: accessKeyDigest };
    const options = await real.owner.command('registrationOptions', { origin, evidence });
    const authOptions = await real.owner.command('authenticationOptions', { origin });
    const work = kind === 'verifyRegistration'
      ? h.owner.command(kind, { origin, evidence, response: real.registration(options.challenge) })
      : h.owner.command(kind, { origin, response: real.assertion(authOptions.challenge) });
    await turn(); const message = h.worker.messages[0]!;
    h.worker.emit('message', { id: message.id, kind, ok: false, refusal: 5, retryAfterSeconds: 0 });
    await assert.rejects(work, e => e instanceof PasskeyVerificationRejectedError && e.message === 'passkey_verification_rejected');
    assert.equal(h.owner.snapshot().unavailable, false);
    const event = h.lines.map(line => JSON.parse(line)).find(e => e.operation === 'auth-sqlite-command' && e.deferred === 1)!;
    assert.ok(event); assert.equal(event.unknown, undefined);
  });

test('pre-dispatch refusals have bounded numeric logs, never inspect getters or claim an unknown write', async t => {
  const h = fake(t); h.worker.emit('message', { kind: 'ready' }); let reads = 0;
  const input = Object.defineProperty({}, 'token', { enumerable: true, get: () => { reads++; throw Error('private-refused-token'); } });
  await assert.rejects(h.owner.command('sessionCurrent', input as { token: string }), AuthPersistenceError);
  assert.equal(reads, 0); assert.equal(h.worker.messages.length, 0); assert.equal(h.owner.snapshot().accepted, 0);
  const event = h.lines.map(line => JSON.parse(line)).find(e => e.operation === 'auth-sqlite-command')!;
  assert.equal(event.step, 4); assert.equal(event.deferred, 1); assert.equal(event.unknown, undefined); assert.equal(event.admitted, undefined);
  assert.equal(h.lines.join('').includes('private-refused-token'), false);
});

for (const [kind, refusal, Expected] of [
  ['authenticationOptions', 1, PasskeyChallengeCapacityError],
  ['verifyAuthentication', 2, PasskeyVerificationCapacityError],
  ['verifyAuthentication', 3, PasskeyVerificationRateError],
] as const) test(`known admission refusal ${refusal} stays typed, not unknown SQL or writer retirement`, async t => {
  const h = fake(t); h.worker.emit('message', { kind: 'ready' });
  const input = kind === 'authenticationOptions' ? { origin } : { origin, response: {
    id: 'test', rawId: 'test', type: 'public-key', clientExtensionResults: {},
    response: { clientDataJSON: 'test', authenticatorData: 'test', signature: 'test' },
  } };
  const work = h.owner.command(kind, input as never); await turn();
  const message = h.worker.messages[0]!;
  h.worker.emit('message', { id: message.id, kind, ok: false, refusal, retryAfterSeconds: 1 });
  await assert.rejects(work, Expected); await turn();
  assert.equal(h.owner.snapshot().unavailable, false); assert.equal(h.worker.messages.length, 1);
  assert.ok(h.lines.some(line => { const e = JSON.parse(line); return e.deferred === 1 && e.unknown === undefined; }));
});

for (const malformed of [
  { refusal: 4, retryAfterSeconds: 1 }, { refusal: 1, retryAfterSeconds: 0 },
  { refusal: 1, retryAfterSeconds: 86401 }, { refusal: 1, retryAfterSeconds: '1' },
  { refusal: 2, retryAfterSeconds: 1 }, { refusal: 1, retryAfterSeconds: 1, error: 'private-text' },
  { refusal: 5, retryAfterSeconds: 0 }, { refusal: 5, retryAfterSeconds: 1 },
]) test(`malformed or wrong-domain refusal retires original protocol owner: ${JSON.stringify(malformed)}`, async t => {
  const h = fake(t); h.worker.emit('message', { kind: 'ready' });
  const work = h.owner.command('authenticationOptions', { origin }); await turn();
  const message = h.worker.messages[0]!;
  h.worker.emit('message', { id: message.id, kind: message.kind, ok: false, ...malformed });
  await assert.rejects(work, AuthPersistenceError); assert.equal(h.owner.snapshot().unavailable, true);
  assert.equal(h.worker.messages.length, 1); assert.equal(h.lines.join('').includes('private-text'), false);
});
test('early close preserves accepted startup commands, freezes new admission and shares the exact close Promise', async t => {
  const h = fake(t), token = createDeckSession();
  const command = h.owner.command('sessionCurrent', { token }), close = h.owner.close();
  assert.equal(h.owner.close(), close);
  await assert.rejects(h.owner.command('sessionCurrent', { token }), AuthPersistenceError);
  h.worker.emit('message', { kind: 'ready' }); await turn();
  assert.equal(h.worker.messages.length, 1); h.worker.reply(0); assert.equal(await command, false); await turn();
  assert.equal(h.worker.messages[1]!.kind, 'close');
  let closed = false; void close.then(() => { closed = true; });
  h.worker.reply(1, 'null'); await turn(); assert.equal(closed, false);
  h.worker.emit('exit', 0); await close;
});
test('pending warning never releases admission, retries a command or terminates the original owner', async t => {
  const h = fake(t, 10); h.worker.emit('message', { kind: 'ready' });
  const command = h.owner.command('sessionCurrent', { token: createDeckSession() });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(h.owner.snapshot().accepted, 1); assert.equal(h.worker.messages.length, 1); assert.equal(h.worker.stops, 0);
  assert.ok(h.lines.some(line => JSON.parse(line).pending === 1));
  h.worker.reply(0); await command;
});
test('unknown transport outcome cannot grant physical shutdown before real worker exit', async t => {
  const h = fake(t); h.worker.emit('message', { kind: 'ready' });
  const command = h.owner.command('sessionCurrent', { token: createDeckSession() }); await turn();
  h.worker.emit('error', Error('private-error')); await assert.rejects(command, AuthPersistenceError);
  const close = h.owner.close(); let shutdown = false;
  const physical = h.owner.closeForShutdown().then(() => { shutdown = true; }); await turn();
  assert.equal(h.worker.stops, 1); assert.equal(shutdown, false);
  await assert.rejects(h.owner.command('status', {}), AuthPersistenceError);
  h.worker.emit('exit', 1); await assert.rejects(close, AuthPersistenceError); await physical;
  assert.equal(h.owner.snapshot().closeAcknowledged, false); assert.equal(h.worker.messages.length, 1);
  assert.ok(!h.lines.join('').includes('private-error'));
});
test('invalid ACK retires original owner; duplicate reply is never a new settlement', async t => {
  const h = fake(t); h.worker.emit('message', { kind: 'ready' });
  const command = h.owner.command('sessionCurrent', { token: createDeckSession() }); await turn();
  h.worker.reply(0, '{"authorized":true}'); await assert.rejects(command, AuthPersistenceError);
  h.worker.reply(0, 'true'); assert.equal(h.owner.snapshot().unavailable, true);
  assert.ok(h.lines.some(line => JSON.parse(line).ownerFailureCode === 4));
});
test('bounded admission is reserved before ready and overflow never reaches worker', async t => {
  const h = fake(t), token = createDeckSession();
  const commands = Array.from({ length: 256 }, () => h.owner.command('sessionCurrent', { token }));
  for (const command of commands) void command.catch(() => {});
  assert.equal(h.owner.snapshot().accepted, 256);
  await assert.rejects(h.owner.command('sessionCurrent', { token }), AuthPersistenceError);
  assert.equal(h.worker.messages.length, 0);
  h.worker.emit('exit', 1); await Promise.allSettled(commands); await turn();
  assert.equal(h.owner.snapshot().acceptedBytes, 0);
});
test('input snapshot cannot be changed after admission', async t => {
  const h = fake(t), token = createDeckSession(), input = { token };
  const command = h.owner.command('sessionCurrent', input); input.token = createDeckSession();
  h.worker.emit('message', { kind: 'ready' }); await turn();
  assert.equal(JSON.parse(h.worker.messages[0]!.body).token, token); h.worker.reply(0); await command;
});
test('callbacks/getters/toJSON/thenables and SQL-shaped commands are refused before owner dispatch', async t => {
  const h = fake(t); h.worker.emit('message', { kind: 'ready' }); let called = 0;
  const hostile = Object.defineProperty({}, 'token', { enumerable: true, get: () => { called++; return createDeckSession(); } });
  await assert.rejects(h.owner.command('sessionCurrent', hostile as { token: string }), AuthPersistenceError);
  await assert.rejects(h.owner.command('authorized', { authorized: true } as never), AuthPersistenceError);
  await assert.rejects(h.owner.command('exec' as never, { sql: 'DROP TABLE shared_auth_sessions' } as never), AuthPersistenceError);
  assert.throws(() => encodeSqliteAuthJson({ toJSON: () => { called++; } }, 1024), AuthPersistenceError);
  assert.throws(() => encodeSqliteAuthJson(Promise.resolve(true), 1024), AuthPersistenceError);
  assert.equal(called, 0); assert.equal(h.worker.messages.length, 0);
});
test('nested, array and revoked Proxies are refused without traps or worker dispatch', async t => {
  const h = fake(t); h.worker.emit('message', { kind: 'ready' }); let traps = 0;
  const handlers: ProxyHandler<object> = {
    getPrototypeOf() { traps++; throw Error('private-proxy-prototype'); },
    ownKeys() { traps++; throw Error('private-proxy-keys'); },
    getOwnPropertyDescriptor() { traps++; throw Error('private-proxy-descriptor'); },
    get() { traps++; throw Error('private-proxy-property'); },
  };
  const proxy = new Proxy({}, handlers), array = new Proxy([], handlers);
  const revoked = Proxy.revocable({}, handlers); revoked.revoke();
  for (const value of [proxy, array, revoked.proxy, { evidence: proxy }, [array]])
    assert.throws(() => encodeSqliteAuthJson(value, 1024), AuthPersistenceError);
  await assert.rejects(h.owner.command('authorized', { evidence: proxy } as never), AuthPersistenceError);
  assert.equal(traps, 0); assert.equal(h.worker.messages.length, 0);
  assert.equal(h.owner.snapshot().accepted, 0); assert.equal(h.owner.snapshot().acceptedBytes, 0);
});
test('Proxy owner configuration is refused before traps or launching a worker', () => {
  let traps = 0, launched = 0;
  const config = new Proxy({ file: 'isolated-config-fixture', legacyFiles: [] }, {
    getPrototypeOf(target) { traps++; return Reflect.getPrototypeOf(target); },
  });
  assert.throws(() => new AsyncSqliteAuthOwner(config, new PerformanceDiagnostics(() => {}),
    () => { launched++; throw Error('private-unexpected-launch'); }), AuthPersistenceError);
  assert.equal(traps, 0); assert.equal(launched, 0);
});
test('byte/depth budgets refuse unbounded input without truncated or partial dispatch', async t => {
  const h = fake(t); h.worker.emit('message', { kind: 'ready' });
  assert.throws(() => encodeSqliteAuthJson({ text: 'x'.repeat(1025) }, 1024), AuthPersistenceError);
  const cyclic: { next?: unknown } = {}; cyclic.next = cyclic;
  assert.throws(() => encodeSqliteAuthJson(cyclic, 1024), AuthPersistenceError);
  let deep: unknown = true; for (let i = 0; i < 34; i++) deep = { next: deep };
  assert.throws(() => encodeSqliteAuthJson(deep, 1024), AuthPersistenceError);
  assert.equal(h.worker.messages.length, 0);
});
for (const mode of ['thrown', 'rejected'] as const) test(`refused physical stop (${mode}) stays pending and logs without private text`, async t => {
  const h = fake(t); h.worker.stopMode = mode; h.worker.emit('message', { kind: 'ready' });
  h.worker.emit('error', Error('private-worker')); const close = h.owner.close();
  let done = false; void close.catch(() => { done = true; }); await turn();
  assert.equal(done, false); assert.equal(h.owner.snapshot().ownerExitConfirmed, false);
  assert.ok(h.lines.some(line => JSON.parse(line).ownerFailureCode === 9));
  assert.ok(!h.lines.join('').includes('private-'));
  h.worker.emit('exit', 1); await assert.rejects(close, AuthPersistenceError); await h.owner.closeForShutdown();
});
test('dispatch failure is unknown, never retransmitted, and retains first failure reason after exit', async t => {
  const h = fake(t); h.worker.emit('message', { kind: 'ready' }); h.worker.dispatchFails = true;
  await assert.rejects(h.owner.command('status', {}), AuthPersistenceError);
  assert.equal(h.worker.messages.length, 0);
  h.worker.emit('exit', 1); await h.owner.closeForShutdown();
  const lifecycle = h.lines.map(line => JSON.parse(line)).filter(row => row.operation === 'auth-sqlite-owner' && row.step !== 3);
  assert.deepEqual(lifecycle.map(row => row.ownerFailureCode), [6, 6]);
});
test('RPC sequence exhaustion never wraps or generates a replacement command identity', async t => {
  const h = fake(t); h.worker.emit('message', { kind: 'ready' });
  (h.owner as unknown as { sequence: number }).sequence = Number.MAX_SAFE_INTEGER;
  await assert.rejects(h.owner.command('status', {}), AuthPersistenceError);
  assert.equal(h.worker.messages.length, 0); assert.equal(h.owner.snapshot().unavailable, true);
  assert.ok(h.lines.some(line => JSON.parse(line).ownerFailureCode === 7));
});
test('SQL close refusal and physical worker exit remain distinct from successful close', async t => {
  const h = fake(t); h.worker.emit('message', { kind: 'ready' });
  const close = h.owner.close(); await turn(); const message = h.worker.messages[0]!;
  h.worker.emit('message', { id: message.id, kind: message.kind, ok: false }); await turn();
  assert.equal(h.worker.stops, 1);
  assert.equal(h.owner.snapshot().closeAcknowledged, false); assert.equal(h.owner.snapshot().ownerExitConfirmed, false);
  h.worker.emit('exit', 1); await assert.rejects(close, AuthPersistenceError); await h.owner.closeForShutdown();
  assert.equal(h.owner.close(), close);
});
test('close dispatch failure requests original physical cleanup, never a replacement close', async t => {
  const h = fake(t); h.worker.emit('message', { kind: 'ready' }); h.worker.dispatchFails = true;
  const close = h.owner.close(); let shutdown = false;
  const physical = h.owner.closeForShutdown().then(() => { shutdown = true; }); await turn();
  assert.equal(h.worker.stops, 1); assert.equal(h.worker.messages.length, 0);
  assert.equal(shutdown, false); assert.equal(h.owner.close(), close);
  h.worker.emit('exit', 1); await assert.rejects(close, AuthPersistenceError); await physical;
  assert.ok(h.lines.some(line => JSON.parse(line).ownerFailureCode === 6));
});
for (const mode of ['thrown', 'rejected'] as const) test(`refused original cleanup (${mode}) retries with cooldown, retaining unknown until real exit`, async t => {
  const h = fake(t); h.worker.stopMode = mode; h.worker.emit('message', { kind: 'ready' });
  h.worker.emit('error', Error('private-first')); const close = h.owner.close();
  let shutdown = false; const physical = h.owner.closeForShutdown().then(() => { shutdown = true; }); await turn();
  assert.equal(h.worker.stops, 1); assert.equal(h.owner.close(), close);
  h.worker.stopMode = 'resolved'; await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(h.worker.stops, 2); assert.equal(h.worker.messages.length, 0); assert.equal(shutdown, false);
  h.worker.emit('exit', 1); await assert.rejects(close, AuthPersistenceError); await physical;
  assert.ok(h.lines.some(line => JSON.parse(line).step === 2 && JSON.parse(line).ownerFailureCode === 2));
});
test('close pending observation covers ACK-to-exit wait without treating ACK as exit proof', async t => {
  const h = fake(t, 10); h.worker.emit('message', { kind: 'ready' }); const close = h.owner.close();
  await turn(); h.worker.reply(0, 'null'); await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(h.owner.snapshot().closeAcknowledged, true); assert.equal(h.owner.snapshot().ownerExitConfirmed, false);
  assert.ok(h.lines.some(line => JSON.parse(line).operation === 'auth-sqlite-owner' && JSON.parse(line).step === 5));
  assert.equal(h.worker.stops, 0); h.worker.emit('exit', 0); await close;
});
test('routine traffic cannot hide exact auth-owner lifecycle observations', async t => {
  const h = fake(t);
  const diagnostics = (h.owner as unknown as { diagnostics: PerformanceDiagnostics }).diagnostics;
  for (let i = 0; i < 50; i++) diagnostics.start('auth-sqlite-command').finish();
  h.worker.emit('message', { kind: 'ready' });
  const ready = diagnostics.snapshot().events.find(row => row.operation === 'auth-sqlite-owner' && row.step === 3);
  assert.ok(ready); assert.equal(ready.unknown, undefined);
});
test('session clear inspects authority inside original transaction and refuses asynchronous callbacks', () => {
  const db = new DatabaseSync(':memory:'), store = new SqlitePasskeys(db, () => key), token = createDeckSession();
  try {
    store.addAdministratorSession(token);
    let transactionObserved = false;
    assert.equal(store.clearSessions(() => { transactionObserved = db.isTransaction; return false; }), false);
    assert.equal(transactionObserved, true); assert.equal(store.sessionAuthorized(token), true);
    let invoked = false;
    assert.equal(store.clearSessions((async () => { invoked = true; return true; }) as unknown as () => boolean), false);
    assert.equal(invoked, false); assert.equal(store.sessionAuthorized(token), true);
    assert.equal(store.clearSessions(() => true), true); assert.equal(store.sessionAuthorized(token), false);
  } finally { db.close(); }
});
test('trusted extraction hashes raw request credential, never accepts the public audit identity as bearer proof', async t => {
  const h = await fixture(t);
  const forged = sqliteAuthEvidenceFromRequest(new Request(origin, { headers: { 'x-agentopsdeck-key': key } }));
  assert.notEqual(forged.suppliedKeyDigest, accessKeyDigest);
  assert.equal(await h.owner.command('authorized', forged), false);
  await assert.rejects(h.owner.command('authorized', { suppliedKeyDigest: key }), AuthPersistenceError);
  const correct = sqliteAuthEvidenceFromRequest(new Request(origin, { headers: { authorization: 'Bearer synthetic-key' } }));
  assert.equal(correct.suppliedKeyDigest, createHash('sha256').update('synthetic-key').digest('hex'));
});
