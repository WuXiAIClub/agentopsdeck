import assert from 'node:assert/strict';
import test from 'node:test';
import { createSourcePreviewCache, sourcePreviewCacheKey } from './source-preview-cache.js';

const url = `/api/hub/v1/sessions/remote%3Aone/messages/message/media/${'a'.repeat(64)}`;
const key = sourcePreviewCacheKey('https://hub.test', '', 'a'.repeat(64), url, '/work/a.ts', 2)!;
const preview = { path: '/work/a.ts', line: 2, startLine: 1, totalLines: 2, text: 'one\ntwo', modifiedAt: 1 };

test('hover prewarm is shared with the opened preview without another source read', async () => {
  const cache = createSourcePreviewCache(() => undefined);
  const releaseWarm = cache.subscribe(key, () => {});
  let reads = 0, finish!: (value: typeof preview) => void;
  const warming = cache.load(key, async () => { reads++; return new Promise(resolve => { finish = resolve; }); });
  await Promise.resolve();
  const releasePreview = cache.subscribe(key, () => {});
  const mountedRead = cache.load(key, async () => { reads++; return preview; });
  assert.equal(mountedRead, warming);
  releaseWarm(); await Promise.resolve();
  finish(preview); await mountedRead;
  assert.equal(reads, 1); assert.deepEqual(cache.peek(key)?.preview, preview);
  releasePreview();
});

test('last preview owner cancels a pending read; late completion cannot replace a remounted read', async () => {
  const cache = createSourcePreviewCache(() => undefined);
  const release = cache.subscribe(key, () => {});
  let signal!: AbortSignal, finish!: (value: typeof preview) => void;
  const old = cache.load(key, async value => { signal = value; return new Promise(resolve => { finish = resolve; }); });
  await Promise.resolve();
  release(); release();
  await Promise.resolve();
  assert.equal(signal.aborted, true);
  assert.equal(cache.peek(key), undefined, 'no ownerless loading marker suppresses the next read');
  const newRelease = cache.subscribe(key, () => {});
  await cache.load(key, async () => ({ ...preview, text: 'new\nsource' }));
  finish(preview); await old;
  assert.equal(cache.peek(key)?.preview?.text, 'new\nsource');
  newRelease();
});

test('shared owners and same-turn remount keep the actual pending preview transport', async () => {
  const cache = createSourcePreviewCache(() => undefined);
  const release = cache.subscribe(key, () => {}), shared = cache.subscribe(key, () => {});
  let signal!: AbortSignal, finish!: (value: typeof preview) => void;
  const pending = cache.load(key, async value => { signal = value; return new Promise(resolve => { finish = resolve; }); });
  await Promise.resolve(); release(); await Promise.resolve();
  assert.equal(signal.aborted, false);
  shared();
  const remount = cache.subscribe(key, () => {});
  await Promise.resolve();
  assert.equal(signal.aborted, false);
  assert.equal(cache.load(key, async () => { throw Error('duplicate'); }), pending);
  finish(preview); await pending; remount(); await Promise.resolve();
  assert.deepEqual(cache.peek(key)?.preview, preview, 'completed previews still survive closing');
});

test('cancelling an unconfirmed refresh evicts persisted source rather than making it newly fresh', async () => {
  const storage = store(), cache = createSourcePreviewCache(() => storage);
  const release = cache.subscribe(key, () => {});
  await cache.load(key, async () => preview);
  let reject!: (error: Error) => void;
  const refresh = cache.load(key, async () => new Promise((_, fail) => { reject = fail; }), true);
  await Promise.resolve(); release(); await Promise.resolve();
  assert.equal(cache.peek(key), undefined);
  assert.equal(createSourcePreviewCache(() => storage).peek(key), undefined);
  reject(new Error('aborted transport')); await refresh;
  assert.equal(cache.peek(key), undefined, 'cancellation is not cached as a failed authorization');
});

test('clear before the loader microtask prevents a revoked preview request from starting', async () => {
  const cache = createSourcePreviewCache(() => undefined);
  let calls = 0;
  const pending = cache.load(key, async () => { calls++; return preview; });
  cache.clear(); await pending;
  assert.equal(calls, 0);
  assert.equal(cache.peek(key), undefined);
});

