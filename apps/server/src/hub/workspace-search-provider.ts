import { RESEARCH_RESULT_LIMIT, researchSourceUrl, type ResearchSource } from '@agentopsdeck/shared';

export type ResearchProvider = 'searxng' | 'tavily';
export class ResearchError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 409 | 413 | 429 | 502 | 503 | 504, readonly code: string) { super(code); }
}

const plain = (value: unknown, max: number) => typeof value === 'string'
  ? value.replace(/<[^<>]*>/g, '').replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, max) : '';

/** Both providers expose results[].{url,title,content}. Never pass provider extras
 * (answers, raw HTML, image URLs, usage or credentials) to the browser/AI reader. */
export function projectResearchSources(value: unknown): ResearchSource[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { results?: unknown }).results)) throw new ResearchError(502, 'invalid_provider_response');
  const sources: ResearchSource[] = [], seen = new Set<string>();
  for (const result of (value as { results: unknown[] }).results.slice(0, 100)) {
    if (!result || typeof result !== 'object') continue;
    const row = result as Record<string, unknown>, url = researchSourceUrl(row.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({ id: `S${sources.length + 1}`, url, title: plain(row.title, 240) || new URL(url).hostname.slice(0, 240), snippet: plain(row.content, 1200) });
    if (sources.length === RESEARCH_RESULT_LIMIT) break;
  }
  return sources;
}

/** Pure protocol adapters. Transport, auth rechecks, byte/time budgets and
 * snapshots remain in WorkspaceResearch, so providers cannot bypass them. */
interface SearchProviderAdapter {
  request(query: string, token?: string): { headers: Record<string, string>; body: string | URLSearchParams };
  project(value: unknown): ResearchSource[];
}
const providers: Record<ResearchProvider, SearchProviderAdapter> = {
  searxng: {
    request: (query, token) => ({
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: new URLSearchParams({ q: query, format: 'json', pageno: '1', categories: 'general', safesearch: '1' }),
    }),
    project: projectResearchSources,
  },
  tavily: {
    request: (query, token) => {
      if (!token) throw new ResearchError(503, 'search_provider_unavailable');
      return {
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ query, topic: 'general', search_depth: 'basic', max_results: RESEARCH_RESULT_LIMIT,
          auto_parameters: false, include_answer: false, include_raw_content: false, include_images: false }),
      };
    },
    project: projectResearchSources,
  },
};

export function searchProvider(provider: ResearchProvider = 'searxng'): SearchProviderAdapter {
  if (provider !== 'searxng' && provider !== 'tavily') throw new ResearchError(503, 'search_provider_unavailable');
  return providers[provider];
}
