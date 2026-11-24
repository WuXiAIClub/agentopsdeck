import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyCandidateRelease } from './stage-candidate-release.mjs';
import { decryptArchive, encryptTree, treeInventory } from './lib/encrypted-stopped-backup.mjs';

const script = fileURLToPath(import.meta.url);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote = name => '"' + name.replaceAll('"', '""') + '"';

// Only hashes and counts leave this function; no credential-bearing SQL rows
// belong in acceptance logs. Include every legacy table, not a chosen subset.
export function migrationTableInventory(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(({ name }) => {
      const rows = db.prepare('SELECT * FROM ' + quote(name)).all().map(row => JSON.stringify(row)).sort();
      return { name, rows: rows.length, sha256: digest(rows) };
    });
}

export function assertMigrationPreserved(before, after) {
  const actual = new Map(after.map(table => [table.name, table]));
  for (const table of before) assert.deepEqual(actual.get(table.name), table, 'Legacy table changed: ' + table.name);
}

async function worker({ release, file, stage, data }) {
  const { HubStore } = await import(pathToFileURL(join(release, 'apps/server/dist/hub/hub-store.js')));
  const store = new HubStore(file, 'isolated-migration-vault', undefined, 'isolated-bootstrap');
  const db = store.db;
  const request = cookie => new Request('http://isolated.invalid', { headers: { cookie: 'agentopsdeck_session=' + cookie } });
  function revoked() {
    assert.equal(store.identities.keyPrincipal(data.key.token), undefined);
    assert.equal(store.identities.requestIdentity(request(data.cookie)), undefined);
    assert.equal(store.grants.get(data.target, data.grant.id).revoked, true);
    assert.equal(store.grants.get(data.otherTarget, data.otherGrant.id).revoked, false);
    assert.equal(store.identities.keyPrincipal(data.otherKey.token).userId, data.other.id);
    assert.equal(store.getConnection('isolated').label, 'Migration fixture');
  }
  try {
    if (stage === 'legacy-seed') {
      // This predecessor must really lack lifecycle epochs. An already upgraded
      // binary is not acceptable evidence of old-to-new migration.
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'hub_user_access'").get(), undefined);
      const admin = store.createUser('Migration admin'), member = store.createUser('Migration member'), other = store.createUser('Independent member');
      store.roles.setHubRole({ userId: 'default', admin: true }, admin.id, 'admin', 0);
      const adminKey = store.identities.issueKey(admin.id), key = store.identities.issueKey(member.id), otherKey = store.identities.issueKey(other.id);
      const cookie = store.identities.createSession(key.token);
      assert.ok(cookie);
      store.upsertConnection({ id: 'isolated', kind: 'local', label: 'Migration fixture', connectorUrl: 'http://isolated.invalid' });
      const target = { ownerUserId: 'default', connectionId: 'isolated', userId: member.id };
      const otherTarget = { ...target, userId: other.id };
      const policy = { runtime: 'codex', sessionKey: 'codex:legacy', actions: ['messages:read'] };
      const grant = store.grants.create(target, policy), otherGrant = store.grants.create(otherTarget, policy);
      return { admin, member, other, adminKey, key, otherKey, cookie, target, otherTarget, grant, otherGrant,
        legacyTables: migrationTableInventory(db), scope: store.identities.recoveryScope({ userId: member.id, admin: false }) };
    }
    if (stage === 'candidate-upgrade') {
      assertMigrationPreserved(data.legacyTables, migrationTableInventory(db));
      assert.equal(store.identities.keyPrincipal(data.key.token).userId, data.member.id);
      assert.equal(store.identities.requestIdentity(request(data.cookie)).userId, data.member.id);
      assert.equal(store.identities.recoveryScope({ userId: data.member.id, admin: false }), data.scope);
      const { executeHubMemberCommand } = await import(pathToFileURL(join(release, 'apps/server/dist/hub/member-owner-domain.js')));
      const result = executeHubMemberCommand(store, 'userChange', {
        evidence: { accessKey: data.adminKey.token }, expectedScope: store.identities.recoveryScope({ userId: data.admin.id, admin: true }),
        change: { action: 'accessChange', userId: data.member.id, status: 'disabled', expectedVersion: 0 },
      });
      assert.deepEqual(result, { access: { userId: data.member.id, status: 'disabled', version: 1 } });
      revoked();
      return { checks: ['all-legacy-tables-preserved', 'legacy-key-cookie-and-scope-preserved', 'candidate-disable-atomic'], tables: migrationTableInventory(db) };
    }
    assert.ok(['restored-candidate', 'legacy-rollback', 'forward-reopen'].includes(stage));
    assertMigrationPreserved(data.upgradedTables, migrationTableInventory(db));
    revoked();
    if (stage === 'legacy-rollback') {
      // Exercise the real old API, not a hand-written SQL imitation. Persistent
      // trigger fences must survive old constructor initialization too.
      assert.throws(() => store.identities.issueKey(data.member.id), /User disabled/);
      assert.throws(() => store.grants.create(data.target, {
        runtime: 'codex', sessionKey: 'codex:rollback-bypass', actions: ['messages:read'],
      }), /User disabled/);
      assertMigrationPreserved(data.upgradedTables, migrationTableInventory(db));
      return { checks: ['old-key-cookie-denied', 'old-key-issuer-fenced', 'old-grant-issuer-fenced', 'old-open-preserves-tombstones'] };
    }
    return { checks: ['disabled-epoch-persistent', 'old-key-cookie-denied', 'grant-tombstones-persistent', 'independent-user-and-connector-preserved'] };
  } finally { await store.close(); }
}

