import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore, DEFAULT_SCOPES } from '../auth/connector-token.js';
import { registerConnectorIssueRoutes } from './issues-http.js';
const source = { id: 'fixture', label: 'Fixture', provider: 'gitlab' as const, origin: 'https://fixture.invalid', project: '12', token: 'private-fixture-token', epoch: 'one' };
test('Work item HTTP is explicit opt-in, fixed read query, exact kind and project',async()=>{
  const temp=await mkdtemp(join(tmpdir(),'work-items-http-'));
  try{
    const tokens=new ConnectorTokenStore(join(temp,'tokens')),actor=tokens.createTransient(['issues:read']),app=new Hono();let calls=0;
    registerConnectorIssueRoutes(app,tokens,[{...source,workItemPath:'group/project'}],(async(url,init)=>{
      calls++;assert.equal(String(url),source.origin+'/api/graphql');assert.equal(init?.method,'POST');
      const payload=JSON.parse(String(init?.body));assert.ok(!payload.query.includes('mutation'));assert.equal(payload.variables.path,'group/project');
      return Response.json({data:{project:{id:'gid://gitlab/Project/12',workItems:{nodes:[{id:'gid://gitlab/WorkItem/5',iid:'3',title:'Work',state:'OPEN',webUrl:source.origin+'/work/3',updatedAt:'2026-10-07T00:00:00Z',project:{id:'gid://gitlab/Project/12'},workItemType:{name:'Task'},widgets:[]}],pageInfo:{hasNextPage:false,endCursor:null}}}}});
    }) as typeof fetch);
    const get=(path:string)=>app.request('/api/connector/v1/issues/'+path,{headers:{authorization:`Bearer ${actor.token}`}});
    assert.deepEqual((await(await get('sources')).json()).sources[0].kinds,['issue','work_item']);
    const response=await get('fixture/items?kind=work_item');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    const body=await response.json();assert.equal(body.items[0].identity.kind,'work_item');assert.equal(body.items[0].number,'3');assert.equal(body.items[0].typeName,'Task');
    assert.equal((await get('fixture/items?kind=work_item&kind=issue')).status,400);assert.equal(calls,1);
  }finally{await rm(temp,{recursive:true,force:true});}
});
test('Issue HTTP opt-in, owner cursors, strict queries, in-flight revoke, rate limiting', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'issues-http-'));
  try {
    const tokens = new ConnectorTokenStore(join(temp, 'tokens')), app = new Hono();
    const a = tokens.createTransient(['issues:read']), b = tokens.createTransient(['issues:read']), session = tokens.createTransient(['sessions:read']);
    let after: () => void = () => {}, limited = false, calls = 0;
    registerConnectorIssueRoutes(app, tokens, [source], (async () => {
      calls++; after(); if (limited) return new Response('', { status: 429, headers: { 'retry-after': '30' } });
      return Response.json([{ id: 1, iid: 1, labels: [], assignees: [], project_id: 12, title: 'PRIVATE TITLE', state: 'open', web_url: 'https://fixture.invalid/a/b/issues/1', description: null, updated_at: '2026-10-07T00:00:00Z' }], { headers: { 'x-next-page': '2' } });
    }) as typeof fetch);
    const get = (suffix: string, token = a.token) => app.request(`/api/connector/v1/issues/${suffix}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(DEFAULT_SCOPES.includes('issues:read'), false); assert.equal((await get('sources', '')).status, 401); assert.equal((await get('sources', session.token)).status, 403);
    const sources = await get('sources'); assert.equal(sources.headers.get('cache-control'), 'no-store'); assert.ok(!(await sources.text()).includes(source.token));
    const page = await (await get('fixture/items')).json(); assert.equal(page.items[0].identity.origin, source.origin); assert.equal(page.items[0].identity.provider, source.provider);
    assert.equal((await get(`fixture/items?cursor=${page.nextCursor}`, b.token)).status, 409);
    for (const query of ['state=bad', 'cursor=bad', 'project=other', 'state=all&state=open']) assert.equal((await get(`fixture/items?${query}`)).status, 400);
    after = () => a.dispose(); const revoked = await get('fixture/items'); assert.equal(revoked.status, 403); assert.ok(!(await revoked.text()).includes('PRIVATE TITLE'));
    after = () => {}; limited = true; assert.equal((await get('fixture/items', b.token)).status, 200); const before = calls;
    assert.equal((await get('fixture/items', b.token)).status, 429); assert.equal(calls, before);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
