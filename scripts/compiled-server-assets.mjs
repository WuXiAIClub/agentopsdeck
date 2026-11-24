import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute, dirname } from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const within = (parent, child) => {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\'));
};

/** Pin non-TypeScript runtime/test assets BEFORE compiling. A complete emitted
 * test manifest does not prove that JSON fixtures or worker modules travelled
 * with it. Refuse aliases/binary/oversized assets rather than silently skipping.
 * This helper never changes source, selects tests, or grants SQL acceptance. */
export function inventoryCompiledServerAssets(sourceRoot) {
  assert.ok(lstatSync(sourceRoot).isDirectory() && !lstatSync(sourceRoot).isSymbolicLink());
  const rows = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false, 'Asset inventory refuses symbolic links');
      if (entry.isDirectory()) { visit(file); continue; }
      assert.ok(entry.isFile(), 'Asset inventory refuses non-regular inputs');
      if (/\.tsx?$/.test(entry.name)) continue;
      assert.ok(/\.(json|mjs)$/.test(entry.name), 'Unreviewed non-TypeScript asset');
      const bytes = readFileSync(file);
      assert.ok(bytes.length <= 4 * 1024 * 1024, 'Asset exceeds text-copy budget');
      const text = bytes.toString('utf8');
      assert.ok(Buffer.from(text, 'utf8').equals(bytes) && !text.includes('\0'), 'Asset must be UTF-8 text');
      assert.ok(text.endsWith('\n'), 'Asset requires a final newline for exact patch copy');
      const path = relative(sourceRoot, file).split('\\').join('/');
      assert.ok(!/[\x00-\x1f\x7f]/.test(path), 'Asset paths must not contain control characters');
      rows.push({ path, sha256: hash(bytes) });
    }
  }
  visit(sourceRoot);
  return rows;
}

export function installCompiledServerAssets(sourceRoot, output, pinned) {
  assert.deepEqual(inventoryCompiledServerAssets(sourceRoot), pinned, 'Assets changed during compilation');
  assert.ok(lstatSync(output).isDirectory() && !lstatSync(output).isSymbolicLink());
  const source = realpathSync(sourceRoot), destination = realpathSync(output);
  assert.ok(!/[\x00-\x1f\x7f]/.test(destination), 'Emit path must not contain control characters');
  assert.ok(!within(source, destination) && !within(destination, source), 'Emit and source must be separate directories');
  // Validate ALL destinations before making any changes. Never overwrite an
  // emitted module or follow a pre-existing directory/file symlink.
  for (const asset of pinned) {
    const parts = asset.path.split('/');
    let current = destination;
    for (const [index, part] of parts.entries()) {
      assert.ok(part && part !== '.' && part !== '..');
      current = join(current, part);
      let stat;
      try { stat = lstatSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat) assert.ok(index < parts.length - 1 && stat.isDirectory() && !stat.isSymbolicLink(), 'Asset destination exists or aliases another file');
    }
  }
  // Use only Node built-ins: apply_patch is an agent tool, not a CI/runtime
  // dependency. Pin bytes before writes and retain exclusive-create semantics.
  const copies = pinned.map(asset => {
    const bytes = readFileSync(join(sourceRoot, asset.path));
    assert.equal(hash(bytes), asset.sha256, 'Asset changed before copy');
    return { path: join(destination, asset.path), bytes };
  });
  for (const asset of copies) {
    mkdirSync(dirname(asset.path), { recursive: true });
    writeFileSync(asset.path, asset.bytes, { flag: 'wx' });
  }
  for (const asset of pinned) assert.equal(hash(readFileSync(join(output, asset.path))), asset.sha256, 'Emitted asset differs from original source');
  assert.deepEqual(inventoryCompiledServerAssets(sourceRoot), pinned, 'Assets changed during installation');
  return pinned;
}
