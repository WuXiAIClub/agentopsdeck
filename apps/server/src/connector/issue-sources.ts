import { createHash } from 'node:crypto';
import { IssueReadError, type IssuePage, type IssueQuery, type ReadOnlyIssueAdapter } from '../hub/issue-card-reader.js';

/** Configuration is operator-owned. Cards receive IDs/capabilities, never
 * credentials or a user-selectable API URL. GitHub uses immutable GraphQL IDs;
 * GitLab uses immutable numeric project IDs. No remote write is implemented. */
export type IssueSource = { id: string; label: string; provider: 'github' | 'gitlab'; origin: string; project: string; token: string; epoch: string; workItemPath?: string };
export function parseIssueSources(input: string | undefined, env: Record<string, string | undefined>): IssueSource[] {
  if (!input) return [];
  const invalid = () => new Error('Invalid AOD_ISSUE_SOURCES_JSON; expected bounded explicit HTTPS sources and private token environment references');
  if (Buffer.byteLength(input) > 32768) throw invalid();
  let values: unknown; try { values = JSON.parse(input); } catch { throw invalid(); }
  if (!Array.isArray(values) || values.length > 16) throw invalid();
  const ids = new Set<string>();
  return values.map(value => {
    if (!value || typeof value !== 'object' || Object.keys(value).some(k => !['id', 'label', 'provider', 'origin', 'project', 'tokenEnv', 'workItemPath'].includes(k))
      || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.id) || ids.has(value.id)
      || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 128 || /[\u0000-\u001f\u007f]/.test(value.label)
      || !['github', 'gitlab'].includes(value.provider) || typeof value.origin !== 'string' || typeof value.project !== 'string'
      || (value.provider === 'gitlab' ? !/^[1-9][0-9]{0,18}$/.test(value.project) || !Number.isSafeInteger(Number(value.project)) : !/^[a-zA-Z0-9_=-]{1,256}$/.test(value.project))
      || typeof value.tokenEnv !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(value.tokenEnv)) throw invalid();
    if (value.workItemPath !== undefined && (value.provider !== 'gitlab' || typeof value.workItemPath !== 'string'
      || value.workItemPath.length > 512 || !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(value.workItemPath)
      || value.workItemPath.split('/').some((part: string) => ['.', '..'].includes(part)))) throw invalid();
    let url: URL; try { url = new URL(value.origin); } catch { throw invalid(); }
    if (url.protocol !== 'https:' || url.origin !== value.origin || url.username || url.password) throw invalid();
    const token = env[value.tokenEnv]; if (!token || token.length > 8192 || /[\u0000-\u0020\u007f]/.test(token)) throw invalid();
    ids.add(value.id);
    const epoch = createHash('sha256').update(JSON.stringify([value.provider, value.origin, value.project, token, value.workItemPath])).digest('hex');
    return { id: value.id, label: value.label, provider: value.provider, origin: value.origin, project: value.project, token, epoch,
      ...(value.workItemPath ? { workItemPath: value.workItemPath } : {}) };
  });
}

