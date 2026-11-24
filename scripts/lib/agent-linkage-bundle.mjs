// Assemble the complete real-agent acceptance bundle BEFORE executing either
// entrypoint. An in-entrypoint preflight cannot catch its own missing imports.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, posix } from 'node:path';
import { sdkProbeFiles } from './sdk-probe-assets.mjs';

export const agentLinkageFiles = Object.freeze([...new Set([
  ...sdkProbeFiles, 'verify-candidate-file-boards.mjs',
  'lib/all-card-linkage-evidence.mjs', 'lib/agent-linkage-bundle.mjs',
])].sort());
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function inventory(root) {
  assert.ok(isAbsolute(root), 'Explicit absolute bundle root required');
  const files = [];
  for (const name of agentLinkageFiles) {
    const path = join(root, name);
    const info = await lstat(path).catch(() => undefined);
    assert.ok(info?.isFile() && !info.isSymbolicLink(), `Incomplete acceptance bundle: ${name}`);
    const bytes = await readFile(path);
    // Deliberately conservative for these reviewed .mjs fixtures; dynamic
    // fork/--import assets additionally live in the explicit inventory above.
    const refs = bytes.toString('utf8').matchAll(/(?:\bfrom\s*|\bimport\s*|new URL\s*\(\s*)['"](\.[^'"]+\.mjs)['"]/g);
    for (const [, ref] of refs) {
      const resolved = posix.normalize(posix.join(posix.dirname(name), ref));
      assert.ok(agentLinkageFiles.includes(resolved), `Unlisted acceptance dependency: ${name} -> ${resolved}`);
    }
    files.push({ name, sha256: digest(bytes), bytes });
  }
  return files;
}

export async function stageAgentLinkageBundle(source, destination) {
  assert.ok(isAbsolute(destination), 'Explicit absolute destination required');
  const files = await inventory(source); // No process, inference or credentials.
  await mkdir(destination, { mode: 0o700 }); // Never overwrite a frozen operation.
  await mkdir(join(destination, 'lib'), { mode: 0o700 });
  for (const file of files) await writeFile(join(destination, file.name), file.bytes, { flag: 'wx', mode: 0o600 });
  const manifest = { version: 1, files: files.map(({ name, sha256 }) => ({ name, sha256 })) };
  await writeFile(join(destination, 'probe-bundle.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await verifyAgentLinkageBundle(destination);
  return manifest;
}

export async function verifyAgentLinkageBundle(root) {
  const actual = await inventory(root);
  const manifest = JSON.parse(await readFile(join(root, 'probe-bundle.json'), 'utf8'));
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.files, actual.map(({ name, sha256 }) => ({ name, sha256 })), 'Acceptance bundle drift');
  return { files: actual.length, manifestSha256: digest(await readFile(join(root, 'probe-bundle.json'))) };
}