test('loading notifications expose the real shared promise to synchronous subscribers', async () => {
  const cache = createSourcePreviewCache(() => undefined);
  let observed: Promise<void> | undefined, calls = 0;
  const release = cache.subscribe(key, () => {
    if (cache.peek(key)?.loading) observed = cache.load(key, async () => { throw Error('duplicate'); });
  });
  const pending = cache.load(key, async () => { calls++; return preview; });
  assert.equal(observed, pending);
  await observed;
  assert.equal(calls, 1);
  assert.deepEqual(cache.peek(key)?.preview, preview);
  release();
});

test('closing synchronously on settled notification preserves successful and denied results', async () => {
  for (const denied of [false, true]) {
    const cache = createSourcePreviewCache(() => undefined);
    const release = cache.subscribe(key, () => { if (!cache.peek(key)?.loading) release(); });
    let signal!: AbortSignal;
    await cache.load(key, async value => {
      signal = value;
      if (denied) throw new Error('denied');
      return preview;
    });
    assert.equal(signal.aborted, false, 'settled transport must not be cancelled during final notification');
    if (denied) assert.equal(cache.peek(key)?.error, 'denied');
    else assert.deepEqual(cache.peek(key)?.preview, preview);
  }
});

test('abort listener may synchronously remount without joining or losing the cancelled read', async () => {
  const cache = createSourcePreviewCache(() => undefined);
  const release = cache.subscribe(key, () => {});
  let remounted: Promise<void> | undefined, releaseNew: (() => void) | undefined;
  const pending = cache.load(key, signal => new Promise((_, reject) => {
    signal.addEventListener('abort', () => {
      releaseNew = cache.subscribe(key, () => {});
      remounted = cache.load(key, async () => ({ ...preview, text: 'fresh\nsource' }));
      reject(new Error('cancelled'));
    }, { once: true });
  }));
  await Promise.resolve(); release(); await Promise.resolve();
  assert.ok(remounted);
  assert.notEqual(remounted, pending);
  await Promise.all([pending, remounted]);
  assert.equal(cache.peek(key)?.preview?.text, 'fresh\nsource');
  releaseNew!();
});

test('sixteen previews repeatedly unmount without retaining background transports or loading entries', async () => {
  const cache = createSourcePreviewCache(() => undefined);
  let active = 0, aborted = 0;
  for (let cycle = 0; cycle < 20; cycle++) {
    const keys = Array.from({ length: 16 }, (_, i) => numberedKey(i));
    const release = keys.map(key => cache.subscribe(key, () => {}));
    const reads = keys.map(key => cache.load(key, signal => new Promise((_, reject) => {
      active++;
      signal.addEventListener('abort', () => { active--; aborted++; reject(new Error('aborted')); }, { once: true });
    })));
    await Promise.resolve(); assert.equal(active, 16);
    release.forEach(close => close()); await Promise.resolve();
    assert.equal(active, 0);
    await Promise.all(reads);
    assert.ok(keys.every(key => cache.peek(key) === undefined));
  }
  assert.equal(aborted, 320);
});

test('notifications are scoped to changed previews, while invalidation reaches every affected card', async () => {
  const cache = createSourcePreviewCache(() => undefined);
  const other = sourcePreviewCacheKey('https://hub.test', '', 'a'.repeat(64), url.replace('/message/', '/other/'), preview.path, 2)!;
  let a = 0, b = 0, missing = 0;
  const unsubscribe = cache.subscribe(key, () => a++);
  cache.subscribe(other, () => b++);
  cache.subscribe(undefined, () => missing++);
  await cache.load(key, async () => preview);
  assert.deepEqual([a, b, missing], [2, 0, 0]);
  await cache.load(other, async () => preview);
  assert.deepEqual([a, b, missing], [2, 2, 0]);
  cache.clear(candidate => candidate === key);
  assert.deepEqual([a, b, missing], [3, 2, 0]);
  assert.equal(cache.peek(key), undefined);
  assert.deepEqual(cache.peek(other)?.preview, preview);
  cache.clear();
  assert.deepEqual([a, b, missing], [3, 3, 0]);
  unsubscribe(); unsubscribe();
  await cache.load(key, async () => preview);
  assert.equal(a, 3);
});

