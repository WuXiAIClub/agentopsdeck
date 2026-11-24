// Standalone verification harness for apps/web/src/lib/session-cache.ts
// Exercises the current SWR cache contract:
// - recoveryScope-gated read/write (unauthenticated no-op + cross-scope isolation)
// - MAX_MESSAGES_PER_SESSION = 200 per-session message cap + byte budget
// - backend + origin namespace isolation
// - LRU 40-session cap and secret exclusion
//
// Build+run via esbuild bundle (see scripts/run-cache-proofs.sh).

import assert from 'node:assert/strict';

class MemoryStorage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
  dump() { return Object.fromEntries(this.map); }
}

const storageMock = new MemoryStorage();
let hostValue = 'deck.example';

const windowTarget = new EventTarget();
(globalThis as any).window = Object.assign(windowTarget, {
  localStorage: storageMock,
  sessionStorage: new MemoryStorage(),
  location: {
    get host() { return hostValue; },
    get hostname() { return hostValue.split(':')[0] ?? hostValue; },
    protocol: 'https:',
    get origin() { return `https://${hostValue}`; },
    get href() { return `https://${hostValue}/`; },
  },
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
});

const API_BASE_URL_STORAGE = 'agentopsdeck.apiBaseUrl';
function setBackend(url: string) {
  if (url) storageMock.setItem(API_BASE_URL_STORAGE, url);
  else storageMock.removeItem(API_BASE_URL_STORAGE);
}

const api = await import('../apps/web/src/api.ts');
const cache = await import('../apps/web/src/lib/session-cache.ts');

const SCOPE_A = 'a'.repeat(64);
const SCOPE_B = 'b'.repeat(64);

