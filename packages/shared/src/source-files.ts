import { parseSourceReference } from './source-reference.js';

/** Native completed file-operation evidence, not a filesystem snapshot. */
export type SourceFileChange = { path: string; kind: 'added' | 'modified' | 'deleted' };

/** Treat remote metadata as untrusted; bound both work and payload size. */
export function normalizeSourceFiles(value: unknown): SourceFileChange[] {
  if (!Array.isArray(value)) return [];
  const result: SourceFileChange[] = [], seen = new Set<string>();
  let chars = 0;
  for (const row of value.slice(0, 64)) {
    if (!row || typeof row !== 'object' || typeof row.path !== 'string' || row.path.length > 2048
      || !['added', 'modified', 'deleted'].includes(row.kind)) continue;
    const reference = parseSourceReference(row.path);
    if (!reference || reference.path !== row.path || seen.has(row.path)) continue;
    if (chars + row.path.length > 8192) break;
    chars += row.path.length; seen.add(row.path);
    result.push({ path: row.path, kind: row.kind });
    if (result.length === 16) break;
  }
  return result;
}
