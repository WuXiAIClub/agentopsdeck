import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncSqliteAuthOwner, type SqliteAuthOwnerConfig } from './async-sqlite-owner.js';
import { AsyncSqliteAuthRoutePort } from './async-sqlite-route-port.js';
import { AsyncConnectorOwner } from '../connector/async-connector-owner.js';
import { applicationTransactionRequest, createApplicationTransactionLink,
  type ApplicationTransactionEvidence } from './application-transaction-gate.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { startupDatabaseOwners } from '../storage/startup-owner.js';

const key = 'standalone-original-key', digest = createHash('sha256').update(key).digest('hex');
const token = 's'.repeat(43), quiet = new PerformanceDiagnostics(() => {});
const binding = { runtime: 'ghcp' as const, resource: 'ghcp:original', commandKey: 'original', payloadDigest: 'a'.repeat(64), phase: 'claim' as const };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function fixture(t: TestContext, mode: 'json' | 'sqlite', keyed = true) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-standalone-transaction-')), link = createApplicationTransactionLink();
  const files = mode === 'json' ? [join(root, 'passkeys.json'), join(root, 'sessions.json')] : [join(root, 'auth.sqlite')];
  const config: SqliteAuthOwnerConfig = { ...(mode === 'json' ? { kind: 'json', passkeysFile: files[0]!, sessionsFile: files[1]! }
    : { file: files[0]!, legacyFiles: [] }), ...(keyed ? { accessKeyDigest: digest } : {}) };
  const owner = new AsyncSqliteAuthOwner(config, quiet, undefined, 30_000, link.auth);
  link.connector.begin(); link.connector.data.ref(); let sequence = 0;
  t.after(async () => {
    link.connector.confirmExit(); await owner.closeForShutdown(); link.closeUnused(); rmSync(root, { recursive: true, force: true });
  });
  await owner.open();
  const acquire = async (evidence: ApplicationTransactionEvidence = { accessKey: key }) => {
    const reply = once(link.connector.data, 'message');
    link.connector.data.postMessage({ kind: 'acquire', id: ++sequence, binding: { ...binding, evidence } });
    const [grant] = await reply; assert.deepEqual(grant, { kind: 'grant', id: sequence, allowed: grant.allowed }); return grant.allowed as boolean;
  };
  const settle = async () => {
    const reply = once(link.connector.data, 'message'); link.connector.data.postMessage({ kind: 'settled', id: sequence });
    assert.deepEqual((await reply)[0], { kind: 'settled', id: sequence });
  };
  return { owner, config, link, acquire, settle, files };
}

for (const mode of ['json', 'sqlite'] as const) for (const keyed of [true, false]) {
  test(`${mode}/${keyed ? 'Key' : 'no-Key'}: transaction identity exactly matches original standalone Request authority`, { timeout: 15_000 }, async t => {
    const f = await fixture(t, mode, keyed), port = new AsyncSqliteAuthRoutePort(f.owner, keyed ? digest : undefined);
    if (keyed) await f.owner.command('issueAdministratorSession', { token, evidence: { suppliedKeyDigest: digest } });
    const cases: ApplicationTransactionEvidence[] = [{}, { accessKey: key }, { authorization: `Bearer ${key}` },
      { accessKey: 'wrong' }, { cookie: `agentopsdeck_access=${key}` }, { cookie: `agentopsdeck_session=${token}` },
      { cookie: `agentopsdeck_session=${token}`, accessKey: 'wrong' }, { cookie: 'agentopsdeck_session=%', accessKey: key },
      { cookie: 'agentopsdeck_session=noncanonical', accessKey: key }, { authorization: 'Bearer wrong', accessKey: key }];
    for (const evidence of cases) {
      const expected = await port.authority.authorize(applicationTransactionRequest(evidence));
      const actual = await f.acquire(evidence); assert.equal(actual, expected, JSON.stringify(Object.keys(evidence)));
      if (actual) await f.settle();
    }
  });
}

