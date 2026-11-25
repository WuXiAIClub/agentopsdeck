import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';

function fixture(context: TestContext, overrides: Partial<ConstructorParameters<typeof CodexAppServer>[0]> = {}) {
  const owner = new ConnectorUserStore(':memory:');
  const store = new DeckStore();
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '/synthetic-workspace',
    defaultModel: 'synthetic', approvalPolicy: 'never', authorizeTurn: () => true,
    turnQueue: owner.turns, executions: owner.codexExecutions, store, ...overrides });
  const runtime = codex as any;
  runtime.connectionId = 'original-connection';
  context.after(async () => { await codex.close(); owner.close(); });
  const addSession = (threadId = 'synthetic') => {
    const sessionKey = `codex:${threadId}`;
    store.upsertSession({ sessionKey, agentId: 'codex', title: 'Synthetic', status: 'running',
      runtime: { phase: 'running', turnId: 'original-run', connection: 'connected', sync: 'current', lastEventAt: 100 } });
    assert.ok(owner.codexExecutions.begin(sessionKey, 'original-command', runtime.connectionId));
    assert.ok(owner.codexExecutions.acknowledge(sessionKey, 'original-command', runtime.connectionId, 'original-run', () => {}));
    return { sessionKey, threadId };
  };
  const session = addSession();
  const delta = (itemId: string, text: string, threadId = session.threadId, turnId = 'original-run') => {
    runtime.handleNotification('item/agentMessage/delta', { threadId, turnId, itemId, delta: text });
  };
  const completed = (itemId: string, text: string, threadId = session.threadId) => {
    runtime.handleNotification('item/completed', { threadId, turnId: 'original-run', item: { id: itemId, type: 'agentMessage', text } });
  };
  return { codex, runtime, owner, store, ...session, addSession, delta, completed };
}

async function rejectedRuntimeChange(context: TestContext, setup: ReturnType<typeof fixture>, sessionKey: string,
  model: string, file?: string) {
  setup.owner.turns.enqueue('codex', { id: `unknown-settings-${randomUUID()}`, sessionKey, createdAt: 1,
    state: 'outcome_unknown', payload: { text: 'unknown', images: [] } });
  const overrides = [...setup.runtime.threadModelOverrides];
  const models = [...setup.runtime.threadModels];
  const efforts = [...setup.runtime.threadEfforts];
  const session = structuredClone(setup.store.getSession(sessionKey));
  const execution = structuredClone(setup.owner.codexExecutions.get(sessionKey));
  const queued = structuredClone(setup.owner.turns.list('codex', sessionKey));
  const bytes = file ? readFileSync(file) : undefined;
  const legacyThinking = context.mock.method(setup.store, 'persistSessionThinkingOverride');
  const ownedThinking = context.mock.method(setup.store, 'persistSessionThinkingEffect');
  let acknowledgements = 0;
  const unchanged = () => {
    assert.deepEqual([...setup.runtime.threadModelOverrides], overrides);
    assert.deepEqual([...setup.runtime.threadModels], models);
    assert.deepEqual([...setup.runtime.threadEfforts], efforts);
    assert.deepEqual(setup.store.getSession(sessionKey), session);
    assert.deepEqual(setup.owner.codexExecutions.get(sessionKey), execution);
    assert.deepEqual(setup.owner.turns.list('codex', sessionKey), queued);
    assert.equal(setup.owner.turns.head('codex', sessionKey)?.state, 'outcome_unknown');
    assert.equal(legacyThinking.mock.callCount(), 0);
    assert.equal(ownedThinking.mock.callCount(), 0);
    assert.equal(acknowledgements, 0);
    if (file) assert.deepEqual(readFileSync(file), bytes);
  };
  assert.throws(() => setup.codex.updateSessionRuntime(sessionKey, { model, thinking: 'high' }, () => { acknowledgements++; }),
    { message: 'session_preference_persistence_failed' });
  unchanged();
  await assert.rejects(setup.codex.updateSessionRuntimeOwned(sessionKey, { model, thinking: 'high' },
    async () => { acknowledgements++; }, () => {}), { message: 'session_preference_persistence_failed' });
  unchanged();
}

