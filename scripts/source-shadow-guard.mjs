import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** A loader may satisfy explicit .js imports with old adjacent emit instead of
 * transforming the corresponding TS. Reject that ambiguity; never repair or
 * delete caller-owned files as a side effect of running acceptance. */
export async function assertNoAdjacentJavaScript(root) {
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const names = new Set(entries.map(entry => entry.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false, 'Source shadow guard refuses symbolic links');
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        const stem = entry.name.slice(0, -3);
        assert.ok(!names.has(stem + '.ts') && !names.has(stem + '.tsx'),
          'Adjacent JavaScript shadows TypeScript source: ' + relative(root, path));
      }
    }
  }
  await visit(root);
}
