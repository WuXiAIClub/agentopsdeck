import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Browser } from 'playwright-core';
import { BrowserError, WorkspaceBrowser, browserUrl, parseWorkspaceBrowserConfig, validBrowserAction } from './workspace-browser.js';
import { loadConfig, redactedConfig } from '../config.js';

const config = { endpoint: 'ws://127.0.0.1:3000/browser', users: ['alice'], hosts: ['learn.microsoft.com', '*.bing.com'] };
test('browser config fails closed; no wildcard user/admin inheritance or arbitrary endpoint', () => {
  assert.equal(parseWorkspaceBrowserConfig({}), undefined);
  const env = { AOD_BROWSER_ENDPOINT: config.endpoint, AOD_BROWSER_USER_IDS: 'alice', AOD_BROWSER_HOSTS: config.hosts.join(','), AOD_BROWSER_EGRESS_ISOLATED: 'true' };
  assert.deepEqual(parseWorkspaceBrowserConfig(env), config);
  const redacted = JSON.stringify(redactedConfig(loadConfig(env)));
  assert.ok(!redacted.includes(config.endpoint)); assert.ok(!redacted.includes('alice')); assert.ok(!redacted.includes('learn.microsoft.com'));
  for (const patch of [{ AOD_BROWSER_EGRESS_ISOLATED: 'false' }, { AOD_BROWSER_USER_IDS: '*' }, { AOD_BROWSER_HOSTS: '*' }, { AOD_BROWSER_HOSTS: '127.0.0.1' },
    { AOD_BROWSER_ENDPOINT: 'ws://remote/browser' }, { AOD_BROWSER_ENDPOINT: 'wss://user:secret@remote/browser' }, { AOD_BROWSER_ENDPOINT: 'wss://remote/browser?token=secret' }]) {
    assert.throws(() => parseWorkspaceBrowserConfig({ ...env, ...patch }), /Invalid isolated browser configuration/);
  }
});
test('public HTTPS allowlist rejects private addresses, credentials, schemes and suffix tricks', () => {
  assert.equal(browserUrl('https://learn.microsoft.com/en-us/?q=hello', config.hosts), 'https://learn.microsoft.com/en-us/?q=hello');
  assert.equal(browserUrl('https://www.bing.com/search?q=a', config.hosts), 'https://www.bing.com/search?q=a');
  for (const value of ['https://bing.com/', 'http://learn.microsoft.com', 'https://learn.microsoft.com:444/', 'https://user:pass@learn.microsoft.com/', 'file:///etc/passwd', 'javascript:alert(1)',
    'https://learn.microsoft.com.evil.com/', 'https://evilbing.com/', 'https://127.0.0.1/', 'https://2130706433/', 'https://[::1]/', 'https://metadata.example.invalid/', 'https://learn.microsoft.com\\@evil.com', 'https://learn.microsoft.com\n']) assert.equal(browserUrl(value, config.hosts), undefined, value);
});
test('input protocol is bounded and cannot evaluate scripts, upload files or execute commands', () => {
  for (const value of [{ kind: 'key', key: 'Enter', seq: 1 }, { kind: 'text', text: '中文', seq: 2 }, { kind: 'click', x: 0, y: 719, seq: 3 }, { kind: 'navigate', url: 'https://learn.microsoft.com', seq: 4 }]) assert.equal(validBrowserAction(value, config.hosts), true);
  for (const value of [{ kind: 'text', text: 'a'.repeat(4001), seq: 1 }, { kind: 'click', x: 1024, y: 0, seq: 1 }, { kind: 'scroll', dy: 9999, seq: 1 },
    { kind: 'evaluate', script: '1', seq: 1 }, { kind: 'reload', seq: 0 }, { kind: 'reload', seq: 1, owner: 'other' }, { kind: 'key', key: 'F12', seq: 1 }]) assert.equal(validBrowserAction(value, config.hosts), false);
});
function fixture() {
  const calls: string[] = []; let url = 'about:blank';
  const page = { url: () => url, title: async () => 'Fixture', on() {}, screenshot: async () => Buffer.from('synthetic jpeg'),
    goto: async (value: string) => { calls.push('navigate'); url = value; }, goBack: async () => { calls.push('back'); }, goForward: async () => {}, reload: async () => {},
    mouse: { click: async () => { calls.push('click'); }, wheel: async () => {} }, keyboard: { insertText: async () => { calls.push('text'); }, press: async () => {} } };
  const context = { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, route: async () => {}, routeWebSocket: async () => {}, on() {}, newPage: async () => page, close: async () => { calls.push('context.close'); } };
  const browser = { newContext: async () => context, close: async () => { calls.push('browser.close'); } } as unknown as Browser;
  return { calls, page, browser, service: new WorkspaceBrowser(config, async () => browser) };
}
const status = (code: number) => (e: unknown) => e instanceof BrowserError && e.status === code;
test('leases are owner-only, bounded, deduplicated; frame hashes avoid duplicate image bodies', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = fixture(), id = randomUUID();
  try {
    assert.equal(f.service.enabled('admin'), false);
    await assert.rejects(f.service.start('admin', id, () => true), status(403));
    await f.service.start('alice', id, () => true); await f.service.start('alice', id, () => true);
    const frame = await f.service.frame('alice', id); assert.equal(frame.image, Buffer.from('synthetic jpeg').toString('base64'));
    await assert.rejects(f.service.frame('alice', id), status(409));
    now += 800;
    const unchanged = await f.service.frame('alice', id, frame.hash);
    assert.equal(unchanged.hash, frame.hash); assert.equal('image' in unchanged, false);
    await f.service.act('alice', id, { kind: 'click', x: 2, y: 3, seq: 1 });
    await assert.rejects(f.service.act('alice', id, { kind: 'click', x: 2, y: 3, seq: 1 }), status(409));
    assert.equal(f.calls.filter(v => v === 'click').length, 1);
    await f.service.start('alice', randomUUID(), () => true);
    await assert.rejects(f.service.start('alice', randomUUID(), () => true), status(429));
    await f.service.stop('bob', id); assert.equal(f.calls.includes('context.close'), false);
    await f.service.stop('alice', id); assert.equal(f.calls.filter(v => v === 'context.close').length, 1);
    await assert.rejects(f.service.frame('alice', id), status(404));
  } finally { await f.service.close(); }
});
test('revocation and uncertain input close the context; no replay or surviving late handle', async () => {
  const f = fixture(); let allowed = true;
  try {
    const id = randomUUID(); await f.service.start('alice', id, () => allowed); allowed = false;
    await assert.rejects(f.service.act('alice', id, { kind: 'reload', seq: 1 }), status(404));
    const next = randomUUID(); await f.service.start('alice', next, () => true);
    f.page.goto = async () => { throw Error('secret endpoint must not escape'); };
    await assert.rejects(f.service.act('alice', next, { kind: 'navigate', url: 'https://learn.microsoft.com/', seq: 1 }), /browser_action_unconfirmed/);
    await assert.rejects(f.service.frame('alice', next), status(404));
  } finally { await f.service.close(); }
  let resolve!: (b: Browser) => void;
  const slow = new WorkspaceBrowser(config, () => new Promise(r => { resolve = r; })), id = randomUUID();
  const started = slow.start('alice', id, () => true); await slow.stop('alice', id); resolve(f.browser);
  await assert.rejects(started, /browser_start_failed/); await slow.close();
  assert.ok(f.calls.includes('browser.close'));
});
test('canceled connects retain capacity until settled; inactive and maximum lifetime expire', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = fixture(), resolvers: Array<(value: Browser) => void> = [];
  const service = new WorkspaceBrowser(config, () => new Promise(resolve => { resolvers.push(resolve); }));
  const a = randomUUID(), b = randomUUID();
  const starts = [service.start('alice', a, () => true), service.start('alice', b, () => true)];
  // Attach rejection handlers before releasing asynchronous connects.
  const rejected = starts.map(p => assert.rejects(p, /browser_start_failed/));
  await service.stop('alice', a); await service.stop('alice', b);
  await assert.rejects(service.start('alice', randomUUID(), () => true), status(429));
  resolvers.forEach(resolve => resolve(f.browser)); await Promise.all(rejected); await service.close();
  try {
    const id = randomUUID(); await f.service.start('alice', id, () => true); now += 120_001;
    await assert.rejects(f.service.frame('alice', id), status(404));
    const next = randomUUID(); await f.service.start('alice', next, () => true);
    for (let i = 0; i < 18; i++) { now += 100_000; await f.service.act('alice', next, { kind: 'back', seq: i + 1 }); }
    now++; await assert.rejects(f.service.frame('alice', next), status(404));
  } finally { await f.service.close(); }
});
