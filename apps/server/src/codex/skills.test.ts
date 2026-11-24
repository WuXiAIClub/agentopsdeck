import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { validateSessionSkills } from '@agentopsdeck/shared';
import { projectSkills, SessionSkillsCache } from './skills.js';
import { CodexAppServer } from './app-server.js';
import { DeckStore } from '../projection/deck-store.js';
import { TurnQueue } from '../commands/turn-queue.js';
import { CodexExecutions } from './executions.js';

const row = { name: 'fixture', description: 'safe description', scope: 'repo', enabled: true, path: '/private/SKILL.md', dependencies: { private: 'hidden' } };
const catalog = (skills: unknown[] = [row]) => ({ data: [{ cwd: '/repo', skills, errors: [] as unknown[] }] });
test('skills allowlist exposes discovery, never path/body/dependencies/loaded claims', () => {
  const result = projectSkills(catalog(), '/repo', 10);
  assert.deepEqual(result, { skills: [{ name: 'fixture', description: 'safe description', scope: 'repo', enabled: true }], observedAt: 10, limited: false, discoveryErrors: 0, usage: 'unknown' });
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.deepEqual(validateSessionSkills({ ...result, loaded: true, secrets: 'hidden' }), result);
  assert.throws(() => validateSessionSkills({ ...result, usage: 'loaded' }));
  for (const value of [null, {}, { data: [] }, { data: [catalog().data[0], catalog().data[0]] }]) assert.throws(() => projectSkills(value, '/repo'));
  assert.throws(() => projectSkills(catalog(), '/other'));
  assert.throws(() => projectSkills(catalog([{ ...row, enabled: 'true' }]), '/repo'));
});
test('skills metadata has independent count/UTF8 limits and error details stay local', () => {
  const short = projectSkills(catalog(Array.from({ length: 201 }, (_, i) => ({ ...row, name: String(i) }))), '/repo');
  assert.equal(short.skills.length, 200); assert.equal(short.limited, true);
  const long = projectSkills(catalog(Array.from({ length: 200 }, (_, i) => ({ ...row, name: String(i), description: '汉'.repeat(1000) }))), '/repo');
  assert.equal(long.limited, true); assert.ok(Buffer.byteLength(JSON.stringify(long)) < 96 * 1024);
  const errors = catalog(); errors.data[0]!.errors = Array(2000).fill('/secret/failed');
  assert.equal(projectSkills(errors, '/repo').discoveryErrors, 1000);
});
test('skills cache coalesces by session, expires, bounds concurrency and retries only explicitly', async () => {
  let now = 0, calls = 0, release!: (value: ReturnType<typeof projectSkills>) => void;
  const cache = new SessionSkillsCache(() => now), value = projectSkills(catalog(), '/repo');
  const load = () => { calls++; return new Promise<typeof value>(resolve => { release = resolve; }); };
  const a = cache.read('a', load), b = cache.read('a', load);
  await Promise.resolve(); assert.equal(calls, 1); release(value); await Promise.all([a, b]);
  await cache.read('a', load); assert.equal(calls, 1);
  now = 30_001; const c = cache.read('a', load); await Promise.resolve(); release(value); await c; assert.equal(calls, 2);
  await assert.rejects(cache.read('fail', async () => { throw new Error('offline'); }));
  await cache.read('fail', async () => value);
  const resolves: Array<(result: typeof value) => void> = [];
  const pending = [0, 1, 2, 3].map(i => cache.read(String(i), () => new Promise<typeof value>(resolve => { resolves.push(resolve); })));
  await assert.rejects(cache.read('fifth', async () => value), /busy/);
  resolves.forEach(resolve => resolve(value)); await Promise.all(pending);
});
test('skills invalidation rejects late metadata, retains request budget and recovers explicitly', async () => {
  const cache = new SessionSkillsCache(), value = projectSkills(catalog(), '/repo');
  const releases: Array<(result: ReturnType<typeof projectSkills>) => void> = [];
  const pending = [0, 1, 2, 3].map(i => cache.read(String(i), () => new Promise<typeof value>(resolve => releases.push(resolve))));
  const rejected = pending.map(p => assert.rejects(p, /changed/));
  await Promise.resolve(); cache.invalidate(); cache.invalidate();
  await assert.rejects(cache.read('new', async () => value), /busy/);
  releases.forEach(resolve => resolve(value)); await Promise.all(rejected);
  let reads = 0;
  await cache.read('0', async () => { reads++; return value; });
  await cache.read('0', async () => { reads++; return value; });
  assert.equal(reads, 1);
  cache.invalidate();
  await cache.read('0', async () => { reads++; return value; });
  assert.equal(reads, 2);
});
test('Codex discovery verifies native identity/cwd, never resumes a thread or fetches history', async () => {
  const db = new DatabaseSync(':memory:'), store = new DeckStore();
  const server = new CodexAppServer({ enabled: true, command: '/never-launch', defaultCwd: '/wrong', defaultModel: 'fixture', approvalPolicy: 'never',
    store, turnQueue: new TurnQueue(db), executions: new CodexExecutions(db), authorizeTurn: () => true });
  const internal = server as any, calls: Array<[string, unknown]> = [];
  internal.ensureStarted = async () => undefined;
  internal.connectionId = 'fixture-connection';
  internal.request = async (method: string, params: any) => {
    calls.push([method, params]);
    if (method === 'thread/read') return { thread: { id: params.threadId, cwd: '/repo' } };
    if (method === 'skills/list') return catalog();
    assert.fail(`unexpected native call ${method}`);
  };
  store.upsertSession({ sessionKey: 'codex:fixture', agentId: 'codex', title: 'Fixture', status: 'idle' });
  try {
    assert.equal((await server.listSessionSkills('codex:fixture')).skills.length, 1);
    await server.listSessionSkills('codex:fixture');
    assert.deepEqual(calls, [['thread/read', { threadId: 'fixture', includeTurns: false }], ['skills/list', { cwds: ['/repo'], forceReload: false }]]);
    internal.handleNotification('skills/changed', {});
    assert.equal(calls.length, 2, 'notification does not poll or resume native work');
    assert.equal((await server.listSessionSkills('codex:fixture')).usage, 'unknown');
    assert.equal(calls.length, 4, 'next explicit read refreshes invalidated metadata');
    await assert.rejects(server.listSessionSkills('codex:other'));
    internal.connectionId = 'other';
    internal.request = async () => ({ thread: { id: 'wrong', cwd: '/repo' } });
    await assert.rejects(server.listSessionSkills('codex:fixture'), /directory/);
  } finally { await server.close(); db.close(); }
});
