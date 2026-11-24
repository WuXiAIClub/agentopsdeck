/** Higher values stay inline longer. Equal priorities retain DOM order. */
export function captionTitleBudget(available: number, intrinsicWidth: number, triggerWidth = 24) {
  // Names outrank every optional action. Only the More access point is reserved;
  // spacing can shrink before a name is truncated on a genuinely narrow card.
  return Math.min(Math.max(0, intrinsicWidth), Math.max(0, available - triggerWidth));
}

export function captionSelection(items: readonly { width: number; priority: number }[], budget: number, triggerWidth: number, gap = 3) {
  const visible = items.map((item, index) => ({ ...item, index })).filter(item => item.width > 0);
  let total = visible.reduce((sum, item) => sum + item.width, 0) + Math.max(0, visible.length - 1) * gap;
  const overflow = total > Math.max(0, budget);
  const hidden = new Set<number>();
  if (!overflow) return { overflow, hidden };
  const available = Math.max(0, budget - triggerWidth - gap);
  // Remove low priorities first, not first-fit packing: a small low-priority
  // icon must never displace a wider, higher-priority control.
  const removal = [...visible].sort((a, b) => a.priority - b.priority || b.index - a.index);
  let count = visible.length;
  for (const item of removal) {
    if (total <= available) break;
    hidden.add(item.index);
    total -= item.width + (count > 1 ? gap : 0);
    count--;
  }
  return { overflow, hidden };
}
