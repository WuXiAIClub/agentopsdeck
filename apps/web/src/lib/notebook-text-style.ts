import { Extension, Mark } from '@tiptap/react';
import { Marked, type marked } from 'marked';

export type NotebookTextStyle = { size: number | null; color: string | null; highlight: string | null; font?: string | null };
export const NOTE_TEXT_FONTS = { sans: 'system-ui, sans-serif', serif: 'Georgia, "Noto Serif", serif', mono: 'ui-monospace, monospace' } as const;
export const NOTE_TEXT_SIZES = [70, 75, 85, 100, 115, 135, 160, 200] as const;
export const NOTE_TEXT_COLORS = ['#334155', '#1d4ed8', '#b91c1c', '#15803d', '#7e22ce', '#c2410c'] as const;
export const NOTE_HIGHLIGHTS = ['#fef08a', '#bfdbfe', '#bbf7d0', '#fecdd3', '#e9d5ff', '#fed7aa'] as const;
const prefix = '<span data-agentopsdeck-note="';

/** Deliberately not a CSS parser: no URLs, arbitrary properties or font loads. */
export function normalizeNoteStyle(value: Partial<NotebookTextStyle>): NotebookTextStyle {
  const color = (input: unknown) => typeof input === 'string' && /^#[\da-f]{6}$/i.test(input) ? input.toLowerCase() : null;
  return { size: Number.isInteger(value.size) && value.size! >= 70 && value.size! <= 200 ? value.size! : null,
    color: color(value.color), highlight: color(value.highlight),
    ...(typeof value.font === 'string' && Object.hasOwn(NOTE_TEXT_FONTS, value.font) ? { font: value.font } : {}) };
}
export function noteStyleMarker(value: Partial<NotebookTextStyle>): string {
  const style = normalizeNoteStyle(value);
  const fields = `${style.size ?? '-'};${style.color ?? '-'};${style.highlight ?? '-'}`;
  return style.font ? `v2;${fields};${style.font}` : `v1;${fields}`;
}
export function parseNoteStyle(value: string | null): NotebookTextStyle | null {
  const match = /^(v1|v2);(-|\d{2,3});(-|#[\da-f]{6});(-|#[\da-f]{6})(?:;(sans|serif|mono))?$/i.exec(value ?? '');
  if (!match) return null;
  if ((match[1]!.toLowerCase() === 'v2') !== !!match[5]) return null;
  const style = normalizeNoteStyle({ size: match[2] === '-' ? null : Number(match[2]), color: match[3]!, highlight: match[4]!, font: match[5]?.toLowerCase() ?? null });
  return match[2] !== '-' && style.size === null ? null : style;
}
export function noteStyleCss(value: Partial<NotebookTextStyle>): string {
  const style = normalizeNoteStyle(value);
  return [style.size && `font-size:${style.size}%`, style.color && `color:${style.color}`,
    style.highlight && `background-color:${style.highlight}`,
    style.font && `font-family:${NOTE_TEXT_FONTS[style.font as keyof typeof NOTE_TEXT_FONTS]}`].filter(Boolean).join(';');
}

export const NotebookTextStyleMark = Mark.create({
  name: 'notebookTextStyle', priority: 1100,
  addAttributes() { return { size: { default: null }, color: { default: null }, highlight: { default: null }, font: { default: null } }; },
  parseHTML() { return [{ tag: 'span[data-agentopsdeck-note]', getAttrs: element => parseNoteStyle(element.getAttribute('data-agentopsdeck-note')) ?? false }]; },
  renderHTML({ mark }) { return ['span', { 'data-agentopsdeck-note': noteStyleMarker(mark.attrs), style: noteStyleCss(mark.attrs) }, 0]; },
  markdownTokenizer: {
    name: 'notebookTextStyle', level: 'inline', start: source => source.indexOf(prefix),
    tokenize(source, _tokens, lexer) {
      if (!source.startsWith(prefix)) return undefined;
      const opening = /^<span data-agentopsdeck-note="([^"]{1,64})">/.exec(source);
      if (!opening) return undefined;
      const attrs = parseNoteStyle(opening[1]!), end = source.indexOf('</span>', opening[0].length);
      if (!attrs || end < 0) return undefined;
      const text = source.slice(opening[0].length, end);
      // Generated marks never nest themselves. Reject recursive input rather
      // than letting a pasted marker create unbounded tokenizer recursion.
      if (text.includes(prefix) || text.includes('\n\n')) return undefined;
      return { type: 'notebookTextStyle', raw: source.slice(0, end + 7), attrs, tokens: lexer.inlineTokens(text) };
    },
  },
  parseMarkdown(token, helpers) { return helpers.applyMark('notebookTextStyle', helpers.parseInline(token.tokens ?? []), token.attrs); },
  renderMarkdown(node, helpers) {
    if (!noteStyleCss(node.attrs ?? {})) return helpers.renderChildren(node);
    return `${prefix}${noteStyleMarker(node.attrs ?? {})}">${helpers.renderChildren(node)}</span>`;
  },
});

// Marked treats a paragraph beginning with an inline HTML tag as an HTML block.
// Parse only our exact bounded marker back through the Markdown inline parser,
// so **bold**, links and task text keep their original semantics inside it.
export const NotebookStyleHtmlBlock = Extension.create({
  name: 'notebookStyleHtmlBlock', markdownTokenName: 'html',
  parseMarkdown(token, helpers) {
    const raw = String(token.raw ?? token.text ?? '').trimEnd();
    if (!raw.startsWith(prefix) || !helpers.tokenizeInline) return [];
    const tokens = helpers.tokenizeInline(raw);
    if (tokens[0]?.type !== 'notebookTextStyle') return [];
    return helpers.createNode('paragraph', undefined, helpers.parseInline(tokens));
  },
});
// Tiptap types this option as the callable singleton, but only uses its lexer
// and configuration methods. Each editor needs its own registry: never add
// custom tokenizers to the shared singleton on every notebook mount.
export const createNotebookMarkdownParser = () => new Marked() as unknown as typeof marked;