test('runtime overrides reject malformed and bounded-invalid input atomically with content-free diagnostics', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'aod-overrides-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'synthetic-private-config.json');
  const warnings: unknown[][] = [];
  context.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args));
  const inputs = [
    '{"synthetic-private-fragment":',
    'x'.repeat(64 * 1024 + 1),
    JSON.stringify(Array.from({ length: 1 }, () => 'synthetic')),
    JSON.stringify(Object.fromEntries(Array.from({ length: 513 }, (_, index) => [`thread-${index}`, 'synthetic']))),
    JSON.stringify({ valid: 'synthetic', invalid: 'x'.repeat(129) }),
    JSON.stringify({ ['x'.repeat(129)]: 'synthetic' }),
    JSON.stringify({ valid: 'synthetic', invalid: null }),
  ];
  for (const input of inputs) {
    writeFileSync(file, input);
    const setup = fixture(context, { runtimeOverridesFile: file });
    assert.equal(setup.runtime.threadModelOverrides.size, 0);
    await setup.codex.close();
  }
  assert.deepEqual(warnings, inputs.map(() => ['[codex] Runtime overrides unavailable']));
  writeFileSync(file, JSON.stringify({ thread: ' synthetic-model ', native: '' }));
  const valid = fixture(context, { runtimeOverridesFile: file });
  assert.deepEqual([...valid.runtime.threadModelOverrides], [['thread', 'synthetic-model'], ['native', '']]);
  const missing = fixture(context, { runtimeOverridesFile: join(directory, 'missing.json') });
  assert.equal(missing.runtime.threadModelOverrides.size, 0);
  assert.equal(warnings.length, inputs.length);
});

test('override filesystem failures and hostile diagnostic sinks cannot expose raw errors or disrupt construction', context => {
  const directory = mkdtempSync(join(tmpdir(), 'aod-overrides-fault-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  context.mock.method(console, 'warn', (message: unknown) => {
    assert.equal(message, '[codex] Runtime overrides unavailable');
    throw new Error('synthetic-private-log-sink');
  });
  const setup = fixture(context, { runtimeOverridesFile: directory });
  assert.equal(setup.runtime.threadModelOverrides.size, 0);
});

test('runtime model mutations reject oversized raw models and keys before persistence or ACK in both paths', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'aod-overrides-mutation-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const model of ['x'.repeat(129), ' '.repeat(129), ` ${'x'.repeat(128)}`]) {
    const file = join(directory, 'models.json');
    writeFileSync(file, JSON.stringify({ synthetic: 'old-model', unrelated: 'preserved' }));
    const setup = fixture(context, { runtimeOverridesFile: file });
    await rejectedRuntimeChange(context, setup, setup.sessionKey, model, file);
  }
  const file = join(directory, 'keys.json');
  writeFileSync(file, JSON.stringify({ unrelated: 'preserved' }));
  const setup = fixture(context, { runtimeOverridesFile: file });
  const oversized = setup.addSession('x'.repeat(129));
  await rejectedRuntimeChange(context, setup, oversized.sessionKey, 'valid-model', file);
  assert.deepEqual(readdirSync(directory).sort(), ['keys.json', 'models.json']);
});

test('explicit model changes reread bounded complete objects and never overwrite invalid existing data', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'aod-overrides-reread-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'models.json');
  const invalidInputs = [
    '{"synthetic-private-fragment":',
    'x'.repeat(64 * 1024 + 1),
    JSON.stringify(['invalid']),
    JSON.stringify({ preserved: 'valid', invalid: null }),
    JSON.stringify({ preserved: 'valid', invalid: 'x'.repeat(129) }),
    JSON.stringify({ ['x'.repeat(129)]: 'valid' }),
    JSON.stringify({ ' ': 'invalid' }),
    JSON.stringify(Object.fromEntries(Array.from({ length: 513 }, (_, index) => [`thread-${index}`, 'valid']))),
  ];
  for (const input of invalidInputs) {
    writeFileSync(file, JSON.stringify({ synthetic: 'old-model', preserved: 'valid' }));
    const setup = fixture(context, { runtimeOverridesFile: file });
    writeFileSync(file, input);
    await rejectedRuntimeChange(context, setup, setup.sessionKey, 'new-model', file);
    assert.deepEqual(readdirSync(directory), ['models.json']);
  }
});

