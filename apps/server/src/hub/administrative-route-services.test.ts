import assert from 'node:assert/strict';
import test from 'node:test';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { HubMemberRequestError } from './async-member-request.js';
import { encodeHubSessionId } from './session-id.js';
import { AuthPersistenceError } from '../auth/private-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const request = () => new Request('http://fixture.invalid/');
const target = { ownerUserId: 'default', connectionId: 'node', userId: 'recipient' };
const unavailable = (error: unknown) => error instanceof HubMemberRequestError && error.status === 503;
const identityUnavailable = (error: unknown) => error instanceof AuthPersistenceError;
const authUnavailable = (error: unknown) => identityUnavailable(error) || unavailable(error);
const laneUnavailable = (lane: string) => ['authIdentity', 'authSessions', 'audit', 'loginLimiter'].includes(lane)
  ? authUnavailable : unavailable;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('remote service lanes outlive group drain but retained proofs cannot dispatch after their own retirement', async () => {
  let calls = 0;
  const owner = { command: async () => {
    calls++; return { principal: { userId: 'default', admin: true }, recoveryScope: 'a'.repeat(64) };
  } } as Pick<AsyncHubMemberOwner, 'command'>;
  const group = createHubAdministrativeServices(owner), remote = group.createWorkspaceRemoteAccess();
  const scope = await remote.requests.begin(request());
  await group.close(); await scope.check(); assert.equal(calls, 2);
  assert.throws(() => group.createWorkspaceRemoteAccess());
  const close = remote.close(); assert.equal(remote.close(), close); await close;
  await assert.rejects(scope.check(), unavailable);
  await assert.rejects(remote.audit.append({ event: 'api_authz', outcome: 'failure' }), identityUnavailable);
  assert.equal(calls, 2);
});

function starts(services: ReturnType<typeof createHubAdministrativeServices>) {
  return {
    members: () => services.members.begin(request()), roles: () => services.roles.read(request(), 'recipient'),
    memberships: () => services.memberships.read(request(), target), directory: () => services.directory.read(request()),
    grants: () => services.grants.begin(request(), 'node'),
    received: () => services.received.received(request(), '', 50),
    collaborators: () => services.collaborators.collaborators(request(), 'owner', 'session'),
    sharing: () => services.sharing.begin(request(), 'owner', 'session'),
    ownedSharing: () => services.ownedSharing.begin(request(), 'session'),
    guidance: () => services.guidance.begin(request(), encodeHubSessionId('node', 'codex:session')),
    quickChatRecovery: () => services.quickChatRecovery.begin(request()),
    workspace: () => services.workspace.save(request(), 'default', { revision: 0, groups: [], sessions: {} }),
    layouts: () => services.layouts.save(request(), 'default', 'current', { revision: 0,
      content: JSON.stringify({ id: 'current', name: 'Current', workspace: { version: 2, panes: [], floating: [] }, collapsedKeys: [] }) }),
    completions: () => services.completions.command(request(), 'default', { action: 'observe', sessionKey: encodeHubSessionId('node', 'codex:session') }),
    sessionPreferences: () => services.sessionPreferences.set(request(), 'default', { sessionKey: encodeHubSessionId('node', 'codex:session'), field: 'pinned', value: true }),
    authIdentity: () => services.authIdentity.memberIdentity(request()),
    authSessions: () => services.authSessions.memberLogin('hub_key_' + 'x'.repeat(43), request()),
    audit: () => services.audit.list(100, request()),
    loginLimiter: () => services.loginLimiter.check('a'.repeat(24)),
    activity: () => services.activity.recordActivity(request()),
    boardMachine: () => services.boardMachine.authorized('aod_board_' + 'b'.repeat(43), request()),
    notebookControl: () => services.notebookControl.capabilities(request(), 'default', JSON.stringify(['hub-notebook', 1])),
    fileBindingReads: () => services.fileBindingReads.read(request(), 'default', { domain: 'board', action: 'current', resourceId: 'default' }),
    privateNotebooks: () => services.privateNotebooks.savePrivate(request(), 'default', {
      resourceId: JSON.stringify(['hub-notebook', 1]), revision: 0, text: 'Private text',
    }, 'hot', false),
  };
}

for (const lane of ['members', 'roles', 'memberships', 'directory', 'grants', 'received', 'collaborators', 'sharing', 'ownedSharing', 'guidance', 'quickChatRecovery', 'workspace', 'layouts', 'completions', 'sessionPreferences', 'authIdentity', 'authSessions', 'audit', 'activity', 'boardMachine', 'privateNotebooks', 'notebookControl', 'fileBindingReads'] as const) {
  test(`administrative aggregate freezes every lane and drains the original ${lane} authority`, async () => {
    let resolve!: (value: unknown) => void;
    const original = new Promise<unknown>(yes => { resolve = yes; });
    let calls = 0, closed = false;
    const owner = { command: async () => { calls++; return original; } } as Pick<AsyncHubMemberOwner, 'command'>;
    const services = createHubAdministrativeServices(owner);
    const start = starts(services);
    const pending = assert.rejects(start[lane](), laneUnavailable(lane));
    assert.equal(calls, 1);
    const closing = services.close(); assert.equal(services.close(), closing);
    void closing.then(() => { closed = true; });
    for (const [name, begin] of Object.entries(start))
      await assert.rejects(begin(), laneUnavailable(name));
    await tick(); assert.equal(closed, false); assert.equal(calls, 1);
    resolve({ principal: { userId: 'default', admin: true }, recoveryScope: 'a'.repeat(64) });
    await pending; await closing; assert.equal(closed, true); assert.equal(calls, 1);
  });
}

