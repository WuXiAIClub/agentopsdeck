import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { hubMemberCommandSteps, hubMemberFailureSteps, hubMemberResultBytes, validHubMemberInput, validHubMemberOutput } from './member-owner-domain.js';
import { HUB_USER_DIRECTORY_BYTES, validHubUserDirectoryResult } from './member-user-directory-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { HubMemberCommands, HubMemberKind } from './member-owner-domain.js';
const quiet = new PerformanceDiagnostics(() => {});
for (const admin of [false, true]) test(`original user directory is scoped and independent of connections (admin=${admin})`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'user-directory-domain-'));
  const store = new HubStore(join(root, 'hub.sqlite'), 'isolated-vault');
  const db = (store as unknown as { db: DatabaseSync }).db;
  const userId = admin ? 'default' : store.createUser('Member').id;
  if (admin) db.prepare("INSERT INTO hub_roles VALUES (?, 'admin', 1)").run(userId);
  const other = store.createUser('Private other'), key = store.identities.issueKey(userId);
  const original = new OriginalHubAdministrativeCommands(store, quiet), service = new AsyncHubMemberRequests(original, quiet);
  t.after(async () => { await service.close(); await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); });
  const request = new Request('http://fixture.invalid/', { headers: { authorization: 'Bearer ' + key.token } });
  const access = await service.begin(request);
  const expected = store.listUsers().filter(row => admin || row.id === userId)
    .map(row => admin ? { ...row, usage: { lastLoginAt: null, lastActiveAt: null } } : row);
  store.upsertConnection({ id: 'oversized', ownerUserId: userId, label: 'Node', connectorUrl: 'http://private.invalid' });
  db.prepare('UPDATE env_connections SET label=? WHERE id=?').run('x'.repeat(20_000), 'oversized');
  const result = await access.users();
  assert.deepEqual(result, { principal: { userId, admin }, users: JSON.parse(JSON.stringify(expected)) });
  if (!admin) assert.doesNotMatch(JSON.stringify(result), new RegExp(other.id + '|usage|Private other'));
  assert.doesNotMatch(JSON.stringify(result), /private.invalid|isolated-vault|hub_key_|encrypted_token/);
  assert.equal(validHubMemberOutput('userDirectory', result), true);
  await assert.rejects(access.connections(), error => error instanceof HubMemberRequestError && error.status === 503);
  // A denied request is retired, not revived by an independently available projection.
  await assert.rejects(access.users(), error => error instanceof HubMemberRequestError && error.status === 503);
});
test('user directory runs on the sole worker and refuses a revoked original credential', async t => {
  const root = mkdtempSync(join(tmpdir(), 'user-directory-worker-')), file = join(root, 'hub.sqlite');
  const store = new HubStore(file, 'isolated-vault'), user = store.createUser('Member'), key = store.identities.issueKey(user.id);
  (store as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES (?, 'admin', 1)").run(user.id);
  await store.close();
  const owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'isolated-vault' }, quiet);
  const service = new AsyncHubMemberRequests(owner, quiet);
  t.after(async () => { await service.close(); await owner.close(); rmSync(root, { recursive: true, force: true }); });
  const access = await service.begin(new Request('http://fixture.invalid/', { headers: { authorization: 'Bearer ' + key.token } }));
  assert.ok((await access.users()).users.some(row => row.id === user.id));
  // Self-revocation commits once, then its final credential proof refuses the
  // response. Do not mistake that refusal for a rollback or replay the effect.
  await assert.rejects(access.revoke(user.id, key.id), error => error instanceof HubMemberRequestError && error.status === 401);
  await assert.rejects(access.users(), error => error instanceof HubMemberRequestError && error.status === 401);
  await assert.rejects(service.begin(new Request('http://fixture.invalid/', { headers: { authorization: 'Bearer ' + key.token } })),
    error => error instanceof HubMemberRequestError && error.status === 401);
});
test('user directory protocol has fixed bounded result, append-only diagnostics and strict evidence', () => {
  const evidence = { accessKey: 'key' }, input = { evidence, expectedScope: 'a'.repeat(64) };
  assert.equal(validHubMemberInput('userDirectory', input), true);
  assert.equal(validHubMemberInput('userDirectory', { ...input, userId: 'foreign' }), false);
  assert.equal(hubMemberResultBytes('userDirectory'), HUB_USER_DIRECTORY_BYTES);
  assert.equal(hubMemberCommandSteps.userDirectory, 63);
  assert.equal(hubMemberFailureSteps.userDirectory, 83);
  for (const value of [undefined, {}, { principal: { userId: 'member', admin: false }, users: [{ id: 'foreign', label: 'P', createdAt: 1, updatedAt: 1 }] },
    { principal: { userId: 'member', admin: false }, users: [], token: 'private' },
    { principal: { userId: 'member', admin: true }, users: [{ id: 'member', label: 'P', createdAt: 1, updatedAt: 1 }] }]) {
    assert.equal(validHubUserDirectoryResult(value), false);
    assert.equal(validHubMemberOutput('userDirectory', value), false);
  }
  assert.equal(validHubUserDirectoryResult(null), true);
});