test('runtime mutations enforce entry and serialized UTF-8 byte budgets before any effects', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'aod-overrides-budget-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'models.json');
  writeFileSync(file, JSON.stringify(Object.fromEntries(Array.from({ length: 512 }, (_, index) => [`thread-${index}`, 'valid']))));
  const entries = fixture(context, { runtimeOverridesFile: file });
  assert.equal(entries.runtime.threadModelOverrides.size, 512);
  await rejectedRuntimeChange(context, entries, entries.sessionKey, 'new-model', file);

  const values = Object.fromEntries(Array.from({ length: 486 }, (_, index) => [`t-${index}`, '😀'.repeat(30)]));
  const original = JSON.stringify(values, null, 2);
  const oversized = JSON.stringify({ ...values, synthetic: '😀'.repeat(64) }, null, 2);
  assert.ok(Buffer.byteLength(original, 'utf8') <= 64 * 1024);
  assert.ok(oversized.length < 64 * 1024);
  assert.ok(Buffer.byteLength(oversized, 'utf8') > 64 * 1024);
  writeFileSync(file, original);
  const bytes = fixture(context, { runtimeOverridesFile: file });
  assert.equal(bytes.runtime.threadModelOverrides.size, 486);
  await rejectedRuntimeChange(context, bytes, bytes.sessionKey, '😀'.repeat(64), file);

  const compactValues = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`t-${index}`, '😀'.repeat(30)]));
  const compact = JSON.stringify(compactValues);
  assert.ok(Buffer.byteLength(compact, 'utf8') <= 64 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(compactValues, null, 2), 'utf8') > 64 * 1024);
  writeFileSync(file, compact);
  const encoding = fixture(context, { runtimeOverridesFile: file });
  assert.equal(encoding.runtime.threadModelOverrides.size, 500);
  const existing = encoding.addSession('t-0');
  await rejectedRuntimeChange(context, encoding, existing.sessionKey, 'valid', file);
});

test('runtime model mutations without a file retain the same bounds', async context => {
  const setup = fixture(context);
  await rejectedRuntimeChange(context, setup, setup.sessionKey, 'x'.repeat(129));
  const full = fixture(context);
  full.runtime.threadModelOverrides = new Map(Array.from({ length: 512 }, (_, index) => [`thread-${index}`, 'valid']));
  await rejectedRuntimeChange(context, full, full.sessionKey, 'valid');
});

test('accepted runtime mutations reconcile disk overrides and reload exact supported boundary values', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'aod-overrides-roundtrip-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'models.json');
  writeFileSync(file, JSON.stringify({ synthetic: 'old-model' }));
  const setup = fixture(context, { runtimeOverridesFile: file });
  writeFileSync(file, JSON.stringify({ synthetic: 'external-model', external: ' external-model ', native: '' }));
  const model = '😀'.repeat(64);
  let acknowledgements = 0;
  setup.codex.updateSessionRuntime(setup.sessionKey, { model }, session => {
    assert.equal(session.model, model);
    acknowledgements++;
  });
  const expected = { synthetic: model, external: 'external-model', native: '' };
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), expected);
  const reloaded = fixture(context, { runtimeOverridesFile: file });
  assert.deepEqual(Object.fromEntries(reloaded.runtime.threadModelOverrides), expected);
  const boundary = setup.addSession('k'.repeat(128));
  await setup.codex.updateSessionRuntimeOwned(boundary.sessionKey, { model: 'x'.repeat(128) }, async session => {
    assert.equal(session.model, 'x'.repeat(128));
    acknowledgements++;
  }, () => {});
  const ownedReloaded = fixture(context, { runtimeOverridesFile: file });
  assert.deepEqual(Object.fromEntries(ownedReloaded.runtime.threadModelOverrides), { ...expected, ['k'.repeat(128)]: 'x'.repeat(128) });
  assert.equal(acknowledgements, 2);
});

