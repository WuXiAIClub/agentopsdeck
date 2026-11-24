import { DRAWING_MAX_BODY_BYTES, drawingContent, validDrawingContent, validDrawingWrite, type DrawingContent, type DrawingWrite, type DrawingDocument } from '@agentopsdeck/shared';
export const drawingDraftKey = (scope: string, id: string) => `agentopsdeck.drawing-draft.v1:${JSON.stringify([scope, id])}`;
export const drawingEqual = (a: DrawingContent, b: DrawingContent) => JSON.stringify(drawingContent(a)) === JSON.stringify(drawingContent(b));
export function parseDrawingDraft(raw: string | null): DrawingWrite | undefined {
  if (!raw || raw.length > DRAWING_MAX_BODY_BYTES) return undefined;
  try { const value: unknown = JSON.parse(raw); return validDrawingWrite(value, true) ? value : undefined; } catch { return undefined; }
}
export function importDrawing(raw: string): DrawingContent {
  if (new TextEncoder().encode(raw).byteLength > DRAWING_MAX_BODY_BYTES) throw Error('Invalid drawing');
  const value: unknown = JSON.parse(raw);
  // Import restores a draft, not a server write; an exported unfinished title must round-trip.
  if (!validDrawingContent(value, true) || Object.keys(value).some(key => !['format', 'version', 'title', 'nodes', 'edges', 'strokes'].includes(key))) throw Error('Invalid drawing');
  return drawingContent(value);
}
export function reconcileDrawing(document: DrawingDocument, draft: DrawingWrite | undefined, mutationId: string) {
  const dirty = !!draft && !drawingEqual(document, draft);
  return { draft: dirty ? draft : { ...drawingContent(document), revision: document.revision, mutationId },
    conflict: dirty && draft.revision !== document.revision };
}
export function removeDrawingNode(value: DrawingContent, id: string): DrawingContent {
  return { ...value, nodes: value.nodes.filter(node => node.id !== id), edges: value.edges.filter(edge => edge.from !== id && edge.to !== id) };
}
export function drawingTextColor(color: string) {
  const rgb = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  const luminance = rgb[0]! * .2126 + rgb[1]! * .7152 + rgb[2]! * .0722;
  return luminance > .179 ? '#000000' : '#ffffff';
}
