import assert from 'node:assert/strict';
import test from 'node:test';
import { createOnceVisibleObserver } from './observe-once.js';

function fixture() {
  const instances: FakeObserver[] = [];
  class FakeObserver {
    targets = new Set<Element>();
    disconnected = false;
    constructor(readonly callback: IntersectionObserverCallback, readonly options: IntersectionObserverInit) { instances.push(this); }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.disconnected = true; this.targets.clear(); }
    notify(target: Element, isIntersecting = true) { this.callback([{ target, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
  }
  return { instances, observe: createOnceVisibleObserver(() => FakeObserver as unknown as typeof IntersectionObserver) };
}

test('1200 cards share one observer, preserve the preload margin and fire once', () => {
  const { observe, instances } = fixture();
  const targets = Array.from({ length: 1200 }, () => ({} as Element));
  let calls = 0;
  const cleanups = targets.map(target => observe(target, () => calls++));
  assert.equal(instances.length, 1);
  assert.equal(instances[0]!.options.rootMargin, '120px');
  instances[0]!.notify(targets[0]!, false);
  assert.equal(calls, 0);
  for (const target of targets) { instances[0]!.notify(target); instances[0]!.notify(target); }
  assert.equal(calls, 1200);
  assert.equal(instances[0]!.disconnected, true);
  cleanups.forEach(cleanup => cleanup());
});

test('unmount and strict remount discard old ownership, not new subscriptions', () => {
  const { observe, instances } = fixture(), target = {} as Element;
  let calls = 0;
  const first = observe(target, () => calls++);
  first(); first();
  const second = observe(target, () => calls++);
  first();
  assert.equal(instances.length, 2);
  instances[0]!.notify(target); // A late callback from a disconnected observer.
  assert.equal(calls, 0);
  instances[1]!.notify(target);
  assert.equal(calls, 1);
  second();
});

test('multiple subscribers on the same element have independent cleanup', () => {
  const { observe, instances } = fixture(), target = {} as Element;
  let calls = 0;
  const callback = () => calls++;
  const first = observe(target, callback), second = observe(target, callback);
  first();
  assert.equal(instances[0]!.targets.size, 1);
  instances[0]!.notify(target);
  assert.equal(calls, 1);
  second();
});

test('browsers without IntersectionObserver still expose preview functionality', () => {
  let calls = 0;
  const stop = createOnceVisibleObserver(() => undefined)({} as Element, () => calls++);
  assert.equal(calls, 1);
  stop();
});
