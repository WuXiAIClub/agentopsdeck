/** Original 2.3.7 user-label normalization, shared by HTTP and the SQL owner.
 * Normalize before bounded Worker admission; transport limits must not change
 * the existing frontend's trim/collapse/truncate contract. */
export function normalizeConnectorUserLabel(value: string) {
  const label = value.trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!label) throw new Error('label is required');
  return label;
}
