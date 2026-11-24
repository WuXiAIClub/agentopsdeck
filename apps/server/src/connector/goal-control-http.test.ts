import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { CodexAppServer } from '../codex/app-server.js';
import { goalSnapshot } from '../codex/goal-control.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { registerSessionSettingsRoutes } from './session-settings-http.js';
import { registerRequestDrain } from '../lifecycle/request-drain.js';

const goal = { threadId: 'thread', objective: 'Private scoped task', status: 'active', tokenBudget: 1000,
  tokensUsed: 45, timeUsedSeconds: 30, createdAt: 1, updatedAt: 2 };
const key = 'codex:thread', path = `/api/sessions/${encodeURIComponent(key)}`;
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-goal-http-')), file = join(directory, 'connector.sqlite');
  let users: ConnectorUserStore, codex: CodexAppServer, app: Hono, drain: ReturnType<typeof registerRequestDrain>;
  const calls: string[] = [], mode = { malformed: false, revoked: false, revokeOnWrite: false, admitted: true,
    readFailure: false, readHttpFailure: false, writeFailure: false };
  let nativeGoal: any = goal;
  const open = () => {
    users = new ConnectorUserStore(file);
    const store = new DeckStore(); store.upsertSession({ sessionKey: key, title: 'Goal', agentId: 'codex', status: 'idle' });
    codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: directory,
      defaultModel: 'test', approvalPolicy: 'never', store, turnQueue: users.turns, executions: users.codexExecutions, authorizeTurn: () => true });
    const runtime = codex as any; runtime.setConnection('connection');
    runtime.ensureStarted = () => assert.fail('No model process');
    runtime.request = async (method: string, params: any, _timeout?: number, receipt?: { beforeWrite: () => void }) => {
      calls.push(method);
      if (method === 'thread/goal/get') {
        if (mode.readHttpFailure) throw new HTTPException(503);
        if (mode.readFailure) throw new Error('synthetic preflight read timeout');
        return { goal: nativeGoal };
      }
      receipt?.beforeWrite();
      assert.equal(users.commands.sessionSettingsPending(key), true, 'receipt durable before dispatch');
      if (mode.writeFailure) throw new Error('synthetic write response lost');
      if (method === 'thread/goal/clear') nativeGoal = null;
      else { assert.equal(method, 'thread/goal/set'); nativeGoal = { ...(nativeGoal ?? goal), ...params }; }
      if (mode.revokeOnWrite) mode.revoked = true;
      return mode.malformed ? {} : method === 'thread/goal/clear' ? { cleared: true } : { goal: nativeGoal };
    };
    app = new Hono(); drain = registerRequestDrain(app);
    registerSessionSettingsRoutes(app, '/api/sessions/:sessionKey', { store, codex, receipts: users.commands,
      actor: c => { if (mode.revoked) throw new HTTPException(403); return c.req.header('actor') ?? 'a'; },
      sessionKey: c => c.req.param('sessionKey')!, settingsAdmission: k => mode.admitted && users.canChangeSettings(k),
      refreshSessions: async () => {}, gateway: {} as any });
  };
  open();
  t.after(async () => { await codex.close(); users.close(); rmSync(directory, { recursive: true, force: true }); });
  const control = (action = 'pause', extra = {}) => ({ action, expectedRevision: goalSnapshot({ goal: nativeGoal }, 'thread', 'connection').revision, ...extra });
  return { calls, mode, control, pause: () => drain.pauseWrites(),
    enqueue: async (id: string) => await users.turns.enqueueAsync('codex', { id, sessionKey: key, createdAt: 1,
      payload: { actorId: 'a', text: 'Original queued message', images: [] } }),
    claim: (id: string) => users.turns.startBatch('codex', key, [id]),
    pending: () => users.commands.sessionSettingsPending(key),
    read: (actor = 'a') => app.request(`${path}/goal`, { headers: { actor } }),
    receipt: (command = 'original', actor = 'a') => app.request(`${path}/settings-commands/${command}`, { headers: { actor } }),
    patch: (payload: object, command = 'original', actor = 'a') => app.request(path, { method: 'PATCH',
      headers: { 'content-type': 'application/json', 'idempotency-key': command, actor }, body: JSON.stringify(payload) }),
    reopen: async () => { await codex.close(); users.close(); open(); } };
}

test('Goal HTTP accepts explicit changes, strips private objectives from receipts and deduplicates after restart', async t => {
  const f = fixture(t), payload = { goal: f.control() };
  const observed = await f.read(); assert.equal(observed.status, 200); assert.equal(observed.headers.get('cache-control'), 'no-store');
  const first = await f.patch(payload); assert.equal(first.status, 200);
  const body = await first.json() as any;
  assert.deepEqual(body.settings, { goalControl: 'pause' }); assert.ok(!JSON.stringify(body).includes('Private scoped'));
  await f.reopen();
  assert.equal((await f.patch(payload)).status, 200);
  assert.equal((await (await f.receipt()).json() as any).command.state, 'accepted');
  assert.equal((await f.receipt('original', 'other')).status, 404);
  assert.equal(f.calls.filter(v => v === 'thread/goal/set').length, 1);
});