for (const mode of ['json', 'sqlite'] as const) for (const action of ['revoke', 'key', 'close'] as const) {
  test(`${mode}: granted original writer blocks later ${action} until its real settlement`, { timeout: 15_000 }, async t => {
    const f = await fixture(t, mode);
    await f.owner.command('issueAdministratorSession', { token, evidence: { suppliedKeyDigest: digest } });
    assert.equal(await f.acquire({ cookie: `agentopsdeck_session=${token}` }), true);
    let done = false;
    const pending = (action === 'revoke' ? f.owner.command('deleteSession', { token })
      : action === 'key' ? f.owner.updateCurrentKeyIdentity('b'.repeat(24)) : f.owner.close()).then(() => { done = true; });
    await tick(); await tick(); assert.equal(done, false);
    await f.settle(); await pending; assert.equal(done, true);
    if (action !== 'close') assert.equal(await f.acquire(action === 'key' ? { accessKey: key } : { cookie: `agentopsdeck_session=${token}` }), false);
  });
}

for (const fault of ['data-close', 'invalid-settlement'] as const) {
  test(`standalone ${fault}: transport failure is not settlement; only original peer exit releases close`, { timeout: 15_000 }, async t => {
    const f = await fixture(t, 'sqlite'); assert.equal(await f.acquire(), true);
    if (fault === 'data-close') f.link.connector.data.close(); else f.link.connector.data.postMessage({ kind: 'settled', id: 2 });
    let closed = false; const closing = f.owner.close().then(() => { closed = true; });
    await tick(); await tick(); assert.equal(closed, false);
    assert.throws(() => startupDatabaseOwners.reserveExclusive(f.files[0]!));
    f.link.connector.confirmExit(); await closing; assert.equal(closed, true);
  });
}

for (const mode of ['json', 'sqlite'] as const) test(`${mode}: actual standalone Auth exit escrows all original files until actual Connector exit`, { timeout: 15_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-standalone-retirement-')), link = createApplicationTransactionLink();
  const preferences = { hidden: join(root, 'hidden.json'), pinned: join(root, 'pinned.json'), archived: join(root, 'archived.json') };
  const config: SqliteAuthOwnerConfig = { ...(mode === 'json' ? { kind: 'json', passkeysFile: join(root, 'passkeys.json'), sessionsFile: join(root, 'sessions.json') }
    : { file: join(root, 'auth.sqlite'), legacyFiles: [] }), legacyPreferences: preferences, accessKeyDigest: digest };
  const owner = new AsyncSqliteAuthOwner(config, quiet, undefined, 30_000, link.auth);
  const connector = new AsyncConnectorOwner({ file: join(root, 'connector.sqlite') }, quiet, undefined, 30_000, link.connector);
  let replacement: AsyncSqliteAuthOwner | undefined;
  try {
    await Promise.all([owner.open(), connector.open()]); await owner.close();
    const files = [...Object.values(preferences), ...(config.kind === 'json' ? [config.passkeysFile, config.sessionsFile] : [config.file])];
    for (const file of files) assert.throws(() => startupDatabaseOwners.reserveExclusive(file));
    assert.throws(() => new AsyncSqliteAuthOwner(config, quiet));
    await connector.close();
    replacement = new AsyncSqliteAuthOwner(config, quiet); await replacement.open();
  } finally {
    await Promise.all([owner.closeForShutdown(), connector.closeForShutdown(), replacement?.closeForShutdown()]);
    link.closeUnused(); rmSync(root, { recursive: true, force: true });
  }
});

test('standalone original paired Auth refuses substitute launchers before reserving files', () => {
  const link = createApplicationTransactionLink(); let launched = false;
  try {
    assert.throws(() => new AsyncSqliteAuthOwner({ file: ':memory:', legacyFiles: [] }, quiet,
      () => { launched = true; throw Error('must not launch'); }, 30_000, link.auth));
    assert.equal(launched, false);
  } finally { link.closeUnused(); }
});
