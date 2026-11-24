// Slow-network hydration timeline proof for COD-055.
//
// Simulates what the web app does on refresh under an authenticated recoveryScope:
//   1. select a session -> seed message state from local cache (synchronous)
//   2. kick off a deliberately slow api.sessionMessages() fetch
//   3. observe the render timeline
//
// It proves the stale-while-revalidate contract: cached messages are present at
// t=0 (first paint, NOT empty/loading-only), and server truth swaps in later.
// It also proves the mobile "land at bottom" precondition: a non-empty cached
// list exists on first render, so settleScrollToBottom() has something to anchor.
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
}

const storageMock = new MemoryStorage();
const windowTarget = new EventTarget();
(globalThis as any).window = Object.assign(windowTarget, {
  localStorage: storageMock,
  sessionStorage: new MemoryStorage(),
  location: { host: 'deck.example', hostname: 'deck.example', protocol: 'https:', origin: 'https://deck.example', href: 'https://deck.example/' },
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
});
storageMock.setItem('agentopsdeck.apiBaseUrl', 'https://backend-a.example');

const api = await import('../apps/web/src/api.ts');
const cache = await import('../apps/web/src/lib/session-cache.ts');

const SCOPE_A = 'a'.repeat(64);
api.setRecoveryScope(SCOPE_A);

type Msg = { id: string; sessionKey: string; role: 'user' | 'assistant'; text: string; createdAt: number };

// --- Pre-populate cache as if the user had this chat open before refreshing ---
const sessionKey = 'agent:ops-pm:web:abc';
const cachedMessages: Msg[] = [
  { id: 'c1', sessionKey, role: 'user', text: 'old question', createdAt: 1 },
  { id: 'c2', sessionKey, role: 'assistant', text: 'old answer', createdAt: 2 },
];
cache.writeCachedMessages(sessionKey, cachedMessages, { hiddenCount: 0, updatedAt: 2 });

// --- Mirror main.tsx messageStateForSession() exactly ---
function messageStateForSession(key: string) {
  const c = cache.readCachedMessages(key);
  if (c && c.messages.length > 0) return { sessionKey: key, items: c.messages, loading: true, hiddenCount: c.hiddenCount };
  return { sessionKey: key, items: [], loading: true };
}

// Unauthenticated state must fail closed (no cache read before recoveryScope is established)
api.setRecoveryScope(undefined);
assert.equal(messageStateForSession(sessionKey).items.length, 0, 'unauthenticated first paint must not read scoped cache');
api.setRecoveryScope(SCOPE_A);

// --- Slow network: server returns the same chat + one NEW message after delay ---
function slowSessionMessages(key: string, delayMs: number) {
  const serverMessages: Msg[] = [
    ...cachedMessages,
    { id: 's3', sessionKey: key, role: 'assistant', text: 'fresh server reply', createdAt: 3 },
  ];
  return new Promise<{ messages: Msg[]; hiddenCount: number; updatedAt: number }>((resolve) => {
    setTimeout(() => resolve({ messages: serverMessages, hiddenCount: 0, updatedAt: 3 }), delayMs);
  });
}

const timeline: Array<{ t: number; phase: string; rendered: number; loading: boolean; lastText: string }> = [];
const start = Date.now();
function record(phase: string, state: { items: Msg[]; loading: boolean }) {
  timeline.push({
    t: Date.now() - start,
    phase,
    rendered: state.items.length,
    loading: state.loading,
    lastText: state.items.at(-1)?.text ?? '(none)',
  });
}

// t=0: select session (refresh just happened) -> seed from cache
let state = messageStateForSession(sessionKey);
record('first-paint (from cache)', state);

// Background revalidate (240ms slow network simulation)
const fetchPromise = slowSessionMessages(sessionKey, 240).then((data) => {
  cache.writeCachedMessages(sessionKey, data.messages, { hiddenCount: data.hiddenCount, updatedAt: data.updatedAt });
  state = { sessionKey, items: data.messages, loading: false, hiddenCount: data.hiddenCount } as any;
  record('after server revalidate', state);
});

// Sample what the user sees at 40ms and 120ms (still loading, but NOT empty)
await new Promise((r) => setTimeout(r, 40));
record('t+40ms (network pending)', state);
await new Promise((r) => setTimeout(r, 80));
record('t+120ms (network pending)', state);

await fetchPromise;

console.log('HYDRATION TIMELINE:');
for (const row of timeline) {
  console.log(`  t=${String(row.t).padStart(4)}ms | ${row.phase.padEnd(28)} | rendered=${row.rendered} loading=${row.loading} last="${row.lastText}"`);
}

// --- Assertions: the SWR contract ---
const firstPaint = timeline[0]!;
assert.equal(firstPaint.rendered, 2, 'first paint must show cached messages, not empty');
assert.equal(firstPaint.lastText, 'old answer', 'first paint shows cached content');

const pendingSample = timeline.find((r) => r.phase.startsWith('t+40ms'))!;
assert.ok(pendingSample.rendered >= 2, 'while network pending, cached messages stay visible (no empty flash)');

const afterServer = timeline.find((r) => r.phase.startsWith('after server'))!;
assert.equal(afterServer.rendered, 3, 'server revalidate adds the new message');
assert.equal(afterServer.lastText, 'fresh server reply', 'server truth swapped in');
assert.equal(afterServer.loading, false, 'loading cleared after revalidate');

// Mobile bottom-restore precondition: non-empty list on first paint means
// settleScrollToBottom() anchors to the newest cached message immediately.
assert.ok(firstPaint.rendered > 0, 'mobile reload has a non-empty list to scroll to bottom');

console.log('\nPASS: stale-while-revalidate timeline verified (cache@t0 -> server later)');
console.log('PASS: mobile bottom-restore precondition (non-empty first paint)');
