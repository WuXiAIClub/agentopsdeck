export function createCacheStorage(initial, send, schedule = setTimeout, cancel = clearTimeout, notify = () => {}) {
  const entries = new Map(Object.entries(initial));
  const changes = new Map();
  const reads = new Map();
  const requests = new Map();
  const versions = new Map();
  let sequence = 0;
  let epoch = 0;
  let scope;
  let timer;
  let writing = false;
  let memoryBytes = [...entries.values()].reduce((total, value) => total + (value?.length ?? 0) * 2, 0);
  function trim() {
    for (const [key, value] of entries) {
      if (entries.size <= 64 && memoryBytes <= 12 * 1024 * 1024) break;
      if (changes.has(key) || key.endsWith('.sessions')) continue;
      entries.delete(key); memoryBytes -= (value?.length ?? 0) * 2;
    }
  }
  function remember(key, value) {
    memoryBytes -= (entries.get(key)?.length ?? 0) * 2;
    entries.delete(key); entries.set(key, value);
    memoryBytes += (value?.length ?? 0) * 2;
    trim();
  }
  const metrics = { hits: 0, misses: 0, reads: 0, writes: 0, retries: 0, readMs: 0 };
  function request(type, payload = {}) {
    const id = String(++sequence);
    return new Promise((resolve, reject) => {
      const timeout = schedule(() => { requests.delete(id); reject(new Error('Native cache timeout')); }, 5000);
      requests.set(id, { resolve, reject, timeout });
      try { send({ type, id, scope, ...payload }); }
      catch (error) { cancel(timeout); requests.delete(id); reject(error); }
    });
  }
  function receive(packet) {
    const pending = requests.get(packet.id);
    if (!pending) return;
    requests.delete(packet.id);
    cancel(pending.timeout);
    if (packet.error) pending.reject(new Error(packet.error));
    else pending.resolve(packet);
  }
  function later(delay = 150) {
    if (timer !== undefined) cancel(timer);
    timer = schedule(() => { timer = undefined; flush(); }, delay);
  }
  async function flush() {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    if (writing || !changes.size) return;
    const batch = [];
    let batchSize = 0;
    for (const [key, value] of changes) {
      const size = key.length + (value?.length ?? 0);
      if (batch.length && (batch.length >= 16 || batchSize + size > 8 * 1024 * 1024)) break;
      batch.push({ key, value, version: versions.get(key) }); batchSize += size;
    }
    const startedEpoch = epoch;
    writing = true;
    let failed = false;
    try {
      await request('cache.write', { changes: batch.map(({ key, value }) => ({ key, value })) });
      metrics.writes++;
      if (startedEpoch === epoch) for (const { key, version } of batch) {
        if (versions.get(key) === version) changes.delete(key);
      }
    } catch { failed = true; metrics.retries++; }
    finally {
      writing = false;
      trim();
      if (changes.size) later(failed ? 2000 : 0);
    }
  }
  async function load(key) {
    if (entries.has(key)) { metrics.hits++; return entries.get(key); }
    if (reads.has(key)) return reads.get(key);
    const startedEpoch = epoch, version = versions.get(key), started = Date.now();
    metrics.misses++;
    const pending = request('cache.get', { key }).then(packet => {
      metrics.reads++; metrics.readMs += Date.now() - started;
      if (startedEpoch !== epoch || versions.get(key) !== version) return entries.get(key) ?? null;
      const value = typeof packet.value === 'string' ? packet.value : null;
      remember(key, value);
      if (value !== null) notify(key);
      return value;
    }).catch(() => null).finally(() => { if (reads.get(key) === pending) reads.delete(key); });
    reads.set(key, pending);
    return pending;
  }
  function persist(key, value) {
    if (!key.startsWith('agentopsdeck.cache.')) return;
    versions.set(key, (versions.get(key) ?? 0) + 1);
    changes.set(key, value);
    if (timer === undefined) later();
  }
  function reset() {
    epoch++;
    entries.clear(); changes.clear(); reads.clear(); versions.clear();
    memoryBytes = 0;
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  }
  const cache = {
    get scope() { return scope; },
    get length() { return [...entries.values()].filter(value => value !== null).length; },
    key(index) { return [...entries].filter(([, value]) => value !== null)[index]?.[0] ?? null; },
    getItem(key) {
      key = String(key);
      if (entries.has(key)) { metrics.hits++; const value = entries.get(key); entries.delete(key); entries.set(key, value); }
      if (!entries.has(key) && key.startsWith('agentopsdeck.cache.') && scope) void load(key);
      return entries.get(key) ?? null;
    },
    setItem(key, value) {
      key = String(key); value = String(value);
      if (value.length > 4 * 1024 * 1024 || key.length > 2048) throw new DOMException('Cache entry exceeds limit', 'QuotaExceededError');
      if (entries.get(key) === value) return;
      persist(key, value);
      remember(key, value);
    },
    removeItem(key) { key = String(key); persist(key, null); remember(key, null); },
    clear() { reset(); return request('cache.clear').catch(() => {}); },
    setScope(next) {
      next = typeof next === 'string' && /^[a-f0-9]{64}$/.test(next) ? next : undefined;
      if (scope === next) return;
      reset(); scope = next;
      send({ type: 'cache.scope', scope: next ?? null });
      if (scope) void load(`agentopsdeck.cache.v2.${scope}.android.sessions`);
    },
    async history(scopeKey, path) {
      if (!scopeKey || scopeKey !== scope) return undefined;
      const raw = await load(historyKey(scopeKey, path));
      if (scope !== scopeKey || !raw) return undefined;
      try {
        const entry = JSON.parse(raw);
        return entry.path === path && Array.isArray(entry.page?.messages) ? entry : undefined;
      } catch { return undefined; }
    },
    saveHistory(scopeKey, path, etag, page) {
      if (!scopeKey || scopeKey !== scope || !/^W\/"history-[a-f0-9]{64}"$/.test(etag ?? '') || !Array.isArray(page?.messages)) return;
      try { cache.setItem(historyKey(scopeKey, path), JSON.stringify({ path, etag, page })); } catch {}
    },
    removeHistory(scopeKey, path) { if (scopeKey && scopeKey === scope) cache.removeItem(historyKey(scopeKey, path)); },
    receive, flush, load, metrics,
  };
  return cache;
}

function historyKey(scope, path) { return `agentopsdeck.cache.transport.${scope}.${encodeURIComponent(path)}`; }
