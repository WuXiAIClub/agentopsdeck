import assert from 'node:assert/strict';
import test from 'node:test';
import { parseIssueSources, IssueProviderAdapter, type IssueSource } from './issue-sources.js';
import { IssueCardReader, type IssueQuery } from '../hub/issue-card-reader.js';
const source = (provider: 'gitlab' | 'github' = 'gitlab'): IssueSource => ({ id: 'source', label: 'Fixture', provider, origin: provider === 'github' ? 'https://github.com' : 'https://git.fixture.invalid', project: provider === 'github' ? 'R_fixture' : '12', token: 'private-fixture-only', epoch: 'one' });
const query = (s: IssueSource): IssueQuery => ({ connection: s.id, project: s.project, kind: 'issue', filter: 'open', limit: 50, order: 'updated_desc' });
const row = { id: 3, iid: 1, labels: ['bug'], assignees: [{ username: 'owner' }], project_id: 12, title: 'Fixture', state: 'opened', web_url: 'https://git.fixture.invalid/project/-/issues/1', description: '<script>unsafe markup stays text</script>', updated_at: '2026-10-07T00:00:00Z' };
test('source configuration is bounded, explicit HTTPS and private environment reference only', () => {
  const value = { id: 'git', label: 'Project', provider: 'gitlab', origin: 'https://git.fixture.invalid', project: '12', tokenEnv: 'FIXTURE_ISSUE_TOKEN' }, env = { FIXTURE_ISSUE_TOKEN: 'private-fixture' };
  assert.equal(parseIssueSources(JSON.stringify([value]), env)[0]!.token, env.FIXTURE_ISSUE_TOKEN);
  for (const patch of [{ origin: 'http://localhost' }, { origin: 'https://u:p@git.fixture.invalid' }, { origin: 'https://git.fixture.invalid/path' }, { project: '../12' }, { token: 'never-accepted' }, { tokenEnv: 'MISSING' }]) {
    assert.throws(() => parseIssueSources(JSON.stringify([{ ...value, ...patch }]), env), error => !String(error).includes('never-accepted'));
  }
  assert.throws(() => parseIssueSources(JSON.stringify([value, value]), env)); assert.deepEqual(parseIssueSources(undefined, env), []);
});
test('GitLab fixes API origin/project, disables redirect and does not follow remote pagination URLs', async () => {
  let calls = 0; const s = source();
  const adapter = new IssueProviderAdapter([s], (async (url, init) => {
    calls++; const u = new URL(String(url)); assert.equal(u.origin, s.origin); assert.equal(u.pathname, '/api/v4/projects/12/issues');
    assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error'); assert.equal(u.searchParams.get('state'), 'opened');
    assert.equal(u.searchParams.get('issue_type'), 'issue'); assert.equal(new Headers(init?.headers).get('private-token'), s.token);
    return Response.json([row], { headers: { 'x-next-page': '2', link: '<https://evil.invalid/>; rel="next"' } });
  }) as typeof fetch);
  const first = await adapter.list(query(s), null, new AbortController().signal); assert.equal(first.nextCursor, '2'); assert.equal(first.items[0]!.remoteId, '3');
  await assert.rejects(adapter.list(query(s), 'https://evil.invalid', new AbortController().signal)); assert.equal(calls, 1);
  await assert.rejects(adapter.list({ ...query(s), kind: 'work_item' }, null, new AbortController().signal)); assert.equal(calls, 1);
});
test('GitHub uses immutable repository node identity and a fixed read-only GraphQL document', async () => {
  const s = source('github'); let mismatch = false;
  const adapter = new IssueProviderAdapter([s], (async (url, init) => {
    assert.equal(String(url), 'https://api.github.com/graphql'); assert.equal(init?.redirect, 'error');
    const body = JSON.parse(String(init?.body)); assert.equal(body.variables.id, s.project); assert.equal(body.query.includes('mutation'), false); assert.deepEqual(body.variables.states, ['OPEN']);
    return Response.json({ data: { node: { id: mismatch ? 'R_other' : s.project, issues: { nodes: [{ id: 'I_fixture', number: 1, labels: { nodes: [{ name: 'bug' }], pageInfo: { hasNextPage: false } }, assignees: { nodes: [{ login: 'owner' }], pageInfo: { hasNextPage: false } }, title: 'Issue', state: 'OPEN', url: 'https://github.com/a/b/issues/1', body: 'plain', updatedAt: row.updated_at }], pageInfo: { hasNextPage: false, endCursor: null } } } } });
  }) as typeof fetch);
  const page = await adapter.list(query(s), null, new AbortController().signal); assert.equal(page.items[0]!.remoteId, 'I_fixture');
  mismatch = true; await assert.rejects(adapter.list(query(s), null, new AbortController().signal), /shape/);
});
test('rate limits return bounded retry hints without automatic retries', async () => {
  const s = source(); let calls = 0;
  const adapter = new IssueProviderAdapter([s], (async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '9999999' } }); }) as typeof fetch);
  const page = await adapter.list(query(s), null, new AbortController().signal); assert.equal(page.retryAfter, 86400); assert.equal(page.completeness, 'partial'); assert.equal(calls, 1);
});
test('response byte cap, bad project/IDs and cross-origin item links fail closed', async () => {
  const s = source();
  for (const response of [() => Response.json([{ ...row, project_id: 99 }]), () => Response.json([{ ...row, id: null }]), () => Response.json([{ ...row, web_url: 'https://evil.invalid/' }]), () => new Response('x'.repeat(262145))]) {
    const adapter = new IssueProviderAdapter([s], (async () => response()) as typeof fetch);
    const reader = new IssueCardReader(adapter, () => ({ epoch: s.epoch, origin: s.origin, provider: s.provider }));
    await assert.rejects(reader.list('owner', query(s)));
  }
});
test('Work items use separately enabled GraphQL kind and immutable project/typed item identity', async () => {
  const s = { ...source(), workItemPath: 'group/project' }; let mismatch = false, calls = 0;
  const adapter = new IssueProviderAdapter([s], (async (url, init) => {
    calls++; assert.equal(String(url), `${s.origin}/api/graphql`); assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error');
    const input = JSON.parse(String(init?.body)); assert.equal(input.query.includes('mutation'), false); assert.equal(input.variables.path, s.workItemPath); assert.equal(input.variables.state, 'opened');
    return Response.json({ data: { project: { id: 'gid://gitlab/Project/12', workItems: { nodes: [{ id: 'gid://gitlab/WorkItem/3', iid: '1', title: 'Task', state: 'OPEN', webUrl: row.web_url, updatedAt: row.updated_at,
      project: { id: mismatch ? 'gid://gitlab/Project/99' : 'gid://gitlab/Project/12' }, workItemType: { name: 'Task' }, widgets: [{ description: 'plain' }, { labels: { nodes: [{ title: 'bug' }], pageInfo: { hasNextPage: true } } }] }], pageInfo: { hasNextPage: false, endCursor: null } } } } });
  }) as typeof fetch);
  const reader = new IssueCardReader(adapter, () => ({ epoch: 'one', origin: s.origin, provider: s.provider }));
  const page = await reader.list('owner', { ...query(s), kind: 'work_item' });
  assert.equal(page.items[0]!.identity.kind, 'work_item'); assert.equal(page.items[0]!.typeName, 'Task'); assert.deepEqual(page.items[0]!.labels, ['bug']); assert.equal(page.items[0]!.metadataPartial, true);
  mismatch = true; await assert.rejects(reader.list('owner', { ...query(s), kind: 'work_item' }), /shape/); assert.equal(calls, 2);
});
test('Work item configuration is opt-in, bounded and GitLab only', () => {
  const config = { id: 'source', label: 'Fixture', provider: 'gitlab', project: '12', origin: 'https://fixture.invalid', tokenEnv: 'TEST_TOKEN', workItemPath: 'group/project' };
  assert.equal(parseIssueSources(JSON.stringify([config]), { TEST_TOKEN: 'fixture' })[0]!.workItemPath, 'group/project');
  for (const patch of [{ provider: 'github' }, { workItemPath: '../project' }, { workItemPath: 'group/../../project' }, { workItemPath: 'https://other.invalid/a' }]) assert.throws(() => parseIssueSources(JSON.stringify([{ ...config, ...patch }]), { TEST_TOKEN: 'fixture' }));
});
