import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
const helper = new URL('../apps/web/tests/fixtures/browser-network.mjs', import.meta.url);
test('browser network fence exists', () => assert.ok(existsSync(helper), 'network fence missing'));
test('network fence admits only the exact synthetic origin and rejects writes and URL tricks', async () => {
  const { permittedRequest } = await import(helper);
  const origin = 'http://127.0.0.1:12345';
  assert.equal(permittedRequest(origin + '/src/test.ts', 'GET', origin), true);
  for (const url of ['https://ci-denied.invalid/', 'http://127.0.0.1:12346/', 'http://localhost:12345/', 'http://127.0.0.1:12345@ci-denied.invalid/', 'file:///etc/passwd', origin + '/']) {
    assert.equal(permittedRequest(url, url === origin + '/' ? 'POST' : 'GET', origin), false, url);
  }
  assert.equal(permittedRequest(origin, 'GET', undefined), false);
});
test('explicit synthetic writes admit only the exact loopback API path and method', async () => {
  const { fenceContext } = await import(helper);
  let handler,handled=0;const origin='http://127.0.0.1:12345',path='/api/fixture/recover';
  const context={route:async(_,fn)=>{handler=fn;},routeWebSocket:async()=>{}};
  const denied=await fenceContext(context,{origin,api:async()=>{handled++;},apiWrites:[{method:'POST',path}]});
  let aborted=0;
  for(const [url,method] of [[origin+path,'POST'],[origin+path+'?trick=1','POST'],[origin+path+'/extra','POST'],[origin+path,'PUT'],['http://127.0.0.1:12346'+path,'POST'],[origin+'/private','POST']]){
    await handler({request:()=>({url:()=>url,method:()=>method}),abort:async()=>{aborted++;},continue:async()=>{throw Error('write escaped');}});
  }
  assert.equal(handled,1);assert.equal(aborted,5);assert.equal(denied.length,5);
});
