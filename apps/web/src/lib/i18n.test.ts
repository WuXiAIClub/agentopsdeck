import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chinese, resolveLocale, translateMessage, type TranslationKey } from './translations.js';

function localeProbe(body: string, browserLanguage = 'en') {
  const source = readFileSync(new URL('./i18n.js', import.meta.url), 'utf8');
  const script = `
    import assert from 'node:assert/strict';
    import vm from 'node:vm';
    const events = {}, rejected = [], notices = [];
    const context = vm.createContext({ navigator: { language: ${JSON.stringify(browserLanguage)} },
      localStorage: { getItem: () => null, setItem() {} }, document: { documentElement: {} },
      window: { addEventListener: (key, listener) => { events[key] = listener; } } });
    process.on('unhandledRejection', error => rejected.push(error));
    let attempts = 0, fail = true;
    const module = new vm.SourceTextModule(${JSON.stringify(source)}, { context,
      importModuleDynamically: async () => {
        attempts++;
        if (fail) throw new Error('synthetic chunk unavailable');
        const translations = new vm.SyntheticModule(['chinese'], function () { this.setExport('chinese', { Hello: '你好' }); }, { context });
        await translations.link(() => {}); await translations.evaluate(); return translations;
      } });
    const react = new vm.SyntheticModule(['useSyncExternalStore'], function () {
      this.setExport('useSyncExternalStore', (subscribe, snapshot) => {
        subscribe(() => notices.push(snapshot())); return snapshot();
      });
    }, { context });
    await module.link(specifier => { assert.equal(specifier, 'react'); return react; });
    await module.evaluate();
    const api = module.namespace;
    const settle = () => new Promise(resolve => setImmediate(resolve));
    ${body}
  `;
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
}

test('Chinese chunk rejection resets single-flight state and explicit retry loads translations', () => {
  localeProbe(`
    api.useI18n();
    const initial = api.ensureChineseLoaded();
    assert.equal(api.ensureChineseLoaded(), initial);
    await assert.rejects(initial, /synthetic chunk unavailable/);
    assert.equal(attempts, 1);
    assert.equal(api.translate('Hello', 'zh-CN'), 'Hello');
    await settle(); assert.equal(attempts, 1);
    fail = false;
    const retry = api.ensureChineseLoaded();
    assert.notEqual(retry, initial); assert.equal(api.ensureChineseLoaded(), retry);
    await retry;
    assert.equal(api.translate('Hello', 'zh-CN'), '你好'); assert.equal(attempts, 2);
    await api.ensureChineseLoaded(); assert.equal(attempts, 2);
    assert.equal(notices.length, 2); assert.deepEqual(rejected, []);
  `);
});

test('automatic locale loads handle rejection without retry loops and user selection can retry', () => {
  localeProbe(`
    await settle();
    assert.equal(attempts, 1); assert.deepEqual(rejected, []);
    api.useI18n();
    for (let count = 0; count < 10; count++) assert.equal(api.translate('Hello'), 'Hello');
    await settle(); assert.equal(attempts, 1);
    assert.equal(context.document.documentElement.lang, 'zh-CN');
    assert.equal(api.useI18n().locale, 'zh-CN');
    fail = false; api.setLocale('zh-CN'); await settle();
    assert.equal(attempts, 2); assert.equal(api.translate('Hello'), '你好');
    assert.ok(notices.includes('zh-CN:ready'));
    api.setLocale('en'); assert.equal(api.translate('Hello'), 'Hello');
    assert.deepEqual(rejected, []);
  `, 'zh-CN');
});

test('locale prefers explicit choice and falls back to browser even when storage is blocked', () => {
  assert.equal(resolveLocale('en', 'zh-CN'), 'en');
  assert.equal(resolveLocale('zh-CN', 'en-US'), 'zh-CN');
  assert.equal(resolveLocale(null, 'zh-TW'), 'zh-CN');
  assert.equal(resolveLocale('invalid', 'ZH-hans'), 'zh-CN');
  assert.equal(resolveLocale(null, 'fr'), 'en');
});
test('all translations retain interpolation keys and English remains the exact source', () => {
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const key of Object.keys(chinese) as TranslationKey[]) {
    assert.ok(chinese[key].trim(), key);
    assert.deepEqual(placeholders(chinese[key]), placeholders(key), key);
    assert.equal(translateMessage(key, 'en'), key);
  }
});
test('interpolation is one-pass plain text and never interprets user values as templates', () => {
  assert.equal(translateMessage('Remove “{name}”?', 'zh-CN', { name: '<b>{name}</b>' }), '移除“<b>{name}</b>”？');
  assert.equal(translateMessage('Context usage {percent}%', 'en', { percent: 0 }), 'Context usage 0%');
  assert.equal(translateMessage('Last used {date}', 'zh-CN'), '上次使用：{date}');
  assert.equal(translateMessage('Last used {date}', 'en', Object.create({ date: 'inherited' })), 'Last used {date}');
});
test('agent activity uses the same short run wording as session status', () => {
  assert.equal(translateMessage('run ·', 'en'), 'run ·');
  assert.equal(translateMessage('run ·', 'zh-CN'), '运行中 ·');
});
test('preview and empty-search translations preserve user paths, line numbers and query text', () => {
  assert.equal(translateMessage('Source preview {path}:{line}', 'zh-CN', { path: 'C:\\项目\\{line}.md', line: 0 }), '源码预览 C:\\项目\\{line}.md:0');
  assert.equal(translateMessage('Document excerpt · lines {start}–{end} of {total}', 'en', { start: 1, end: 20, total: 99 }), 'Document excerpt · lines 1–20 of 99');
  assert.equal(translateMessage('Document excerpt · lines {start}–{end} of {total}', 'zh-CN', { start: 1, end: 20, total: 99 }), '文档片段 · 第 1–20 行，共 99 行');
  assert.equal(translateMessage('No sessions match “{query}” in this environment.', 'zh-CN', { query: '<b>{query}</b>' }), '此环境中没有匹配“<b>{query}</b>”的会话。');
});
