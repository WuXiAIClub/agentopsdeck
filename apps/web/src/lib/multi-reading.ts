import { RESEARCH_READING_BYTES, RESEARCH_READING_SOURCES, validResearchArticle, validResearchReadingRange, validResearchSynthesis, type ResearchArticle, type ResearchReadingSelection, type ResearchReadingEvidence, type ResearchResult, type ResearchSynthesis } from '@agentopsdeck/shared';

export type ReadingDocument = { article: ResearchArticle; selection: ResearchReadingSelection };
export type MultiReadingAnswer = ResearchSynthesis & { evidence: ResearchReadingEvidence[] };
export function readingDocuments(result: ResearchResult, documents: ReadingDocument[]) {
  if (documents.length < 2 || documents.length > RESEARCH_READING_SOURCES || new Set(documents.map(d => d.article.sourceId)).size !== documents.length) throw Error('Invalid reading sources');
  const inputs = documents.map(({ article, selection }) => {
    const range = selection.mode === 'full' ? { start: 0, end: article.text.length } : selection.range;
    if (!validResearchArticle(article, result) || !article.articleId || selection.articleId !== article.articleId
      || !['full', 'selection'].includes(selection.mode) || (selection.mode === 'full' && selection.range !== undefined)
      || !range || !validResearchReadingRange(article.text, range)) throw Error('Invalid reading selection');
    return { article, text: article.text.slice(range.start, range.end), evidence: { articleId: article.articleId, sourceId: article.sourceId,
      mode: selection.mode, start: range.start, end: range.end, truncated: article.truncated } };
  });
  if (inputs.reduce((n, d) => n + new TextEncoder().encode(d.text).byteLength, 0) > RESEARCH_READING_BYTES) throw Error('Reading text too large');
  return inputs;
}
/** Verify response against the exact submitted scopes, not just a valid-looking range. */
export function multiReadingCitation(result: ResearchResult, documents: ReadingDocument[], value: unknown): string {
  const inputs = readingDocuments(result, documents);
  if (!validResearchSynthesis(value, result, inputs.map(d => d.article.sourceId))) throw Error('Invalid reading answer');
  const evidence = (value as MultiReadingAnswer).evidence;
  if (!Array.isArray(evidence) || evidence.length !== inputs.length || inputs.some((d, i) =>
    !evidence[i] || Object.entries(d.evidence).some(([key, expected]) => evidence[i]![key as keyof ResearchReadingEvidence] !== expected))) throw Error('Invalid reading evidence');
  const text = JSON.stringify({ version: 1, kind: 'multi-article-reading', query: result.query,
    sources: inputs.map(({ article, text, evidence }) => ({ id: article.sourceId, title: article.title, url: article.url,
      fetchedAt: new Date(article.fetchedAt).toISOString(), scope: evidence.mode, truncated: article.truncated,
      range: { start: evidence.start, end: evidence.end, unit: 'UTF-16' }, text })),
    summary: { verified: false, paragraphs: value.paragraphs.map(p => ({ text: p.text, citations: p.citations })), caveat: value.caveat } }, null, 2);
  if (new TextEncoder().encode(text).byteLength > 192 * 1024) throw Error('Reading export too large');
  return text;
}
