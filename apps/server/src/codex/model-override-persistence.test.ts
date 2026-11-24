import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { CodexAppServer } from './app-server.js';
import { CodexExecutions } from './executions.js';
import { TurnQueue } from '../commands/turn-queue.js';
import { DeckStore } from '../projection/deck-store.js';

const key = 'codex:synthetic-model';
function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'agentopsdeck-model-persist-'));
  const db = new DatabaseSync(join(dir, 'commands.sqlite'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const file = join(dir, 'models.json'), thinking = join(dir, 'thinking.json');
  fs.writeFileSync(file, JSON.stringify({ other: 'kept', 'synthetic-model': 'old-model', legacy: '' }, null, 2));
  fs.writeFileSync(thinking, JSON.stringify({ [key]: 'medium' }, null, 2));
  const store = new DeckStore({ sessionThinkingOverridesFile: thinking });
  store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Original', status: 'idle', model: 'old-model' });
  const codex = new CodexAppServer({ enabled: false, command: 'never-run', defaultCwd: dir,
    defaultModel: 'default-model', approvalPolicy: 'never', store, runtimeOverridesFile: file,
    turnQueue: new TurnQueue(db), executions: new CodexExecutions(db), authorizeTurn: () => false });
  const internal = codex as unknown as { threadModelOverrides: Map<string, string>; threadModels: Map<string, string>; threadEfforts: Map<string, string> };
  internal.threadModels.set('synthetic-model', 'old-model');
  internal.threadEfforts.set('synthetic-model', 'medium');
  return { dir, file, thinking, store, codex, internal, bytes: fs.readFileSync(file, 'utf8'),
    revision: store.latestEventId(), session: store.getSession(key) };
}
function failOnce(t: TestContext, method: 'writeFileSync' | 'openSync' | 'fsyncSync' | 'closeSync' | 'renameSync', after = false) {
  const original = fs[method]; let first = true;
  const mocked = t.mock.method(fs, method, (...args: unknown[]) => {
    if (!first) return (original as (...args: unknown[]) => unknown)(...args);
    first = false;
    if (after) (original as (...args: unknown[]) => unknown)(...args);
    if (method === 'writeFileSync') (original as typeof fs.writeFileSync)(args[0] as number, 'partial confidential file');
    throw Object.assign(new Error('ENOSPC confidential file'), { code: 'ENOSPC' });
  });
  syncBuiltinESMExports();
  const restore = () => { mocked.mock.restore(); syncBuiltinESMExports(); }; t.after(restore); return restore;
}
for (const method of ['writeFileSync', 'openSync', 'fsyncSync', 'closeSync', 'renameSync'] as const) {
  test(`model failed ${method} preserves durable file, dispatch maps, thinking and projection`, t => {
    const f = fixture(t); const restore = failOnce(t, method); let acks = 0;
    assert.throws(() => f.codex.updateSessionRuntime(key, { model: 'new-model', thinking: 'high' }, () => { acks++; }),
      { message: 'session_preference_persistence_failed' }); restore();
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.bytes);
    assert.equal(f.internal.threadModelOverrides.get('synthetic-model'), 'old-model');
    assert.equal(f.internal.threadModels.get('synthetic-model'), 'old-model');
    assert.equal(f.internal.threadEfforts.get('synthetic-model'), 'medium');
    assert.equal(f.store.latestEventId(), f.revision); assert.equal(acks, 0);
    assert.deepEqual(f.store.getSession(key), f.session);
    assert.deepEqual(fs.readdirSync(f.dir).filter(name => name.endsWith('.tmp')), []);
  });
}
test('thinking save failure leaves durable model known but does not install rejected dispatch effort', t => {
  const f = fixture(t); fs.unlinkSync(f.thinking); fs.mkdirSync(f.thinking); let acks = 0;
  assert.throws(() => f.codex.updateSessionRuntime(key, { model: 'new-model', thinking: 'high' }, () => { acks++; }));
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8'))['synthetic-model'], 'new-model');
  assert.equal(f.internal.threadModelOverrides.get('synthetic-model'), 'new-model');
  assert.equal(f.internal.threadModels.get('synthetic-model'), 'new-model');
  assert.equal(f.internal.threadEfforts.get('synthetic-model'), 'medium');
  assert.equal(f.store.latestEventId(), f.revision); assert.equal(acks, 0);
});
test('lost model rename ACK does not replay; later explicit change reconciles unrelated saved entries', t => {
  const f = fixture(t); const restore = failOnce(t, 'renameSync', true); let acks = 0;
  assert.throws(() => f.codex.updateSessionRuntime(key, { model: 'new-model' }, () => { acks++; })); restore();
  assert.equal(acks, 0); assert.equal(f.internal.threadModels.get('synthetic-model'), 'old-model');
  assert.equal(f.store.latestEventId(), f.revision);
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8'))['synthetic-model'], 'new-model');
  fs.writeFileSync(f.file, JSON.stringify({ other: 'kept', 'synthetic-model': 'new-model', legacy: '', durable: 'another-model' }, null, 2));
  f.codex.updateSessionRuntime(key, { model: 'explicit-model' });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), { other: 'kept', 'synthetic-model': 'explicit-model', legacy: '', durable: 'another-model' });
});
test('successful model update preserves legacy object order, empty entries and native dispatch values', t => {
  const f = fixture(t); let acks = 0;
  f.codex.updateSessionRuntime(key, { model: ' new-model ', thinking: 'high' }, session => {
    acks++; assert.equal(session.model, 'new-model'); assert.equal(session.thinkingLevel, 'high');
    assert.equal(f.internal.threadModels.get('synthetic-model'), 'new-model');
    assert.equal(f.internal.threadEfforts.get('synthetic-model'), 'high');
  });
  assert.equal(acks, 1);
  assert.equal(fs.readFileSync(f.file, 'utf8'), JSON.stringify({ other: 'kept', 'synthetic-model': 'new-model', legacy: '' }, null, 2));
});
for (const shape of ['{broken', '[]', 'null', '"wrong"']) test(`malformed models ${shape} fails closed without replacing disk or dispatch`, t => {
  const f = fixture(t); fs.writeFileSync(f.file, shape); let acks = 0;
  assert.throws(() => f.codex.updateSessionRuntime(key, { model: 'new-model' }, () => { acks++; }),
    { message: 'session_preference_persistence_failed' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), shape);
  assert.equal(f.internal.threadModels.get('synthetic-model'), 'old-model');
  assert.equal(f.store.latestEventId(), f.revision); assert.equal(acks, 0);
});
test('ACK refusal does not roll back independently durable model or thinking', t => {
  const f = fixture(t);
  assert.throws(() => f.codex.updateSessionRuntime(key, { model: 'new-model', thinking: 'high' }, () => {
    throw new Error('synthetic ACK unavailable');
  }), /synthetic ACK unavailable/);
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8'))['synthetic-model'], 'new-model');
  assert.equal(JSON.parse(fs.readFileSync(f.thinking, 'utf8'))[key], 'high');
  assert.equal(f.internal.threadModels.get('synthetic-model'), 'new-model');
  assert.equal(f.internal.threadEfforts.get('synthetic-model'), 'high');
  assert.equal(f.store.latestEventId(), f.revision);
});
test('reset uses the existing default model and deletes thinking only after durable save', t => {
  const f = fixture(t);
  const session = f.codex.updateSessionRuntime(key, { model: null, thinking: null });
  assert.equal(session.model, 'default-model'); assert.equal(session.thinkingLevel, undefined);
  assert.equal(f.internal.threadModels.get('synthetic-model'), 'default-model');
  assert.equal(f.internal.threadEfforts.has('synthetic-model'), false);
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8'))['synthetic-model'], 'default-model');
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(f.thinking, 'utf8')), key), false);
});
test('model replacement preserves existing Unix mode', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); fs.chmodSync(f.file, 0o640);
  f.codex.updateSessionRuntime(key, { model: 'new-model' });
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o640);
});
test('model symlink keeps its destination and dangling links fail closed', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); const target = join(f.dir, 'target.json'); fs.renameSync(f.file, target); fs.symlinkSync(target, f.file);
  f.codex.updateSessionRuntime(key, { model: 'new-model' });
  assert.equal(fs.lstatSync(f.file).isSymbolicLink(), true);
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8'))['synthetic-model'], 'new-model');
  fs.unlinkSync(target); const before = f.internal.threadModels.get('synthetic-model');
  assert.throws(() => f.codex.updateSessionRuntime(key, { model: 'rejected-model' }), { message: 'session_preference_persistence_failed' });
  assert.equal(fs.lstatSync(f.file).isSymbolicLink(), true); assert.equal(fs.existsSync(target), false);
  assert.equal(f.internal.threadModels.get('synthetic-model'), before);
});
