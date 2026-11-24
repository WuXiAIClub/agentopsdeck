import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectCodexMaintenance, NativeMaintenanceInspectionError, nativeMaintenanceFailureReason } from './maintenance.js';

function fixture() {
  const calls: string[] = [];
  let lists = 0;
  const request = async (method: string, params: any) => {
    calls.push(method);
    if (method === 'thread/loaded/list') { lists++; return { data: ['parent', 'child'], nextCursor: null }; }
    if (method === 'thread/list') return { data: ['parent', 'child'].map(id => ({ id, status: { type: 'idle' } })), nextCursor: null };
    if (method === 'thread/backgroundTerminals/list') return { data: [], nextCursor: null };
    throw new Error('Unexpected mutation');
  };
  return { request, calls, lists: () => lists };
}

test('maintenance inspects all native-loaded threads including unprojected children, without loading history or mutation', async () => {
  const f = fixture();
  assert.deepEqual(await inspectCodexMaintenance(f.request, () => {}), { loadedThreads: 2, activeRuns: 0, backgroundTerminals: 0 });
  assert.equal(f.lists(), 2);
  assert.equal(f.calls.filter(method => method === 'thread/list').length, 1);
  assert.equal(f.calls.includes('thread/read'), false, 'maintenance never hydrates rollout history');
});

test('active child threads and background terminals block quiet evidence independently', async () => {
  const f = fixture();
  const result = await inspectCodexMaintenance(async (method, params: any) => {
    if (method === 'thread/list') {
      assert.deepEqual(params.modelProviders, []);
      assert.equal(params.useStateDbOnly, true);
      assert.ok(params.sourceKinds.includes('subAgentThreadSpawn'));
      return { data: ['parent', 'child'].map(id => ({ id, status: { type: id === 'child' ? 'active' : 'idle' } })), nextCursor: null };
    }
    if (method === 'thread/backgroundTerminals/list' && params.threadId === 'parent') {
      return { data: [{ processId: 'process', itemId: 'tool' }], nextCursor: null };
    }
    return f.request(method, params);
  }, () => {});
  assert.deepEqual(result, { loadedThreads: 2, activeRuns: 1, backgroundTerminals: 1 });
});

test('unknown, notLoaded, malformed identity and unsupported native RPC never prove idle', async () => {
  for (const thread of [{ id: 'wrong', status: { type: 'idle' } }, { id: 'parent', status: { type: 'notLoaded' } },
    { id: 'parent', status: { type: 'systemError' } }, { id: 'parent' }]) {
    const f = fixture();
    await assert.rejects(inspectCodexMaintenance((method, params) => method === 'thread/list'
      ? Promise.resolve({ data: [thread], nextCursor: null }) : f.request(method, params), () => {}));
  }
  await assert.rejects(inspectCodexMaintenance(async () => { throw new Error('unsupported'); }, () => {}));
});

test('all loaded identities must have native status, including archived threads and later pages', async () => {
  const f = fixture(), calls: any[] = [];
  const result = await inspectCodexMaintenance(async (method, params: any) => {
    if (method !== 'thread/list') return f.request(method, params);
    calls.push(params);
    if (params.archived) return { data: [{ id: 'child', status: { type: 'active' } }], nextCursor: null };
    if (!params.cursor) return { data: [{ id: 'unrelated', status: { type: 'notLoaded' } }], nextCursor: 'second' };
    return { data: [{ id: 'parent', status: { type: 'idle' } }], nextCursor: null };
  }, () => {});
  assert.equal(result.activeRuns, 1);
  assert.deepEqual(calls.map(p => [p.archived, p.cursor]), [[false, undefined], [false, 'second'], [true, undefined]]);
});

test('a stalled history RPC cannot stall an otherwise fully observable maintenance snapshot', async () => {
  const f = fixture();
  const result = await inspectCodexMaintenance((method, params) => method === 'thread/read'
    ? new Promise(() => {}) : f.request(method, params), () => {});
  assert.equal(result.loadedThreads, 2);
});

