import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function cacheProbe(body: string) {
  const source = ts.transpileModule(readFileSync(new URL('../../../src/lib/session-cache.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const budget = readFileSync(new URL('./cache-storage-budget.js', import.meta.url), 'utf8');
  const script = `
    import assert from 'node:assert/strict';
    import vm from 'node:vm';
    const data = new Map(), operations = [];
    let scope = 'a'.repeat(64), denied = false;
    const store = {
      get length() { return data.size; }, key: index => [...data.keys()][index] ?? null,
      getItem: key => { operations.push(['get', key]); return data.get(key) ?? null; },
      setItem: (key, value) => { operations.push(['set', key]); if (denied) throw new Error('denied'); data.set(key, value); },
      removeItem: key => { operations.push(['remove', key]); data.delete(key); },
    };
    const context = vm.createContext({ window: { localStorage: store, location: { host: 'fixture.test' } } });
    const clear = () => {}, cache = { clear };
    const exports = {
      '../api': { apiBaseUrl: () => '', recoveryScope: () => scope, invalidateNavigationHistory: clear },
      './message-cache-budget': { fitMessageCache: entry => entry },
      './source-preview-cache': { clearSourcePreviewsForNodes: clear, sourcePreviewCache: cache },
      './session-preview-cache': { sessionPreviewCache: cache },
      './optimistic-messages': { clearOptimisticMessages: clear },
      './cache-cleaners': { registerCacheCleaner: clear, runCacheCleaners: clear },
    };
    const budgetModule = new vm.SourceTextModule(${JSON.stringify(budget)}, { context });
    await budgetModule.link(() => {});
    const module = new vm.SourceTextModule(${JSON.stringify(source)}, { context });
    await module.link(specifier => {
      if (specifier === './cache-storage-budget') return budgetModule;
      const values = exports[specifier]; assert.ok(values, specifier);
      return new vm.SyntheticModule(Object.keys(values), function () {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value);
      }, { context });
    });
    await module.evaluate();
    const api = module.namespace;
    ${body}
  `;
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
}

test('cache availability probe uses only the AOD alias and cleans it without touching foreign storage', () => {
  cacheProbe(`
    data.set('foreign.probe', 'preserve');
    assert.equal(api.readCachedMessages('session'), undefined);
    assert.deepEqual(operations.filter(([kind]) => kind !== 'get'), [
      ['set', '__agentopsdeck_cache_probe__'], ['remove', '__agentopsdeck_cache_probe__'],
    ]);
    assert.equal(data.get('foreign.probe'), 'preserve');
    assert.equal(data.has('__agentopsdeck_cache_probe__'), false);
    assert.equal(operations.some(([, key]) => key === 'foreign.probe'), false);
  `);
});

test('cache probe storage denial remains best effort and does not read cached or foreign values', () => {
  cacheProbe(`
    denied = true; data.set('foreign.cache', 'preserve');
    assert.equal(api.readCachedMessages('session'), undefined);
    api.writeCachedMessages('session', []);
    assert.equal(operations.every(([kind, key]) => kind === 'set' && key === '__agentopsdeck_cache_probe__'), true);
    assert.equal(data.get('foreign.cache'), 'preserve');
    assert.equal(data.has('__agentopsdeck_cache_probe__'), false);
  `);
});

test('cache writes globally evict old scoped histories without migrating them into the new scope', () => {
  cacheProbe(`
    const old = 'agentopsdeck.cache.v2.old.backend.messages.1';
    data.set(old, JSON.stringify({ v: 'v2', sessionKey: 'session', cachedAt: 1, messages: [{ text: 'x'.repeat(2200000) }] }));
    data.set('foreign.cache', 'preserve');
    assert.equal(api.readCachedMessages('session'), undefined);
    api.writeCachedMessages('session', [{ id: 'fresh', role: 'user', sessionKey: 'session', text: 'fresh', createdAt: 2 }]);
    assert.equal(data.has(old), false);
    assert.equal(api.readCachedMessages('session').messages[0].text, 'fresh');
    scope = 'b'.repeat(64); assert.equal(api.readCachedMessages('session'), undefined);
    assert.equal(data.get('foreign.cache'), 'preserve');
  `);
});

test('cache logout cleanup preserves drafts, command journals and foreign namespaces', () => {
  cacheProbe(`
    for (const key of ['foreign.cache', 'agentopsdeck.draft', 'agentopsdeck.command-recovery.v1']) data.set(key, 'preserve');
    data.set('agentopsdeck.cache.v2.old.backend.messages.1', 'disposable');
    api.clearAllCachedData();
    assert.deepEqual([...data.keys()], ['foreign.cache', 'agentopsdeck.draft', 'agentopsdeck.command-recovery.v1']);
    assert.equal(data.has('__agentopsdeck_cache_probe__'), false);
  `);
});
