import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { HubStore } from '../hub/hub-store.js';
import { ConnectorTokenStore, DEFAULT_SCOPES } from '../auth/connector-token.js';
import { MetricsSampler } from './metrics.js';
import { registerHubMetrics, registerMetricsRead } from './metrics-http.js';
import type { ConnectorClient } from '../hub/connector-client.js';
const node='node_00000000-0000-4000-8000-000000000001';
const payload = { version:1 as const,source:{kind:'connector' as const,id:node},sampledAt:10000,scope:'process' as const,
  cpu:{percent:null,cores:1},memory:{usedBytes:10,totalBytes:null,availableBytes:null},volumes:[] };
test('Hub metrics require local admin or exact owned pinned Connector; identity and postawait permission checks', async()=>{
  const dir=mkdtempSync(join(tmpdir(),'metrics-routes-')),store=new HubStore(join(dir,'db'),'test'),app=new Hono();
  let actor={userId:'default',admin:true}, response:unknown=payload, after=()=>{};
  try {
    store.upsertConnection({id:'node',label:'Node',connectorUrl:'http://node',credentialToken:'test',capabilities:[]});
    store.pinConnectionNode('node','default',store.connectionAuthority('node')!,node);
    registerHubMetrics(app,store,()=>actor,()=>({json:async()=>{after();return response;}} as unknown as ConnectorClient),
      new MetricsSampler({kind:'hub',id:store.identities.hubId},async()=>({scope:'process',identity:'x',busy:1,capacity:1,clock:1,cores:1,memory:payload.memory,volumes:[]})));
    const get=(suffix:string)=>app.request(`/api/hub/v1/system/metrics/${suffix}`);
    assert.equal((await get('hub')).status,200);
    actor={userId:'default',admin:false}; assert.equal((await get('hub')).status,403);
    assert.equal((await get('connectors/node')).status,200);
    response={...payload,source:{...payload.source,id:'other'}}; assert.equal((await get('connectors/node')).status,502);
    response={...payload,internalPath:'/never-return'}; const clean=await get('connectors/node'); assert.equal(clean.status,200); assert.equal((await clean.text()).includes('never-return'),false);
    after=()=>{actor={userId:'other',admin:true};}; assert.equal((await get('connectors/node')).status,403);
    assert.equal((await get('connectors/node')).status,404);
    assert.equal((await (await get('sources')).json()).sources.length,1,'admin sees own Hub, not inherited machines');
  } finally {await store.close();rmSync(dir,{recursive:true,force:true});}
});

for (const outcome of ['success', 'account', 'role', 'directory', 'failure', 'abort'] as const) {
  test(`metrics sources awaited snapshot ${outcome} preserves scope and recoverable status`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'metrics-sources-')), store = new HubStore(join(dir, 'hub.sqlite'), 'synthetic');
    t.after(async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); });
    store.upsertConnection({ id: 'node', label: 'Node', connectorUrl: 'https://fixture.invalid', credentialToken: 'private' });
    store.pinConnectionNode('node', 'default', store.connectionAuthority('node')!, node);
    const app = new Hono(), abort = new AbortController(); let actor = { userId: 'default', admin: true };
    const original = store.listConnectionsAsync.bind(store); let calls = 0;
    t.mock.method(store, 'listConnections', () => { throw Error('sync scan forbidden'); });
    t.mock.method(store, 'listConnectionsAsync', async (owner: string) => {
      calls++; const rows = await original(owner);
      if (outcome === 'account') actor = { userId: 'other', admin: true };
      if (outcome === 'role') actor = { userId: 'default', admin: false };
      if (outcome === 'directory') store.upsertConnection({ id: 'node', label: 'Node', connectorUrl: 'https://fixture.invalid', status: 'disabled' });
      if (outcome === 'abort') abort.abort();
      if (outcome === 'failure') throw Error('private database path');
      return rows;
    });
    registerHubMetrics(app, store, () => actor, () => { throw Error('sources must not dispatch'); },
      new MetricsSampler({ kind: 'hub', id: store.identities.hubId }, async () => { throw Error('sources must not sample'); }));
    const result = await app.request(new Request('http://local/api/hub/v1/system/metrics/sources', { signal: abort.signal }));
    assert.equal(result.status, outcome === 'success' ? 200 : ['account', 'role'].includes(outcome) ? 403 : outcome === 'abort' ? 499 : 503);
    assert.equal(result.headers.get('cache-control'), 'no-store'); assert.equal(calls, 1);
    const text = await result.text(); assert.doesNotMatch(text, /private|credential|connectorUrl/);
    if (outcome === 'success') assert.deepEqual(JSON.parse(text).sources, [
      { key: 'hub', kind: 'hub', id: store.identities.hubId, label: 'Hub' },
      { key: 'node', kind: 'connector', id: node, label: 'Node' },
    ]);
    else assert.equal(Object.hasOwn(JSON.parse(text), 'sources'), false, 'failure cannot masquerade as empty successful scope');
  });
}
test('Connector metrics explicitly opt in and revoke during sample does not deliver', async()=>{
  const dir=mkdtempSync(join(tmpdir(),'metrics-permission-')); try {
    const tokens=new ConnectorTokenStore(join(dir,'tokens'),'bootstrap'); assert.equal(DEFAULT_SCOPES.includes('system:metrics:read'),false);
    assert.equal(tokens.requireScope(new Request('http://local',{headers:{Authorization:'Bearer bootstrap'}}),'system:metrics:read'),undefined);
    let allowed=true;
    const app=new Hono(); registerMetricsRead(app,'/metrics',new MetricsSampler(payload.source,async()=>{allowed=false;return {scope:'process',identity:'x',busy:1,capacity:1,clock:1,cores:1,memory:payload.memory,volumes:[]};}),()=>{
      const check=()=>{if(!allowed)throw new HTTPException(403);};check();return check;
    });
    const result=await app.request('/metrics'); assert.equal(result.status,403); assert.equal(result.headers.get('cache-control'),'no-store');
    assert.equal((await result.text()).includes('usedBytes'),false);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