async function runWorker(input) {
  // Credentials travel only through private inherited IPC and memory, never
  // argv, environment, stdout, result files or storageState.
  const child = fork(script, ['--isolated-worker'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let output;
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  try {
    await new Promise((accept, reject) => {
      child.once('error', reject);
      child.on('message', message => { output = message; });
      child.once('close', (code, signal) => code === 0 && !signal && output?.ok
        ? accept() : reject(Object.assign(new Error('Migration worker failed: ' + input.stage + ' (' + (signal ?? code) + ')'), { safeMigrationDetails: output?.error })));
      child.send(input);
    });
    return output.value;
  } finally { clearTimeout(timer); }
}

async function extract(archive, destination) {
  await mkdir(destination, { mode: 0o700 });
  const child = spawn('/usr/bin/tar', ['-xzpf', archive, '-C', destination], { stdio: 'ignore' });
  await new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 && !signal ? accept() : reject(new Error('Private fixture extraction failed')));
  });
}

export async function verifyIsolatedPermissionsMigration({ predecessor, candidate, evidence }) {
  for (const path of [predecessor, candidate, evidence]) assert.ok(isAbsolute(path) && resolve(path) === path);
  assert.notEqual(predecessor, candidate);
  assert.equal(await realpath(dirname(evidence)), dirname(evidence));
  const before = { predecessor: await verifyCandidateRelease(predecessor), candidate: await verifyCandidateRelease(candidate) };
  await mkdir(evidence, { mode: 0o700 }); // Exclusive; never overwrite another run.
  const root = await mkdtemp(join(evidence, 'private-fixture-'));
  const result = { version: 1, passed: false, startedAt: new Date().toISOString(), releases: before,
    productionTouched: false, modelCalls: 0, stages: [], scope: 'disposable Hub identity/grant migration; not a full production-volume restore' };
  const key = randomBytes(32);
  const source = join(root, 'state'); await mkdir(source, { mode: 0o700 });
  let data;
  async function step(stage, release, state) {
    const value = await runWorker({ stage, release, file: join(state, 'hub.sqlite'), data });
    result.stages.push({ stage, passed: true, checks: value.checks });
    return value;
  }
  async function backup(name) {
    // All owning child processes have exited before inventory/encryption. No
    // synthetic lock clearing, online SQLite copy or live volume is involved.
    assert.ok(!(await readdir(source)).some(name => /-(wal|shm)$/.test(name)), 'Stopped fixture retained a writer sidecar');
    const inventory = await treeInventory(source), encrypted = join(root, name + '.enc');
    await encryptTree(source, encrypted, key);
    const archive = join(root, name + '.tar.gz');
    await decryptArchive(encrypted, archive, key);
    const restored = join(root, name + '-restore'); await extract(archive, restored);
    const state = join(restored, 'state');
    assert.deepEqual(await treeInventory(state), inventory, 'Stopped restore is not byte/mode exact');
    result.stages.push({ stage: name, passed: true, exactTreeSha256: digest(inventory), encryptedSha256: createHash('sha256').update(await readFile(encrypted)).digest('hex') });
    return state;
  }
  try {
    data = await step('legacy-seed', predecessor, source);
    await backup('pre-upgrade-stopped-backup');
    const upgraded = await step('candidate-upgrade', candidate, source);
    data.upgradedTables = upgraded.tables;
    const restored = await backup('post-upgrade-stopped-backup');
    const original = await treeInventory(source);
    await step('restored-candidate', candidate, restored);
    await step('legacy-rollback', predecessor, restored);
    await step('forward-reopen', candidate, restored);
    assert.deepEqual(await treeInventory(source), original, 'Rollback changed original upgraded state');
    assert.deepEqual({ predecessor: await verifyCandidateRelease(predecessor), candidate: await verifyCandidateRelease(candidate) }, before);
    result.passed = true;
  } catch (error) {
    // Assertion values can contain transient keys. Persist a bounded safe stage
    // identifier only; do not dump nested assertion actual/expected values.
    result.failure = 'Isolated migration failed after ' + (result.stages.at(-1)?.stage ?? 'preparation');
    result.failureDetails = error.safeMigrationDetails;
    throw new Error(result.failure);
  } finally {
    key.fill(0); data = undefined;
    await rm(root, { recursive: true, force: true }); // Exact exclusively allocated fixture; never a supplied directory.
    result.privateFixtureRemoved = true;
    result.completedAt = new Date().toISOString();
    await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  if (process.argv[2] === '--isolated-worker') {
    process.once('message', async input => {
      try { const value = await worker(input); process.send({ ok: true, value }, () => process.disconnect()); }
      catch (error) {
        process.exitCode = 1;
        const frames = String(error.stack ?? '').split('\n').filter(line => /^    at /.test(line)).slice(0, 4);
        process.send({ ok: false, error: { name: error.name, code: error.code, frames } }, () => process.disconnect());
      }
    });
  } else {
    assert.equal(process.argv.length, 5, 'Usage: PREDECESSOR_RELEASE CANDIDATE_RELEASE NEW_EVIDENCE_DIRECTORY');
    verifyIsolatedPermissionsMigration({ predecessor: process.argv[2], candidate: process.argv[3], evidence: process.argv[4] })
      .then(result => console.log(JSON.stringify({ passed: result.passed, stages: result.stages.length })))
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
