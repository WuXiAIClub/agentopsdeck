export type ModelChoice = { id: string; label: string };

/** Bounded native catalog; no credentials, hidden models or arbitrary RPC fields. */
export async function readModelCatalog(request: (params: Record<string, unknown>) => Promise<unknown>): Promise<ModelChoice[]> {
  const models = new Map<string, ModelChoice>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const response = await request({ limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }) as any;
    if (!Array.isArray(response?.data)) throw new Error('Invalid native model catalog');
    for (const row of response.data) {
      if (row?.hidden === true || typeof row?.model !== 'string' || !row.model.trim() || row.model.length > 4096) continue;
      const id = row.model.trim();
      models.set(id, { id, label: typeof row.displayName === 'string' ? row.displayName.slice(0, 256) : id });
    }
    if (!response.nextCursor) return [...models.values()];
    if (typeof response.nextCursor !== 'string' || cursors.has(response.nextCursor)) throw new Error('Invalid native model catalog cursor');
    cursor = response.nextCursor as string; cursors.add(cursor);
  }
  throw new Error('Native model catalog exceeds pagination limit');
}
