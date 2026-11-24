/** A missing stream means no completion was observed yet, not an API outage. */
export function partialUnreadCoverage(keys: string[], rows: { sessionKey: string; coverage: 'gap' | 'observed' }[], overflow = false) {
  const observed = new Set(rows.map(row => row.sessionKey));
  return overflow || rows.some(row => row.coverage === 'gap') || keys.some(key => !observed.has(key));
}
