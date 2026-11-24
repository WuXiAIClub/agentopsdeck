import { Extension } from '@tiptap/react';
import type { Node } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

type Heading = { position: number; end: number; level: number; key: string };
export const notebookFoldKey = new PluginKey('notebookFolding');
// Presentation only. Neither fold state nor reading mode enters Markdown/undo.
export function notebookHeadings(doc: Node): Heading[] {
  const headings: Heading[] = [], parents: Heading[] = [], occurrences = new Map<string, number>();
  doc.forEach((node, position) => {
    if (node.type.name !== 'heading') return;
    const level = Number(node.attrs.level);
    while (parents.length && parents.at(-1)!.level >= level) parents.pop()!.end = position;
    if (headings.length >= 200) return;
    const identity = `${parents.at(-1)?.key ?? ''}/${level}/${node.textContent}`;
    const occurrence = (occurrences.get(identity) ?? 0) + 1; occurrences.set(identity, occurrence);
    let hash = 2166136261;
    for (let i = 0; i < identity.length; i++) hash = Math.imul(hash ^ identity.charCodeAt(i), 16777619);
    const heading = { position, end: doc.content.size, level, key: `${hash >>> 0}:${occurrence}` };
    parents.push(heading); headings.push(heading);
  });
  return headings;
}
export function readNotebookFolds(key?: string): { reading: boolean; folded: string[] } {
  try {
    const raw = key ? localStorage.getItem(`agentopsdeck.note-folds.v1:${key}`) : null;
    if (!raw || raw.length > 8000) return { reading: false, folded: [] };
    const value = JSON.parse(raw);
    return { reading: value.reading === true, folded: Array.isArray(value.folded) ? value.folded.filter((v: unknown): v is string => typeof v === 'string' && /^\d{1,10}:\d{1,3}$/.test(v)).slice(0, 200) : [] };
  } catch { return { reading: false, folded: [] }; }
}
export function notebookFolding(key: string | undefined, labels: { expand: string; collapse: string }) {
  const initial = readNotebookFolds(key);
  let reading = initial.reading;
  const folded = new Set(initial.folded);
  const persist = () => {
    try { if (key) localStorage.setItem(`agentopsdeck.note-folds.v1:${key}`, JSON.stringify({ reading, folded: [...folded].slice(0, 200) })); } catch { /* Storage denial must not disable reading. */ }
  };
  const decorate = (doc: Node) => {
    if (!reading) return DecorationSet.empty;
    const headings = notebookHeadings(doc), decorations: Decoration[] = [];
    const hidden = headings.filter(h => folded.has(h.key));
    doc.forEach((node, position) => {
      if (hidden.some(h => position > h.position && position < h.end)) decorations.push(Decoration.node(position, position + node.nodeSize, { style: 'display:none' }));
    });
    for (const h of headings) {
      if (hidden.some(parent => h.position > parent.position && h.position < parent.end)) continue;
      decorations.push(Decoration.widget(h.position + 1, view => {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'notebook-fold-toggle'; button.contentEditable = 'false';
        button.textContent = folded.has(h.key) ? '▸' : '▾';
        button.setAttribute('aria-label', folded.has(h.key) ? labels.expand : labels.collapse);
        button.setAttribute('aria-expanded', String(!folded.has(h.key)));
        button.onmousedown = event => event.preventDefault();
        button.onclick = () => view.dispatch(view.state.tr.setMeta(notebookFoldKey, { toggle: h.key }));
        return button;
      }, { side: -1, key: `${h.key}:${folded.has(h.key)}`, ignoreSelection: true, stopEvent: () => true }));
    }
    return DecorationSet.create(doc, decorations);
  };
  return Extension.create({ name: 'notebookFolding', addProseMirrorPlugins: () => [new Plugin({
    key: notebookFoldKey,
    filterTransaction: tr => !reading || !tr.docChanged || tr.getMeta('preventUpdate') === true,
    state: {
      init: (_, state) => decorate(state.doc),
      apply: (tr, previous) => {
        const action = tr.getMeta(notebookFoldKey);
        if (action) {
          const valid = new Set(notebookHeadings(tr.doc).map(h => h.key));
          for (const id of folded) if (!valid.has(id)) folded.delete(id);
          if (typeof action.reading === 'boolean') reading = action.reading;
          if (action.toggle) { if (folded.has(action.toggle)) folded.delete(action.toggle); else if (folded.size < 200) folded.add(action.toggle); }
          if (typeof action.reveal === 'number') for (const h of notebookHeadings(tr.doc)) if (h.position < action.reveal && h.end > action.reveal) folded.delete(h.key);
          persist();
        }
        return action || tr.docChanged ? decorate(tr.doc) : previous;
      },
    },
    props: { decorations: state => notebookFoldKey.getState(state) },
  })] });
}
