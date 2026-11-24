import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardBindingError, ConnectorBoardBindings, parseBoardBindingPolicies, type BoardBindingInput } from './board-bindings.js';
import { BOARD_READ_TOOL, loadWorkerBoardTools } from '../tools/workspace-board-worker.js';

const endpoint = 'http://127.0.0.1:8791/api/workspace-agent/v1/board';
const actor = 'connector:test';
const input = (): BoardBindingInput => ({ id: randomUUID(), runtime: 'ghcp', sessionId: randomUUID(),
  credential: { endpoint, token: 'aod_board_' + 'a'.repeat(43), expiresAt: Date.now() + 60_000 } });
const rejects = (promise: Promise<unknown>, status: number) => assert.rejects(promise, (e: unknown) => e instanceof BoardBindingError && e.status === status);
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-binding-')), directory = join(root, 'private');
  await mkdir(directory, { mode: 0o700 }); t.after(() => rm(root, { recursive: true, force: true }));
  let authorized = true;
  const store = () => new ConnectorBoardBindings({ ghcp: directory }, [{ owner: actor, runtime: 'ghcp', endpoint }], () => authorized);
  return { directory, store, revoke: () => { authorized = false; } };
}

test('binding policies are opt-in, exact identity/runtime/endpoint and contain no default', () => {
  assert.deepEqual(parseBoardBindingPolicies(undefined), []);
  const policy = { owner: actor, runtime: 'ghcp', endpoint };
  assert.deepEqual(parseBoardBindingPolicies(JSON.stringify([policy])), [policy]);
  assert.deepEqual(parseBoardBindingPolicies(JSON.stringify([{ ...policy, runtime: 'codex' }])), [{ ...policy, runtime: 'codex' }]);
  for (const value of [[policy, policy], [{ ...policy, owner: '*' }], [{ ...policy, runtime: 'unknown' }],
    [{ ...policy, endpoint: 'http://remote.example/api/workspace-agent/v1/board' }], [{ ...policy, extra: 1 }], {}]) {
    assert.throws(() => parseBoardBindingPolicies(JSON.stringify(value)), BoardBindingError);
  }
});

test('private install is idempotent; receipts contain no token; runtime and session cannot be substituted', async t => {
  const f = await fixture(t), b = input(), store = f.store();
  const [one, two] = await Promise.all([store.install(actor, b), store.install(actor, b)]);
  assert.deepEqual(one, two); assert.equal(JSON.stringify(one).includes(b.credential.token), false);
  assert.deepEqual(await f.store().get(actor, b.runtime, b.sessionId), one);
  await rejects(store.install(actor, { ...b, sessionId: randomUUID() }), 409);
  await rejects(store.install(actor, { ...b, credential: { ...b.credential, token: 'aod_board_' + 'b'.repeat(43) } }), 409);
  await rejects(store.install('other', b), 403);
  await rejects(store.install(actor, { ...b, runtime: 'claude-code' }), 403);
  await rejects(store.install(actor, { ...b, credential: { ...b.credential, endpoint: 'https://other.example/api/workspace-agent/v1/board' } }), 403);
  const intent = await readFile(join(f.directory, `.binding-${b.runtime}-${b.id}.json`), 'utf8');
  assert.equal(intent.includes(b.credential.token), false);
  assert.equal((await readdir(f.directory)).filter(n => n.endsWith('.pending')).length, 0);
});

test('removal survives restart; delayed delete cannot affect a new grant; manual files stay intact', async t => {
  const f = await fixture(t), b = input(), store = f.store();
  await store.install(actor, b); await store.remove(actor, b.runtime, b.sessionId, b.id);
  await rejects(f.store().install(actor, b), 409);
  assert.deepEqual(await f.store().remove(actor, b.runtime, b.sessionId, b.id), { id: b.id, state: 'removed' });
  const next = { ...b, id: randomUUID() };
  await store.install(actor, next); await store.remove(actor, b.runtime, b.sessionId, b.id);
  assert.equal((await store.get(actor, b.runtime, b.sessionId))?.id, next.id);
  const manual = input(), path = join(f.directory, `${manual.runtime}-${manual.sessionId}.json`);
  const contents = JSON.stringify({ runtime: manual.runtime, sessionId: manual.sessionId, credential: manual.credential });
  await writeFile(path, contents, { mode: 0o600 });
  await rejects(store.install(actor, manual), 409); await rejects(store.remove(actor, manual.runtime, manual.sessionId, manual.id), 409);
  assert.equal(await readFile(path, 'utf8'), contents);
});

