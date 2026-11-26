import type { GitRepoPullRequestSummary, GitRepoStatus, GitRepoWorkflowRun } from '@agentopsdeck/shared';
import { normalizeGitRepoSlug, type GitStatusAccountConfig } from './config.js';

export const GIT_STATUS_CACHE_TTL_MS = 30_000;
const REFRESH_COOLDOWN_MS = 5_000;
const FAILURE_BACKOFF_MS = 5_000;
const MAX_CACHE_ENTRIES = 64;
const MAX_RESPONSE_BYTES = 512 * 1024;
const UPSTREAM_TIMEOUT_MS = 12_000;

export type GitStatusErrorCode =
  | 'invalid_git_repo'
  | 'unknown_git_account'
  | 'git_repo_not_found'
  | 'git_auth_required'
  | 'git_rate_limited'
  | 'git_repo_status_unavailable';

export class GitRepoStatusError extends Error {
  constructor(
    readonly code: GitStatusErrorCode,
    readonly status: 400 | 403 | 404 | 429 | 503,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = 'GitRepoStatusError';
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const safeText = (value: unknown, maxLen: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return cleaned ? cleaned.slice(0, maxLen) : undefined;
};

const safeHttpsUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
};

const parseIsoTimestamp = (value: unknown): number | null => {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

const parseNonNegativeInt = (value: unknown): number => {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
};

const parseHeaderInt = (value: string | null): number | null => {
  if (!value || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
};

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new GitRepoStatusError('git_repo_status_unavailable', 503);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new GitRepoStatusError('git_repo_status_unavailable', 503);
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new GitRepoStatusError('git_repo_status_unavailable', 503);
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof GitRepoStatusError) throw error;
    throw new GitRepoStatusError('git_repo_status_unavailable', 503);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function extractRetryAfter(response: Response): number {
  const retryHeader = parseHeaderInt(response.headers.get('retry-after'));
  if (retryHeader !== null && retryHeader > 0) return Math.min(3600, retryHeader);
  const resetEpoch = parseHeaderInt(response.headers.get('x-ratelimit-reset'));
  if (resetEpoch !== null) {
    const delta = Math.ceil(resetEpoch - Date.now() / 1000);
    if (delta > 0) return Math.min(3600, delta);
  }
  return 60;
}

function classifyFailure(response: Response): GitRepoStatusError {
  if (response.status === 404) return new GitRepoStatusError('git_repo_not_found', 404);
  if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
    return new GitRepoStatusError('git_rate_limited', 429, extractRetryAfter(response));
  }
  if (response.status === 401 || response.status === 403) {
    return new GitRepoStatusError('git_auth_required', 403);
  }
  return new GitRepoStatusError('git_repo_status_unavailable', 503);
}

function parsePullRequests(raw: unknown): GitRepoPullRequestSummary[] {
  if (!Array.isArray(raw)) return [];
  const items: GitRepoPullRequestSummary[] = [];
  for (const entry of raw.slice(0, 8)) {
    const pr = asRecord(entry);
    if (!pr) continue;
    const number = parseNonNegativeInt(pr.number);
    const title = safeText(pr.title, 180);
    const url = safeHttpsUrl(pr.html_url);
    const updatedAt = parseIsoTimestamp(pr.updated_at) ?? parseIsoTimestamp(pr.created_at) ?? Date.now();
    if (!number || !title || !url) continue;
    const user = asRecord(pr.user);
    const head = asRecord(pr.head);
    const base = asRecord(pr.base);
    const draft = pr.draft === true;
    const merged = typeof pr.merged_at === 'string' && pr.merged_at.length > 0;
    const state: GitRepoPullRequestSummary['state'] =
      merged ? 'merged' : pr.state === 'closed' ? 'closed' : draft ? 'draft' : 'open';
    const headRef = safeText(head?.ref, 80);
    const baseRef = safeText(base?.ref, 80);
    items.push({
      number,
      title,
      state,
      author: safeText(user?.login, 60) ?? 'unknown',
      url,
      updatedAt,
      ...(headRef ? { headRef } : {}),
      ...(baseRef ? { baseRef } : {}),
      ...(typeof pr.comments === 'number' && Number.isFinite(pr.comments) ? { comments: Math.max(0, Math.trunc(pr.comments)) } : {}),
    });
  }
  return items;
}

const VALID_CONCLUSIONS = new Set([
  'success', 'failure', 'cancelled', 'skipped', 'timed_out', 'action_required', 'neutral', 'stale',
]);

function parseWorkflowRuns(raw: unknown): GitRepoWorkflowRun[] {
  const root = asRecord(raw);
  const runs = Array.isArray(root?.workflow_runs) ? root.workflow_runs : [];
  const parsed: GitRepoWorkflowRun[] = [];
  for (const entry of runs.slice(0, 10)) {
    const run = asRecord(entry);
    if (!run) continue;
    const id = parseNonNegativeInt(run.id);
    const name = safeText(run.name, 120) ?? safeText(run.display_title, 120);
    const url = safeHttpsUrl(run.html_url);
    const updatedAt = parseIsoTimestamp(run.updated_at) ?? parseIsoTimestamp(run.created_at) ?? Date.now();
    if (!id || !name || !url) continue;
    const rawStatus = run.status;
    const status: GitRepoWorkflowRun['status'] =
      rawStatus === 'queued' || rawStatus === 'waiting' || rawStatus === 'pending' || rawStatus === 'requested'
        ? 'queued'
        : rawStatus === 'in_progress'
          ? 'in_progress'
          : rawStatus === 'completed'
            ? 'completed'
            : 'unknown';
    const rawConclusion = typeof run.conclusion === 'string' ? run.conclusion : null;
    const conclusion = rawConclusion && VALID_CONCLUSIONS.has(rawConclusion)
      ? rawConclusion as GitRepoWorkflowRun['conclusion']
      : null;
    parsed.push({
      id,
      name,
      status,
      conclusion,
      branch: safeText(run.head_branch, 80) ?? 'main',
      event: safeText(run.event, 40) ?? 'push',
      url,
      updatedAt,
    });
  }
  return parsed;
}

function summarizeActions(runs: GitRepoWorkflowRun[]): GitRepoStatus['actions'] {
  let passingCount = 0;
  let failingCount = 0;
  let runningCount = 0;
  for (const run of runs) {
    if (run.status === 'queued' || run.status === 'in_progress') {
      runningCount += 1;
    } else if (run.conclusion === 'success') {
      passingCount += 1;
    } else if (run.conclusion === 'failure' || run.conclusion === 'timed_out' || run.conclusion === 'action_required') {
      failingCount += 1;
    }
  }
  const decided = passingCount + failingCount;
  const successRate = decided > 0 ? passingCount / decided : null;
  const latest = runs[0];
  let latestStatus: GitRepoStatus['actions']['latestStatus'] = 'none';
  if (latest) {
    if (latest.status === 'queued' || latest.status === 'in_progress') latestStatus = 'running';
    else if (latest.conclusion === 'success') latestStatus = 'success';
    else if (latest.conclusion === 'failure' || latest.conclusion === 'timed_out' || latest.conclusion === 'action_required') latestStatus = 'failure';
    else latestStatus = 'neutral';
  }
  return {
    totalRecent: runs.length,
    passingCount,
    failingCount,
    runningCount,
    successRate,
    latestStatus,
    runs,
  };
}

export function createGitRepoStatusReader(
  accounts: readonly GitStatusAccountConfig[],
  options: {
    fetcher?: typeof fetch;
    now?: () => number;
    wallClock?: () => number;
  } = {},
) {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => performance.now());
  const wallClock = options.wallClock ?? (() => Date.now());
  const inflight = new Map<string, Promise<GitRepoStatus>>();
  const cache = new Map<string, { value: GitRepoStatus; cachedAt: number; expiresAt: number }>();
  const backoff = new Map<string, number>();

