import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Worker, MessageChannel } from 'node:worker_threads';
import { AsyncSqliteAuthOwner } from './async-sqlite-owner.js';
import { SqlitePasskeys } from './sqlite-passkeys.js';
import { credentialHashForAudit } from './security.js';
import { AuthPersistenceError } from './private-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { PasskeyVerificationCapacityError } from './passkeys.js';

const digest = 'a'.repeat(64), origin = 'https://hub.example';
const evidence = { suppliedKeyDigest: digest };
async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-auth-original-concurrency-'));
  chmodSync(dir, 0o700);
  const file = join(dir, 'auth.sqlite');
  const db = new DatabaseSync(file); chmodSync(file, 0o600);
  const store = new SqlitePasskeys(db, () => digest.slice(0, 24));
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x!, 'base64url'),
    Buffer.from('225820', 'hex'), Buffer.from(jwk.y!, 'base64url')]);
  const id = Buffer.from('auth-inflight-original-credential').toString('base64url');
  store.importLegacy([{ id, publicKey: cose.toString('base64url'), counter: 0, rpId: 'hub.example',
    keyIdentityHash: digest.slice(0, 24), createdAt: 1, label: 'fixture' }], true);
  db.close(); // Only the original worker opens runtime state after offline seeding.
  const { port1, port2 } = new MessageChannel();
  const source = new URL(import.meta.url).pathname.endsWith('.ts');
  const entry = new URL(source ? './sqlite-owner-worker.ts' : './sqlite-owner-worker.js', import.meta.url);
  const logs: string[] = [], sent: string[] = [];
  const worker = new Worker(`(async () => {
    const { workerData, parentPort } = require('node:worker_threads');
    const control = workerData.control; delete workerData.control;
    const { webcrypto } = require('node:crypto');
    const original = webcrypto.subtle.verify.bind(webcrypto.subtle);
    const gates = new Map(); let sequence = 0, released = false;
    control.on('message', message => {
      if (message === 'release-all') { released = true; for (const done of gates.values()) done(); gates.clear(); }
    });
    control.unref();
    parentPort.on('message', message => {
      if (message.kind === 'close') control.postMessage({ stage: 'close-received' });
    });
    webcrypto.subtle.verify = async (...args) => {
      const value = await original(...args);
      if (released) return value;
      const index = ++sequence;
      await new Promise(resolve => {
        gates.set(index, resolve);
        control.postMessage({ stage: 'signature-held', index });
      });
      return value;
    };
    if (workerData.loader) { const { tsImport } = await import(workerData.loader); await tsImport(workerData.entry, workerData.entry); }
    else await import(workerData.entry);
  })().catch(() => process.exit(1));`, { eval: true, execArgv: [], workerData: {
    file, legacyFiles: [], accessKeyDigest: digest, control: port2, entry: entry.href,
    loader: source ? import.meta.resolve('tsx/esm/api') : undefined,
  }, transferList: [port2] });
  const originalPost = worker.postMessage.bind(worker);
  worker.postMessage = ((message: { kind: string }) => { sent.push(message.kind); originalPost(message); }) as typeof worker.postMessage;
  const owner = new AsyncSqliteAuthOwner({ file, legacyFiles: [], accessKeyDigest: digest },
    new PerformanceDiagnostics(line => logs.push(line)), () => worker);
  const held: number[] = [];
  let confirmClose!: () => void;
  const closeReceived = new Promise<void>(resolve => { confirmClose = resolve; });
  let changed: (() => void) | undefined;
  port1.on('message', message => {
    if (message.stage === 'close-received') { confirmClose(); return; }
    assert.equal(message.stage, 'signature-held'); held.push(message.index); changed?.();
  });
  const waitHeld = async (count: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([new Promise<void>(resolve => {
        changed = () => { if (held.length >= count) resolve(); }; changed();
      }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Original verification did not reach its gate')), 5000); })]);
    } finally { clearTimeout(timer); changed = undefined; }
  };
  const release = () => port1.postMessage('release-all');
  t.after(async () => {
    release();
    await owner.closeForShutdown(); // Cleanup waits; it never retires a healthy held worker.
    port1.close(); rmSync(dir, { recursive: true, force: true });
  });
  await owner.open();
  const assertion = (challenge: string, counter: number) => {
    const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin })), auth = Buffer.alloc(37);
    createHash('sha256').update('hub.example').digest().copy(auth); auth[32] = 5; auth.writeUInt32BE(counter, 33);
    return { id, rawId: id, type: 'public-key' as const, clientExtensionResults: {}, response: {
      clientDataJSON: client.toString('base64url'), authenticatorData: auth.toString('base64url'),
      signature: sign('sha256', Buffer.concat([auth, createHash('sha256').update(client).digest()]), privateKey).toString('base64url'),
    } };
  };
  const verify = async (counter: number) => {
    const options = await owner.command('authenticationOptions', { origin });
    const result = owner.command('verifyAuthentication', { origin, response: assertion(options.challenge, counter) });
    void result.catch(() => {});
    return { result, response: assertion(options.challenge, counter) };
  };
  const stopped = () => new DatabaseSync(file, { readOnly: true });
  return { owner, worker, closeReceived, held, waitHeld, release, verify, stopped, sent, logs, dir, id, credentialHash: credentialHashForAudit(id) };
}

async function within<T>(work: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Error('Independent original command blocked behind WebAuthn')), 2000);
  })]); } finally { clearTimeout(timer); }
}

