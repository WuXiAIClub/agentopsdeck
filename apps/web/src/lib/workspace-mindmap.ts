import { DRAWING_CANVAS, DRAWING_MAX_NODES, drawingContent, validDrawingContent, type DrawingContent } from '@agentopsdeck/shared';

export type MindmapResult = { ok: true; content: DrawingContent } | { ok: false; reason: 'not-tree' | 'too-large' };

/** Stable directed forest layout. Never discard edges to make an arbitrary graph a tree. */
export function arrangeMindmap(value: DrawingContent): MindmapResult {
  if (!validDrawingContent(value, true)) return { ok: false, reason: 'too-large' };
  const nodes = new Map(value.nodes.map(n => [n.id, n]));
  const children = new Map(value.nodes.map(n => [n.id, [] as string[]]));
  const parents = new Map<string, string>();
  for (const edge of value.edges) {
    if (parents.has(edge.to)) return { ok: false, reason: 'not-tree' };
    parents.set(edge.to, edge.from); children.get(edge.from)!.push(edge.to);
  }
  const roots = value.nodes.filter(n => !parents.has(n.id));
  const heights = new Map<string, number>(), depths = new Map<string, number>(), widths: number[] = [];
  const walk = (id: string, depth: number): number => {
    depths.set(id, depth); widths[depth] = Math.max(widths[depth] ?? 0, nodes.get(id)!.width);
    const kids = children.get(id)!;
    const h = Math.max(nodes.get(id)!.height, kids.reduce((sum, child) => sum + walk(child, depth + 1), 0) + Math.max(0, kids.length - 1) * 24);
    heights.set(id, h); return h;
  };
  // With at most one parent, cycles are disconnected from all roots. Traversal is bounded by 256 nodes.
  const height = roots.reduce((sum, root) => sum + walk(root.id, 0), 0) + Math.max(0, roots.length - 1) * 40;
  if (depths.size !== nodes.size) return { ok: false, reason: 'not-tree' };
  const width = widths.reduce((sum, w) => sum + w, 0) + Math.max(0, widths.length - 1) * 56;
  if (width > DRAWING_CANVAS.width - 64 || height > DRAWING_CANVAS.height - 64) return { ok: false, reason: 'too-large' };
  const xs: number[] = []; let x = 32;
  for (const w of widths) { xs.push(x); x += w + 56; }
  const positions = new Map<string, { x: number; y: number }>();
  const place = (id: string, top: number) => {
    positions.set(id, { x: xs[depths.get(id)!]!, y: top + (heights.get(id)! - nodes.get(id)!.height) / 2 });
    const kids = children.get(id)!;
    const total = kids.reduce((sum, child) => sum + heights.get(child)!, 0) + Math.max(0, kids.length - 1) * 24;
    let y = top + (heights.get(id)! - total) / 2;
    for (const child of kids) { place(child, y); y += heights.get(child)! + 24; }
  };
  let y = 32;
  for (const root of roots) { place(root.id, y); y += heights.get(root.id)! + 40; }
  return { ok: true, content: { ...drawingContent(value), nodes: value.nodes.map(node => ({ ...node, ...positions.get(node.id)! })) } };
}

export function addMindmapTopic(value: DrawingContent, selected: string | undefined, kind: 'child' | 'sibling', text: string, id: string, edgeId: string): MindmapResult {
  if (value.nodes.length >= DRAWING_MAX_NODES) return { ok: false, reason: 'too-large' };
  const checked = arrangeMindmap(value); if (!checked.ok) return checked;
  const chosen = value.nodes.find(n => n.id === selected);
  if (selected && !chosen) return { ok: false, reason: 'not-tree' };
  const parent = kind === 'child' ? chosen?.id : value.edges.find(e => e.to === chosen?.id)?.from;
  return arrangeMindmap({ ...drawingContent(value), nodes: [...value.nodes, {
    id, x: 0, y: 0, width: 160, height: 64, text, color: chosen?.color ?? '#dbeafe',
  }], edges: parent ? [...value.edges, { id: edgeId, from: parent, to: id }] : value.edges });
}
