import { DRAWING_MAX_BODY_BYTES, DRAWING_MAX_NODES, DRAWING_MAX_EDGES, drawingContent, validDrawingContent, type DrawingContent } from '@agentopsdeck/shared';
import { drawingTextColor } from './workspace-drawing.js';

const xmlText = (value: string) => {
  if (/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(value)) throw Error('Unsupported draw.io content');
  return value.replace(/[&<>"'\r\n\t]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\r': '&#13;', '\n': '&#10;', '\t': '&#9;' })[char]!);
};
const bounded = (text: string) => {
  if (new TextEncoder().encode(text).byteLength > DRAWING_MAX_BODY_BYTES) throw Error('Unsupported draw.io content');
  return text;
};
const nodeStyle = (color: string) => `rounded=1;whiteSpace=wrap;html=0;fillColor=${color};strokeColor=#64748b;fontColor=${drawingTextColor(color)};`;
const edgeStyle = 'endArrow=none;html=0;strokeColor=#64748b;';

/** Actual, uncompressed mxGraph XML. Never place private Hub metadata in the exported file. */
export function exportDrawio(value: DrawingContent): string {
  if (!validDrawingContent(drawingContent(value), true) || value.strokes?.length) throw Error('Unsupported draw.io content');
  return bounded(`<?xml version="1.0" encoding="UTF-8"?>\n<mxfile><diagram name="${xmlText(value.title)}"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${value.nodes.map(n =>
    `<mxCell id="n-${n.id}" value="${xmlText(n.text)}" style="${nodeStyle(n.color)}" vertex="1" parent="1"><mxGeometry x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" as="geometry"/></mxCell>`).join('')}${value.edges.map(e =>
    `<mxCell id="e-${e.id}" value="" style="${edgeStyle}" edge="1" parent="1" source="n-${e.from}" target="n-${e.to}"><mxGeometry relative="1" as="geometry"/></mxCell>`).join('')}</root></mxGraphModel></diagram></mxfile>`);
}

/** Deliberately narrow interop: plain cards/lines, single page, no HTML, compression or external content.
 * Unsupported constructs fail the entire import instead of silently losing parts of a diagram. */
export function importDrawio(text: string, parse: (xml: string) => Document = xml => new DOMParser().parseFromString(xml, 'application/xml')): DrawingContent {
  bounded(text);
  if (/<!|<\?(?!xml\s)/i.test(text)) throw Error('Unsupported draw.io content'); // DTD/entities/CDATA/comments/processing instructions
  const doc = parse(text);
  if (doc.doctype || doc.querySelector('parsererror')) throw Error('Unsupported draw.io content');
  const check = (element: Element | undefined, name: string, attrs: string[]) => {
    if (!element || element.tagName !== name || element.namespaceURI || [...element.attributes].some(a => !attrs.includes(a.name))
      || [...element.childNodes].some(n => n.nodeType !== 1 && (n.nodeType !== 3 || n.textContent?.trim()))) throw Error('Unsupported draw.io content');
    return element;
  };
  const only = (element: Element, name: string, attrs: string[]) => {
    if (element.children.length !== 1) throw Error('Unsupported draw.io content');
    return check(element.children[0], name, attrs);
  };
  const file = check(doc.documentElement, 'mxfile', ['host', 'modified', 'agent', 'version', 'type', 'compressed']);
  if (file.getAttribute('compressed') && file.getAttribute('compressed') !== 'false') throw Error('Unsupported draw.io content');
  const diagram = only(file, 'diagram', ['id', 'name']);
  const model = only(diagram, 'mxGraphModel', ['dx', 'dy', 'grid', 'gridSize', 'guides', 'tooltips', 'connect', 'arrows', 'fold', 'page', 'pageScale', 'pageWidth', 'pageHeight', 'math', 'shadow']);
  // View/grid metadata is not document content; rendering features cannot be silently flattened.
  for (const feature of ['math', 'shadow']) if (model.hasAttribute(feature) && model.getAttribute(feature) !== '0') throw Error('Unsupported draw.io content');
  const root = only(model, 'root', []);
  const result: DrawingContent = { format: 'agentopsdeck-drawing', version: 1, title: diagram.getAttribute('name') ?? '', nodes: [], edges: [] };
  const ids = new Map<string, string>(), seen = new Set<string>();
  const cells = [...root.children];
  if (cells.length > DRAWING_MAX_NODES + DRAWING_MAX_EDGES + 2) throw Error('Unsupported draw.io content');
  const attr = (e: Element, name: string) => e.getAttribute(name) ?? '';
  for (const cell of cells) {
    check(cell, 'mxCell', ['id', 'parent', 'value', 'style', 'vertex', 'edge', 'source', 'target']);
    const id = attr(cell, 'id'); if (!id || id.length > 128 || seen.has(id)) throw Error('Unsupported draw.io content'); seen.add(id);
    if (id === '0' || id === '1') {
      check(cell, 'mxCell', id === '0' ? ['id'] : ['id', 'parent']);
      if (cell.children.length || (id === '1' && attr(cell, 'parent') !== '0')) throw Error('Unsupported draw.io content');
      continue;
    }
    if (attr(cell, 'parent') !== '1' || (attr(cell, 'vertex') === '1') === (attr(cell, 'edge') === '1')) throw Error('Unsupported draw.io content');
    if (attr(cell, 'vertex') === '1') {
      check(cell, 'mxCell', ['id', 'parent', 'value', 'style', 'vertex']);
      const style = attr(cell, 'style'), color = /(?:^|;)fillColor=(#[a-fA-F0-9]{6});/.exec(style)?.[1];
      // Exact supported presentation avoids silently discarding rich labels, shapes, URLs, or styling.
      if (!color || style !== nodeStyle(color)) throw Error('Unsupported draw.io content');
      const geometry = only(cell, 'mxGeometry', ['x', 'y', 'width', 'height', 'as']);
      if (geometry.children.length || attr(geometry, 'as') !== 'geometry') throw Error('Unsupported draw.io content');
      const number = (name: string) => { const raw = attr(geometry, name); return raw.trim() ? Number(raw) : name === 'x' || name === 'y' ? 0 : NaN; };
      const nativeId = crypto.randomUUID(); ids.set(id, nativeId);
      result.nodes.push({ id: nativeId, text: attr(cell, 'value'), color, x: number('x'), y: number('y'), width: number('width'), height: number('height') });
    }
  }
  if (!seen.has('0') || !seen.has('1')) throw Error('Unsupported draw.io content');
  for (const cell of cells.filter(c => attr(c, 'edge') === '1')) {
    check(cell, 'mxCell', ['id', 'parent', 'value', 'style', 'edge', 'source', 'target']);
    if (attr(cell, 'value') || attr(cell, 'style') !== edgeStyle) throw Error('Unsupported draw.io content');
    const geometry = only(cell, 'mxGeometry', ['relative', 'as']);
    if (geometry.children.length || attr(geometry, 'as') !== 'geometry' || attr(geometry, 'relative') !== '1') throw Error('Unsupported draw.io content');
    result.edges.push({ id: crypto.randomUUID(), from: ids.get(attr(cell, 'source')) ?? '', to: ids.get(attr(cell, 'target')) ?? '' });
  }
  if (!validDrawingContent(result, true)) throw Error('Unsupported draw.io content');
  return result;
}