test('held original signature permits status and revocation; stale authentication cannot commit or replay', { timeout: 15000 }, async t => {
  const h = await fixture(t), first = await h.verify(1);
  await h.waitHeld(1);
  assert.equal((await within(h.owner.command('status', {}))).count, 1);
  assert.equal(await within(h.owner.command('revoke', { credentialHash: h.credentialHash, evidence })), true);
  assert.equal(await within(h.owner.command('credentialCurrent', { credentialHash: h.credentialHash })), false);
  h.release();
  assert.deepEqual(await first.result, { verified: false });
  assert.deepEqual(await h.owner.command('verifyAuthentication', { origin, response: first.response }), { verified: false });
  await h.owner.close();
  const db = h.stopped();
  try {
    assert.equal(db.prepare('SELECT count(*) n FROM shared_auth_sessions').get()!.n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM shared_auth_audit WHERE kind='issued'").get()!.n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM shared_auth_audit WHERE kind='revoked'").get()!.n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM shared_auth_challenges WHERE claim IS NOT NULL').get()!.n, 0);
  } finally { db.close(); }
  for (const secret of [digest, h.dir, h.id, first.response.response.signature]) assert.equal(h.logs.join('').includes(secret), false);
});

test('two held signed assertions share one original connection; final credential version admits only one issuance', { timeout: 15000 }, async t => {
  const h = await fixture(t), first = await h.verify(1), second = await h.verify(2);
  await h.waitHeld(2);
  h.release();
  const outcomes = await Promise.all([first.result, second.result]);
  assert.equal(outcomes.filter(value => value.verified).length, 1);
  await h.owner.close();
  const db = h.stopped();
  try {
    assert.equal(db.prepare('SELECT count(*) n FROM shared_auth_sessions').get()!.n, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM shared_auth_audit WHERE kind='issued'").get()!.n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM shared_auth_challenges WHERE claim IS NOT NULL').get()!.n, 0);
  } finally { db.close(); }
});

test('close keeps a held original verification and its admission until ACK and actual original exit', { timeout: 15000 }, async t => {
  const h = await fixture(t), first = await h.verify(1);
  await h.waitHeld(1);
  let closed = false;
  const close = h.owner.close().then(() => { closed = true; });
  await assert.rejects(h.owner.command('status', {}), AuthPersistenceError);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  assert.equal(h.owner.snapshot().closing, true);
  assert.equal(h.owner.snapshot().ownerExitConfirmed, false);
  assert.equal(h.owner.snapshot().accepted, 1);
  assert.equal(h.sent.includes('close'), false);
  h.release();
  assert.equal((await first.result).verified, true);
  await close;
  assert.equal(h.owner.snapshot().ownerExitConfirmed, true);
  assert.equal(h.owner.snapshot().closeAcknowledged, true);
  assert.equal(h.owner.snapshot().accepted, 0);
  assert.equal(h.sent.filter(kind => kind === 'verifyAuthentication').length, 1);
  assert.equal(h.sent.filter(kind => kind === 'close').length, 1);
});

test('eight durable held claims retain the original verification capacity without blocking revocation', { timeout: 15000 }, async t => {
  const h = await fixture(t), attempts: Awaited<ReturnType<typeof h.verify>>[] = [];
  for (let index = 1; index <= 8; index++) {
    attempts.push(await h.verify(index));
    await h.waitHeld(index);
  }
  const refused = await h.verify(9);
  await assert.rejects(within(refused.result), PasskeyVerificationCapacityError);
  assert.equal(h.owner.snapshot().unavailable, false);
  assert.equal(await within(h.owner.command('revoke', { credentialHash: h.credentialHash, evidence })), true);
  h.release();
  assert.deepEqual(await Promise.all(attempts.map(attempt => attempt.result)), Array.from({ length: 8 }, () => ({ verified: false })));
  await h.owner.close();
  const db = h.stopped();
  try {
    assert.equal(db.prepare('SELECT count(*) n FROM shared_auth_sessions').get()!.n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM shared_auth_challenges WHERE claim IS NOT NULL').get()!.n, 0);
  } finally { db.close(); }
});

test('the worker itself drains an accepted verification before a directly received close', { timeout: 15000 }, async t => {
  const h = await fixture(t), first = await h.verify(1);
  await h.waitHeld(1);
  const replies: { id: number; kind: string; ok: boolean; body: string }[] = [];
  h.worker.on('message', reply => { if (Number.isSafeInteger(reply.id)) replies.push(reply); });
  let exited = false;
  const exit = new Promise<number>(resolve => h.worker.once('exit', code => { exited = true; resolve(code); }));
  // Raw protocol test: bypass the parent barrier ONLY to exercise the original
  // worker's own drain. The parent intentionally has no waiter for this close.
  const id = h.sent.length + 1;
  h.worker.postMessage({ id, kind: 'close', body: '{}' });
  await within(h.closeReceived);
  assert.equal(exited, false);
  assert.equal(replies.some(reply => reply.kind === 'close'), false);
  h.release();
  assert.equal((await first.result).verified, true);
  assert.equal(await exit, 0);
  assert.deepEqual(replies.map(reply => reply.kind), ['verifyAuthentication', 'close']);
  assert.deepEqual(replies.at(-1), { id, kind: 'close', ok: true, body: 'null' });
  assert.equal(h.owner.snapshot().ownerExitConfirmed, true);
  const db = h.stopped();
  try {
    assert.equal(db.prepare('SELECT count(*) n FROM shared_auth_sessions').get()!.n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM shared_auth_challenges WHERE claim IS NOT NULL').get()!.n, 0);
  } finally { db.close(); }
});
