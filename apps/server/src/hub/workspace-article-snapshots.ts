import { randomUUID } from 'node:crypto';
import { RESEARCH_READING_BYTES, RESEARCH_READING_SOURCES, validResearchArticle, validResearchReadingRange, type ResearchArticle, type ResearchReadingEvidence, type ResearchReadingRange, type ResearchResult } from '@agentopsdeck/shared';
import { ResearchError } from './workspace-research.js';

export type ResearchReadingInput = { text: string; evidence: ResearchReadingEvidence };
export const ARTICLE_SNAPSHOT_TTL = 300_000;
const MAX_BYTES = 4 * 1024 * 1024, MAX_USERS = 16;
/** At most three extractions per owner/search; rereading a source replaces only
 * that source. Never persists, logs, or silently evicts another owner's data. */
export class WorkspaceArticleSnapshots {
  private entries = new Map<string, Map<string, { article: ResearchArticle; bytes: number; expires: number; timer: ReturnType<typeof setTimeout> }>>();
  private bytes = 0;
  constructor(private readonly now = Date.now) {}
  drop(user: string, sourceId?: string) {
    const entries = this.entries.get(user);
    if (!entries) return;
    for (const [id, old] of entries) if (sourceId === undefined || sourceId === id) {
      clearTimeout(old.timer); this.bytes -= old.bytes; entries.delete(id);
    }
    if (!entries.size) this.entries.delete(user);
  }
  close() { for (const user of this.entries.keys()) this.drop(user); }
  save(user: string, result: ResearchResult, article: ResearchArticle, retain = false): ResearchArticle {
    if (!validResearchArticle(article, result)) throw new ResearchError(502, 'invalid_article');
    for (const [owner, entries] of this.entries) for (const [id, entry] of entries) if (entry.expires <= this.now()) this.drop(owner, id);
    const saved = { ...article, articleId: randomUUID() };
    const bytes = Buffer.byteLength(JSON.stringify(saved), 'utf8');
    const current = this.entries.get(user);
    const replacingSearch = !!current && (!retain || [...current.values()].some(entry => entry.article.searchId !== result.searchId));
    const oldBytes = replacingSearch ? [...current!.values()].reduce((sum, entry) => sum + entry.bytes, 0) : current?.get(article.sourceId)?.bytes ?? 0;
    if ((!this.entries.has(user) && this.entries.size >= MAX_USERS) || this.bytes - oldBytes + bytes > MAX_BYTES)
      throw new ResearchError(429, 'article_snapshot_budget_exceeded');
    if (!replacingSearch && current && !current.has(article.sourceId) && current.size >= RESEARCH_READING_SOURCES)
      throw new ResearchError(429, 'article_snapshot_budget_exceeded');
    this.drop(user, replacingSearch ? undefined : article.sourceId);
    const timer = setTimeout(() => { if (this.entries.get(user)?.get(article.sourceId)?.article.articleId === saved.articleId) this.drop(user, article.sourceId); }, ARTICLE_SNAPSHOT_TTL); timer.unref();
    const entries = this.entries.get(user) ?? new Map();
    entries.set(article.sourceId, { article: saved, bytes, expires: this.now() + ARTICLE_SNAPSHOT_TTL, timer });
    this.entries.set(user, entries); this.bytes += bytes;
    return structuredClone(saved);
  }
  private current(user: string, result: ResearchResult, articleId: string): ResearchArticle {
    const entry = [...(this.entries.get(user)?.values() ?? [])].find(value => value.article.articleId === articleId);
    if (entry && entry.expires <= this.now()) this.drop(user, entry.article.sourceId);
    const article = entry && entry.expires > this.now() ? entry.article : undefined;
    const source = result.sources.find(source => source.id === article?.sourceId);
    // Stored data is validated once at admission and never exposed by reference.
    // Rechecks must not scan/clone the entire article every 250ms during synthesis.
    if (!article || article.articleId !== articleId || article.searchId !== result.searchId
      || !source || article.url !== source.url || article.title !== source.title) throw new ResearchError(409, 'article_expired');
    return article;
  }
  assertCurrent(user: string, result: ResearchResult, articleId: string): void { this.current(user, result, articleId); }
  get(user: string, result: ResearchResult, articleId: string): ResearchArticle {
    return structuredClone(this.current(user, result, articleId));
  }
  resolve(user: string, result: ResearchResult, articleId: string, mode: 'full' | 'selection', range?: ResearchReadingRange): ResearchReadingInput {
    const article = this.current(user, result, articleId);
    const selected = mode === 'full' ? { start: 0, end: article.text.length } : range;
    if (!selected || (mode === 'full' && range !== undefined) || !validResearchReadingRange(article.text, selected)) throw new ResearchError(400, 'invalid_article_selection');
    const text = article.text.slice(selected.start, selected.end);
    if (Buffer.byteLength(text, 'utf8') > RESEARCH_READING_BYTES) throw new ResearchError(413, 'article_selection_too_large');
    return { text, evidence: { articleId, sourceId: article.sourceId, mode, start: selected.start, end: selected.end, truncated: article.truncated } };
  }
}