test('reused subscription callbacks retain independent mounted ownership', async () => {
  const cache = createSourcePreviewCache(() => undefined);
  let calls = 0;
  const callback = () => calls++;
  const first = cache.subscribe(key, callback), second = cache.subscribe(key, callback);
  first(); first();
  await cache.load(key, async () => preview);
  assert.equal(calls, 2);
  second();
  cache.clear();
  assert.equal(calls, 2);
});

function store() {
  const map = new Map<string, string>();
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); }, clear: () => map.clear(), key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size; } } satisfies Storage;
}

test('preview reads coalesce and survive remount and tab reload without another fetch', async () => {
  const storage = store(), cache = createSourcePreviewCache(() => storage);
  let calls = 0;
  const loader = async () => { calls++; return preview; };
  const one = cache.load(key, loader), two = cache.load(key, loader);
  assert.equal(one, two);
  await one; await cache.load(key, loader);
  const reloaded = createSourcePreviewCache(() => storage);
  assert.deepEqual(reloaded.peek(key)?.preview, preview);
  await reloaded.load(key, loader);
  assert.equal(calls, 1);
});

test('refresh keeps source while loading, replaces on success and evicts on denial', async () => {
  const storage = store(), cache = createSourcePreviewCache(() => storage);
  await cache.load(key, async () => preview);
  const refresh = cache.load(key, async () => ({ ...preview, text: 'changed\nnow' }), true);
  assert.deepEqual(cache.peek(key)?.preview, preview);
  assert.equal(cache.peek(key)?.loading, true);
  await refresh;
  assert.equal(cache.peek(key)?.preview?.text, 'changed\nnow');
  await cache.load(key, async () => { throw new Error('Permission revoked'); }, true);
  assert.equal(cache.peek(key)?.preview, undefined);
  assert.equal(cache.peek(key)?.error, 'Permission revoked');
  assert.equal(createSourcePreviewCache(() => storage).peek(key), undefined);
  let retried = false;
  await cache.load(key, async () => { retried = true; return preview; });
  assert.equal(retried, false, 'remount must not loop failed requests');
  await cache.load(key, async () => preview, true);
  assert.deepEqual(cache.peek(key)?.preview, preview);
});

test('expiry reloads and keys isolate account, Hub, session, path and line', async () => {
  let now = 1000, calls = 0;
  const storage = store(), cache = createSourcePreviewCache(() => storage, () => now);
  await cache.load(key, async () => { calls++; return preview; });
  now += 5 * 60_000;
  assert.deepEqual(cache.peek(key)?.preview, preview, 'mounted content stays stable after expiry');
  assert.equal(createSourcePreviewCache(() => storage, () => now).peek(key), undefined);
  await cache.load(key, async () => { calls++; return preview; });
  assert.equal(calls, 2);
  for (const variant of [
    sourcePreviewCacheKey('https://other.test', '', 'a'.repeat(64), url, preview.path, 2),
    sourcePreviewCacheKey('https://hub.test', '/other', 'a'.repeat(64), url, preview.path, 2),
    sourcePreviewCacheKey('https://hub.test', '', 'b'.repeat(64), url, preview.path, 2),
    sourcePreviewCacheKey('https://hub.test', '', 'a'.repeat(64), url.replace('remote%3Aone', 'remote%3Atwo'), preview.path, 2),
    sourcePreviewCacheKey('https://hub.test', '', 'a'.repeat(64), url, '/other/a.ts', 2),
    sourcePreviewCacheKey('https://hub.test', '', 'a'.repeat(64), url, preview.path, 1),
  ]) assert.equal(cache.peek(variant), undefined);
  assert.equal(sourcePreviewCacheKey('https://hub.test', '', undefined, url, preview.path, 2), undefined);
  assert.equal(sourcePreviewCacheKey('https://hub.test', '', 'a'.repeat(64), 'https://evil.test/', preview.path, 2), undefined);
});