test('bounded runtime persistence preserves symlink target mode and rejects nonregular and linked targets', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'aod-overrides-atomic-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'models.json');
  writeFileSync(file, JSON.stringify({ synthetic: 'old-model' }));
  chmodSync(file, 0o640);
  const alias = join(directory, 'alias.json');
  symlinkSync(file, alias);
  const setup = fixture(context, { runtimeOverridesFile: alias });
  setup.codex.updateSessionRuntime(setup.sessionKey, { model: 'new-model' });
  assert.equal(readFileSync(alias, 'utf8'), readFileSync(file, 'utf8'));
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o640);
  const hardLink = join(directory, 'hard.json');
  linkSync(file, hardLink);
  await rejectedRuntimeChange(context, setup, setup.sessionKey, 'rejected-model', file);
  assert.equal(readFileSync(hardLink, 'utf8'), readFileSync(file, 'utf8'));
  setup.runtime.options.runtimeOverridesFile = directory;
  await rejectedRuntimeChange(context, setup, setup.sessionKey, 'rejected-model');
  const dangling = join(directory, 'dangling.json');
  symlinkSync(join(directory, 'absent.json'), dangling);
  setup.runtime.options.runtimeOverridesFile = dangling;
  await rejectedRuntimeChange(context, setup, setup.sessionKey, 'rejected-model');
  assert.deepEqual(readdirSync(directory).sort(), ['alias.json', 'dangling.json', 'hard.json', 'models.json']);
});

test('cumulative UTF-8 deltas stop before retention overflow and preserve exact execution and unknown queue', async context => {
  const setup = fixture(context);
  setup.owner.turns.enqueue('codex', { id: 'unknown-admission', sessionKey: setup.sessionKey, createdAt: 1,
    state: 'outcome_unknown', payload: { text: 'unknown', images: [] } });
  setup.owner.turns.enqueue('codex', { id: 'successor', sessionKey: setup.sessionKey, createdAt: 2,
    payload: { text: 'successor', images: [] } });
  const execution = setup.owner.codexExecutions.get(setup.sessionKey);
  const queued = setup.owner.turns.list('codex', setup.sessionKey);
  const chunk = '😀'.repeat(64 * 1024);
  for (let index = 0; index < 4; index++) setup.delta('reply', chunk);
  assert.equal(Buffer.byteLength(setup.store.getMessages(setup.sessionKey)[0]!.text), 1024 * 1024);
  setup.delta('reply', 'x');
  await setup.runtime.nativeObservations.drain();
  assert.equal(setup.runtime.assistantRetainedBytes, 1024 * 1024);
  assert.equal(setup.runtime.assistantText.size, 1);
  assert.equal(setup.runtime.executionUnavailable, true);
  const display = setup.store.getMessages(setup.sessionKey).find(message => message.role === 'system');
  assert.equal(display?.status, 'failed');
  assert.equal(display?.turnId, 'original-run');
  assert.match(display?.text ?? '', /display incomplete; execution outcome unconfirmed/);
  assert.throws(() => setup.store.getSession(setup.sessionKey), /Codex execution facts unavailable/);
  await assert.rejects(setup.runtime.nativeObservations.beforeEffect(), /observations unavailable/);
  setup.runtime.handleNotification('turn/completed', { threadId: setup.threadId, turn: { id: 'original-run', status: 'completed' } });
  setup.delta('replacement', 'ignored');
  assert.deepEqual(setup.owner.codexExecutions.get(setup.sessionKey), execution);
  assert.deepEqual(setup.owner.turns.list('codex', setup.sessionKey), queued);
  assert.equal(setup.owner.codexExecutions.canStart(setup.sessionKey), false);
  assert.equal(setup.owner.turns.head('codex', setup.sessionKey)?.state, 'outcome_unknown');
  assert.equal(setup.runtime.connectionId, 'original-connection');
});

test('completed assistant items still consume the cumulative per-turn byte budget', async context => {
  const setup = fixture(context);
  const text = 'x'.repeat(1024 * 1024);
  for (let index = 0; index < 8; index++) { setup.completed(`reply-${index}`, text); await tick(); }
  assert.equal(setup.runtime.assistantText.size, 0);
  assert.equal(setup.runtime.assistantRetainedBytes, 8 * 1024 * 1024);
  assert.equal(setup.store.getMessages(setup.sessionKey).length, 8);
  setup.completed('overflow', 'x');
  assert.equal(setup.runtime.executionUnavailable, true);
  assert.equal(setup.store.getMessages(setup.sessionKey).filter(message => message.role === 'assistant').length, 8);
  assert.equal(setup.owner.codexExecutions.get(setup.sessionKey)?.phase, 'running');
});