const GITHUB_QUERY = 'query ReadIssues($id:ID!,$first:Int!,$after:String,$states:[IssueState!]){node(id:$id){... on Repository{id issues(first:$first,after:$after,states:$states,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{id number title state url body updatedAt labels(first:20){nodes{name} pageInfo{hasNextPage}} assignees(first:20){nodes{login} pageInfo{hasNextPage}}} pageInfo{hasNextPage endCursor}}}}}';
// Explicit opt-in: older GitLab schemas may reject this query; never fallback
// to ordinary issues or drop the requested resource kind silently.
const WORK_ITEMS_QUERY = 'query ReadWorkItems($path:ID!,$first:Int!,$after:String,$state:IssuableState){project(fullPath:$path){id workItems(first:$first,after:$after,state:$state,sort:UPDATED_DESC){nodes{id iid title state webUrl updatedAt workItemType{name} project{id} widgets{... on WorkItemWidgetDescription{description} ... on WorkItemWidgetLabels{labels(first:20){nodes{title} pageInfo{hasNextPage}}} ... on WorkItemWidgetAssignees{assignees(first:20){nodes{username} pageInfo{hasNextPage}}}}} pageInfo{hasNextPage endCursor}}}}';
function connectionValues(connection: any, field: string): string[] {
  if (!connection || !Array.isArray(connection.nodes) || connection.nodes.length > 20 || typeof connection.pageInfo?.hasNextPage !== 'boolean') throw new IssueReadError('metadata-shape');
  return connection.nodes.map((node: any) => node?.[field]);
}
const budget = 256 * 1024;
async function boundedJson(response: Response) {
  if (Number(response.headers.get('content-length')) > budget) { await response.body?.cancel(); throw new IssueReadError('response-budget'); }
  const reader = response.body?.getReader(); if (!reader) throw new IssueReadError('empty-response');
  let bytes = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength; if (bytes > budget) throw new IssueReadError('response-budget'); chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as any;
  } finally { await reader.cancel(); reader.releaseLock(); }
}

