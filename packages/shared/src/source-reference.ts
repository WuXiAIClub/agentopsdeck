/** Local source addresses are not web URLs or capabilities. Never fetch them directly. */
export type SourceReference = { href: string; path: string; line: number; endLine?: number };
export type SourcePreview = { path: string; line: number; startLine: number; totalLines: number; text: string; modifiedAt: number; temporaryApproval?: boolean };

export function parseSourceReference(href: string): SourceReference | undefined {
  if (!href || href.length > 4096 || /[\x00-\x1f\x7f]/.test(href)) return undefined;
  let value: string;
  try { value = decodeURIComponent(href); } catch { return undefined; }
  if (!/^(?:\/(?!\/)|[A-Za-z]:[\\/])/.test(value) || /[?\x00-\x1f\x7f]/.test(value)) return undefined;
  const match = /^(.*?)(?::([1-9]\d*)(?::[1-9]\d*)?|#L([1-9]\d*)(?:-L?([1-9]\d*))?)?$/.exec(value);
  if (!match) return undefined;
  const path = match[1]!, line = Number(match[2] ?? match[3] ?? 1), endLine = match[4] ? Number(match[4]) : undefined;
  if (!/\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|dart|c|h|cpp|hpp|cs|sh|bash|zsh|css|scss|html|vue|svelte|sql|md|markdown|txt)$/i.test(path)
    || /[?#]/.test(path) || path.split(/[\\/]/).some(part => part === '..' || part === '.')
    || !Number.isSafeInteger(line) || line > 10_000_000 || (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < line || endLine > 10_000_000))) return undefined;
  return { href, path, line, ...(endLine !== undefined ? { endLine } : {}) };
}

/** Explicit Markdown links and inline-code absolute paths only. Never guess relative filenames. */
export function sourceReferences(text: string): SourceReference[] {
  const result: SourceReference[] = [], seen = new Set<string>();
  const bounded = text.slice(0, 256 * 1024);
  const links = /(?<!!)\[[^\]\n]{1,500}\]\((?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"\n]*")?\)/g;
  for (const match of bounded.matchAll(links)) {
    const reference = parseSourceReference(match[1] ?? match[2] ?? '');
    if (reference && !seen.has(reference.href)) { seen.add(reference.href); result.push(reference); }
    if (result.length === 16) break;
  }
  // Strip fenced code: example paths in scripts are not referenced artifacts.
  const prose = bounded.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1[^\n]*(?:\n|$)/gm, '');
  for (const match of prose.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) {
    if (result.length >= 16) break;
    const reference = parseSourceReference(match[1]!);
    if (reference && !seen.has(reference.href)) { seen.add(reference.href); result.push(reference); }
  }
  return result;
}
