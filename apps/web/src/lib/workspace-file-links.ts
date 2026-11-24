import { isSessionPane, paneKey, paneSessionKey, type Pane } from './workspace-layout.js';
export const filePaneKinds = ['file-browser', 'file-editor', 'image-viewer', 'media'] as const;
export const coBindablePaneKinds = ['notebook', 'taskboard', 'statuscard'] as const;
export const isFileLinkedPane = (pane: Pane) => filePaneKinds.some(kind => pane.kind === kind);
export const isCoBindablePane = (pane: Pane) => coBindablePaneKinds.some(kind => pane.kind === kind);

/** Returns all session keys co-bound to a notebook or taskboard pane (including native session notebook target). */
export function coBoundSessionKeys(panes: Pane[], cardPaneIdOrKey: string): string[] {
  const card = panes.find(p => p.id === cardPaneIdOrKey || paneKey(p) === cardPaneIdOrKey);
  if (!card || !isCoBindablePane(card)) return [];
  const cardKey = paneKey(card);
  const availableSessions = new Set(panes.filter(isSessionPane).map(paneKey));
  const result = new Set<string>();
  const primary = paneSessionKey(card);
  if (primary && availableSessions.has(primary)) result.add(primary);
  for (const link of card.fileLinks ?? []) {
    if (availableSessions.has(link)) result.add(link);
  }
  for (const p of panes) {
    if (isSessionPane(p) && p.fileLinks?.includes(cardKey)) {
      result.add(paneKey(p));
    }
  }
  return [...result];
}

/** Toggle a multi-session co-binding between a notebook/taskboard card and a session pane. */
export function toggleCoBoundSession(panes: Pane[], cardKeyOrId: string, sessionKeyOrId: string): Pane[] {
  const card = panes.find(p => isCoBindablePane(p) && (p.id === cardKeyOrId || paneKey(p) === cardKeyOrId));
  const session = panes.find(p => isSessionPane(p) && (p.id === sessionKeyOrId || paneKey(p) === sessionKeyOrId));
  if (!card || !session) return panes;
  const sKey = paneKey(session);
  const cKey = paneKey(card);
  const hasLink = Boolean(card.fileLinks?.includes(sKey) || session.fileLinks?.includes(cKey));
  return panes.map(p => {
    if (p === card) {
      const nextLinks = hasLink
        ? (p.fileLinks ?? []).filter(k => k !== sKey)
        : [...new Set([...(p.fileLinks ?? []), sKey])].slice(0, 32);
      return { ...p, fileLinks: nextLinks };
    }
    if (p === session && p.fileLinks?.includes(cKey) && hasLink) {
      return { ...p, fileLinks: p.fileLinks.filter(k => k !== cKey) };
    }
    return p;
  });
}
/** The exact same persisted links used for file selection, not a second graph. */
export function fileLinkEdges(panes: Pane[]): { card: string; session: string }[] {
  const nodes = panes.filter(isFileLinkedPane);
  const raw = [
    ...nodes.flatMap((a, i) => nodes.slice(i + 1).flatMap(b =>
      a.fileLinks?.includes(paneKey(b)) || b.fileLinks?.includes(paneKey(a)) ? [{ card: a.id, session: b.id }] : [])),
    ...nodes.filter(p => p.kind === 'file-browser').flatMap(browser => {
      const session = linkedFileSession(panes, paneKey(browser));
      const peer = panes.find(p => isSessionPane(p) && paneKey(p) === session);
      return peer ? [{ card: browser.id, session: peer.id }] : [];
    }),
    ...panes.flatMap((a, i) => panes.slice(i + 1).flatMap(b =>
      (isFileLinkedPane(a) && isFileLinkedPane(b)) || ((isFileLinkedPane(a) && isSessionPane(b) && a.kind !== 'file-browser') || (isFileLinkedPane(b) && isSessionPane(a) && b.kind !== 'file-browser'))
        || !(a.fileLinks?.includes(paneKey(b)) || b.fileLinks?.includes(paneKey(a)))
        ? []
        : [isSessionPane(a) && !isSessionPane(b) ? { card: b.id, session: a.id } : { card: a.id, session: b.id }]
    )),
  ];
  const seen = new Set<string>();
  return raw.filter(e => { const k = e.card < e.session ? `${e.card}\0${e.session}` : `${e.session}\0${e.card}`; return !seen.has(k) && (seen.add(k), true); });
}
/** A direct directory association, deliberately excluded from the transitive
 * viewer graph: sessions cannot bridge editors or overwrite their drafts. */
export function linkedFileSession(panes: Pane[], browserKey: string) {
  const browser = panes.find(p => p.kind === 'file-browser' && paneKey(p) === browserKey);
  return browser?.fileLinks?.find(key => panes.some(p => isSessionPane(p) && paneKey(p) === key));
}
/** Undirected connected component; identity survives saved-layout host remapping.
 * Dangling links never cause a card to open or a service to run. */
export function fileLinkTargets(panes: Pane[], source: string): string[] {
  const nodes = panes.filter(isFileLinkedPane), keys = new Set(nodes.map(paneKey));
  if (!keys.has(source)) return [];
  const seen = new Set([source]), queue = [source];
  for (let i = 0; i < queue.length; i++) {
    const key = queue[i]!;
    for (const node of nodes) {
      const other = paneKey(node);
      if (!seen.has(other) && (node.fileLinks?.includes(key) || nodes.find(p => paneKey(p) === key)?.fileLinks?.includes(other))) {
        seen.add(other); queue.push(other);
      }
    }
  }
  return queue;
}
export function toggleFileLink(panes: Pane[], source: string, target: string): Pane[] {
  const coCard = panes.find(p => isCoBindablePane(p) && (paneKey(p) === source || paneKey(p) === target || p.id === source || p.id === target));
  const coSession = panes.find(p => isSessionPane(p) && (paneKey(p) === source || paneKey(p) === target || p.id === source || p.id === target));
  if (coCard && coSession) {
    return toggleCoBoundSession(panes, paneKey(coCard), paneKey(coSession));
  }
  const browser = panes.find(p => p.kind === 'file-browser' && (paneKey(p) === source || paneKey(p) === target));
  const session = panes.find(p => isSessionPane(p) && (paneKey(p) === source || paneKey(p) === target));
  if (browser && session && paneKey(browser) !== paneKey(session)) {
    const remove = linkedFileSession(panes, paneKey(browser)) === paneKey(session);
    const sessions = new Set(panes.filter(isSessionPane).map(paneKey));
    return panes.map(p => p !== browser ? p : { ...p, fileLinks: [
      ...(p.fileLinks ?? []).filter(key => !sessions.has(key)), ...(remove ? [] : [paneKey(session)])
    ].slice(-32) });
  }
  const a = panes.find(p => paneKey(p) === source && isFileLinkedPane(p)), b = panes.find(p => paneKey(p) === target && isFileLinkedPane(p));
  if (!a || !b || a === b) return panes;
  const remove = a.fileLinks?.includes(target) || b.fileLinks?.includes(source);
  return panes.map(p => p !== a && p !== b ? p : { ...p, fileLinks: remove
    ? (p.fileLinks ?? []).filter(k => k !== (p === a ? target : source))
    : [...new Set([...(p.fileLinks ?? []), p === a ? target : source])].slice(0, 32) });
}