test('retained member and grant closures cannot dispatch after aggregate close', async () => {
  let calls = 0;
  const owner = { command: async (kind: string) => {
    calls++;
    if (kind === 'memberSnapshot') return { principal: { userId: 'default', admin: true }, recoveryScope: 'a'.repeat(64) };
    if (kind === 'grantRead') return { action: 'authorize', target: { ownerUserId: 'default', connectionId: 'node' },
      authority: { nodeVersion: 1, verified: true, executionConfigured: false, creationConfigured: false } };
    throw Error('unexpected domain');
  } } as Pick<AsyncHubMemberOwner, 'command'>;
  const services = createHubAdministrativeServices(owner);
  const member = await services.members.begin(request());
  const grant = await services.grants.begin(request(), 'node');
  await services.close(); const before = calls;
  await assert.rejects(member.check(), unavailable);
  await assert.rejects(member.createUser('no effect'), unavailable);
  await assert.rejects(member.revoke('default', 'invalid'), unavailable);
  await assert.rejects(grant.check(), unavailable);
  await assert.rejects(grant.revoke('grant', 1), unavailable);
  assert.equal(calls, before);
});

test('aggregate diagnostic reentry cannot dispatch any later lane or retained mutation', async () => {
  let calls = 0;
  const owner = { command: async (kind: string) => {
    calls++;
    if (kind === 'memberSnapshot') return { principal: { userId: 'default', admin: true }, recoveryScope: 'a'.repeat(64) };
    if (kind === 'grantRead') return { action: 'authorize', target: { ownerUserId: 'default', connectionId: 'node' },
      authority: { nodeVersion: 1, verified: true, executionConfigured: false, creationConfigured: false } };
    throw Error('unexpected domain');
  } } as Pick<AsyncHubMemberOwner, 'command'>;
  const diagnostics = new PerformanceDiagnostics(() => {});
  const services = createHubAdministrativeServices(owner, diagnostics);
  const member = await services.members.begin(request()), grant = await services.grants.begin(request(), 'node');
  const before = calls, reentered: Promise<void>[] = [];
  let reentry = false, nested: Promise<void> | undefined;
  const original = diagnostics.start.bind(diagnostics);
  diagnostics.start = (...args) => {
    if (!reentry && args[0] === 'hub-route-drain') {
      reentry = true;
      // This occurs before even the first facade's close() has run.
      for (const [name, begin] of Object.entries(starts(services)))
        reentered.push(assert.rejects(begin(), laneUnavailable(name)));
      reentered.push(assert.rejects(services.authIdentity.keyIdentity('wrong'), identityUnavailable),
        assert.rejects(services.authIdentity.requestPrincipal(request()), identityUnavailable),
        assert.rejects(services.authIdentity.recoveryScope(request(), { userId: 'default', admin: true }), identityUnavailable),
        assert.rejects(services.authSessions.revokeMemberSession('hub_session_' + 'y'.repeat(43), request()), identityUnavailable),
        assert.rejects(services.audit.append({ event: 'access_key_login', outcome: 'failure' }), identityUnavailable),
        assert.rejects(services.loginLimiter.recordFailure('a'.repeat(24)), identityUnavailable),
        assert.rejects(services.loginLimiter.recordSuccess('a'.repeat(24)), identityUnavailable),
        assert.rejects(member.createUser('no effect'), unavailable),
        assert.rejects(grant.revoke('grant', 1), unavailable));
      nested = services.close();
    }
    return original(...args);
  };
  const closing = services.close();
  assert.equal(nested, closing); assert.equal(services.close(), closing);
  await Promise.all(reentered); await closing;
  assert.equal(reentry, true); assert.equal(calls, before);
});

for (const method of ['check', 'recordFailure', 'recordSuccess'] as const) {
  test(`aggregate retains the original limiter ${method} commit, not a timed-out replacement`, async () => {
    let resolve!: (value: unknown) => void, calls = 0, drained = false;
    const pending = new Promise<unknown>(yes => { resolve = yes; });
    const owner = { command: async () => { calls++; return pending; } } as Pick<AsyncHubMemberOwner, 'command'>;
    const services = createHubAdministrativeServices(owner);
    const original = services.loginLimiter[method]('a'.repeat(24));
    const closing = services.close(); void closing.then(() => { drained = true; });
    await assert.rejects(services.loginLimiter.check('a'.repeat(24)), identityUnavailable);
    await tick(); assert.equal(drained, false); assert.equal(calls, 1);
    const decision = { allowed: false, failureCount: 2, retryAfterSeconds: 60 };
    resolve(method === 'recordSuccess' ? null : decision);
    assert.deepEqual(await original, method === 'recordSuccess' ? undefined : decision);
    await closing; assert.equal(drained, true); assert.equal(calls, 1);
  });
}
