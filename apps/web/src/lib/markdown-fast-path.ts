// Conservative plain-text fast path and bounded LRU cache for Markdown rendering.
//
// Any text containing potential CommonMark/GFM syntax characters falls back to
// full ReactMarkdown + remarkGfm parsing so formatting, links, code spans, HTML
// entities, lists, blockquotes, tables, and task lists behave identically.

const SPECIAL_MARKDOWN_CHARS = /[*_`~[\]()#><|\\&-]|https?:\/\/|www\.|mailto:/i;
const NUMBERED_LIST_LINE = /(?:^|\n)\s*(?:\d+[.)]|[+*])\s/;
const INDENTED_CODE_LINE = /(?:^|\n)(?: {4}|\t)/;
const HR_OR_SETEXT_LINE = /(?:^|\n)\s*(?:[-=_]{3,})\s*(?:\n|$)/;

export function isPlainTextMarkdown(text: string): boolean {
  if (!text) return true;
  if (SPECIAL_MARKDOWN_CHARS.test(text)) return false;
  if (NUMBERED_LIST_LINE.test(text)) return false;
  if (INDENTED_CODE_LINE.test(text)) return false;
  if (HR_OR_SETEXT_LINE.test(text)) return false;
  return true;
}

export function createBoundedMarkdownCache<T>(maxEntries = 320, maxTextLength = 24_000) {
  const store = new Map<string, T>();
  return {
    get(tone: string, text: string): T | undefined {
      if (text.length > maxTextLength) return undefined;
      const key = `${tone}\0${text}`;
      const hit = store.get(key);
      if (hit !== undefined) {
        store.delete(key);
        store.set(key, hit);
      }
      return hit;
    },
    set(tone: string, text: string, value: T): T {
      if (text.length > maxTextLength) return value;
      const key = `${tone}\0${text}`;
      if (store.has(key)) store.delete(key);
      store.set(key, value);
      if (store.size > maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest !== undefined) store.delete(oldest);
      }
      return value;
    },
    clear(): void {
      store.clear();
    },
    size(): number {
      return store.size;
    },
  };
}
