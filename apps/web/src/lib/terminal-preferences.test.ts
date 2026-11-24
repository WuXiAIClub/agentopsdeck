import assert from 'node:assert/strict';
import test from 'node:test';
import { readTerminalPreference, saveTerminalPreference, takeTerminalResume } from './terminal-preferences.js';

const preference = { connection: 'connector', target: 'shell', reconnect: true, resume: true };
function store() { const data = new Map<string, string>(); return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } }; }
test('terminal configuration is separated by account and card, with no commands or PTY IDs', () => {
  const storage = store();
  saveTerminalPreference(storage, 'account', 'card', { ...preference, command: 'secret', id: 'pty' } as typeof preference);
  assert.deepEqual(readTerminalPreference(storage, 'account', 'card'), preference);
  assert.equal(readTerminalPreference(storage, 'other', 'card'), undefined);
  assert.equal(readTerminalPreference(storage, 'account', 'other'), undefined);
  assert.ok(!JSON.stringify([...storage.data]).includes('secret'));
  assert.ok(!JSON.stringify([...storage.data]).includes('pty'));
});
test('refresh resume is consumed once, normal navigation never starts a shell', () => {
  const storage = store();
  saveTerminalPreference(storage, 'a', 'c', preference);
  assert.deepEqual(takeTerminalResume(storage, 'a', 'c', true), preference);
  assert.equal(takeTerminalResume(storage, 'a', 'c', true), undefined);
  saveTerminalPreference(storage, 'a', 'c', preference);
  assert.equal(takeTerminalResume(storage, 'a', 'c', false), undefined);
  assert.equal(takeTerminalResume(storage, 'a', 'c', true), undefined);
});
test('stopped terminals, opt-out, expired and invalid configuration cannot auto-connect', () => {
  const storage = store();
  for (const value of [{ ...preference, resume: false }, { ...preference, reconnect: false }, { ...preference, target: '' }]) {
    saveTerminalPreference(storage, 'a', 'c', value);
    assert.equal(takeTerminalResume(storage, 'a', 'c', true), undefined);
  }
  saveTerminalPreference(storage, 'a', 'c', preference, 100);
  assert.equal(readTerminalPreference(storage, 'a', 'c', 100 + 12 * 60 * 60 * 1000 + 1), undefined);
  assert.equal(readTerminalPreference(storage, 'a', 'c', 99), undefined);
  for (const k of storage.data.keys()) storage.data.set(k, '{broken');
  assert.equal(readTerminalPreference(storage, 'a', 'c'), undefined);
});
test('storage failure disables automatic start without breaking manual use', () => {
  assert.equal(readTerminalPreference(undefined, 'a', 'c'), undefined);
  assert.equal(saveTerminalPreference(undefined, 'a', 'c', preference), false);
  const storage = store(); saveTerminalPreference(storage, 'a', 'c', preference);
  storage.setItem = () => { throw Error('quota'); };
  assert.equal(takeTerminalResume(storage, 'a', 'c', true), undefined);
  assert.equal(saveTerminalPreference(storage, '', 'c', preference), false);
});