  function rememberCache(key: string, value: GitRepoStatus) {
    const current = now();
    cache.delete(key);
    cache.set(key, { value, cachedAt: current, expiresAt: current + GIT_STATUS_CACHE_TTL_MS });
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  async function githubGet(account: GitStatusAccountConfig, pathAndQuery: string, signal?: AbortSignal): Promise<Response> {
    const url = new URL(pathAndQuery, account.apiOrigin);
    if (url.origin !== account.apiOrigin) {
      throw new GitRepoStatusError('invalid_git_repo', 400);
    }
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'AgentOpsDeck',
      'x-github-api-version': '2022-11-28',
    };
    if (account.token) headers.authorization = `Bearer ${account.token}`;
    const timeoutSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      return await fetcher(url, { method: 'GET', headers, redirect: 'error', signal: combinedSignal });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new GitRepoStatusError('git_repo_status_unavailable', 503);
    }
  }

  return async function readGitRepoStatus(params: {
    repo: string;
    accountId?: string;
    refresh?: boolean;
    signal?: AbortSignal;
  }): Promise<GitRepoStatus> {
    const slug = normalizeGitRepoSlug(params.repo);
    if (!slug) throw new GitRepoStatusError('invalid_git_repo', 400);
    const requestedAccountId = params.accountId?.trim();
    const account = requestedAccountId
      ? accounts.find(item => item.id === requestedAccountId)
      : accounts[0];
    if (!account) throw new GitRepoStatusError('unknown_git_account', 400);

    const cacheKey = `${account.id}:${slug.toLowerCase()}`;
    const current = now();
    const existing = cache.get(cacheKey);
    const refreshAllowed = params.refresh === true && (!existing || current - existing.cachedAt >= REFRESH_COOLDOWN_MS);
    if (existing && !refreshAllowed && current < existing.expiresAt) {
      return existing.value;
    }

    const pending = inflight.get(cacheKey);
    if (pending) return pending;

    const retryUntil = backoff.get(cacheKey) ?? 0;
    if (!refreshAllowed && current < retryUntil) {
      if (existing) return existing.value;
      throw new GitRepoStatusError('git_repo_status_unavailable', 503);
    }

    const [owner, name] = slug.split('/') as [string, string];
    const encodedOwner = encodeURIComponent(owner);
    const encodedName = encodeURIComponent(name);

    const task = (async (): Promise<GitRepoStatus> => {
      try {
        const repoResponse = await githubGet(account, `/repos/${encodedOwner}/${encodedName}`, params.signal);
        if (!repoResponse.ok) {
          await repoResponse.body?.cancel();
          throw classifyFailure(repoResponse);
        }
        const repoRaw = asRecord(await readBoundedJson(repoResponse));
        const repoUrl = safeHttpsUrl(repoRaw?.html_url);
        const fullName = safeText(repoRaw?.full_name, 160) ?? slug;
        if (!repoRaw || !repoUrl) {
          throw new GitRepoStatusError('git_repo_status_unavailable', 503);
        }

        const rateRemaining = parseHeaderInt(repoResponse.headers.get('x-ratelimit-remaining'));
        const rateLimit = parseHeaderInt(repoResponse.headers.get('x-ratelimit-limit'));
        const rateResetEpoch = parseHeaderInt(repoResponse.headers.get('x-ratelimit-reset'));

        const prSearchQuery = encodeURIComponent(`repo:${owner}/${name} is:pr is:open`);
        const [pullsRes, prCountRes, actionsRes] = await Promise.all([
          githubGet(account, `/repos/${encodedOwner}/${encodedName}/pulls?state=open&sort=updated&direction=desc&per_page=20`, params.signal).catch(() => undefined),
          githubGet(account, `/search/issues?q=${prSearchQuery}&per_page=1`, params.signal).catch(() => undefined),
          githubGet(account, `/repos/${encodedOwner}/${encodedName}/actions/runs?per_page=10`, params.signal).catch(() => undefined),
        ]);

        let rawPulls: unknown = [];
        if (pullsRes) {
          if (pullsRes.ok) rawPulls = await readBoundedJson(pullsRes).catch(() => []);
          else await pullsRes.body?.cancel();
        }
        const pulls = parsePullRequests(rawPulls);
        const rawPullsArray = Array.isArray(rawPulls) ? rawPulls : [];
        let openPrCount = rawPullsArray.length;
        if (prCountRes) {
          if (prCountRes.ok) {
            const searchJson = asRecord(await readBoundedJson(prCountRes).catch(() => undefined));
            if (typeof searchJson?.total_count === 'number' && Number.isFinite(searchJson.total_count) && searchJson.total_count >= 0) {
              openPrCount = Math.trunc(searchJson.total_count);
            }
          } else {
            await prCountRes.body?.cancel();
          }
        }
        const draftCount = rawPullsArray.reduce<number>((sum, item) => sum + (asRecord(item)?.draft === true ? 1 : 0), 0);

        let runs: GitRepoWorkflowRun[] = [];
        if (actionsRes) {
          if (actionsRes.ok) {
            const actionsJson = await readBoundedJson(actionsRes).catch(() => undefined);
            runs = parseWorkflowRuns(actionsJson);
          } else {
            await actionsRes.body?.cancel();
          }
        }

        const combinedOpenIssues = parseNonNegativeInt(repoRaw.open_issues_count);
        const pureOpenIssues = Math.max(0, combinedOpenIssues - openPrCount);

        const status: GitRepoStatus = {
          sampledAt: wallClock(),
          provider: 'github',
          accountId: account.id,
          accountLabel: account.label,
          authenticated: Boolean(account.token),
          repository: {
            owner,
            name,
            fullName,
            description: safeText(repoRaw.description, 240) ?? null,
            url: repoUrl,
            defaultBranch: safeText(repoRaw.default_branch, 80) ?? 'main',
            isPrivate: repoRaw.private === true,
            stars: parseNonNegativeInt(repoRaw.stargazers_count),
            forks: parseNonNegativeInt(repoRaw.forks_count),
            pushedAt: parseIsoTimestamp(repoRaw.pushed_at),
          },
          pullRequests: {
            openCount: openPrCount,
            draftCount,
            items: pulls,
          },
          issues: {
            openCount: pureOpenIssues,
          },
          actions: summarizeActions(runs),
          rateLimit: {
            remaining: rateRemaining,
            limit: rateLimit,
            resetAt: rateResetEpoch !== null ? rateResetEpoch * 1000 : null,
          },
        };

        rememberCache(cacheKey, status);
        backoff.delete(cacheKey);
        return status;
      } catch (error) {
        if (error instanceof GitRepoStatusError && error.status === 503) {
          backoff.set(cacheKey, now() + FAILURE_BACKOFF_MS);
          if (existing) return existing.value;
        }
        throw error;
      } finally {
        inflight.delete(cacheKey);
      }
    })();

    inflight.set(cacheKey, task);
    return task;
  };
}
