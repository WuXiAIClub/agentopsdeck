import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { HubStore } from './hub-store.js';
import { encodeHubSessionId } from './session-id.js';
import { connectionCompletionTarget } from './completion-unread-store.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { HubMemberRequestError } from './async-member-request.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncHubWorkspacePreferences } from './async-workspace-preferences.js';
import { AsyncHubWorkspaceLayouts } from './async-workspace-layouts.js';
import { AsyncHubCompletions } from './async-completions.js';
import { AsyncHubSessionPreferences } from './async-session-preferences.js';

const unavailable = (error: unknown) => error instanceof HubMemberRequestError && error.status === 503;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const document = () => ({ revision: 0, groups: [], sessions: {} });
const layout = () => ({ revision: 0, content: JSON.stringify({ id: 'current', name: 'Current',
  workspace: { version: 2, panes: [], floating: [] }, collapsedKeys: [] }) });
const domains = ['workspaceSave', 'layoutSave', 'completionObserve', 'completionRead', 'sessionPreferenceSet'] as const;

for (const Facade of [AsyncHubWorkspacePreferences, AsyncHubWorkspaceLayouts, AsyncHubCompletions, AsyncHubSessionPreferences]) {
  test(`${Facade.name}: close freezes admission before diagnostic reentry, including principal lookup`, async t => {
    let calls = 0, reentered = false;
    const owner = { command: async () => { calls++; throw Error('No command may start after close'); } } as Pick<AsyncHubMemberOwner, 'command'>;
    const diagnostics = new PerformanceDiagnostics(() => {});
    const service = new Facade(owner, diagnostics), denied: Promise<void>[] = [];
    const original = diagnostics.start.bind(diagnostics);
    t.mock.method(diagnostics, 'start', (operation: Parameters<PerformanceDiagnostics['start']>[0]) => {
      if (operation === 'hub-route-drain' && !reentered) {
        reentered = true;
        denied.push(assert.rejects(service.principal(new Request('http://fixture.invalid/')), unavailable));
        const request = new Request('http://fixture.invalid/');
        const mutation = service instanceof AsyncHubWorkspacePreferences ? service.save(request, 'member', document())
          : service instanceof AsyncHubWorkspaceLayouts ? service.save(request, 'member', 'current', layout())
          : service instanceof AsyncHubCompletions ? service.command(request, 'member', { action: 'observe', sessionKey: encodeHubSessionId('node', 'codex:session') })
          : service.set(request, 'member', { sessionKey: encodeHubSessionId('node', 'codex:session'), field: 'hidden', value: true });
        denied.push(assert.rejects(mutation, unavailable));
      }
      return original(operation);
    });
    const closing = service.close(); assert.equal(service.close(), closing);
    await closing; await Promise.all(denied);
    assert.equal(reentered, true); assert.equal(denied.length, 2); assert.equal(calls, 0);
  });
}

