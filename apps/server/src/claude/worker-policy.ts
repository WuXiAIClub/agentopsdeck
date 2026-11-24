/** Initial private-worker policy: no host settings, executable policy helpers,
 * hooks, plugins, memory or peer delivery. Enterprise policy is not bypassed:
 * an installation needing managed settings is unsupported and fails closed.
 * The SDK resolver does not execute policyHelper; rejecting ALL non-empty
 * source settings also rejects helpers hidden by effective-setting merges.
 * This is a trusted-host configuration check, NOT an OS sandbox/TOCTOU guard.
 */
export const claudeWorkerSettings = Object.freeze({ disableAllHooks: true,
  disableBundledSkills: true, autoMemoryEnabled: false, crossSessionInbound: 'refuse' });

export function assertClaudeWorkerPolicy(resolved: unknown): void {
  const invalid = () => new Error('Claude host policy is unsupported by the private worker');
  const empty = (value: unknown) => value !== null && typeof value === 'object'
    && !Array.isArray(value) && Object.keys(value).length === 0;
  if (!resolved || typeof resolved !== 'object') throw invalid();
  const { effective, sources, provenance } = resolved as Record<string, unknown>;
  if (!empty(effective) || !empty(provenance) || !Array.isArray(sources) || sources.length > 32) throw invalid();
  for (const source of sources) {
    if (!source || typeof source !== 'object' || !empty(source.settings)
      || !['managed', 'user', 'project', 'local', 'flag'].includes(source.source)) throw invalid();
  }
}
