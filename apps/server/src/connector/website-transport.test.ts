import assert from 'node:assert/strict';
import test from 'node:test';
import { readWebsiteResource } from './website-access.js';
import { WebsiteActionExecution, type WebsiteActionPolicy } from './website-actions.js';

const service = { id: 'synthetic', label: 'Synthetic', url: 'http://synthetic.invalid/', browse: true };
const action: WebsiteActionPolicy = { id: 'save', label: 'Save', method: 'POST', path: '/save', contentType: 'application/json', maxBytes: 64 };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(complete => { resolve = complete; });
  return { promise, resolve };
}

for (const kind of ['resource', 'action'] as const) test(`${kind}: deadline bounds caller before uncooperative fetch resolves and retains cancel acknowledgement`, async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const response = deferred<Response>(), cancelled = deferred<void>(), retained: Promise<unknown>[] = [];
  let calls = 0, cancels = 0;
  const fetcher: typeof fetch = async () => { calls++; return response.promise; };
  const execution = new WebsiteActionExecution(service.url, action);
  const pending = kind === 'resource'
    ? readWebsiteResource(service, '/', new AbortController().signal, fetcher, work => retained.push(work))
    : execution.execute('{}', new AbortController().signal, fetcher, work => retained.push(work));
  const checked = kind === 'resource' ? assert.rejects(pending, { status: 504 }) : pending.then(value => assert.deepEqual(value, { state: 'unknown' }));
  await turn(); assert.equal(calls, 1);
  context.mock.timers.tick(8000); await checked;
  let drained = false;
  const drain = Promise.allSettled(retained).then(() => { drained = true; });
  await turn(); assert.equal(drained, false);
  response.resolve(new Response(new ReadableStream({ cancel() { cancels++; return cancelled.promise; } }), { headers: { 'content-type': 'text/plain' } }));
  await turn(); assert.equal(cancels, 1); assert.equal(drained, false);
  if (kind === 'action') { assert.deepEqual(await execution.execute('{}', new AbortController().signal, fetcher), { state: 'unknown' }); assert.equal(calls, 1); }
  cancelled.resolve(); await drain; assert.equal(drained, true);
  if (kind === 'action') assert.deepEqual(execution.receipt, { state: 'unknown' });
});

test('aborted original transports retain shared resource/action capacity until actual settlement', async () => {
  const replies = Array.from({ length: 4 }, () => deferred<Response>()), retained: Promise<unknown>[] = [];
  let calls = 0;
  const fetcher: typeof fetch = async () => calls < 4 ? replies[calls++]!.promise : (calls++, new Response('recovered', { headers: { 'content-type': 'text/plain' } }));
  for (let index = 0; index < 4; index++) {
    const controller = new AbortController();
    const pending = readWebsiteResource(service, '/', controller.signal, fetcher, work => retained.push(work));
    const rejected = assert.rejects(pending, { status: 502 });
    await turn(); controller.abort(); await rejected;
  }
  await assert.rejects(readWebsiteResource(service, '/', new AbortController().signal, fetcher), { status: 429 });
  const execution = new WebsiteActionExecution(service.url, action);
  await assert.rejects(execution.execute('{}', new AbortController().signal, fetcher), { status: 429 });
  assert.deepEqual(execution.receipt, { state: 'ready' }); assert.equal(calls, 4);
  for (const reply of replies) reply.resolve(new Response('late', { headers: { 'content-type': 'text/plain' } }));
  await Promise.allSettled(retained);
  const completed = new WebsiteActionExecution(service.url, action);
  const healthy: typeof fetch = async () => new Response('saved', { headers: { 'content-type': 'text/plain' } });
  assert.deepEqual(await completed.execute('{}', new AbortController().signal, healthy), { state: 'completed', status: 200, text: 'saved' });
  assert.equal((await readWebsiteResource(service, '/', new AbortController().signal, fetcher)).status, 200);
  assert.equal(calls, 5);
});

test('caller abort during body consumption returns promptly while cancellation remains owned', async () => {
  const cancelled = deferred<void>(), retained: Promise<unknown>[] = [], controller = new AbortController();
  let reading!: () => void;
  const began = new Promise<void>(resolve => { reading = resolve; });
  const fetcher: typeof fetch = async () => new Response(new ReadableStream({ pull() { reading(); return new Promise(() => {}); }, cancel() { return cancelled.promise; } }), { headers: { 'content-type': 'text/plain' } });
  const pending = readWebsiteResource(service, '/', controller.signal, fetcher, work => retained.push(work));
  const rejected = assert.rejects(pending, { status: 502 });
  await began; controller.abort(); await rejected;
  let drained = false;
  const drain = Promise.allSettled(retained).then(() => { drained = true; });
  await turn(); assert.equal(drained, false);
  cancelled.resolve(); await drain;
});
