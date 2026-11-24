import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { CodexAppServer } from '../codex/app-server.js';
import { codexAdmissionProof } from '../codex/dispatch-admission.js';
import { normalizeTurnContext } from '../codex/turn-context.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { DeckStore } from '../projection/deck-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncCodexDispatch } from './async-codex-dispatch.js';
import { AsyncCodexQueue, type CodexQueuePreparation } from './async-codex-queue.js';
import { connectorProjectionReadKinds } from './connector-owner-domain.js';
import { createConnectorCodexContextCommands, validConnectorCodexContextInput } from './connector-codex-context-domain.js';
import { executeConnectorCodexDispatch } from './connector-codex-dispatch-domain.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { workspaceFileContext } from './workspace-file-context.js';
import { LOCAL_FILE_BOARD_OWNER } from './workspace-board-file-policy.js';

const silence = new PerformanceDiagnostics(() => {});
async function fixture(t: import('node:test').TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-original-context-'));
  const config = { file: join(directory, 'connector.sqlite'), tokenFile: join(directory, 'tokens.json'), bootstrapToken: 'isolated-context' };
  const tokens = new ConnectorTokenStore(config.tokenFile, config.bootstrapToken);
  const actor = tokens.create({ label: 'original files', scopes: ['messages:send', 'boards:files'] }).record.id;
  const key = `codex:${randomUUID()}`, commandId = 'original-command', connectionId = 'original-connection';
  const policy = { root: join(directory, 'files'), policies: [{ owner: actor, runtime: 'codex' as const }] };
  mkdirSync(policy.root, { mode: 0o700 });
  const store = new ConnectorUserStore(config.file, undefined, { runtimeOwner: true });
  const boards = store.createFileBoards(policy.root, () => true), cards = store.createFileCards(policy.root, () => true);
  const boardId = randomUUID(), cardId = randomUUID();
  await boards.install(actor, { id: boardId, sessionKey: key, content: { title: 'Original tasks', tasks: [] } });
  await cards.install(actor, { id: cardId, sessionKey: key,
    content: { kind: 'notebook', content: { title: 'Original note', text: 'hot', archive: 'cold retained' } } });
  await boards.install(actor, { id: randomUUID(), sessionKey: 'codex:other', content: { title: 'Other session', tasks: [] } });
  await boards.install('other-owner', { id: randomUUID(), sessionKey: key, content: { title: 'Other owner', tasks: [] } });
  const expected = workspaceFileContext(boards, cards, () => true, key, actor);
  const paths = [...boards.filesForSession(actor, key), ...cards.filesForSession(actor, key)];
  const bytes = paths.map(path => readFileSync(path, 'utf8'));
  await store.turns.enqueueAsync('codex', { id: commandId, sessionKey: key, createdAt: 1,
    payload: { text: 'original request', images: [], actorId: actor } });
  const ref = { sessionKey: key, commandId, connectionId,
    proof: codexAdmissionProof(store.turns, store.turns.list<any>('codex', key)) };
  let closed = false;
  async function closeStore() { if (!closed) { await boards.close(); await cards.close(); store.close(); closed = true; } }
  t.after(async () => { await closeStore(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, config: { ...config, boardFiles: policy }, tokens, actor, key, store, policy, expected, ref, paths, bytes, closeStore };
}

test('original file context preserves local mapping, delegated exclusion, scope and size limits', () => {
  const calls: string[] = [];
  const boards = { contextForSession(owner: string, key: string) { calls.push(`${owner}/${key}`); return 'board'; } };
  const cards = { contextForSession() { return 'card'; } };
  assert.equal(workspaceFileContext(boards, cards, () => true, 'codex:one'), '');
  assert.equal(workspaceFileContext(boards, cards, () => true, 'codex:one', 'actor', {}), '');
  assert.equal(workspaceFileContext(boards, cards, () => false, 'codex:one', 'actor'), '');
  assert.deepEqual(calls, []);
  assert.equal(workspaceFileContext(boards, cards, () => true, 'codex:one', 'local:daily'), 'board\n\ncard');
  assert.deepEqual(calls, [`${LOCAL_FILE_BOARD_OWNER}/codex:one`]);
  assert.throws(() => workspaceFileContext({ contextForSession: () => 'a'.repeat(64001) }, undefined,
    () => true, 'codex:one', 'actor'), /limit/);
});

test('context command rejects caller authority and is not a projection read', () => {
  const ref = { sessionKey: 'codex:one', commandId: 'original', connectionId: 'connection', proof: { count: 1, digest: 'a'.repeat(64) } };
  for (const field of ['actorId', 'authorized', 'grant', 'sql', 'context', 'callback'])
    assert.equal(validConnectorCodexContextInput({ ...ref, [field]: true }), false);
  assert.equal((connectorProjectionReadKinds as readonly string[]).includes('codexQueueContext'), false);
});

for (const mode of ['original', 'no-policy', 'foreign-owner-policy', 'revoked', 'maintenance', 'wrong-command', 'wrong-proof'] as const)
  test(`original FIFO context ${mode} uses installed original bindings only`, async t => {
    const f = await fixture(t);
    const policy = mode === 'no-policy' ? undefined : mode === 'foreign-owner-policy'
      ? { ...f.policy, policies: [{ owner: 'other-owner', runtime: 'codex' as const }] } : f.policy;
    const domain = createConnectorCodexContextCommands(f.store, f.tokens, policy), ref = structuredClone(f.ref);
    if (mode === 'revoked') f.tokens.revoke(f.actor);
    if (mode === 'maintenance') f.store.pauseTurnStarts();
    if (mode === 'wrong-command') ref.commandId = 'replacement';
    if (mode === 'wrong-proof') ref.proof.digest = 'b'.repeat(64);
    const result = domain(ref);
    if (['revoked', 'maintenance', 'wrong-command', 'wrong-proof'].includes(mode)) assert.equal(result, null);
    else {
      assert.ok(result);
      assert.equal(result.context, mode === 'original' ? f.expected : '');
      assert.deepEqual({ ...result, context: undefined }, { ...ref, context: undefined });
      if (mode === 'original') {
        for (const path of f.paths) assert.ok(result.context.includes(JSON.stringify(path)));
        assert.equal(result.context.includes('cold retained'), false, 'context holds instructions/paths, never file bodies');
      }
    }
    assert.deepEqual(f.paths.map(path => readFileSync(path, 'utf8')), f.bytes);
    assert.equal(f.store.turns.list('codex', f.key)[0]?.state, 'queued');
  });

test('prepared context binds exact original connection and updated dispatching proof', async t => {
  const f = await fixture(t), domain = createConnectorCodexContextCommands(f.store, f.tokens, f.policy);
  const claimed = executeConnectorCodexDispatch('codexDispatchClaim', { ...f.ref, preparing: true, blockedGoalInput: false }, f.store, f.tokens);
  assert.ok(claimed);
  const ref = { ...f.ref, proof: claimed.proof };
  assert.equal(domain(ref), null, 'active native preparation does not expose context');
  assert.equal(executeConnectorCodexDispatch('codexPreparationFinish', { ...ref, revision: claimed.execution.revision }, f.store, f.tokens), true);
  assert.equal(domain(ref)?.context, f.expected);
  assert.equal(domain({ ...ref, connectionId: 'replacement' }), null);
  assert.equal(domain(f.ref), null, 'preclaim proof cannot read a changed original');
});

test('worker reopen reads original context without changing file contents or admitting execution', async t => {
  const f = await fixture(t); await f.closeStore();
  for (let i = 0; i < 2; i++) {
    const owner = new AsyncConnectorOwner(f.config, silence);
    try {
      await owner.open();
      assert.equal((await owner.command('codexQueueContext', f.ref))?.context, f.expected);
      assert.equal(await owner.command('codexExecutionRead', { sessionKey: f.key }), null);
      assert.deepEqual(f.paths.map(path => readFileSync(path, 'utf8')), f.bytes);
    } finally { await owner.close(); }
  }
});

for (const mode of ['original', 'foreign-reply', 'mutated-request', 'lost-reply', 'close', 'revoked', 'mutable-preparation'] as const)
  test(`original queue → worker context → original native transport: ${mode}`, async t => {
    const f = await fixture(t); await f.closeStore();
    const owner = new AsyncConnectorOwner(f.config, silence); await owner.open();
    const db = new ConnectorUserStore(':memory:'), deck = new DeckStore();
    const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: f.directory, defaultModel: 'test',
      approvalPolicy: 'never', store: deck, turnQueue: db.turns, executions: db.codexExecutions,
      authorizeTurn: () => { throw Error('main-thread authority forbidden'); }, requestTimeoutMs: 30 });
    const runtime = codex as any, writes: any[] = [], finishes: string[] = [];
    runtime.connectionId = f.ref.connectionId;
    runtime.loadedThreadIds.add(f.key.slice('codex:'.length));
    runtime.child = { stdin: { writable: true, write(line: string) {
      const row = JSON.parse(line); writes.push(row);
      runtime.receive(JSON.stringify({ id: row.id, result: { turn: { id: 'original-run' } } })); return true;
    } } };
    const get = db.codexExecutions.get, list = db.turns.list;
    db.codexExecutions.get = () => { throw Error('main-thread SQL forbidden'); };
    db.turns.list = () => { throw Error('main-thread SQL forbidden'); };
    let preparation: CodexQueuePreparation, closing: Promise<void> | undefined;
    const port = { command: (async (kind: any, input: any) => {
      const result = await owner.command(kind, input);
      if (kind === 'codexQueueContext') {
        if (mode === 'foreign-reply') return { ...result, commandId: 'foreign' };
        if (mode === 'mutated-request') { input.commandId = 'foreign'; return { ...result, commandId: 'foreign' }; }
        if (mode === 'lost-reply') throw Error('lost context read reply');
        if (mode === 'close') closing = queue.close();
        if (mode === 'revoked') f.tokens.revoke(f.actor);
        if (mode === 'mutable-preparation') {
          preparation.connectionId = 'foreign'; preparation.interactive = true; preparation.blockedGoalInput = true;
          preparation.input[0] = { type: 'text', text: 'replaced after await' };
          preparation.dispatching = () => { assert.fail('replaced preparation cannot acquire resources'); };
          preparation.finish = async () => { assert.fail('replaced preparation cannot settle resources'); };
        }
      }
      return result;
    }) as AsyncConnectorOwner['command'] };
    const dispatch = new AsyncCodexDispatch({ owner: port, runtime: codex, local() {}, diagnostics: silence });
    const queue = new AsyncCodexQueue({ owner: port, dispatch, local() {}, diagnostics: silence,
      async prepare() {
        preparation = { input: [{ type: 'text', text: 'original request' }], connectionId: f.ref.connectionId,
          interactive: false, blockedGoalInput: false, async finish(outcome) { finishes.push(outcome); } };
        return preparation;
      } });
    try {
      const accepted = mode === 'original' || mode === 'mutable-preparation';
      const outcome = await queue.run(f.key);
      assert.equal(outcome, accepted ? 'admitted' : 'not_started');
      await closing;
      assert.equal(writes.length, accepted ? 1 : 0);
      assert.deepEqual(finishes, [outcome]);
      const fact = await owner.command('codexExecutionRead', { sessionKey: f.key });
      if (accepted) {
        assert.equal(writes[0].method, 'turn/start');
        assert.deepEqual(writes[0].params.input, [{ type: 'text', text: `original request\n\n${f.expected}` }]);
        assert.equal(fact?.runId, 'original-run');
        const token = randomUUID();
        await owner.command('codexHistoryOpen', { sessionKey: f.key, token });
        const evidence = await owner.command('codexHistoryEvidence', { token,
          identities: [{ id: f.ref.commandId, turnId: 'original-run' }] });
        assert.ok(evidence[0]?.proof);
        const message = { id: 'user', sessionKey: f.key, role: 'user' as const, text: writes[0].params.input[0].text, createdAt: 1 };
        assert.equal(normalizeTurnContext(message, evidence[0].proof).text, 'original request');
        await owner.command('codexHistoryFinish', { token, abandon: false });
        assert.equal(await owner.command('turnMaintenanceCount', { runtime: 'codex' }), 0);
      } else assert.equal(await owner.command('turnMaintenanceCount', { runtime: 'codex' }), 1);
    } finally {
      await queue.close(); await dispatch.close(); runtime.child = undefined;
      db.codexExecutions.get = get; db.turns.list = list;
      await codex.close(); db.close(); await owner.close();
    }
  });
