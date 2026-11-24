import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundedArchiveTransfer } from './bounded-archive-transfer.mjs';

export const PNPM_VERSION = '9.15.0';
export const PNPM_URL = 'https://registry.npmjs.org/pnpm/-/pnpm-9.15.0.tgz';
export const PNPM_INTEGRITY = 'sha512-duI3l2CkMo7EQVgVvNZije5yevN3mqpMkU45RBVsQpmSGon5djge4QfUHxLPpLZmgcqccY8GaPoIMe1MbYulbA==';
export function verifyIntegrity(bytes, integrity) {
  assert.match(integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  assert.equal('sha512-' + createHash('sha512').update(bytes).digest('base64'), integrity, 'Package-manager archive integrity mismatch');
}
export function downloadArguments(file) {
  return ['--fail', '--location', '--silent', '--show-error', '--connect-timeout', '15',
    '--max-time', '180', '--retry', '2', '--output', file, PNPM_URL];
}
export function installArguments(file) {
  return ['install', '--global', file, '--ignore-scripts', '--no-audit', '--no-fund', '--offline'];
}
export async function bootstrapPnpm() {
  assert.equal(process.platform, 'linux', 'CI package-manager bootstrap is a native Linux gate');
  const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-pnpm-bootstrap-'));
  const archive = join(directory, 'pnpm.tgz');
  const run = (command, args, timeout) => {
    const result = spawnSync(command, args, { stdio: 'inherit', timeout });
    if (result.error || result.signal || result.status !== 0) {
      throw new Error(`Pinned package-manager bootstrap failed: ${command}, exit=${result.status}, signal=${result.signal}`,
        { cause: result.error });
    }
  };
  try {
    // Fetch immutable release bytes, not the ever-growing package metadata.
    // Only the read-only download retries; package scripts never execute.
    const transfer = await boundedArchiveTransfer(downloadArguments(archive), archive, 32 * 1024 * 1024, 600_000);
    assert.ok(!transfer.error && !transfer.signal && transfer.status === 0, 'Bounded package-manager transfer failed');
    assert.ok((await stat(archive)).size <= 32 * 1024 * 1024, 'Package-manager archive exceeds its bound');
    verifyIntegrity(await readFile(archive), PNPM_INTEGRITY);
    run('npm', installArguments(archive), 120_000);
    const version = spawnSync('pnpm', ['--version'], { encoding: 'utf8', timeout: 10_000 });
    assert.ok(!version.error && !version.signal && version.status === 0);
    assert.equal(version.stdout.trim(), PNPM_VERSION);
    console.log(`Pinned pnpm ${PNPM_VERSION} archive verified and installed without registry metadata resolution`);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await bootstrapPnpm();
}