test('temporary approvals never persist and are revalidated on the next load', async () => {
  const storage = store(), cache = createSourcePreviewCache(() => storage);
  let calls = 0;
  const load = async () => { calls++; return { ...preview, temporaryApproval: true }; };
  await cache.load(key, load);
  assert.equal(cache.peek(key)?.preview?.temporaryApproval, true);
  assert.equal(createSourcePreviewCache(() => storage).peek(key), undefined);
  await cache.load(key, load);
  assert.equal(calls, 2);
  await cache.load(key, async () => { throw Error('Source approval revoked'); });
  assert.equal(cache.peek(key)?.preview, undefined);
});

test('revocation/lock abort pending reads and cannot resurrect cleared source', async () => {
  const storage = store(), cache = createSourcePreviewCache(() => storage);
  let resolve!: (value: typeof preview) => void, signal: AbortSignal | undefined;
  const read = cache.load(key, s => { signal = s; return new Promise(done => { resolve = done; }); });
  await Promise.resolve();
  cache.clear();
  assert.equal(signal?.aborted, true);
  resolve(preview); await read;
  assert.equal(cache.peek(key), undefined);
  assert.equal(createSourcePreviewCache(() => storage).peek(key), undefined);
});

test('storage failure and malformed data degrade to memory, mismatched response is rejected', async () => {
  const cache = createSourcePreviewCache(() => { throw new Error('disabled'); });
  await cache.load(key, async () => preview);
  assert.deepEqual(cache.peek(key)?.preview, preview);
  await cache.load(key, async () => ({ ...preview, path: '/wrong.ts' }), true);
  assert.equal(cache.peek(key)?.preview, undefined);
  const broken = store(); broken.setItem('agentopsdeck.source-previews.v1', '{broken');
  assert.equal(createSourcePreviewCache(() => broken).peek(key), undefined);
});

test('preview storage and memory have bounded entry counts', async () => {
  const storage = store(), cache = createSourcePreviewCache(() => storage);
  for (let i = 0; i < 40; i++) {
    const next = sourcePreviewCacheKey('https://hub.test', '', 'a'.repeat(64), url.replace('/message/', `/message${i}/`), preview.path, 2)!;
    await cache.load(next, async () => preview);
    if (i === 0) assert.ok(cache.peek(next));
  }
  const rows = JSON.parse(storage.getItem('agentopsdeck.source-previews.v1')!);
  assert.equal(rows.length, 32);
  assert.equal(cache.peek(sourcePreviewCacheKey('https://hub.test', '', 'a'.repeat(64), url.replace('/message/', '/message0/'), preview.path, 2)), undefined);
});

test('byte budget evicts large previews and selective invalidation preserves other sessions', async () => {
  const storage = store(), cache = createSourcePreviewCache(() => storage);
  const keys: string[] = [];
  for (let i = 0; i < 12; i++) {
    const next = sourcePreviewCacheKey('https://hub.test', '', 'a'.repeat(64), url.replace('/message/', `/large${i}/`), preview.path, 2)!;
    keys.push(next);
    await cache.load(next, async () => ({ ...preview, text: 'x'.repeat(90_000) + '\nlast' }));
  }
  assert.ok(storage.getItem('agentopsdeck.source-previews.v1')!.length * 2 <= 1024 * 1024);
  assert.ok(keys.filter(key => cache.peek(key)).length < 12);
  cache.clear(key => key === keys.at(-1));
  assert.equal(cache.peek(keys.at(-1)), undefined);
  assert.ok(cache.peek(keys.at(-2))?.preview);
});

test('eviction never blanks mounted previews, but explicit invalidation does', async () => {
  const cache = createSourcePreviewCache(() => store());
  const unsubscribe = cache.subscribe(key, () => {});
  await cache.load(key, async () => preview);
  for (let i = 0; i < 40; i++) {
    const next = sourcePreviewCacheKey('https://hub.test', '', 'a'.repeat(64), url.replace('/message/', `/other${i}/`), preview.path, 2)!;
    await cache.load(next, async () => preview);
  }
  assert.deepEqual(cache.peek(key)?.preview, preview);
  cache.clear();
  assert.equal(cache.peek(key), undefined);
  unsubscribe();
});

function numberedKey(index: number) {
  return sourcePreviewCacheKey('https://hub.test', '', 'a'.repeat(64),
    url.replace('remote%3Aone', `remote%3Apane${index % 2}`).replace('/message/', `/message${index}/`), preview.path, 2)!;
}

