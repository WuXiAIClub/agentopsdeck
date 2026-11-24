import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreviewRetention, PREVIEW_RETENTION_DELAY_MS as delay } from './preview-retention.js';

function fixture() {
  let time = 0, serial = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const protectedTargets = new Set<string>();
  const changes: [string, boolean][] = [];
  const retention = createPreviewRetention<string>({ now: () => time, protectedTarget: key => protectedTargets.has(key),
    schedule: ((run: () => void, ms: number) => { const id = ++serial; timers.set(id, { at: time + ms, run }); return id; }) as unknown as typeof setTimeout,
    cancel: ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout,
  });
  const register = (key: string) => retention.register(key, compact => changes.push([key, compact]));
  const advance = (ms: number) => {
    const end = time + ms;
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      time = next[1].at; timers.delete(next[0]); next[1].run();
    }
    time = end;
  };
  return { retention, register, advance, changes, timers, protectedTargets };
}

test('offscreen details expire after a grace period and restore immediately near the viewport', () => {
  const f = fixture(); f.register('a');
  f.retention.update([['a', false]]); f.advance(delay - 1);
  assert.deepEqual(f.changes, []);
  f.advance(1); assert.deepEqual(f.changes, [['a', true]]);
  f.retention.update([['a', true]]);
  assert.deepEqual(f.changes, [['a', true], ['a', false]]);
  assert.equal(f.timers.size, 0);
});

test('fast scroll out and back never compacts; repeated observer reports do not extend expiry', () => {
  const f = fixture(); f.register('a');
  f.retention.update([['a', false]]); f.advance(100);
  f.retention.update([['a', true]]); f.advance(delay);
  assert.deepEqual(f.changes, []);
  f.retention.update([['a', false]]); f.advance(100);
  f.retention.update([['a', false]]); f.advance(delay - 100);
  assert.deepEqual(f.changes, [['a', true]]);
});

test('selection or focus holds rendering without a retry timer; release reconsiders it', () => {
  const f = fixture(); f.register('a'); f.protectedTargets.add('a');
  f.retention.update([['a', false]]); f.advance(delay * 10);
  assert.deepEqual(f.changes, []); assert.equal(f.timers.size, 0);
  f.protectedTargets.delete('a'); f.retention.flush();
  assert.deepEqual(f.changes, [['a', true]]);
  f.protectedTargets.add('a'); f.retention.update([['a', true]]);
  assert.deepEqual(f.changes, [['a', true]], 'selected compact text must not be replaced');
  f.protectedTargets.delete('a'); f.retention.flush();
  assert.deepEqual(f.changes, [['a', true], ['a', false]]);
});

test('two thousand previews share one timer; disposed ownership cannot receive callbacks', () => {
  const f = fixture();
  const dispose = Array.from({ length: 2000 }, (_, i) => f.register(String(i)));
  f.retention.update(Array.from({ length: 2000 }, (_, i) => [String(i), false] as const));
  assert.equal(f.timers.size, 1);
  dispose[0]!(); f.advance(delay);
  assert.equal(f.changes.length, 1999);
  assert.ok(!f.changes.some(([key]) => key === '0'));
  f.retention.dispose(); assert.equal(f.timers.size, 0);
  f.retention.update([['0', true]]); assert.equal(f.changes.length, 1999);
});

test('last unsubscribe cancels pending work; stale cleanup cannot delete replacement ownership', () => {
  const f = fixture(); const old = f.register('a');
  const current = f.register('a'); old();
  f.retention.update([['a', false]]); assert.equal(f.timers.size, 1);
  current(); assert.equal(f.timers.size, 0);
  f.advance(delay); assert.deepEqual(f.changes, []);
});

test('scroll surfaces have independent retention and cleanup', () => {
  const a = fixture(), b = fixture(); a.register('same'); b.register('same');
  a.retention.update([['same', false]]); b.retention.update([['same', false]]);
  a.retention.dispose(); b.advance(delay);
  assert.deepEqual(a.changes, []); assert.deepEqual(b.changes, [['same', true]]);
});
