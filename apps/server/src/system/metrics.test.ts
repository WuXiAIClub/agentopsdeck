import assert from 'node:assert/strict';
import test from 'node:test';
import { MetricsSampler, linuxMetricsProvider, parseMetricVolumes, type RawMetrics } from './metrics.js';
import { publicSystemMetrics, validSystemMetrics } from '@agentopsdeck/shared';
const source = { kind: 'connector' as const, id: 'node_synthetic' };
const raw = (busy = 10, clock = 10): RawMetrics => ({ scope: 'process', identity: 'one', busy, clock, capacity: clock,
  cores: 1, memory: { usedBytes: 10, totalBytes: null, availableBytes: null }, volumes: [] });

test('metrics first sample unknown, delta accounting, cached single flight, rollback resets baseline', async () => {
  let now = 10000, count = 0, next = raw();
  const sampler = new MetricsSampler(source, async () => { count++; return next; }, () => now);
  const [a,b] = await Promise.all([sampler.sample(), sampler.sample()]); assert.equal(count, 1); assert.equal(a,b); assert.equal(a.cpu.percent,null);
  assert.equal(await sampler.sample(),a); assert.equal(count,1);
  now+=5001; next=raw(15,20); assert.equal((await sampler.sample()).cpu.percent,50);
  now+=5001; next=raw(1,30); assert.equal((await sampler.sample()).cpu.percent,null);
  now+=5001; next={...raw(3,40),identity:'restarted'}; assert.equal((await sampler.sample()).cpu.percent,null);
});
test('timeout rejects within budget but cannot create unbounded stuck provider work', async () => {
  let count=0, finish!: (r:RawMetrics)=>void;
  const sampler=new MetricsSampler(source,()=>{count++;return new Promise(r=>{finish=r;});},()=>10000,10);
  await assert.rejects(sampler.sample(),/timed out/); await assert.rejects(sampler.sample(),/timed out/); assert.equal(count,1);
  finish(raw()); await new Promise(r=>setImmediate(r));
  const again=sampler.sample(); await Promise.resolve(); finish(raw()); assert.equal((await again).cpu.percent,null); assert.equal(count,2);
});
test('volume allowlist is explicit, bounded and never shares file-reader defaults', () => {
  assert.deepEqual(parseMetricVolumes(),{}); assert.deepEqual(parseMetricVolumes('{"data":"/data"}'),{data:'/data'});
  for(const v of ['{"x":"relative"}','{"__proto__":"/x"}','[]','not-json']) assert.throws(()=>parseMetricVolumes(v));
});
test('real read-only kernel sampler exposes no paths or environment and labels its scope', async () => {
  const sampler=new MetricsSampler(source,linuxMetricsProvider()); const value=await sampler.sample();
  assert.equal(validSystemMetrics(value),true); assert.equal(value.cpu.percent,null);
  assert.equal(JSON.stringify(value).includes('/'),false); assert.deepEqual(value.volumes,[]);
  assert.deepEqual(publicSystemMetrics({...value, secret:'no'} as typeof value),value);
  assert.equal(validSystemMetrics({...value,volumes:[null]}),false);
});

const kernel = (files: Record<string, string>) => ({
  read: async (path: string, signal: AbortSignal) => { signal.throwIfAborted(); if (!(path in files)) throw Error('Missing fixture'); return files[path]!; },
  platform: 'linux' as const, parallelism: () => 8, totalMemory: () => 8192, cpuCount: () => 8,
});
test('cgroup accounting includes tighter ancestor quota and sibling memory consumption', async () => {
  const files = {
    '/proc/self/cgroup': '0::/parent/child\n',
    '/sys/fs/cgroup/parent/child/cpu.stat': 'usage_usec 12\n',
    '/sys/fs/cgroup/parent/child/cpu.max': 'max 100000',
    '/sys/fs/cgroup/parent/child/memory.max': 'max',
    '/sys/fs/cgroup/parent/child/memory.current': '100',
    '/sys/fs/cgroup/parent/cpu.max': '50000 100000',
    '/sys/fs/cgroup/parent/memory.max': '1000',
    '/sys/fs/cgroup/parent/memory.current': '900',
  };
  const value = await linuxMetricsProvider({}, kernel(files))(new AbortController().signal);
  assert.equal(value.scope, 'cgroup'); assert.equal(value.cores, .5);
  assert.deepEqual(value.memory, { usedBytes: 100, totalBytes: 1000, availableBytes: 100 });
  assert.equal(value.busy, 12);
});
test('legacy, namespaced root and unreadable ancestor never claim host capacity', async () => {
  for (const membership of ['0::/\n', '1:memory:/docker/test\n', '0::/parent/child\n', '0::/../../invalid\n']) {
    const value = await linuxMetricsProvider({}, kernel({'/proc/self/cgroup': membership}))(new AbortController().signal);
    assert.equal(value.scope, 'process'); assert.equal(value.memory.totalBytes, null);
  }
});
test('unconstrained systemd service cgroup promotes to host /proc/stat and /proc/meminfo accounting when available', async () => {
  const files = {
    '/proc/self/cgroup': '0::/user.slice/agentopsdeck-local.service\n',
    '/sys/fs/cgroup/user.slice/agentopsdeck-local.service/cpu.stat': 'usage_usec 1200\n',
    '/sys/fs/cgroup/user.slice/agentopsdeck-local.service/cpu.max': 'max 100000\n',
    '/sys/fs/cgroup/user.slice/agentopsdeck-local.service/memory.max': 'max\n',
    '/sys/fs/cgroup/user.slice/agentopsdeck-local.service/memory.current': '1900000000\n',
    '/sys/fs/cgroup/user.slice/cpu.max': 'max 100000\n',
    '/sys/fs/cgroup/user.slice/memory.max': 'max\n',
    '/sys/fs/cgroup/user.slice/memory.current': '2100000000\n',
    '/proc/stat': 'cpu 100 0 50 750 100 0 0 0\n',
    '/proc/meminfo': 'MemTotal: 8 kB\nMemAvailable: 3 kB\n',
  };
  const value = await linuxMetricsProvider({}, kernel(files))(new AbortController().signal);
  assert.equal(value.scope, 'host');
  assert.equal(value.capacity, 1000);
  assert.equal(value.busy, 150);
  assert.deepEqual(value.memory, { totalBytes: 8192, availableBytes: 3072, usedBytes: 5120 });
});
test('uncgrouped host accounting excludes idle and iowait from busy', async () => {
  const value = await linuxMetricsProvider({}, kernel({ '/proc/self/cgroup': '', '/proc/stat': 'cpu 10 0 10 60 20 0 0 0\n',
    '/proc/meminfo': 'MemAvailable: 2 kB\n' }))(new AbortController().signal);
  assert.equal(value.scope, 'host'); assert.equal(value.capacity, 100); assert.equal(value.busy, 20);
  assert.deepEqual(value.memory, { totalBytes: 8192, availableBytes: 2048, usedBytes: 6144 });
});
test('invalid provider samples never poison cached data or baseline', async () => {
  let next = {...raw(), busy: NaN}; const sampler = new MetricsSampler(source, async () => next);
  await assert.rejects(sampler.sample(), /Invalid metrics/);
  next = raw(); assert.equal((await sampler.sample()).cpu.percent, null);
});
