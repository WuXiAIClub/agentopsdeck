import assert from 'node:assert/strict';
import test from 'node:test';
import { staticCopy } from './check-web-i18n.mjs';

test('literal JSX expressions cannot bypass the static text guard', () => {
  assert.deepEqual(staticCopy(`<p>{'Hello'}{\`World\`}</p>`).map(({ text }) => text), ['Hello', 'World']);
});

test('finds untranslated JSX, including Chinese, nested text and accessible attributes', () => {
  const copies = staticCopy(`<><p>Hello <strong>world</strong> 中文</p><input placeholder="Search" title={'Help'} aria-label={\`Find\`} /><img alt="Photo" /></>`);
  assert.deepEqual(copies.map(({ kind, text }) => [kind, text]), [
    ['text', 'Hello'], ['text', 'world'], ['text', '中文'], ['placeholder', 'Search'],
    ['title', 'Help'], ['aria-label', 'Find'], ['alt', 'Photo'],
  ]);
});

test('ignores translations, user content, numbers, symbols and non-copy attributes', () => {
  assert.deepEqual(staticCopy(`<><p>{t('Hello')}{user.name} · 42</p><input className="layout" placeholder={t('Search')} title={error} data-testid="fixture" />{/* Comment */}</>`), []);
});

test('reports source line and normalizes multiline whitespace', () => {
  const copies = staticCopy(`<div>\n  Hello\n  world\n</div>`);
  assert.deepEqual(copies.map(({ text }) => text), ['Hello world']);
  assert.ok(copies[0].line >= 1);
});