function makeMessages(n: number, prefix = 'm') {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`,
    sessionKey: 'sess-1',
    role: 'user' as const,
    text: `message ${i}`,
    createdAt: 1000 + i,
  }));
}

// 0) Unauthenticated fail-closed contract (undefined recoveryScope -> no-op)
setBackend('https://backend-a.example');
api.setRecoveryScope(undefined);
cache.writeCachedMessages('sess-unauth', makeMessages(3, 'U'));
assert.equal(cache.readCachedMessages('sess-unauth'), undefined, 'unauthenticated write/read must be a no-op');
cache.writeCachedSessionsState({
  groups: [{ agentId: 'ops-pm', sessions: [{ sessionKey: 's1', title: 'T', status: 'idle' as const }] }],
  updatedAt: 1,
} as any);
assert.equal(cache.readCachedSessionsState(), undefined, 'unauthenticated sessions state must be a no-op');
console.log('PASS: unauthenticated recoveryScope fail-closed');

// 1) Authenticated round-trip messages + cross-recoveryScope isolation
api.setRecoveryScope(SCOPE_A);
cache.writeCachedMessages('sess-1', makeMessages(5), { hiddenCount: 2, updatedAt: 42 });
const r1 = cache.readCachedMessages('sess-1');
assert.ok(r1, 'should read back cached messages under SCOPE_A');
assert.equal(r1!.messages.length, 5);
assert.equal(r1!.hiddenCount, 2);

api.setRecoveryScope(SCOPE_B);
assert.equal(cache.readCachedMessages('sess-1'), undefined, 'SCOPE_B must not see SCOPE_A cached messages');
api.setRecoveryScope(SCOPE_A);
assert.equal(cache.readCachedMessages('sess-1')?.messages.length, 5, 'SCOPE_A retains its own cached messages');
console.log('PASS: messages round-trip + recoveryScope isolation');

// 2) Per-session cap (MAX_MESSAGES_PER_SESSION = 200): writing 300 keeps last 200 (big-100..big-299)
cache.writeCachedMessages('sess-1', makeMessages(300, 'big'));
const r2 = cache.readCachedMessages('sess-1');
assert.equal(r2!.messages.length, 200, 'per-session cap should bound to 200');
assert.equal(r2!.messages.at(-1)!.id, 'big-299', 'should keep newest tail');
assert.equal(r2!.messages[0]!.id, 'big-100', 'should drop oldest beyond 200-item cap');
console.log('PASS: per-session 200-message cap + newest-tail retained');

// 2b) Oversized single entry byte-budget guard (> 1.5MB UTF-16 budget trims/evicts safely)
cache.writeCachedMessages('sess-oversize', [
  {
    id: 'huge-0',
    sessionKey: 'sess-oversize',
    role: 'assistant' as const,
    text: 'x'.repeat(900_000),
    createdAt: 2000,
  },
]);
assert.equal(cache.readCachedMessages('sess-oversize'), undefined, 'single message exceeding entry byte budget must not persist');
console.log('PASS: per-entry byte budget enforced');

// 3) Namespace isolation across backends
setBackend('https://backend-a.example');
cache.writeCachedMessages('shared-key', makeMessages(3, 'A'));
setBackend('https://backend-b.example');
const crossBackend = cache.readCachedMessages('shared-key');
assert.equal(crossBackend, undefined, 'different backend must not see other backend cache');
cache.writeCachedMessages('shared-key', makeMessages(4, 'B'));
setBackend('https://backend-a.example');
const backA = cache.readCachedMessages('shared-key');
assert.equal(backA!.messages.length, 3, 'backend A keeps its own cache');
assert.equal(backA!.messages[0]!.id, 'A-0');
console.log('PASS: backend namespace isolation');

// 4) Origin isolation
setBackend('https://backend-a.example');
hostValue = 'deck.example';
cache.writeCachedMessages('origin-key', makeMessages(2, 'O1'));
hostValue = 'other-deck.example';
const crossOrigin = cache.readCachedMessages('origin-key');
assert.equal(crossOrigin, undefined, 'different origin must not see cache');
hostValue = 'deck.example';
console.log('PASS: origin namespace isolation');

// 5) Sessions list round-trip
const sessionsState = {
  groups: [{ agentId: 'ops-pm', sessions: [{ sessionKey: 's1', title: 'T', status: 'idle' as const }] }],
  updatedAt: 123,
};
cache.writeCachedSessionsState(sessionsState as any);
const rs = cache.readCachedSessionsState();
assert.ok(rs, 'sessions state should round-trip');
assert.equal(rs!.groups[0]!.sessions[0]!.sessionKey, 's1');
console.log('PASS: sessions-state round-trip');

// 6) No secret leakage: cache must never contain access key/token strings
storageMock.setItem('agentopsdeck.accessKey', 'SUPER_SECRET_KEY_123');
for (const [k, v] of Object.entries(storageMock.dump())) {
  if (k.startsWith('agentopsdeck.cache.')) {
    assert.ok(!v.includes('SUPER_SECRET_KEY_123'), `cache entry ${k} must not contain secret`);
    assert.ok(!k.includes('SUPER_SECRET_KEY_123'), `cache key ${k} must not contain secret`);
  }
}
console.log('PASS: no access key/secret in cache entries');

// 7) clearCachedMessages only drops the target session
setBackend('https://backend-a.example');
cache.writeCachedMessages('keep-1', makeMessages(2, 'K'));
cache.writeCachedMessages('drop-1', makeMessages(2, 'D'));
cache.clearCachedMessages('drop-1');
assert.equal(cache.readCachedMessages('drop-1'), undefined, 'dropped session gone');
assert.ok(cache.readCachedMessages('keep-1'), 'other session retained');
console.log('PASS: targeted clearCachedMessages');

// 8) LRU session cap (40): write 50 distinct sessions, only <= 40 newest remain
storageMock.clear();
setBackend('https://backend-a.example');
api.setRecoveryScope(SCOPE_A);
for (let i = 0; i < 50; i += 1) {
  cache.writeCachedMessages(`lru-${i}`, makeMessages(2, `L${i}`));
}
let surviving = 0;
for (let i = 0; i < 50; i += 1) {
  if (cache.readCachedMessages(`lru-${i}`)) surviving += 1;
}
assert.ok(surviving <= 40, `LRU should cap cached sessions at 40 (got ${surviving})`);
assert.ok(cache.readCachedMessages('lru-49'), 'newest session must survive LRU');
assert.equal(cache.readCachedMessages('lru-0'), undefined, 'oldest session evicted by LRU');
console.log(`PASS: LRU session cap enforced (${surviving} survivors <= 40)`);

// 9) clearAllCachedData wipes everything namespaced
cache.clearAllCachedData();
assert.equal(cache.readCachedMessages('lru-49'), undefined, 'clearAll wipes cache');
assert.equal(cache.readCachedSessionsState(), undefined, 'clearAll wipes sessions');
console.log('PASS: clearAllCachedData wipes all cache namespaces');

console.log('\nALL CACHE VERIFICATION CHECKS PASSED');