test('item cardinality is bounded even when completed assistant text is tiny', async context => {
  const setup = fixture(context);
  for (let index = 0; index < 128; index++) { setup.completed(`reply-${index}`, 'x'); await tick(); }
  setup.completed('overflow', 'x');
  assert.equal(setup.runtime.executionUnavailable, true);
  assert.equal(setup.runtime.assistantRetainedItems, 128);
  assert.equal(setup.runtime.completedAssistantItems.size, 128);
  assert.equal(setup.store.getMessages(setup.sessionKey).filter(message => message.role === 'assistant').length, 128);
});

test('empty commentary completions release placeholder retention without consuming item cardinality', async context => {
  const setup = fixture(context);
  for (let index = 0; index < 200; index++) {
    if (index % 2 === 0) setup.delta(`empty-${index}`, '   ');
    setup.completed(`empty-${index}`, '');
  }
  await tick();
  assert.equal(setup.runtime.executionUnavailable, false);
  assert.equal(setup.runtime.assistantRetainedItems, 0);
  assert.equal(setup.runtime.assistantRetainedBytes, 0);
  assert.equal(setup.store.getMessages(setup.sessionKey).filter(message => message.role === 'assistant').length, 0);
  setup.completed('final-reply', 'done');
  await tick();
  assert.equal(setup.runtime.executionUnavailable, false);
  assert.equal(setup.runtime.assistantRetainedItems, 1);
  assert.equal(setup.store.getMessages(setup.sessionKey).filter(message => message.role === 'assistant').length, 1);
});

test('live retention is bounded across sessions and release resets accounting only through buffer cleanup', context => {
  const setup = fixture(context);
  const text = 'x'.repeat(1024 * 1024);
  for (let session = 0; session < 4; session++) {
    const threadId = session === 0 ? setup.threadId : setup.addSession(`thread-${session}`).threadId;
    for (let item = 0; item < 8; item++) setup.delta(`reply-${item}`, text, threadId);
  }
  assert.equal(setup.runtime.assistantRetainedBytes, 32 * 1024 * 1024);
  setup.delta('overflow', 'x', setup.addSession('overflow-thread').threadId);
  assert.equal(setup.runtime.executionUnavailable, true);
  assert.equal(setup.runtime.assistantRetainedBytes, 32 * 1024 * 1024);
  setup.runtime.clearTransientBuffers(setup.sessionKey);
  assert.equal(setup.runtime.assistantRetainedBytes, 24 * 1024 * 1024);
  assert.equal(setup.runtime.assistantRetainedItems, 24);
  setup.runtime.clearTransientBuffers();
  assert.equal(setup.runtime.assistantRetainedBytes, 0);
  assert.equal(setup.runtime.assistantRetainedItems, 0);
  assert.equal(setup.runtime.assistantRetention.size, 0);
  assert.equal(setup.runtime.executionUnavailable, true);
});

test('aggregate item cardinality is bounded across sessions independently of bytes', context => {
  const setup = fixture(context);
  for (let session = 0; session < 8; session++) {
    const threadId = session === 0 ? setup.threadId : setup.addSession(`thread-${session}`).threadId;
    for (let item = 0; item < 128; item++) setup.delta(`reply-${item}`, 'x', threadId);
  }
  assert.equal(setup.runtime.assistantRetainedItems, 1024);
  assert.equal(setup.runtime.assistantRetainedBytes, 1024);
  setup.delta('overflow', 'x', setup.addSession('overflow-thread').threadId);
  assert.equal(setup.runtime.executionUnavailable, true);
  assert.equal(setup.runtime.assistantRetainedItems, 1024);
});

