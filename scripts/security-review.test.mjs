import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkPublication, unsafeEnvironmentCategory, unsafePathCategory, unsafeTextCategory } from './publication-check.mjs';

test('complete eligible source passes the same security gate as CI', () => {
  const result = checkPublication();
  assert.equal(result.passed, true, JSON.stringify(result.errors));
  assert.ok(result.filesChecked > 1000);
});

test('eligible web source and CSS fixtures contain no legacy CSS namespaces', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))];
  const namespaces = ['claw' + 'ops-', '--cp-' + 'ctx-'];
  const selected = files.filter(path => path.endsWith('.css')
    || /^apps\/web\/.*\.(?:[cm]?[jt]sx?|html)$/.test(path)
    || /^scripts\/verify-.*\.mjs$/.test(path));
  for (const path of ['apps/web/src/main.tsx', 'apps/web/src/styles.css',
    'apps/web/src/lib/context-menu-position.ts', 'scripts/verify-pwa-standalone-css.mjs',
    'scripts/verify-mobile-overflow.mjs']) assert.ok(selected.includes(path));
  for (const path of selected) {
    const source = readFileSync(new URL(path, new URL('../', import.meta.url)), 'utf8');
    for (const namespace of namespaces) assert.equal(source.includes(namespace), false, `${path}: legacy CSS namespace`);
  }
});

test('credential signatures, JWTs and literal high-entropy assignments are refused', () => {
  const samples = [
    'ghp_' + 'a'.repeat(40), 'github_pat_' + 'a'.repeat(40), 'glpat-' + 'a'.repeat(24),
    'sk-' + 'a'.repeat(40), 'AKIA' + 'A'.repeat(16), 'AIza' + 'a'.repeat(35),
    'xoxb-' + 'a'.repeat(24), 'eyJ' + 'a'.repeat(18) + '.' + 'b'.repeat(18) + '.' + 'c'.repeat(18),
    '-----BEGIN ' + 'ENCRYPTED PRIVATE KEY-----',
    'const apiKey = "' + 'a'.repeat(40) + '";',
    'client_secret: "' + 'b'.repeat(40) + '"',
    'AOD_ACCESS_KEY=' + 'c'.repeat(40),
  ];
  for (const sample of samples) assert.equal(unsafeTextCategory(sample), 'credential-pattern');
});

test('legacy branding, internal origins and private runtime paths fail closed', () => {
  const brand = ['claw', 'pool'].join('');
  for (const sample of [brand, brand.toUpperCase(), `@${brand}/shared`, `x-${brand}-protocol`]) assert.equal(unsafeTextCategory(sample), 'legacy-brand');
  for (const sample of [['claw', 'connector'].join(''), ['cp', 'conn', 'fixture'].join('_'), ['cp', 'local', 'fixture'].join('_')]) {
    assert.equal(unsafeTextCategory(sample), 'legacy-brand');
  }
  assert.equal(unsafePathCategory(`native/${brand}/app.ts`), 'legacy-brand-path');
  assert.equal(unsafeTextCategory('https://' + 'service.internal/api'), 'private-origin');
  for (const path of ['.env', '.env.production', 'private/config.json', 'state/session.db', 'id_ed25519', 'signing.p12']) assert.equal(unsafePathCategory(path), 'private-runtime-file');
});

test('credential field names, empty settings and placeholders are not credentials', () => {
  for (const sample of ['AOD_ACCESS_KEY=', 'Authorization: Bearer <token>', 'apiKey: process.env.PROVIDER_API_KEY', 'https://example.invalid', 'const password = "fixture"']) assert.equal(unsafeTextCategory(sample), undefined);
});

test('AOD connector aliases pass while predecessor token prefixes do not', () => {
  for (const sample of ['aod-connector', 'aod_conn_fixture', 'aod_local_fixture']) {
    assert.equal(unsafeTextCategory(sample), undefined);
  }
});

test('fixed workstation paths and LAN endpoints cannot become public runtime defaults', () => {
  for (const sample of ['/' + 'home/developer/private/', '/' + 'Users/developer/private/',
    'http://' + '192.168.1.10:8890', 'http://' + '10.0.0.8:8890']) {
    assert.equal(unsafeEnvironmentCategory(sample, 'scripts/runtime.mjs'), 'fixed-environment');
    assert.equal(unsafeEnvironmentCategory(sample, 'scripts/runtime.test.mjs'), undefined);
  }
  assert.equal(unsafeEnvironmentCategory('http://127.0.0.1:8890', 'scripts/runtime.mjs'), undefined);
  assert.equal(unsafeEnvironmentCategory('http://192.0.2.10:8890', 'scripts/runtime.mjs'), undefined);
});
