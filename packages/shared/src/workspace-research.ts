/** Text-only, bounded search projection. No provider secrets or active markup. */
export const RESEARCH_QUERY_LIMIT = 320;
export const RESEARCH_RESULT_LIMIT = 8;
export type ResearchSource = { id: string; title: string; url: string; snippet: string };
export type ResearchResult = { searchId: string; query: string; fetchedAt: number; sources: ResearchSource[] };
export const RESEARCH_ARTICLE_LIMIT = 80_000;
export type ResearchArticle = { searchId: string; sourceId: string; url: string; title: string; text: string; fetchedAt: number; truncated: boolean; articleId?: string };
/** UTF-16 offsets into the exact extracted text, matching browser text selection. */
export type ResearchReadingRange = { start: number; end: number };
export type ResearchReadingEvidence = ResearchReadingRange & { articleId: string; sourceId: string; mode: 'full' | 'selection'; truncated: boolean };
export const RESEARCH_READING_BYTES = 32_000;
export const RESEARCH_READING_SOURCES = 3;
export type ResearchReadingSelection = { articleId: string; mode: 'full' | 'selection'; range?: ResearchReadingRange };
export function validResearchReadingRange(text: string, range: ResearchReadingRange): boolean {
  const { start, end } = range;
  const splitsPair = (at: number) => at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]!) && /[\uDC00-\uDFFF]/.test(text[at]!);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= text.length
    && !splitsPair(start) && !splitsPair(end) && !!text.slice(start, end).trim();
}
export function validResearchArticle(value: unknown, result: ResearchResult): value is ResearchArticle {
  if (!value || typeof value !== 'object') return false;
  const article = value as ResearchArticle, source = result.sources.find(item => item.id === article.sourceId);
  return !!source && article.searchId === result.searchId && article.url === source.url && article.title === source.title
    && typeof article.text === 'string' && !!article.text.trim() && article.text.length <= RESEARCH_ARTICLE_LIMIT
    && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(article.text)
    && Number.isSafeInteger(article.fetchedAt) && article.fetchedAt > 0 && article.fetchedAt <= 8_640_000_000_000_000
    && typeof article.truncated === 'boolean'
    && (article.articleId === undefined || typeof article.articleId === 'string' && /^[a-f0-9-]{36}$/.test(article.articleId));
}
export type ResearchSynthesis = { searchId: string; paragraphs: { text: string; citations: string[] }[]; caveat: string };
export function validResearchSynthesis(value: unknown, result: ResearchResult, selected: string[]): value is ResearchSynthesis {
  if (!value || typeof value !== 'object') return false;
  const answer = value as ResearchSynthesis;
  const text = (v: unknown, max: number) => typeof v === 'string' && !!v.trim() && v.length <= max
    && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(v);
  return answer.searchId === result.searchId && text(answer.caveat, 1000)
    && Array.isArray(answer.paragraphs) && answer.paragraphs.length > 0 && answer.paragraphs.length <= 8
    && answer.paragraphs.every(p => p && text(p.text, 2000) && Array.isArray(p.citations) && p.citations.length > 0
      && p.citations.length <= RESEARCH_RESULT_LIMIT && new Set(p.citations).size === p.citations.length
      && p.citations.every(id => selected.includes(id) && result.sources.some(source => source.id === id)));
}
export function researchQuery(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > RESEARCH_QUERY_LIMIT || /[\x00-\x1f\x7f]/.test(value)) return undefined;
  return value.trim() || undefined;
}
export function researchSourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    url.hash = '';
    return url.href.length <= 2048 ? url.href : undefined;
  } catch { return undefined; }
}
export function validResearchResult(value: unknown): value is ResearchResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as ResearchResult;
  if (typeof result.searchId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result.searchId)
    || typeof result.query !== 'string' || researchQuery(result.query) !== result.query
    || !Number.isSafeInteger(result.fetchedAt) || result.fetchedAt <= 0 || result.fetchedAt > 8_640_000_000_000_000
    || !Array.isArray(result.sources) || result.sources.length > RESEARCH_RESULT_LIMIT) return false;
  const urls = new Set<string>();
  return result.sources.every((source, index) => {
    if (!source || source.id !== `S${index + 1}` || typeof source.title !== 'string' || !source.title || source.title.length > 240
      || typeof source.snippet !== 'string' || source.snippet.length > 1200 || !researchSourceUrl(source.url)
      || researchSourceUrl(source.url) !== source.url || urls.has(source.url)) return false;
    urls.add(source.url); return true;
  });
}
export function researchCitation(result: ResearchResult, source: ResearchSource): string {
  return JSON.stringify({ version: 1, kind: 'search-snippet', searchId: result.searchId, query: result.query,
    fetchedAt: new Date(result.fetchedAt).toISOString(), source: { id: source.id, title: source.title, url: source.url, snippet: source.snippet } }, null, 2);
}
