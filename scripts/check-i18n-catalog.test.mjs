import assert from 'node:assert/strict';
import test from 'node:test';
import { checkI18nCatalog, readCatalog, translationCalls } from './check-i18n-catalog.mjs';

test('catalog rejects duplicates, missing values and interpolation drift', () => {
  const result = readCatalog("export const chinese = { 'Hello {name}': '你好', 'Empty': '', 'Empty': '重复' } as const;");
  assert.equal(result.errors.length, 3);
  assert.ok(result.errors.some(error => error.startsWith('Placeholder mismatch')));
  assert.ok(result.errors.some(error => error.startsWith('Duplicate')));
  assert.ok(result.errors.some(error => error.startsWith('Empty')));
});

test('all literal translation calls and English/Chinese placeholders agree', () => {
  const result = checkI18nCatalog();
  assert.deepEqual(result.errors, []);
  assert.ok(result.calls > 500);
  assert.ok(result.entries > 500);
});

test('dynamic translation inputs are counted, not claimed to be statically verified', () => {
  assert.deepEqual(translationCalls("t('Hello'); translateMessage(`Welcome`, locale); t(key); translate(variable);", 'fixture.ts'), { keys: ['Hello', 'Welcome'], dynamic: [1, 1] });
});
