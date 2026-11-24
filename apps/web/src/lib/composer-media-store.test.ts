import assert from 'node:assert/strict';
import test from 'node:test';
import { createComposerMediaStore } from './composer-media-store.js';
import type { SendMessageUpload } from '@agentopsdeck/shared';

const image = (name: string): SendMessageUpload => ({ type: 'image', name, mimeType: 'image/png', dataUrl: 'data:image/png;base64,YQ==', size: 1 });

test('concurrent composers keep independent drafts across same-account activation/remount', () => {
  const store = createComposerMediaStore(); store.activate('a');
  const one = [image('one')], two = [image('two')];
  store.update('a', 'one', one); store.activate('a'); store.update('a', 'two', two);
  assert.equal(store.read('a', 'one'), one); assert.equal(store.read('a', 'two'), two);
  store.update('a', 'two', []); assert.equal(store.read('a', 'one'), one);
  assert.equal(store.read('a', 'none'), store.read('a', 'two'), 'empty snapshots are stable');
});

test('updaters append against the latest draft and validation failures are atomic', () => {
  const store = createComposerMediaStore(); store.activate('a');
  store.update('a', 'one', items => [...items, image('first')]);
  store.update('a', 'one', items => [...items, image('second')]);
  const before = store.read('a', 'one');
  assert.throws(() => store.update('a', 'one', () => { throw new Error('Max attachments'); }));
  assert.equal(store.read('a', 'one'), before);
  assert.deepEqual(before.map(item => item.name), ['first', 'second']);
});

test('account switch/auth loss discard drafts and reject late writes', () => {
  const store = createComposerMediaStore(); store.activate('a'); store.update('a', 'one', [image('private')]);
  store.activate('b'); store.update('a', 'one', [image('late')]);
  assert.deepEqual(store.read('a', 'one'), []); assert.deepEqual(store.read('b', 'one'), []);
  store.update('b', 'one', [image('b')]); store.clear(); store.update('b', 'one', [image('late')]);
  store.activate('b'); assert.deepEqual(store.read('b', 'one'), []);
});

test('global byte budget rejects new drafts without eviction and is reclaimed on remove', () => {
  const media = [image('one')], store = createComposerMediaStore(media[0]!.dataUrl.length * 2);
  store.activate('a'); store.update('a', 'one', media);
  assert.throws(() => store.update('a', 'two', media), /too much memory/);
  assert.equal(store.read('a', 'one'), media); assert.deepEqual(store.read('a', 'two'), []);
  store.update('a', 'one', []); store.update('a', 'two', media);
  assert.equal(store.read('a', 'two'), media);
});

test('preflight-rejected sends can restore existing files without losing another pane draft', () => {
  const media = [image('one')], store = createComposerMediaStore(media[0]!.dataUrl.length * 2);
  store.activate('a'); store.update('a', 'one', media); store.update('a', 'one', []);
  store.update('a', 'two', media); store.update('a', 'one', media, true);
  assert.equal(store.read('a', 'one'), media); assert.equal(store.read('a', 'two'), media);
  assert.throws(() => store.update('a', 'three', media), /too much memory/);
  store.update('a', 'three', media, true);
  store.update('a', 'one', []);
  assert.deepEqual(store.read('a', 'one'), [], 'removal works even while remaining drafts exceed the budget');
});