test('only source-tracked unmaterialized threads use native empty-thread proof when absent from lists', async () => {
  const f = fixture(), unmaterialized = new Set(['child']);
  const request = async (method: string, params: any) => {
    if (method === 'thread/list') return { data: params.archived ? [] : [{ id: 'parent', status: { type: 'idle' } }] };
    if (method === 'thread/read') {
      assert.deepEqual(params, { threadId: 'child', includeTurns: false });
      return { thread: { id: 'child', status: { type: 'idle' }, turns: [] } };
    }
    return f.request(method, params);
  };
  assert.deepEqual(await inspectCodexMaintenance(request, () => {}, Date.now() + 4000, unmaterialized),
    { loadedThreads: 2, activeRuns: 0, backgroundTerminals: 0 });
  await assert.rejects(inspectCodexMaintenance(request, () => {}), /unavailable/);
  for (const invalid of [
    { id: 'wrong', status: { type: 'idle' }, turns: [] },
    { id: 'child', status: { type: 'active' }, turns: [] },
    { id: 'child', status: { type: 'notLoaded' }, turns: [] },
    { id: 'child', status: { type: 'idle' }, turns: [{}] },
    { id: 'child', status: { type: 'idle' } },
  ]) {
    await assert.rejects(inspectCodexMaintenance((method, params) => method === 'thread/read'
      ? Promise.resolve({ thread: invalid }) : request(method, params), () => {}, Date.now() + 4000, unmaterialized), /unavailable/);
  }
  await assert.rejects(inspectCodexMaintenance(async (method, params) => {
    const result = await request(method, params);
    if (method === 'thread/read') unmaterialized.clear();
    return result;
  }, () => {}, Date.now() + 4000, unmaterialized), /unavailable/);
});

test('error threads remain blocked with a fixed safe diagnostic code, not idle', async () => {
  const f = fixture();
  await assert.rejects(inspectCodexMaintenance((method, params) => method === 'thread/list'
    ? Promise.resolve({ data: [{ id: 'parent', status: { type: 'systemError' } }] }) : f.request(method, params), () => {}),
  error => nativeMaintenanceFailureReason(error) === 'native_thread_system_error');
  assert.equal(nativeMaintenanceFailureReason(new Error('secret native input /private/path')), undefined);
  const error = new NativeMaintenanceInspectionError('native_thread_status_unavailable');
  (error as any).reason = 'secret';
  assert.equal(nativeMaintenanceFailureReason(error), undefined);
});

test('status pages fail closed for duplicates, malformed rows/cursors, loops and exhaustion', async () => {
  for (const pages of [
    [{ data: [{ id: 'parent', status: { type: 'idle' } }, { id: 'parent', status: { type: 'idle' } }] }],
    [{ data: [null] }], [{ data: [{ id: '' }] }], [{ data: [], nextCursor: {} }],
    [{ data: [], nextCursor: 'same' }, { data: [], nextCursor: 'same' }],
  ]) {
    const f = fixture(); let page = 0;
    await assert.rejects(inspectCodexMaintenance((method, params) => method === 'thread/list'
      ? Promise.resolve(pages[page++]) : f.request(method, params), () => {}));
  }
  const f = fixture(); let pages = 0;
  await assert.rejects(inspectCodexMaintenance((method, params) => method === 'thread/list'
    ? Promise.resolve({ data: [], nextCursor: String(++pages) }) : f.request(method, params), () => {}), /budget/);
  assert.equal(pages, 32);
});

test('connection/notification invalidation and changed loaded sets reject a stale proof', async () => {
  const f = fixture(); let invalid = false;
  await assert.rejects(inspectCodexMaintenance(async (method, params) => {
    const result = await f.request(method, params); invalid = true; return result;
  }, () => { if (invalid) throw new Error('activity changed'); }), /activity changed/);
  const g = fixture();
  await assert.rejects(inspectCodexMaintenance((method, params) => method === 'thread/loaded/list' && g.lists()
    ? Promise.resolve({ data: ['replacement'], nextCursor: null }) : g.request(method, params), () => {}), /threads changed/);
});

test('pagination is bounded and rejects duplicates and looping cursors', async () => {
  for (const pages of [
    [{ data: ['same', 'same'], nextCursor: null }],
    [{ data: ['one'], nextCursor: 'next' }, { data: ['two'], nextCursor: 'next' }],
    [{ data: ['one'], nextCursor: 'next' }, { data: ['one'], nextCursor: null }],
    [{ data: [null], nextCursor: null }],
    [{ data: [], nextCursor: {} }],
  ]) {
    let i = 0;
    await assert.rejects(inspectCodexMaintenance(async () => pages[i++], () => {}));
  }
  let calls = 0;
  await assert.rejects(inspectCodexMaintenance(async () => ({ data: [], nextCursor: `page:${++calls}` }), () => {}), /budget/);
  assert.equal(calls, 32);
});

test('one total deadline covers all reads; expired inspection sends no new RPC', async () => {
  const f = fixture();
  await assert.rejects(inspectCodexMaintenance(f.request, () => {}, Date.now() - 1), /timed out/);
  assert.deepEqual(f.calls, []);
});