test('200 to 2000 mounted previews keep update serialization bounded and release without rereading payloads', async t => {
  const storage = store(), cache = createSourcePreviewCache(() => storage);
  let reads = 0;
  const observed = { ...preview, get text() { reads++; return preview.text; } };
  const releases: (() => void)[] = [];
  const updateReads: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const next = numberedKey(i);
    releases.push(cache.subscribe(next, () => {}));
    await cache.load(next, async () => observed);
    if (i === 199 || i === 1999) {
      reads = 0;
      await cache.load(next, async () => observed, true);
      updateReads.push(reads);
    }
  }
  assert.equal(updateReads[0], updateReads[1], 'per-update payload work must not grow with mounted history');
  // Two changed-entry measurements + 2×32 persisted rows + five validator reads.
  assert.equal(updateReads[1], 71);
  for (let i = 0; i < 2000; i++) assert.equal(cache.peek(numberedKey(i))?.preview, observed);
  const persisted = JSON.parse(storage.getItem('agentopsdeck.source-previews.v1')!) as [string, unknown][];
  assert.deepEqual(persisted.map(([key]) => key), Array.from({ length: 32 }, (_, i) => numberedKey(1968 + i)));
  reads = 0;
  // Release in interleaved-pane order, not the cache insertion order.
  for (const parity of [0, 1]) for (let i = parity; i < releases.length; i += 2) releases[i]!();
  assert.equal(reads, 0, 'pane teardown must not serialize any source payload');
  assert.equal(Array.from({ length: 2000 }, (_, i) => cache.peek(numberedKey(i))).filter(Boolean).length, 32);
  t.diagnostic(JSON.stringify({ mountedPreviews: [200, 2000], refreshPayloadReads: updateReads, releasePayloadReads: reads }));
});

test('exact byte accounting survives replacement, hydration, clear and Unicode escaping', async () => {
  const storage = store(), cache = createSourcePreviewCache(() => storage, () => 1000);
  const text = '中😀"\\\t'.repeat(8000) + '\nlast';
  const keys = Array.from({ length: 8 }, (_, i) => numberedKey(i));
  for (const next of keys) await cache.load(next, async () => ({ ...preview, text }));
  const assertBudget = (subject: ReturnType<typeof createSourcePreviewCache>) => {
    const rows = keys.flatMap(next => { const entry = subject.peek(next); return entry ? [[next, entry]] : []; });
    assert.ok(rows.length > 0 && rows.length < keys.length);
    assert.ok(JSON.stringify(rows).length * 2 <= 1024 * 1024);
    assert.ok(storage.getItem('agentopsdeck.source-previews.v1')!.length * 2 <= 1024 * 1024);
  };
  assertBudget(cache);
  const reloaded = createSourcePreviewCache(() => storage, () => 1000);
  assertBudget(reloaded);
  await reloaded.load(keys[7]!, async () => preview, true);
  reloaded.clear(candidate => candidate === keys[6]);
  await reloaded.load(keys[0]!, async () => ({ ...preview, text }));
  assertBudget(reloaded);
  reloaded.clear();
  for (const next of keys) await reloaded.load(next, async () => preview);
  assert.equal(keys.filter(next => reloaded.peek(next)).length, keys.length, 'no phantom bytes after clear');
});

test('oversized mounted newest preview keeps display but persists no older fallback', async () => {
  const storage = store(), cache = createSourcePreviewCache(() => storage);
  const releaseFirst = cache.subscribe(key, () => {});
  await cache.load(key, async () => preview);
  const next = numberedKey(1), releaseNext = cache.subscribe(next, () => {});
  // Valid <96KiB source can exceed the 1MiB JSON budget through escaping.
  const text = '\u0000'.repeat(90000) + '\nlast';
  await cache.load(next, async () => ({ ...preview, text }));
  assert.equal(cache.peek(next)?.preview?.text, text);
  assert.deepEqual(JSON.parse(storage.getItem('agentopsdeck.source-previews.v1')!), []);
  releaseNext();
  assert.equal(cache.peek(next), undefined);
  assert.deepEqual(cache.peek(key)?.preview, preview);
  releaseFirst();
});

