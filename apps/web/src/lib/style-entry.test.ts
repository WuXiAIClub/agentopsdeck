import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { SessionSummary } from '@agentopsdeck/shared';
import { sessionRunOutcome } from './live-session.js';

test('mobile creation forwards completion and closes its dialog only after settlement', async () => {
  const source = ts.createSourceFile('main.tsx', readFileSync('src/main.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function createHandler(component: string, child: string, dependencies: Record<string, unknown>) {
    const declaration = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === component);
    assert.ok(declaration && ts.isFunctionDeclaration(declaration));
    if (component === 'SessionsPage') assert.match(declaration.parameters[0]!.getText(source), /onCreate: \(target: NewSessionTarget, title: string\) => Promise<void>/);
    let handler: ts.ArrowFunction | undefined;
    function visit(node: ts.Node) {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === child) {
        for (const attribute of node.attributes.properties) {
          if (ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'onCreate' && attribute.initializer && ts.isJsxExpression(attribute.initializer)
            && attribute.initializer.expression && ts.isArrowFunction(attribute.initializer.expression)) handler = attribute.initializer.expression;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(declaration);
    assert.ok(handler, `exercise actual ${component} ${child} creation callback`);
    const compiled = ts.transpileModule(`const handler = ${handler.getText(source)};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    return new Function(...Object.keys(dependencies), `${compiled}\nreturn handler;`)(...Object.values(dependencies)) as (target: { groupId: string }, title: string) => Promise<void>;
  }
  for (const outcome of ['resolved', 'rejected'] as const) {
    const failure = new Error('creation failed');
    let finish!: () => void;
    const completion = new Promise<void>((resolve, reject) => { finish = outcome === 'resolved' ? resolve : () => reject(failure); });
    const target = { groupId: 'local:codex' };
    const groups: string[] = [];
    const closed: boolean[] = [];
    const calls: unknown[][] = [];
    const mobileCreate = createHandler('MobileApp', 'SessionsPage', {
      setNewSessionGroupId: (group: string) => groups.push(group),
      createSession: (...args: unknown[]) => { calls.push(args); return completion; },
    });
    const dialogCreate = createHandler('SessionsPage', 'NewSessionDialog', {
      onCreate: (selected: typeof target, title: string) => {
        const forwarded = mobileCreate(selected, title);
        assert.equal(forwarded, completion, 'mobile forwards the original creation completion');
        return forwarded;
      },
      setCreateDialogOpen: (open: boolean) => closed.push(open),
    });
    const pending = dialogCreate(target, 'Held creation');
    await Promise.resolve();
    assert.deepEqual(groups, [target.groupId]);
    assert.deepEqual(calls, [[target, 'Held creation']]);
    assert.deepEqual(closed, [], 'pending creation keeps the dialog mounted');
    const settled = outcome === 'rejected' ? assert.rejects(pending, failure) : pending;
    finish();
    await settled;
    assert.deepEqual(closed, outcome === 'resolved' ? [false] : [], 'rejected completion does not close the dialog');
  }
});

function seenFixture() {
  const source = readFileSync('src/main.tsx', 'utf8');
  const start = source.indexOf('const sessionSeenFallback =');
  const end = source.indexOf('function useTicker(', start);
  assert.ok(start >= 0 && end > start, 'exercise the actual entry-point seen helpers');
  const prefixes = source.match(/^const SESSION_(?:COMPLETION|MESSAGE)_SEEN_PREFIX = .*;$/gm);
  assert.equal(prefixes?.length, 2);
  const compiled = ts.transpileModule(`${prefixes!.join('\n')}\n${source.slice(start, end)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let scope: string | undefined = 'a'.repeat(64);
  let denied: 'property' | 'get' | 'set' | undefined;
  const data = new Map<string, string>();
  const store = {
    getItem(key: string) { if (denied === 'get') throw new DOMException('denied', 'SecurityError'); return data.get(key) ?? null; },
    setItem(key: string, value: string) { if (denied === 'set') throw new DOMException('full', 'QuotaExceededError'); data.set(key, value); },
  };
  const window = { get localStorage() { if (denied === 'property') throw new DOMException('denied', 'SecurityError'); return store; } };
  const helpers = new Function('window', 'recoveryScope', 'sessionRunOutcome', `${compiled}
    return { markSessionCompletionSeen, markSessionMessagesSeen, seedSessionMessagesSeen, sessionUnreadMessageCount,
      isSessionCompletionUnseen, sessionSeenKey, sessionSeenFallback };`)(window, () => scope, sessionRunOutcome) as {
    markSessionCompletionSeen(session: SessionSummary | undefined): void;
    markSessionMessagesSeen(session: SessionSummary | undefined): void;
    seedSessionMessagesSeen(session: SessionSummary): void;
    sessionUnreadMessageCount(session: SessionSummary, open?: boolean): number;
    isSessionCompletionUnseen(session: SessionSummary, open?: boolean): boolean;
    sessionSeenKey(prefix: string, sessionKey: string): string | undefined;
    sessionSeenFallback: Map<string, string>;
  };
  const session: SessionSummary = { sessionKey: 'local:existing', title: 'Existing session', source: 'codex', status: 'idle', messageCount: 4,
    runCompletedAt: 100, runtime: { phase: 'completed', threadActivity: 'idle', connection: 'connected', sync: 'current', lastEventAt: 100 } };
  return { helpers, session, data, deny(value: typeof denied) { denied = value; }, scope(value: string | undefined) { scope = value; } };
}

for (const denial of ['property', 'get', 'set'] as const) test(`seen display survives ${denial} denial without changing completion evidence`, () => {
  const fixture = seenFixture(), { helpers, session } = fixture;
  fixture.deny(denial);
  assert.equal(helpers.sessionUnreadMessageCount(session), 0);
  assert.equal(helpers.isSessionCompletionUnseen(session), true);
  assert.doesNotThrow(() => helpers.seedSessionMessagesSeen(session));
  assert.doesNotThrow(() => helpers.markSessionMessagesSeen(session));
  assert.doesNotThrow(() => helpers.markSessionCompletionSeen(session));
  assert.equal(helpers.sessionUnreadMessageCount(session), 0);
  assert.equal(helpers.isSessionCompletionUnseen(session), false);
  assert.equal(helpers.isSessionCompletionUnseen({ ...session, runCompletedAt: 101 }), true);
  assert.equal(helpers.sessionUnreadMessageCount({ ...session, messageCount: 6 }), 2);
  assert.equal(helpers.sessionUnreadMessageCount({ ...session, messageCount: 6 }, true), 0);
  assert.equal(helpers.isSessionCompletionUnseen({ ...session, runCompletedAt: 101 }, true), false);
  for (const phase of ['unknown', 'running', 'waiting', 'failed', 'interrupted'] as const) {
    const uncertain = { ...session, runtime: { ...session.runtime!, phase } };
    assert.equal(helpers.isSessionCompletionUnseen(uncertain), false);
    assert.equal(sessionRunOutcome(uncertain), phase === 'failed' ? 'failed' : phase === 'interrupted' ? 'interrupted' : undefined);
  }
});

test('seen markers are scoped, never migrate unscoped values, and do not persist without identity', () => {
  const fixture = seenFixture(), { helpers, session, data } = fixture;
  data.set(`agentopsdeck.sessionCompletionSeen:${session.sessionKey}`, '100');
  data.set(`agentopsdeck.sessionMessageSeen:${session.sessionKey}`, '4');
  assert.equal(helpers.isSessionCompletionUnseen(session), true);
  helpers.seedSessionMessagesSeen(session);
  helpers.markSessionCompletionSeen(session);
  assert.equal(helpers.sessionUnreadMessageCount({ ...session, messageCount: 7 }), 3);
  fixture.scope('b'.repeat(64));
  assert.equal(helpers.isSessionCompletionUnseen(session), true);
  assert.equal(helpers.sessionUnreadMessageCount({ ...session, messageCount: 7 }), 0);
  fixture.deny('set');
  helpers.markSessionCompletionSeen(session);
  fixture.scope('c'.repeat(64));
  assert.equal(helpers.isSessionCompletionUnseen(session), true);
  fixture.scope('b'.repeat(64));
  assert.equal(helpers.isSessionCompletionUnseen(session), false);
  fixture.scope(undefined);
  const before = [...data], fallback = [...helpers.sessionSeenFallback];
  helpers.seedSessionMessagesSeen(session); helpers.markSessionCompletionSeen(session);
  assert.deepEqual([...data], before); assert.deepEqual([...helpers.sessionSeenFallback], fallback);
  assert.equal(helpers.sessionSeenKey('marker:', 'existing'), undefined);
});

test('quota fallback wins over stale persistence, recovers on write, and stays bounded', () => {
  const fixture = seenFixture(), { helpers, session, data } = fixture;
  helpers.markSessionCompletionSeen(session);
  fixture.deny('set');
  helpers.markSessionCompletionSeen({ ...session, messageCount: 8, runCompletedAt: 200 });
  assert.equal(helpers.isSessionCompletionUnseen({ ...session, runCompletedAt: 200 }), false);
  assert.equal(helpers.sessionUnreadMessageCount({ ...session, messageCount: 10 }), 2);
  fixture.deny(undefined);
  helpers.markSessionCompletionSeen({ ...session, messageCount: 10, runCompletedAt: 300 });
  assert.equal(helpers.sessionSeenFallback.size, 0);
  const key = helpers.sessionSeenKey('agentopsdeck.sessionCompletionSeen:', session.sessionKey)!;
  assert.equal(data.get(key), '300');
  for (const value of ['NaN', 'Infinity', '-1', '{broken']) {
    data.set(key, value); assert.equal(helpers.isSessionCompletionUnseen(session), true);
  }
  fixture.deny('property');
  for (let index = 0; index < 2_100; index++) helpers.markSessionMessagesSeen({ ...session, sessionKey: `session:${index}` });
  assert.equal(helpers.sessionSeenFallback.size, 2_048);
  assert.equal(helpers.sessionUnreadMessageCount({ ...session, sessionKey: 'session:2099', messageCount: 6 }), 2);
});

test('WEB-STYLEENTRY-H01 optimistic message updater binds originating scope and epoch and blocks stale writes', () => {
  const sourceText = readFileSync('src/main.tsx', 'utf8');
  const parsed = ts.createSourceFile('main.tsx', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fn = parsed.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'useOptimisticSessionMessages');
  assert.ok(fn && ts.isFunctionDeclaration(fn));
  const compiled = ts.transpileModule(fn.getText(parsed), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let activeScope: string | undefined = 'scope-a';
  let activeEpoch = 1;
  const writes: Array<{ scope: string | undefined; sessionKey: string; items: unknown[] }> = [];
  let state: Array<{ id: string }> = [];
  const effects: Array<() => void> = [];
  const runHook = () => new Function(
    'useSyncExternalStore', 'subscribeRecoveryScope', 'recoveryScope', 'recoveryEpoch',
    'useState', 'useCallback', 'useEffect', 'readOptimisticMessages', 'writeOptimisticMessages', 'hasMatchingRealMessage',
    `${compiled}\nreturn useOptimisticSessionMessages('local:s1', []);`,
  )(
    (_sub: unknown, getSnap: () => string) => getSnap(),
    () => () => undefined,
    () => activeScope,
    () => activeEpoch,
    (init: () => Array<{ id: string }>) => {
      if (state.length === 0) state = typeof init === 'function' ? init() : init;
      const setState = (updater: unknown) => {
        state = typeof updater === 'function' ? (updater as (prev: typeof state) => typeof state)(state) : updater as typeof state;
      };
      return [state, setState] as const;
    },
    (cb: unknown) => cb,
    (eff: () => void) => { effects.push(eff); },
    () => [],
    (scope: string | undefined, sessionKey: string, items: unknown[]) => { writes.push({ scope, sessionKey, items }); },
    () => false,
  ) as readonly [Array<{ id: string }>, (u: (prev: Array<{ id: string }>) => Array<{ id: string }>) => void];

  const [, setOptimistic] = runHook();
  setOptimistic((prev) => [...prev, { id: 'm1' }]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.scope, 'scope-a');

  // Stale updater invoked after auth transition (different scope or bumped epoch on same scope) must no-op.
  activeScope = 'scope-b';
  setOptimistic((prev) => [...prev, { id: 'm2' }]);
  activeScope = 'scope-a';
  activeEpoch = 2;
  setOptimistic((prev) => [...prev, { id: 'm3' }]);
  assert.equal(writes.length, 1, 'stale render updater must not persist across scope or epoch boundary');
  assert.deepEqual(state, [{ id: 'm1' }]);
});

test('WEB-STYLEENTRY-H02 mobile viewport timers read latest autoScrollEnabled ref and cancel cleanly on unmount', () => {
  const sourceText = readFileSync('src/main.tsx', 'utf8');
  assert.match(sourceText, /const autoScrollEnabledRef = useRef\(autoScrollEnabled\);\s*autoScrollEnabledRef\.current = autoScrollEnabled;/);
  const start = sourceText.indexOf('const autoScrollEnabledRef = useRef(autoScrollEnabled);');
  const end = sourceText.indexOf('function discardVoiceInput()', start);
  assert.ok(start > 0 && end > start);
  const snippet = sourceText.slice(start, end);
  assert.doesNotMatch(snippet.slice(snippet.indexOf('const settleMobileViewport')), /\bautoScrollEnabled\b/);
  const compiled = ts.transpileModule(snippet, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

  let autoScrollEnabled = true;
  const scheduled = new Map<number, () => void>();
  let nextTimerId = 1;
  let settleCalls = 0;
  let settleCleanups = 0;
  let effectCleanup: (() => void) | undefined;
  const listeners = new Map<string, () => void>();

  const harness = new Function(
    'useRef', 'useLayoutEffect', 'useEffect', 'autoScrollEnabled', 'stickToBottomRef', 'scrollContainerRef',
    'hasTextSelectionInside', 'syncMobileViewport', 'resetMobileKeyboardOffset', 'settleScrollToBottom',
    'window', 'document', 'session',
    `${compiled}\nreturn { settleMobileViewport, syncAutoScroll(next) { autoScrollEnabledRef.current = next; } };`,
  )(
    (initial: unknown) => ({ current: initial }),
    () => undefined,
    (fn: () => () => void) => { effectCleanup = fn(); },
    autoScrollEnabled,
    { current: true },
    { current: null },
    () => false,
    () => true,
    () => undefined,
    () => { settleCalls += 1; return () => { settleCleanups += 1; }; },
    {
      setTimeout: (cb: () => void) => { const id = nextTimerId++; scheduled.set(id, cb); return id; },
      clearTimeout: (id: number) => { scheduled.delete(id); },
      scrollTo: () => undefined,
      addEventListener: (name: string, cb: () => void) => { listeners.set(name, cb); },
      removeEventListener: (name: string) => { listeners.delete(name); },
      visualViewport: { addEventListener: () => undefined, removeEventListener: () => undefined },
    },
    {
      hidden: false,
      documentElement: { scrollTop: 0 },
      body: { scrollTop: 0 },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
    { sessionKey: 'local:mobile-1' },
  ) as { settleMobileViewport: () => void; syncAutoScroll: (next: boolean) => void };

  // Initial effect scheduled the 40ms viewport timer; disabling auto-scroll before it fires prevents scrolling.
  assert.equal(scheduled.size, 1);
  autoScrollEnabled = false;
  harness.syncAutoScroll(false);
  for (const [id, cb] of [...scheduled]) { scheduled.delete(id); cb(); }
  assert.equal(settleCalls, 0, 'queued timer respects disabled autoScrollEnabledRef');

  // Re-enable auto-scroll, trigger settleMobileViewport, run first timer to register a settleScrollToBottom cleanup, then unmount.
  harness.syncAutoScroll(true);
  harness.settleMobileViewport();
  assert.equal(scheduled.size, 4);
  const [firstId, firstCb] = [...scheduled][0]!;
  scheduled.delete(firstId);
  firstCb();
  assert.equal(settleCalls, 1);
  assert.equal(scheduled.size, 3);
  effectCleanup!();
  assert.equal(scheduled.size, 0, 'unmount clears all pending mobile viewport timers');
  assert.equal(settleCleanups, 1, 'unmount runs tracked settleScrollToBottom cleanups');
});