test('worker rejects tombstone crash window, corrupted receipts and modified credentials before network access', async t => {
  const f = await fixture(t), b = input(), store = f.store();
  await store.install(actor, b);
  let calls = 0;
  const worker = await loadWorkerBoardTools(f.directory, b.runtime, b.sessionId, () => true, (async () => { calls++; throw Error('not used'); }) as typeof fetch);
  assert.ok(worker);
  const tomb = join(f.directory, `.removed-${b.runtime}-${b.id}.json`);
  const receipt = join(f.directory, `.binding-${b.runtime}-${b.id}.json`), intent = await readFile(receipt, 'utf8');
  await writeFile(tomb, intent, { mode: 0o600 });
  assert.equal((await store.get(actor, b.runtime, b.sessionId))?.state, 'removed');
  assert.match(String((await worker.invoke(BOARD_READ_TOOL, {})).error), /unavailable/); assert.equal(calls, 0);
  await assert.rejects(loadWorkerBoardTools(f.directory, b.runtime, b.sessionId, () => true));
  await unlink(tomb);
  await writeFile(receipt, '{}'); await assert.rejects(loadWorkerBoardTools(f.directory, b.runtime, b.sessionId, () => true));
  await writeFile(receipt, intent);
  const path = join(f.directory, `${b.runtime}-${b.sessionId}.json`), value = JSON.parse(await readFile(path, 'utf8'));
  value.credential.token = 'aod_board_' + 'b'.repeat(43); await writeFile(path, JSON.stringify(value));
  await rejects(store.get(actor, b.runtime, b.sessionId), 503);
  await assert.rejects(loadWorkerBoardTools(f.directory, b.runtime, b.sessionId, () => true));
});

test('install intent can resume after crash or be cancelled before publication', async t => {
  const f = await fixture(t), b = input(), store = f.store();
  await store.install(actor, b);
  await unlink(join(f.directory, `${b.runtime}-${b.sessionId}.json`));
  await f.store().install(actor, b);
  await unlink(join(f.directory, `${b.runtime}-${b.sessionId}.json`));
  await f.store().remove(actor, b.runtime, b.sessionId, b.id);
  await rejects(f.store().install(actor, b), 409);
});

test('permissions, symlinks, expired input, revocation and malformed input fail closed', async t => {
  const f = await fixture(t), b = input(), store = f.store();
  await rejects(store.install(actor, { ...b, credential: { ...b.credential, expiresAt: Date.now() - 1 } }), 403);
  await rejects(store.install(actor, { ...b, sessionId: '../escape' }), 403);
  await chmod(f.directory, 0o755); await rejects(store.install(actor, b), 503); await chmod(f.directory, 0o700);
  await symlink('/does-not-exist', join(f.directory, `${b.runtime}-${b.sessionId}.json`));
  await rejects(store.install(actor, b), 503); await unlink(join(f.directory, `${b.runtime}-${b.sessionId}.json`));
  f.revoke(); await rejects(store.install(actor, b), 403);
});

test('startup and token-change reconciliation preserve valid/manual files but revoke stale managed bindings', async t => {
  const f = await fixture(t), b = input(), store = f.store();
  await store.install(actor, b);
  await f.store().reconcile();
  assert.equal((await store.get(actor, b.runtime, b.sessionId))?.state, 'installed');
  f.revoke(); await store.reconcile();
  assert.equal(await loadWorkerBoardTools(f.directory, b.runtime, b.sessionId, () => true), undefined);
  const restored = new ConnectorBoardBindings({ ghcp: f.directory }, [{ owner: actor, runtime: 'ghcp', endpoint }], () => true);
  await rejects(restored.install(actor, b), 409);
  const c = { ...input(), runtime: 'ghcp' as const };
  await restored.install(actor, c);
  const changed = new ConnectorBoardBindings({ ghcp: f.directory }, [], () => true);
  await changed.reconcile();
  assert.equal(await loadWorkerBoardTools(f.directory, c.runtime, c.sessionId, () => true), undefined);
});

test('one corrupted managed file does not prevent revocation of other bindings', async t => {
  const f = await fixture(t), store = f.store(), broken = input(), valid = input();
  await store.install(actor, broken); await store.install(actor, valid);
  await writeFile(join(f.directory, `${broken.runtime}-${broken.sessionId}.json`), '{invalid', { mode: 0o600 });
  f.revoke();
  await assert.rejects(store.reconcile(), BoardBindingError);
  assert.equal(await loadWorkerBoardTools(f.directory, valid.runtime, valid.sessionId, () => true), undefined);
  const restored = new ConnectorBoardBindings({ ghcp: f.directory }, [{ owner: actor, runtime: 'ghcp', endpoint }], () => true);
  await rejects(restored.install(actor, valid), 409);
});
