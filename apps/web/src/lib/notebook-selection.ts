import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Transform } from '@tiptap/pm/transform';

export type NotebookArchiveSelection = { source: string; start: number; end: number; requestId: string;
  scope: string | undefined; epoch: number; resourceId: string | undefined };

/** Locate the actual rich-text selection, not the first matching phrase.
 * Only return offsets when marker removal reproduces the stored source exactly.
 * Unsupported block selections/noncanonical Markdown stay untouched. */
export function notebookSelectionRange(doc: ProseMirrorNode, from: number, to: number,
  serialize: (doc: ProseMirrorNode) => string, source: string): { start: number; end: number } | undefined {
  if (from < 0 || to > doc.content.size || from >= to) return;
  const start = doc.resolve(from), end = doc.resolve(to);
  if (!start.parent.inlineContent || !end.parent.inlineContent) return;
  // A raw substring spanning table cells can remove unselected delimiters.
  // Cross-block moves remain available in the explicit Markdown selector.
  if (start.parent !== end.parent) return;
  let token = 'AgentOpsDeckSelectionBoundary';
  while (source.includes(token) || doc.textContent.includes(token)) token += 'Z';
  const left = `${token}Start`, right = `${token}End`;
  // Keep only marks crossing a boundary. Whole selected marks then remain
  // inside the moved Markdown, rather than leaving empty ** delimiters behind.
  const boundaryMarks = (position: typeof start) => position.nodeBefore?.marks.filter(mark =>
    position.nodeAfter?.marks.some(next => next.eq(mark))) ?? [];
  const transformed = new Transform(doc)
    .insert(to, doc.type.schema.text(right, boundaryMarks(end)))
    .insert(from, doc.type.schema.text(left, boundaryMarks(start))).doc;
  const marked = serialize(transformed), a = marked.indexOf(left), b = marked.indexOf(right);
  if (a < 0 || b <= a || marked.indexOf(left, a + left.length) >= 0 || marked.indexOf(right, b + right.length) >= 0) return;
  if (marked.slice(0, a) + marked.slice(a + left.length, b) + marked.slice(b + right.length) !== source) return;
  const range = { start: a, end: b - left.length };
  return range.end > range.start && range.end - range.start <= 16000 ? range : undefined;
}
