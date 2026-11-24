import { validResearchResult, validResearchSynthesis, type ResearchResult, type ResearchSynthesis } from '@agentopsdeck/shared';

/** Inert, bounded provenance: search snippets are not extracted article text. */
export function synthesisCitation(result: ResearchResult, answer: ResearchSynthesis, selected: string[]): string {
  if (!validResearchResult(result) || !Array.isArray(selected) || !selected.length || selected.length > 8
    || new Set(selected).size !== selected.length || selected.some(id => !result.sources.some(source => source.id === id))
    || !validResearchSynthesis(answer, result, selected)) throw Error('Invalid synthesis citation');
  const text = JSON.stringify({ version: 1, kind: 'search-synthesis', mode: 'snippets', query: result.query,
    fetchedAt: new Date(result.fetchedAt).toISOString(),
    sources: selected.map(id => {
      const source = result.sources.find(item => item.id === id)!;
      return { id: source.id, title: source.title, url: source.url, snippet: source.snippet };
    }),
    summary: { verified: false, paragraphs: answer.paragraphs.map(p => ({ text: p.text, citations: [...p.citations] })), caveat: answer.caveat },
  }, null, 2);
  // Includes JSON escaping and UTF-8 expansion, not just the source character count.
  if (new TextEncoder().encode(text).byteLength > 192 * 1024) throw Error('Synthesis citation too large');
  return text;
}
