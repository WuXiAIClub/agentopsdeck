const SELECTOR = '[data-message-search-id]';

/** Index only message wrappers, not their (frequently streaming) descendants.
 * takeRecords makes synchronous React layout effects see a just-committed page.
 * Desktop wrappers are a vertical flow: binary search measures O(log n) rows.
 * Mobile keeps its existing linear geometry policy, but shares the ID index.
 */
export function createHistoryAnchorIndex(root: HTMLElement) {
  let dirty = true;
  let rows: HTMLElement[] = [];
  const ids = new Map<string, HTMLElement>();
  const containsRow = (node: Node) => node instanceof Element && (node.matches(SELECTOR) || !!node.querySelector(SELECTOR));
  const changed = (records: MutationRecord[]) => {
    if (records.some(record => record.type === 'attributes' || [...record.addedNodes, ...record.removedNodes].some(containsRow))) dirty = true;
  };
  const observer = new MutationObserver(changed);
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-message-search-id'] });
  const sync = () => {
    changed(observer.takeRecords());
    if (!dirty) return;
    rows = Array.from(root.querySelectorAll<HTMLElement>(SELECTOR));
    ids.clear();
    for (const row of rows) if (!ids.has(row.dataset.messageSearchId!)) ids.set(row.dataset.messageSearchId!, row);
    dirty = false;
  };
  return {
    capture() {
      sync();
      if (!root.clientHeight || !rows.length) return;
      const top = root.getBoundingClientRect().top;
      let node: HTMLElement | undefined;
      if (root.closest('.desktop-session-frame')) {
        let low = 0, high = rows.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (rows[middle]!.getBoundingClientRect().bottom > top) high = middle;
          else low = middle + 1;
        }
        node = rows[low];
      } else node = rows.find(row => row.getBoundingClientRect().bottom > top);
      return node ? { id: node.dataset.messageSearchId!, top: node.getBoundingClientRect().top } : undefined;
    },
    get(id: string) { sync(); return ids.get(id); },
    dispose() { observer.disconnect(); rows = []; ids.clear(); },
  };
}