export class IssueProviderAdapter implements ReadOnlyIssueAdapter {
  constructor(private readonly sources: readonly IssueSource[], private readonly fetcher: typeof fetch = fetch) {}
  async list(query: IssueQuery, cursor: string | null, signal: AbortSignal): Promise<IssuePage> {
    const source = this.sources.find(s => s.id === query.connection && s.project === query.project);
    if (!source || !['issue', 'work_item'].includes(query.kind) || query.kind === 'work_item' && (source.provider !== 'gitlab' || !source.workItemPath) || !['', 'open', 'closed', 'all'].includes(query.filter)) throw new IssueReadError('unsupported-query');
    if (cursor && (cursor.length > 2048 || /[\u0000-\u001f\u007f]/.test(cursor))) throw new IssueReadError('cursor');
    let url: URL, init: RequestInit;
    if (query.kind === 'work_item') {
      url = new URL(`${source.origin}/api/graphql`);
      init = { method: 'POST', headers: { authorization: `Bearer ${source.token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query: WORK_ITEMS_QUERY, variables: { path: source.workItemPath, first: query.limit, after: cursor,
          state: query.filter === 'open' ? 'opened' : query.filter || 'all' } }) };
    } else if (source.provider === 'github') {
      url = new URL(source.origin === 'https://github.com' ? 'https://api.github.com/graphql' : `${source.origin}/api/graphql`);
      init = { method: 'POST', headers: { authorization: `Bearer ${source.token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query: GITHUB_QUERY, variables: { id: source.project, first: query.limit, after: cursor,
          states: query.filter === 'open' ? ['OPEN'] : query.filter === 'closed' ? ['CLOSED'] : ['OPEN', 'CLOSED'] } }) };
    } else {
      if (cursor && !/^[1-9][0-9]{0,5}$/.test(cursor)) throw new IssueReadError('cursor');
      url = new URL(`${source.origin}/api/v4/projects/${source.project}/issues`);
      url.search = new URLSearchParams({ scope: 'all', issue_type: 'issue', state: query.filter === 'open' ? 'opened' : query.filter || 'all', order_by: 'updated_at', sort: 'desc', per_page: String(query.limit), page: cursor || '1' }).toString();
      init = { method: 'GET', headers: { 'PRIVATE-TOKEN': source.token, accept: 'application/json' } };
    }
    const response = await this.fetcher(url, { ...init, signal, redirect: 'error' });
    if (response.status === 429 || response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
      const retry = response.headers.get('retry-after'), seconds = retry && /^\d+$/.test(retry) ? Math.min(86400, Number(retry)) : 60;
      await response.body?.cancel(); return { items: [], nextCursor: cursor, completeness: 'partial', retryAfter: seconds };
    }
    if (!response.ok) { await response.body?.cancel(); throw new IssueReadError('provider-unavailable'); }
    const value = await boundedJson(response);
    if (query.kind === 'work_item') {
      const project = value?.data?.project, connection = project?.workItems;
      if (value?.errors || project?.id !== `gid://gitlab/Project/${source.project}` || !Array.isArray(connection?.nodes)
        || typeof connection?.pageInfo?.hasNextPage !== 'boolean' || connection.pageInfo.hasNextPage && !connection.pageInfo.endCursor) throw new IssueReadError('provider-shape');
      const items = connection.nodes.map((item: any) => {
        if (item?.project?.id !== project.id || typeof item?.id !== 'string' || !/^gid:\/\/gitlab\/WorkItem\/[1-9][0-9]*$/.test(item.id) || !Array.isArray(item.widgets) || item.widgets.length > 64) throw new IssueReadError('provider-shape');
        const descriptions = item.widgets.filter((w: any) => w && Object.hasOwn(w, 'description')),
          labels = item.widgets.filter((w: any) => w && Object.hasOwn(w, 'labels')),
          assignees = item.widgets.filter((w: any) => w && Object.hasOwn(w, 'assignees'));
        if ([descriptions, labels, assignees].some(list => list.length > 1)) throw new IssueReadError('widget-shape');
        return { remoteId: item.id, number: item.iid, title: item.title, state: item.state, url: item.webUrl, body: descriptions[0]?.description ?? null,
          updatedAt: Date.parse(item.updatedAt), typeName: item.workItemType?.name,
          labels: labels.length ? connectionValues(labels[0].labels, 'title') : [], assignees: assignees.length ? connectionValues(assignees[0].assignees, 'username') : [],
          metadataPartial: labels[0]?.labels.pageInfo.hasNextPage === true || assignees[0]?.assignees.pageInfo.hasNextPage === true };
      });
      return { items, nextCursor: connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null, completeness: 'complete', retryAfter: null };
    }
    if (source.provider === 'github') {
      const node = value?.data?.node, connection = node?.issues;
      if (value?.errors || node?.id !== source.project || !Array.isArray(connection?.nodes) || typeof connection?.pageInfo?.hasNextPage !== 'boolean'
        || connection.pageInfo.hasNextPage && (typeof connection.pageInfo.endCursor !== 'string' || !connection.pageInfo.endCursor)) throw new IssueReadError('provider-shape');
      return { items: connection.nodes.map((item: any) => ({ remoteId: item.id, title: item.title, state: item.state, url: item.url, body: item.body ?? null, updatedAt: Date.parse(item.updatedAt),
        number: String(item.number), labels: connectionValues(item.labels, 'name'), assignees: connectionValues(item.assignees, 'login'), metadataPartial: item.labels.pageInfo.hasNextPage || item.assignees.pageInfo.hasNextPage })),
        nextCursor: connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null, completeness: 'complete', retryAfter: null };
    }
    if (!Array.isArray(value) || value.some(item => !Number.isSafeInteger(item?.id) || item.id < 1 || !Number.isSafeInteger(item?.project_id) || item.project_id.toString() !== source.project || item.issue_type !== undefined && item.issue_type !== 'issue')) throw new IssueReadError('provider-shape');
    const next = response.headers.get('x-next-page');
    if (next && (!/^[1-9][0-9]{0,5}$/.test(next) || Number(next) <= Number(cursor || 1))) throw new IssueReadError('provider-cursor');
    return { items: value.map(item => ({ remoteId: String(item.id), title: item.title, state: item.state, url: item.web_url, body: item.description ?? null, updatedAt: Date.parse(item.updated_at),
      number: String(item.iid), labels: item.labels, assignees: Array.isArray(item.assignees) ? item.assignees.map((a: any) => a?.username) : undefined, metadataPartial: false })),
      nextCursor: next || null, completeness: value.length === query.limit && !response.headers.has('x-next-page') ? 'partial' : 'complete', retryAfter: null };
  }
}