test('shared ownership protects entries until the last release, including resubscription', async () => {
  const cache = createSourcePreviewCache(() => undefined);
  const releases: (() => void)[] = [];
  for (let i = 0; i < 40; i++) {
    releases.push(cache.subscribe(numberedKey(i), () => {}));
    await cache.load(numberedKey(i), async () => preview);
  }
  const shared = cache.subscribe(numberedKey(0), () => {});
  releases[0]!(); releases[0]!();
  assert.ok(cache.peek(numberedKey(0)));
  shared();
  assert.equal(cache.peek(numberedKey(0)), undefined);
  const remounted = cache.subscribe(numberedKey(0), () => {});
  await cache.load(numberedKey(0), async () => preview);
  assert.ok(cache.peek(numberedKey(0)));
  cache.clear(candidate => candidate === numberedKey(0));
  assert.equal(cache.peek(numberedKey(0)), undefined);
  await cache.load(numberedKey(0), async () => preview);
  assert.ok(cache.peek(numberedKey(0)));
  remounted();
  assert.equal(cache.peek(numberedKey(0)), undefined);
  for (const release of releases) release();
});

test('persistence ordering skips expired, temporary and denied entries and handles refreshed middle keys', async () => {
  let now = 1000;
  const storage = store(), cache = createSourcePreviewCache(() => storage, () => now);
  const keys = Array.from({ length: 40 }, (_, i) => numberedKey(i));
  for (const next of keys) cache.subscribe(next, () => {});
  for (const next of keys.slice(0, 5)) await cache.load(next, async () => preview);
  now += 5 * 60000;
  for (const next of keys.slice(5)) await cache.load(next, async () => preview);
  await cache.load(keys[10]!, async () => preview, true);
  await cache.load(keys[39]!, async () => ({ ...preview, temporaryApproval: true }), true);
  await cache.load(keys[38]!, async () => { throw new Error('denied'); }, true);
  cache.clear(candidate => candidate === keys[37] || candidate === keys[7]);
  const rows = JSON.parse(storage.getItem('agentopsdeck.source-previews.v1')!) as [string, unknown][];
  assert.deepEqual(rows.map(([key]) => key), [...keys.slice(5, 37).filter(key => key !== keys[7] && key !== keys[10]), keys[10]]);
  assert.equal(cache.peek(keys[0])?.preview, preview, 'expiry must not blank mounted source');
});

test('incremental persistence matches the previous full-scan contract through mixed refresh and invalidation', async () => {
  let now = 1000000, seed = 42;
  const storage = store(), cache = createSourcePreviewCache(() => storage, () => now);
  const keys = Array.from({ length: 45 }, (_, i) => numberedKey(i));
  for (const key of keys) cache.subscribe(key, () => {});
  const model = new Map<string, NonNullable<ReturnType<typeof cache.peek>>>();
  for (let step = 0; step < 240; step++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const key = keys[seed % keys.length]!;
    if (step % 53 === 0) now += 300000;
    if (step % 79 === 0) now -= 150000; // Wall-clock rollback must not expose a future cache entry.
    if (step % 7 === 0) {
      cache.clear(candidate => candidate === key);
      model.delete(key);
    } else {
      await cache.load(key, async () => {
        if (step % 11 === 0) throw new Error('denied');
        return { ...preview, text: '\u0000'.repeat((step % 4) * 4000) + 'first\nlast',
          ...(step % 13 === 0 ? { temporaryApproval: true } : {}) };
      }, true);
      model.delete(key);
      model.set(key, cache.peek(key)!);
    }
    // Independent reference: original full-scan/filter/suffix/serialize logic.
    const expected = [...model].filter(([, entry]) => entry.preview && !entry.preview.temporaryApproval
      && now >= entry.savedAt && now - entry.savedAt < 300000)
      .slice(-32).map(([key, entry]) => [key, { preview: entry.preview, savedAt: entry.savedAt }]);
    let json = JSON.stringify(expected);
    while (expected.length && json.length * 2 > 1024 * 1024) { expected.shift(); json = JSON.stringify(expected); }
    assert.equal(storage.getItem('agentopsdeck.source-previews.v1'), json, `persisted suffix at step ${step}`);
  }
});
