import { RESEARCH_READING_BYTES, validResearchArticle, validResearchReadingRange, validResearchSynthesis, type ResearchArticle, type ResearchReadingEvidence, type ResearchResult, type ResearchSynthesis } from '@agentopsdeck/shared';

type Selection = { start: number; end: number; backward: boolean };
/** Non-editing navigation for readonly controls; offsets never split a surrogate pair. */
export function readingSelection(text: string, selection: Selection, key: string, shift: boolean, documentEdge: boolean): Selection {
  const { start, end, backward } = selection, anchor = backward ? end : start, focus = backward ? start : end;
  let next = focus;
  if (key === 'ArrowLeft') next = !shift && start < end ? start : Math.max(0, focus - (focus > 1 && /[\uDC00-\uDFFF]/.test(text[focus - 1]!) ? 2 : 1));
  if (key === 'ArrowRight') next = !shift && start < end ? end : Math.min(text.length, focus + ((text.codePointAt(focus) ?? 0) > 0xffff ? 2 : 1));
  if (key === 'Home') next = documentEdge ? 0 : focus === 0 ? 0 : text.lastIndexOf('\n', focus - 1) + 1;
  if (key === 'End') { const newline = text.indexOf('\n', focus); next = documentEdge || newline < 0 ? text.length : newline; }
  return { start: shift ? Math.min(anchor, next) : next, end: shift ? Math.max(anchor, next) : next, backward: shift && next < anchor };
}

/** Measure wrapped text only on an explicit citation jump, not on every render or keystroke. */
export function revealReadingRange(element: HTMLTextAreaElement, start: number, end: number) {
  element.focus(); element.setSelectionRange(start, end);
  const style = getComputedStyle(element), mirror = document.createElement('div'), marker = document.createElement('span');
  Object.assign(mirror.style, { position: 'fixed', left: '-100000px', top: '0', visibility: 'hidden',
    boxSizing: 'border-box', width: `${element.clientWidth}px`, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
    font: style.font, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, wordSpacing: style.wordSpacing,
    padding: style.padding, tabSize: style.tabSize, direction: style.direction, textAlign: style.textAlign });
  mirror.textContent = element.value.slice(0, start); marker.textContent = element.value.slice(start, start + 1) || ' ';
  mirror.append(marker); document.body.append(mirror);
  try { element.scrollTop = Math.max(0, marker.offsetTop - element.clientHeight / 4); }
  finally { mirror.remove(); }
  element.scrollIntoView({ block: 'nearest' });
}

/** Copy text and its provenance as inert data. Never writes to a session or executes a card. */
export function readingCitation(result: ResearchResult, article: ResearchArticle, answer: ResearchSynthesis & { evidence: ResearchReadingEvidence }): string {
  const evidence = answer.evidence;
  if (!validResearchArticle(article, result) || !validResearchSynthesis(answer, result, [article.sourceId])
    || evidence.articleId !== article.articleId || evidence.sourceId !== article.sourceId || evidence.truncated !== article.truncated
    || !['full', 'selection'].includes(evidence.mode) || !validResearchReadingRange(article.text, evidence)
    || (evidence.mode === 'full' && (evidence.start !== 0 || evidence.end !== article.text.length))) throw Error('Invalid reading citation');
  const text = article.text.slice(evidence.start, evidence.end);
  if (new TextEncoder().encode(text).byteLength > RESEARCH_READING_BYTES) throw Error('Reading citation too large');
  return JSON.stringify({ version: 1, kind: 'article-reading', query: result.query,
    source: { id: article.sourceId, title: article.title, url: article.url, fetchedAt: new Date(article.fetchedAt).toISOString(),
      scope: evidence.mode, truncated: article.truncated, range: { start: evidence.start, end: evidence.end, unit: 'UTF-16' }, text },
    summary: { verified: false, paragraphs: answer.paragraphs, caveat: answer.caveat } }, null, 2);
}
