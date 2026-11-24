import type { api as client } from '../api.js';

type AccessApi = Pick<typeof client, 'hubNodeGrants' | 'hubExecutionIssuer' | 'hubSetupLocalExecution' | 'hubCreateNodeGrant'>;
const actions = ['sessions:create'] as const;

export async function grantMemberCreation(api: AccessApi, connectionId: string, userId: string,
  expectedVersion: number, isCurrent: () => boolean) {
  const check = () => { if (!isCurrent()) throw new Error('Login changed. Reopen access management.'); };
  check();
  let page = await api.hubNodeGrants(connectionId);
  check();
  if (!page.verified || page.nodeVersion !== expectedVersion) throw new Error('Environment changed. Refresh authorizations before continuing.');
  if (!page.creationConfigured) {
    const setup = await api.hubExecutionIssuer(connectionId);
    check();
    if (!setup.localSetupAllowed) throw new Error('A Connector operator must enable member creation for this environment first.');
    await api.hubSetupLocalExecution(connectionId, page.nodeVersion, true);
    check();
    page = await api.hubNodeGrants(connectionId);
    check();
  }
  if (!page.verified || !page.creationConfigured || !page.executionConfigured) throw new Error('Environment setup is not ready. Refresh before continuing.');
  const version = page.nodeVersion, cursors = new Set<string>();
  for (;;) {
    const existing = page.grants.find(grant => grant.userId === userId && !grant.revoked && grant.nodeVersion === version
      && grant.policy.runtime === 'codex' && !grant.policy.sessionKey && !grant.policy.agentId
      && actions.every(action => grant.policy.actions.includes(action)));
    if (existing) return existing;
    if (!page.nextCursor) break;
    if (cursors.has(page.nextCursor)) throw new Error('Authorization pagination changed. Refresh before continuing.');
    cursors.add(page.nextCursor);
    page = await api.hubNodeGrants(connectionId, page.nextCursor);
    check();
    if (page.nodeVersion !== version || !page.verified || !page.creationConfigured || !page.executionConfigured) {
      throw new Error('Environment changed. Refresh authorizations before continuing.');
    }
  }
  check();
  const result = await api.hubCreateNodeGrant(connectionId, { userId, nodeVersion: version,
    policy: { runtime: 'codex', actions: [...actions] } });
  check();
  return result.grant;
}