test('Goal malformed native ACK remains unknown across restart and blocks new intents for all actors', async t => {
  const f = fixture(t); f.mode.malformed = true;
  const payload = { goal: f.control() };
  assert.equal((await f.patch(payload)).status, 202); assert.equal(f.pending(), true);
  await f.reopen(); f.mode.malformed = false;
  assert.equal((await f.patch(payload)).status, 202);
  assert.equal((await f.patch({ goal: f.control('resume') }, 'new', 'other')).status, 409);
  assert.equal((await (await f.receipt()).json() as any).command.state, 'outcome_unknown');
  assert.equal(f.calls.filter(v => v === 'thread/goal/set').length, 1);
});

for (const failure of ['readFailure', 'readHttpFailure'] as const) test(`Goal preflight ${failure} rejects durably, releases admission and never replays the old intent`, async t => {
  const f = fixture(t), payload = { goal: f.control() };
  await f.enqueue('original-queued-message');
  f.mode[failure] = true;
  assert.equal((await f.patch(payload)).status, 409);
  assert.equal(f.pending(), false);
  assert.equal((await (await f.receipt()).json() as any).command.state, 'rejected');
  assert.deepEqual(f.calls, ['thread/goal/get']);
  await f.reopen(); f.mode[failure] = false;
  assert.equal((await f.patch(payload)).status, 409, 'old key cannot become a new write after recovery');
  assert.deepEqual(f.calls, ['thread/goal/get']);
  assert.equal((await f.patch({ title: 'A later explicit change' }, 'new', 'other')).status, 200);
  assert.equal(f.pending(), false, 'the preflight failure must not fence other actors or later messages');
  assert.equal(f.claim('original-queued-message'), true, 'the original queued identity can start without cancel/resend');
  assert.equal(f.claim('original-queued-message'), false, 'the same message cannot be claimed twice');
});

test('Goal write transport failure remains unknown and cannot be replayed after restart', async t => {
  const f = fixture(t), payload = { goal: f.control() };
  await f.enqueue('original-queued-message');
  f.mode.writeFailure = true;
  assert.equal((await f.patch(payload)).status, 202);
  assert.equal(f.pending(), true);
  await f.reopen(); f.mode.writeFailure = false;
  assert.equal((await f.patch(payload)).status, 202);
  assert.equal((await f.patch({ title: 'Not safe yet' }, 'new', 'other')).status, 409);
  assert.equal(f.claim('original-queued-message'), false, 'a lost write reply still protects execution');
  assert.deepEqual(f.calls, ['thread/goal/get', 'thread/goal/set']);
});

test('Goal invalid payload and stale preflight settle rejected without native mutation', async t => {
  const f = fixture(t);
  for (const [i, payload] of [{ goal: f.control('resume'), title: 'mixed' }, { goal: f.control('edit', { tokenBudget: null }) },
    { goal: f.control('create') }, { goal: f.control('pause', { expectedRevision: 'f'.repeat(64) }) },
    { goal: f.control('edit', { tokenBudget: 0 }) }].entries()) {
    const response = await f.patch(payload, `bad${i}`);
    assert.ok([400, 409].includes(response.status));
    if (i === 3) assert.equal((await response.json() as any).error, 'Command rejected',
      'the receipt layer must retain its existing sanitized rejection response');
    assert.equal((await (await f.receipt(`bad${i}`)).json() as any).command.state, 'rejected');
    assert.equal(f.pending(), false);
  }
  assert.equal(f.calls.filter(v => v !== 'thread/goal/get').length, 0);
});

test('Goal clear/create/edit preserve explicit budget and do not synthesize chat/turn requests', async t => {
  const f = fixture(t);
  for (const [i, [action, extra]] of [['clear', {}], ['create', { objective: 'New scoped goal', tokenBudget: 1 }],
    ['edit', { tokenBudget: 20 }], ['resume', {}]].entries()) {
    assert.equal((await f.patch({ goal: f.control(action as string, extra) }, `change${i}`)).status, 200);
  }
  assert.ok(f.calls.every(v => ['thread/goal/get', 'thread/goal/set', 'thread/goal/clear'].includes(v)));
});

test('Goal authorization revoked after dispatch still saves original ACK, never resends', async t => {
  const f = fixture(t); f.mode.revokeOnWrite = true;
  const payload = { goal: f.control() }; await f.patch(payload);
  f.mode.revoked = false;
  assert.equal((await (await f.receipt()).json() as any).command.state, 'accepted');
  assert.equal((await f.patch(payload)).status, 200);
  assert.equal(f.calls.filter(v => v === 'thread/goal/set').length, 1);
});

test('maintenance and execution admission reject Goal spending before native dispatch', async t => {
  const f = fixture(t), pause = f.pause(); await pause.drained;
  assert.equal((await f.patch({ goal: f.control('resume') })).status, 503);
  assert.equal(f.calls.length, 0); assert.equal(pause.resume(), true);
  f.mode.admitted = false;
  assert.equal((await f.patch({ goal: f.control('resume') })).status, 409);
  assert.equal(f.calls.length, 0);
});