for (const outcome of ['cancel', 'deadline', 'close'] as const)
  test(`user directory ${outcome} keeps the original read admitted until its actual ACK`, async () => {
    const principal = { userId: 'member', admin: false }, scope = 'a'.repeat(64), controller = new AbortController();
    let entered!: () => void, release!: () => void, submissions = 0;
    const admission = new Promise<void>(yes => { entered = yes; }), gate = new Promise<void>(yes => { release = yes; });
    const logs: string[] = [];
    const diagnostics = new PerformanceDiagnostics(line => logs.push(line), () => 0);
    const owner = { command: async <K extends HubMemberKind>(kind: K): Promise<HubMemberCommands[K]['output']> => {
      submissions++;
      if (kind === 'memberSnapshot') return { principal, recoveryScope: scope } as HubMemberCommands[K]['output'];
      assert.equal(kind, 'userDirectory'); entered(); await gate;
      return { principal, users: [] } as unknown as HubMemberCommands[K]['output'];
    } };
    const service = new AsyncHubMemberRequests(owner, diagnostics, 30_000, outcome === 'deadline' ? 5 : 30_000);
    try {
      const access = await service.begin(new Request('http://fixture.invalid/', { signal: controller.signal }));
      const pending = access.users(); await admission;
      let closed = false;
      if (outcome === 'cancel') controller.abort();
      if (outcome !== 'close') await assert.rejects(pending, error => error instanceof HubMemberRequestError
        && error.status === (outcome === 'cancel' ? 499 : 503));
      assert.equal(service.pendingReads, 1);
      const closing = service.close().then(() => { closed = true; });
      await new Promise<void>(done => setImmediate(done)); assert.equal(closed, false);
      release();
      if (outcome === 'close') await assert.rejects(pending, error => error instanceof HubMemberRequestError && error.status === 503);
      await closing; assert.equal(closed, true); assert.equal(service.pendingReads, 0);
      const before = submissions;
      await assert.rejects(access.users(), error => error instanceof HubMemberRequestError);
      assert.equal(submissions, before, 'retired request never resubmits owner work');
      // Successful fast reads are emitted but intentionally do not occupy the
      // bounded recovery ring. Inspect the actual sink for their settled ACK.
      const events = logs.map(line => JSON.parse(line) as { step?: number; cancelled?: number; timedOut?: number; settled?: number });
      assert.ok(events.some(event => event.step === 86));
      assert.ok(events.some(event => event.step === 86 && event.settled === 1));
      if (outcome !== 'close') assert.ok(events.some(event => event.step === 86
        && (outcome === 'cancel' ? event.cancelled === 1 : event.timedOut === 1)));
      assert.doesNotMatch(JSON.stringify(events), /fixture.invalid|userDirectory|member|aaaaaaaa/);
    } finally { release(); await service.close(); }
  });