for (const domain of domains) {
  test(`${domain}: aggregate close retains the original committed ACK, refuses every new lane and never replays`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'administrative-workspace-drain-'));
    const store = new HubStore(join(root, 'hub.sqlite'), 'isolated-vault');
    const production = new OriginalHubAdministrativeCommands(store, new PerformanceDiagnostics(() => {}));
    const user = store.createUser('Owner'), token = store.identities.createSession(store.identities.issueKey(user.id).token)!;
    store.upsertConnection({ id: 'node', ownerUserId: user.id, kind: 'remote', label: 'Node', connectorUrl: 'http://unused.invalid' });
    const nodeId = 'node_' + randomUUID();
    store.pinConnectionNode('node', user.id, store.connectionAuthority('node', user.id)!, nodeId);
    const remote = 'codex:' + randomUUID(), sessionKey = encodeHubSessionId('node', remote);
    const target = connectionCompletionTarget(nodeId, 'node', store.connectionAuthority('node', user.id)!, remote);
    store.completions.baseline(user.id, target, 'epoch', 0);
    store.completions.record({ owner: user.id, target, epoch: 'epoch', turnId: 'turn', sourceCursor: 1, provenance: 'live-successful-message' });
    const observation = store.completions.observe(user.id, target);
    const request = () => new Request('http://fixture.invalid/', { headers: { cookie: `agentopsdeck_session=${token}` } });
    let release!: () => void, entered!: () => void, effects = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const dispatched = new Promise<void>(resolve => { entered = resolve; });
    const command: Pick<AsyncHubMemberOwner, 'command'> = {
      command: (async (kind, input) => {
        const value = await production.command(kind, input);
        if (kind === domain) { effects++; entered(); await gate; }
        return value;
      }) as AsyncHubMemberOwner['command'],
    };
    const services = createHubAdministrativeServices(command);
    const actions = {
      workspaceSave: () => services.workspace.save(request(), user.id, document()),
      layoutSave: () => services.layouts.save(request(), user.id, 'current', layout()),
      completionObserve: () => services.completions.command(request(), user.id, { action: 'observe', sessionKey }),
      completionRead: () => services.completions.command(request(), user.id, { action: 'read', sessionKey,
        requestId: randomUUID(), token: observation.token, throughSequence: observation.throughSequence }),
      sessionPreferenceSet: () => services.sessionPreferences.set(request(), user.id, { sessionKey, field: 'pinned', value: true }),
    };
    try {
      const pending = assert.rejects(actions[domain](), unavailable);
      await Promise.race([dispatched, pending.then(() => assert.fail('Original mutation did not reach its ACK boundary'))]);
      const closing = services.close(); assert.equal(services.close(), closing);
      let closed = false; void closing.then(() => { closed = true; });
      await tick(); assert.equal(closed, false);
      for (const start of Object.values(actions)) await assert.rejects(start(), unavailable);
      await assert.rejects(services.workspace.get(request(), user.id), unavailable);
      await assert.rejects(services.layouts.get(request(), user.id, 'current'), unavailable);
      await assert.rejects(services.completions.command(request(), user.id, { action: 'summary', sessions: [] }), unavailable);
      assert.equal(effects, 1);
      release(); await pending; await closing;
      assert.equal(effects, 1); assert.equal(closed, true);
      assert.equal(store.workspace.get(user.id).revision, domain === 'workspaceSave' ? 1 : 0);
      assert.equal(store.layouts.get(user.id, 'current').revision, domain === 'layoutSave' ? 1 : 0);
      assert.equal(store.sessionPreferences(user.id).get(sessionKey)?.pinned, domain === 'sessionPreferenceSet' ? true : undefined);
      assert.equal(store.completions.summary(user.id, [target])[0]!.readThrough, domain === 'completionRead' ? 1 : 0);
      assert.equal(store.createUser('Still open').label, 'Still open');
    } finally { release(); await services.close(); await production.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

for (const lane of ['workspace', 'layouts', 'completions', 'sessionPreferences'] as const) for (const snapshot of [1, 2]) {
  test(`${lane}: complete operation close holds ${snapshot === 1 ? 'initial' : 'final'} authority and suppresses late delivery`, async () => {
    let release!: () => void, entered!: () => void, checks = 0, effects = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const dispatched = new Promise<void>(resolve => { entered = resolve; });
    const directoryReads: string[] = [];
    const owner = { command: async (kind: string) => {
      if (kind === 'memberSnapshot') {
        if (++checks === snapshot) { entered(); await gate; }
        return { principal: { userId: 'member', admin: false }, recoveryScope: 'a'.repeat(64) };
      }
      if (kind === 'connectionDirectoryVersion') {
        directoryReads.push(kind);
        return { action: 'version', version: 1 };
      }
      if (kind === 'connectionDirectoryCheck') {
        directoryReads.push(kind);
        return { action: 'check', version: 1, ok: true };
      }
      effects++;
      return kind === 'workspaceSave' ? { document: { ...document(), revision: 1 } }
        : kind === 'layoutSave' ? { document: { ...layout(), revision: 1 } }
        : kind === 'completionRead' ? { throughSequence: 1 } : { ok: true };
    } } as Pick<AsyncHubMemberOwner, 'command'>;
    const services = createHubAdministrativeServices(owner), sessionKey = encodeHubSessionId('node', 'codex:session');
    const request = () => new Request('http://fixture.invalid/');
    const actions = {
      workspace: () => services.workspace.save(request(), 'member', document()),
      layouts: () => services.layouts.save(request(), 'member', 'current', layout()),
      completions: () => services.completions.command(request(), 'member', { action: 'read', sessionKey,
        requestId: randomUUID(), token: randomUUID(), throughSequence: 1 }),
      sessionPreferences: () => services.sessionPreferences.set(request(), 'member', { sessionKey, field: 'hidden', value: true }),
    };
    try {
      const pending = assert.rejects(actions[lane](), unavailable);
      await Promise.race([dispatched, pending.then(() => assert.fail('Original operation did not reach its authority boundary'))]);
      const closing = services.close(); let closed = false; void closing.then(() => { closed = true; });
      await tick(); assert.equal(closed, false);
      for (const start of Object.values(actions)) await assert.rejects(start(), unavailable);
      assert.equal(effects, snapshot - 1);
      release(); await pending; await closing;
      assert.equal(effects, snapshot - 1); assert.equal(closed, true);
      assert.deepEqual(directoryReads, lane === 'completions' && snapshot === 2 ? ['connectionDirectoryVersion'] : []);
    } finally { release(); await services.close(); }
  });
}
