/** Process-local proof only: never serialize this guard into a worker reply.
 * Owned runtimes supply metadata-only state, read synchronously at delivery. */
export function captureMaintenanceFacts<T extends object>(read: () => T): T & { assertCurrent(): void } {
  const facts = read(), fingerprint = JSON.stringify(facts);
  return { ...facts, assertCurrent() {
    if (JSON.stringify(read()) !== fingerprint) throw Error('Maintenance native observation changed; no idle proof');
  } };
}
