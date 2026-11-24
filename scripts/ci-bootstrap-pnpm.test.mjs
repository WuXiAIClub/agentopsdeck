import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PNPM_VERSION, PNPM_URL, PNPM_INTEGRITY, verifyIntegrity, downloadArguments, installArguments } from './ci-bootstrap-pnpm.mjs';

test('package manager bootstrap pins an immutable release and published SHA-512 integrity', () => {
  assert.equal(PNPM_VERSION, '9.15.0');
  assert.equal(PNPM_URL, 'https://registry.npmjs.org/pnpm/-/pnpm-9.15.0.tgz');
  assert.equal(PNPM_INTEGRITY, 'sha512-duI3l2CkMo7EQVgVvNZije5yevN3mqpMkU45RBVsQpmSGon5djge4QfUHxLPpLZmgcqccY8GaPoIMe1MbYulbA==');
  const bytes = Buffer.from('synthetic archive');
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  assert.doesNotThrow(() => verifyIntegrity(bytes, integrity));
  assert.throws(() => verifyIntegrity(Buffer.from('corrupt'), integrity));
  assert.throws(() => verifyIntegrity(bytes, 'sha1-untrusted'));
});

test('only bounded archive download retries; verified installation is offline with scripts disabled', () => {
  const file = '/owned/pnpm.tgz';
  const download = downloadArguments(file);
  assert.equal(download.at(-1), PNPM_URL);
  assert.equal(download[download.indexOf('--output') + 1], file);
  assert.equal(download[download.indexOf('--max-time') + 1], '180');
  assert.equal(download[download.indexOf('--retry') + 1], '2');
  assert.equal(download.includes('--insecure'), false);
  assert.deepEqual(installArguments(file),
    ['install', '--global', file, '--ignore-scripts', '--no-audit', '--no-fund', '--offline']);
});
