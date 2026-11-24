/** Memory-only navigation cache. Never caches file contents or crosses scopes. */
export class DirectoryCache<T extends { entries: unknown[] }> {
  private rows = new Map<string, { value: T; at: number }>();
  constructor(private ttl = 15_000, private now = () => Date.now()) {}
  get(key: string): T | undefined {
    const row = this.rows.get(key);
    if (!row || this.now() - row.at >= this.ttl) { this.rows.delete(key); return undefined; }
    this.rows.delete(key); this.rows.set(key, row);
    return row.value;
  }
  set(key: string, value: T) {
    this.rows.delete(key);
    // Bound both directory count and metadata retained for large directories.
    if (value.entries.length > 5000) return;
    this.rows.set(key, { value, at: this.now() });
    while (this.rows.size > 16 || [...this.rows.values()].reduce((n, row) => n + row.value.entries.length, 0) > 5000) {
      this.rows.delete(this.rows.keys().next().value!);
    }
  }
  clear() { this.rows.clear(); }
}

/** Wire paths are relative POSIX paths even when the Connector runs on Windows. */
export function parentDirectory(path: string) { return path.split('/').filter(Boolean).slice(0, -1).join('/'); }
