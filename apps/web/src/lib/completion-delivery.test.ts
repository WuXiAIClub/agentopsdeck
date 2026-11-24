import assert from 'node:assert/strict';
import test from 'node:test';
import { completionHistoryCurrent, createCompletionDelivery } from './completion-delivery.js';
import { sharedSessionRoute } from './session-address.js';

const cursor = (seq: number, epoch = '11111111-1111-4111-8111-111111111111') => `ce1_${epoch}:${seq}`;
test('shared, directory and invalid routes suppress owner completion reads and notifications', async () => {
  for (const shared of ['#/shared', '#/session/' + encodeURIComponent(JSON.stringify(['shared-session-v1', 'other', 'same:session'])), '#/session/%']) {
    let hash = '#/tab/sessions', reads = 0;
    const notifications: string[] = [];
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const d = createCompletionDelivery<string>({ scope: () => 'account',
      enabled: () => sharedSessionRoute(hash).kind === 'owner',
      read: async () => { reads++; return {}; }, settle: async () => {}, deliver: n => notifications.push(n) });
    d.enqueue('owner', 'waiting', undefined);
    const flight = d.flush('owner', [barrier]); hash = shared; release(); await flight;
    d.enqueue('owner', 'shared-event', undefined); await d.flush('owner', []);
    assert.equal(reads, 0); assert.deepEqual(notifications, []);
    hash = '#/tab/sessions'; await d.flush('owner', []);
    assert.equal(reads, 0); // Suppressed intent must not revive on return.
    d.enqueue('owner', 'new-owner-event', undefined); await d.flush('owner', []);
    assert.equal(reads, 1); assert.deepEqual(notifications, ['new-owner-event']);
  }
});
test('navigation during a completion read or render suppresses its late delivery', async () => {
  for (const phase of ['read', 'settle']) {
    let enabled = true, release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const notifications: string[] = [];
    const wait = async () => { entered(); await barrier; };
    const d = createCompletionDelivery<string>({ scope: () => 'account', enabled: () => enabled,
      read: async () => { if (phase === 'read') await wait(); return {}; },
      settle: async () => { if (phase === 'settle') await wait(); }, deliver: n => notifications.push(n) });
    d.enqueue('owner', 'late-owner', undefined); const flight = d.flush('owner', []);
    await waiting; enabled = false; release(); await flight;
    enabled = true; await d.flush('owner', []); assert.deepEqual(notifications, []);
  }
});
test('notification proof rejects missing, stale, foreign and malformed cursors', () => {
  assert.equal(completionHistoryCurrent(undefined, undefined), true);
  for (const page of [undefined, cursor(9), cursor(10, 'foreign'), 'invalid'])
    assert.equal(completionHistoryCurrent(cursor(10), page), false);
  assert.equal(completionHistoryCurrent(cursor(10), cursor(10)), true);
  assert.equal(completionHistoryCurrent(cursor(10), cursor(11)), true);
});
test('completion waits for mounted messages and metadata, fresh GET and render before notifying once', async () => {
  let unblock!: () => void, settle!: () => void, reads = 0;
  const mounted = new Promise<void>(resolve => { unblock = resolve; });
  const rendered = new Promise<void>(resolve => { settle = resolve; });
  const notifications: string[] = [];
  const d = createCompletionDelivery<string>({ scope: () => 'account',
    read: async () => { reads++; return { sourceCursor: cursor(10) }; },
    settle: () => rendered, deliver: n => notifications.push(n) });
  d.enqueue('session', 'done', cursor(10)); const delivery = d.flush('session', [mounted]);
  await Promise.resolve(); assert.equal(reads, 0); assert.deepEqual(notifications, []);
  unblock(); for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(reads, 1); assert.deepEqual(notifications, []);
  settle(); await delivery; await d.flush('session', []); assert.deepEqual(notifications, ['done']);
});
test('lagging projection and GET errors retain pending completion, scope changes and successors cancel it', async () => {
  let scope = 'account', seq = 9, failed = false;
  const notifications: string[] = [];
  const d = createCompletionDelivery<string>({ scope: () => scope,
    read: async () => { if (failed) throw Error('offline'); return { sourceCursor: cursor(seq) }; },
    settle: async () => {}, deliver: n => notifications.push(n) });
  d.enqueue('s', 'old', cursor(10)); await d.flush('s', []); assert.deepEqual(notifications, []);
  failed = true; await d.flush('s', []); assert.deepEqual(notifications, []);
  failed = false; seq = 10; await d.flush('s', []); assert.deepEqual(notifications, ['old']);
  d.enqueue('s', 'wrong-account', cursor(10)); scope = 'other'; await d.flush('s', []);
  d.enqueue('s', 'superseded', cursor(10)); d.clear('s'); await d.flush('s', []);
  assert.deepEqual(notifications, ['old']);
});
test('fresh global history cannot announce before the mounted view applies it; ordinary success resumes delivery', async () => {
  let ready = false;
  const notifications: string[] = [];
  const d = createCompletionDelivery<string>({ scope: () => 'account',
    read: async () => ({ sourceCursor: cursor(10) }), settle: async () => {},
    ready: () => ready, deliver: n => notifications.push(n) });
  d.enqueue('s', 'done', cursor(10)); await d.flush('s', []);
  assert.deepEqual(notifications, []);
  ready = true; d.flushAll(); await d.flush('s', []);
  assert.deepEqual(notifications, ['done']);
});
