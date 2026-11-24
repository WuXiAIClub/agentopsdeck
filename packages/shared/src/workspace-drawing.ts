/** Portable data only. Never interpret imported strings as markup or URLs. */
export const DRAWING_MAX_BODY_BYTES = 512 * 1024;
export const DRAWING_MAX_NODES = 256;
export const DRAWING_MAX_EDGES = 512;
export const DRAWING_MAX_CHARS = 64_000;
export const DRAWING_MAX_DOCUMENTS = 32;
export const DRAWING_MAX_STROKES = 128;
export const DRAWING_MAX_STROKE_POINTS = 512;
export const DRAWING_MAX_POINTS = 8192;
export const DRAWING_CANVAS = { width: 1600, height: 1000 } as const;
export type DrawingNode = { id: string; x: number; y: number; width: number; height: number; text: string; color: string };
export type DrawingEdge = { id: string; from: string; to: string };
export type DrawingPoint = [number, number];
export type DrawingStroke = { id: string; color: string; width: number; points: DrawingPoint[] };
export type DrawingContent = { format: 'agentopsdeck-drawing'; version: 1; title: string; nodes: DrawingNode[]; edges: DrawingEdge[]; strokes?: DrawingStroke[] };
export type DrawingDocument = DrawingContent & { resourceId: string; revision: number; updatedAt: number | null };
export type DrawingWrite = DrawingContent & { revision: number; mutationId: string };
export type DrawingSummary = Pick<DrawingDocument, 'resourceId' | 'title' | 'revision' | 'updatedAt'>;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
export const validDrawingId = (v: unknown): v is string => v === 'default' || uuid(v);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).every(k => names.includes(k));
const range = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
export function validDrawingContent(v: unknown, allowEmptyTitle = false): v is DrawingContent {
  if (!record(v) || !keys(v, ['format', 'version', 'title', 'nodes', 'edges', 'strokes', 'revision', 'mutationId'])
    || v.format !== 'agentopsdeck-drawing' || v.version !== 1 || typeof v.title !== 'string' || (!allowEmptyTitle && !v.title.trim()) || v.title.length > 160
    || !Array.isArray(v.nodes) || v.nodes.length > DRAWING_MAX_NODES || !Array.isArray(v.edges) || v.edges.length > DRAWING_MAX_EDGES) return false;
  let chars = v.title.length;
  const ids = new Set<string>();
  for (const n of v.nodes) {
    if (!record(n) || !keys(n, ['id', 'x', 'y', 'width', 'height', 'text', 'color']) || !uuid(n.id) || ids.has(n.id)
      || !range(n.width, 80, 600) || !range(n.height, 50, 400) || !range(n.x, 0, DRAWING_CANVAS.width - n.width)
      || !range(n.y, 0, DRAWING_CANVAS.height - n.height) || typeof n.text !== 'string' || n.text.length > 2000
      || typeof n.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(n.color)) return false;
    ids.add(n.id); chars += n.text.length;
  }
  const edgeIds = new Set<string>(), pairs = new Set<string>();
  for (const e of v.edges) {
    if (!record(e) || !keys(e, ['id', 'from', 'to']) || !uuid(e.id) || edgeIds.has(e.id) || !uuid(e.from) || !uuid(e.to)
      || e.from === e.to || !ids.has(e.from) || !ids.has(e.to) || pairs.has(`${e.from}:${e.to}`)) return false;
    edgeIds.add(e.id); pairs.add(`${e.from}:${e.to}`);
  }
  if (v.strokes !== undefined) {
    if (!Array.isArray(v.strokes) || v.strokes.length > DRAWING_MAX_STROKES) return false;
    const strokeIds = new Set<string>(); let points = 0;
    for (const s of v.strokes) {
      if (!record(s) || !keys(s, ['id', 'color', 'width', 'points']) || !uuid(s.id) || strokeIds.has(s.id)
        || typeof s.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(s.color) || !Number.isInteger(s.width) || !range(s.width, 1, 12)
        || !Array.isArray(s.points) || !s.points.length || s.points.length > DRAWING_MAX_STROKE_POINTS) return false;
      strokeIds.add(s.id); points += s.points.length;
      if (points > DRAWING_MAX_POINTS) return false;
      for (const p of s.points) if (!Array.isArray(p) || p.length !== 2 || !Number.isInteger(p[0]) || !Number.isInteger(p[1])
        || !range(p[0], 0, DRAWING_CANVAS.width) || !range(p[1], 0, DRAWING_CANVAS.height)) return false;
    }
  }
  // Escaped control characters, edges and ink share one transport budget.
  // Reserve room for the write revision/mutation envelope; accepted exports must re-import.
  return chars <= DRAWING_MAX_CHARS && new TextEncoder().encode(JSON.stringify(drawingContent(v as unknown as DrawingContent))).byteLength <= DRAWING_MAX_BODY_BYTES - 256;
}
export function validDrawingWrite(v: unknown, allowEmptyTitle = false): v is DrawingWrite {
  if (!record(v)) return false;
  const { revision, mutationId } = v;
  return validDrawingContent(v, allowEmptyTitle) && Number.isSafeInteger(revision) && (revision as number) >= 0
    && (revision as number) < Number.MAX_SAFE_INTEGER && uuid(mutationId);
}
export function drawingContent(v: DrawingContent): DrawingContent {
  return { format: 'agentopsdeck-drawing', version: 1, title: v.title,
    nodes: v.nodes.map(({ id, x, y, width, height, text, color }) => ({ id, x, y, width, height, text, color })),
    edges: v.edges.map(({ id, from, to }) => ({ id, from, to })),
    ...(v.strokes?.length ? { strokes: v.strokes.map(({ id, color, width, points }) => ({ id, color, width, points: points.map(([x, y]): DrawingPoint => [x, y]) })) } : {}) };
}
export const emptyDrawing = (): DrawingContent => ({ format: 'agentopsdeck-drawing', version: 1, title: 'Whiteboard', nodes: [], edges: [] });
