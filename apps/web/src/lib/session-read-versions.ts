/** Session-local write fences. Eviction invalidates outstanding tokens rather
 * than recycling a revision, so bounded bookkeeping cannot resurrect old reads. */
export function createSessionReadVersions(capacity = 256) {
  const versions = new Map<string, { revision: number; valid: boolean }>();
  let revision = 0;
  return {
    capture(path: string) {
      let token = versions.get(path);
      if (!token) {
        token = { revision: ++revision, valid: true };
        versions.set(path, token);
      } else {
        versions.delete(path); versions.set(path, token);
      }
      while (versions.size > capacity) {
        const oldest = versions.keys().next().value!;
        versions.get(oldest)!.valid = false; versions.delete(oldest);
      }
      return token;
    },
    invalidate(path: string) {
      const token = versions.get(path);
      if (token) token.valid = false;
      versions.delete(path);
    },
    invalidateMatching(matches: (path: string) => boolean) {
      for (const [path, token] of versions) if (matches(path)) {
        token.valid = false; versions.delete(path);
      }
    },
    clear() {
      for (const token of versions.values()) token.valid = false;
      versions.clear();
    },
  };
}