test('stale execution deltas and duplicate completed items do not create retained work', async context => {
  let projections = 0;
  const setup = fixture(context, { projectAssistant: async text => { projections++; return { text, media: [] }; } });
  setup.delta('stale', 'x', setup.threadId, 'predecessor');
  assert.equal(setup.runtime.assistantRetainedItems, 0);
  setup.delta('reply', 'hello');
  setup.completed('reply', 'hello');
  setup.completed('reply', 'hello');
  await tick();
  setup.delta('reply', 'late');
  assert.equal(projections, 1);
  assert.equal(setup.runtime.assistantRetainedItems, 1);
  assert.equal(setup.runtime.assistantRetainedBytes, 5);
  assert.equal(setup.store.getMessages(setup.sessionKey)[0]?.text, 'hello');
  assert.equal(setup.runtime.executionUnavailable, false);
});

test('oversized completed and enriched text is never stored as a full completion', async context => {
  const direct = fixture(context);
  direct.completed('oversized', 'x'.repeat(1024 * 1024 + 1));
  assert.equal(direct.runtime.executionUnavailable, true);
  assert.equal(direct.store.getMessages(direct.sessionKey).filter(message => message.role === 'assistant').length, 0);
  const enriched = fixture(context, { projectAssistant: async () => ({ text: 'x'.repeat(1024 * 1024 + 1), media: [] }) });
  enriched.completed('oversized', 'small');
  await tick();
  assert.equal(enriched.runtime.executionUnavailable, true);
  assert.equal(enriched.store.getMessages(enriched.sessionKey).filter(message => message.role === 'assistant').length, 0);
});

test('budget overflow does not detach the original pending assistant projector or its close drain', async context => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const setup = fixture(context, { projectAssistant: async text => { await pending; return { text, media: [] }; } });
  setup.completed('pending', 'small');
  setup.delta('overflow', 'x'.repeat(1024 * 1024 + 1));
  assert.equal(setup.runtime.assistantProjections.get(setup.sessionKey)?.size, 1);
  let closed = false;
  const closing = setup.codex.close().then(() => { closed = true; });
  await tick();
  assert.equal(closed, false);
  release();
  await closing;
  assert.equal(closed, true);
  assert.equal(setup.store.getMessages(setup.sessionKey).filter(message => message.role === 'assistant').length, 0);
  assert.equal(setup.owner.codexExecutions.get(setup.sessionKey)?.phase, 'running');
});

test('model discovery rejects ambient credentials and captures only the explicit instance environment', async context => {
  const variable = 'AOD_SYNTHETIC_CATALOG_TOKEN';
  const previous = process.env[variable];
  process.env[variable] = 'synthetic-ambient';
  context.after(() => { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; });
  const config = { config: { model_provider: 'synthetic', model_providers: { synthetic: {
    base_url: 'https://catalog.invalid/v1', env_key: variable, env_http_headers: { 'x-instance': 'INSTANCE_HEADER' },
  } } } };
  const configure = (setup: ReturnType<typeof fixture>) => {
    setup.runtime.ensureStarted = async () => {};
    setup.runtime.request = async (method: string) => { assert.equal(method, 'config/read'); return config; };
    const headers: unknown[] = [];
    setup.runtime.providerModelCatalog.read = async (provider: any) => { headers.push(provider.headers); return [{ id: 'synthetic', label: 'Synthetic' }]; };
    return headers;
  };
  const ambient = fixture(context);
  const ambientHeaders = configure(ambient);
  await assert.rejects(ambient.codex.listModels(), /^Error: Provider model discovery unavailable$/);
  assert.deepEqual(ambientHeaders, []);
  const environment = { [variable]: 'synthetic-instance', INSTANCE_HEADER: 'synthetic-header' };
  const explicit = fixture(context, { modelProviderEnvironment: environment });
  const headers = configure(explicit);
  environment[variable] = 'synthetic-mutated';
  await explicit.codex.listModels();
  assert.deepEqual(headers, [{ accept: 'application/json', authorization: 'Bearer synthetic-instance', 'x-instance': 'synthetic-header' }]);
  const second = fixture(context, { modelProviderEnvironment: { [variable]: 'synthetic-second', INSTANCE_HEADER: 'second-header' } });
  const secondHeaders = configure(second);
  await second.codex.listModels();
  assert.deepEqual(secondHeaders, [{ accept: 'application/json', authorization: 'Bearer synthetic-second', 'x-instance': 'second-header' }]);
  assert.equal(process.env[variable], 'synthetic-ambient');
});
