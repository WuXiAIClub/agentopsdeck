import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeGitRepoSlug, parseGitStatusAccounts, publicGitAccountOptions } from './config.js';
import { createGitRepoStatusReader, GIT_STATUS_CACHE_TTL_MS, GitRepoStatusError } from './service.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('normalizeGitRepoSlug accepts owner/repo and GitHub URLs while rejecting traversal', () => {
  assert.equal(normalizeGitRepoSlug('WuXiAIClub/agentopsdeck'), 'WuXiAIClub/agentopsdeck');
  assert.equal(normalizeGitRepoSlug(' https://github.com/WuXiAIClub/agentopsdeck.git '), 'WuXiAIClub/agentopsdeck');
  assert.equal(normalizeGitRepoSlug('org/my.repo_1-a'), 'org/my.repo_1-a');
  for (const bad of ['', 'only-owner', 'a/b/c', '../secret', 'owner/..', 'owner/.', 'owner/repo?x=1', 'owner/repo#hash', '-bad/repo']) {
    assert.equal(normalizeGitRepoSlug(bad), undefined, bad);
  }
});

test('parseGitStatusAccounts supports public fallback, env JSON, token files and never leaks tokens', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aod-git-status-cfg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tokenFile = join(dir, 'token.txt');
  const linkFile = join(dir, 'token-link.txt');
  await writeFile(tokenFile, 'synthetic-test-token\n', 'utf8');
  await symlink(tokenFile, linkFile);

  const fallback = parseGitStatusAccounts({});
  assert.deepEqual(publicGitAccountOptions(fallback), [
    { id: 'public', label: 'GitHub (Public)', provider: 'github', authenticated: false },
  ]);

  const configured = parseGitStatusAccounts({
    AOD_GIT_ACCOUNTS_JSON: JSON.stringify([
      {
        id: 'work',
        label: 'Work Org',
        provider: 'github',
        tokenFile,
        defaultRepo: 'WuXiAIClub/agentopsdeck',
        repos: ['WuXiAIClub/agentopsdeck', 'WuXiAIClub/docs'],
      },
    ]),
  });
  assert.equal(configured[0]?.token, 'synthetic-test-token');
  const publicView = publicGitAccountOptions(configured);
  assert.equal(publicView[0]?.id, 'work');
  assert.equal(publicView[0]?.authenticated, true);
  assert.equal('token' in (publicView[0] as Record<string, unknown>), false);
  assert.deepEqual(publicView[0]?.repos, ['WuXiAIClub/agentopsdeck', 'WuXiAIClub/docs']);

  assert.throws(() => parseGitStatusAccounts({ AOD_GITHUB_TOKEN_FILE: linkFile }));
  assert.throws(() => parseGitStatusAccounts({ AOD_GITHUB_API_ORIGIN: 'http://api.github.com' }));
  assert.throws(() => parseGitStatusAccounts({ AOD_GITHUB_TOKEN: 'a', AOD_GITHUB_TOKEN_FILE: tokenFile }));
});

test('readGitRepoStatus aggregates repo, PRs, pure open issues, and Actions with caching and singleflight', async () => {
  let clock = 10_000;
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls += 1;
    const url = new URL(String(input));
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    assert.equal(auth, 'Bearer synthetic-token');
    assert.equal(init?.redirect, 'error');
    if (url.pathname === '/repos/WuXiAIClub/agentopsdeck') {
      return jsonResponse({
        full_name: 'WuXiAIClub/agentopsdeck',
        description: 'Bilingual agent operations deck',
        html_url: 'https://github.com/WuXiAIClub/agentopsdeck',
        default_branch: 'main',
        private: false,
        stargazers_count: 420,
        forks_count: 58,
        open_issues_count: 14,
        pushed_at: '2026-11-26T10:00:00Z',
      }, 200, { 'x-ratelimit-remaining': '4990', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '1795690000' });
    }
    if (url.pathname === '/repos/WuXiAIClub/agentopsdeck/pulls') {
      return jsonResponse([
        {
          number: 18,
          title: 'feat(web): add Git repository status card',
          state: 'open',
          draft: false,
          html_url: 'https://github.com/WuXiAIClub/agentopsdeck/pull/18',
          updated_at: '2026-11-26T11:30:00Z',
          user: { login: 'alice' },
          head: { ref: 'feat-git-card' },
          base: { ref: 'main' },
          comments: 3,
        },
        {
          number: 17,
          title: 'wip: experimental layout',
          state: 'open',
          draft: true,
          html_url: 'https://github.com/WuXiAIClub/agentopsdeck/pull/17',
          updated_at: '2026-11-26T09:00:00Z',
          user: { login: 'bob' },
          head: { ref: 'wip-layout' },
          base: { ref: 'main' },
        },
      ]);
    }
    if (url.pathname === '/search/issues') {
      return jsonResponse({ total_count: 5 });
    }
    if (url.pathname === '/repos/WuXiAIClub/agentopsdeck/actions/runs') {
      return jsonResponse({
        workflow_runs: [
          {
            id: 101,
            name: 'CI',
            status: 'completed',
            conclusion: 'success',
            head_branch: 'main',
            event: 'push',
            html_url: 'https://github.com/WuXiAIClub/agentopsdeck/actions/runs/101',
            updated_at: '2026-11-26T11:45:00Z',
          },
          {
            id: 102,
            name: 'CI',
            status: 'completed',
            conclusion: 'failure',
            head_branch: 'feat-git-card',
            event: 'pull_request',
            html_url: 'https://github.com/WuXiAIClub/agentopsdeck/actions/runs/102',
            updated_at: '2026-11-26T11:15:00Z',
          },
          {
            id: 103,
            name: 'Release Check',
            status: 'in_progress',
            conclusion: null,
            head_branch: 'main',
            event: 'workflow_dispatch',
            html_url: 'https://github.com/WuXiAIClub/agentopsdeck/actions/runs/103',
            updated_at: '2026-11-26T11:50:00Z',
          },
          {
            id: 104,
            name: 'Unsafe Link',
            status: 'completed',
            conclusion: 'success',
            head_branch: 'main',
            event: 'push',
            html_url: 'javascript:alert(1)',
            updated_at: '2026-11-26T11:00:00Z',
          },
        ],
      });
    }
    return new Response(null, { status: 404 });
  };

  const read = createGitRepoStatusReader(
    [{ id: 'work', label: 'Work', provider: 'github', apiOrigin: 'https://api.github.com', token: 'synthetic-token' }],
    { fetcher, now: () => clock, wallClock: () => 1795685000000 },
  );

  const [first, second] = await Promise.all([
    read({ repo: 'WuXiAIClub/agentopsdeck', accountId: 'work' }),
    read({ repo: 'WuXiAIClub/agentopsdeck', accountId: 'work' }),
  ]);
  assert.equal(calls, 4, 'singleflight deduplicates concurrent reads');
  assert.deepEqual(first, second);
  assert.equal(first.repository.stars, 420);
  assert.equal(first.repository.forks, 58);
  assert.equal(first.pullRequests.openCount, 5);
  assert.equal(first.pullRequests.draftCount, 1);
  assert.equal(first.pullRequests.items.length, 2);
  assert.equal(first.pullRequests.items[0]?.state, 'open');
  assert.equal(first.pullRequests.items[1]?.state, 'draft');
  assert.equal(first.issues.openCount, 9, 'subtracts open PR count from GitHub combined open_issues_count');
  assert.equal(first.actions.totalRecent, 3, 'drops non-https run URLs');
  assert.equal(first.actions.passingCount, 1);
  assert.equal(first.actions.failingCount, 1);
  assert.equal(first.actions.runningCount, 1);
  assert.equal(first.actions.successRate, 0.5);
  assert.equal(first.actions.latestStatus, 'success');
  assert.equal(first.rateLimit?.remaining, 4990);

  // Within TTL uses cache
  clock += 1_000;
  await read({ repo: 'WuXiAIClub/agentopsdeck', accountId: 'work' });
  assert.equal(calls, 4);

  // Explicit refresh inside 5s cooldown stays cached; after 5s refreshes
  await read({ repo: 'WuXiAIClub/agentopsdeck', accountId: 'work', refresh: true });
  assert.equal(calls, 4);
  clock += 5_000;
  await read({ repo: 'WuXiAIClub/agentopsdeck', accountId: 'work', refresh: true });
  assert.equal(calls, 8);

  // After TTL expires, refreshes automatically
  clock += GIT_STATUS_CACHE_TTL_MS + 1;
  await read({ repo: 'WuXiAIClub/agentopsdeck', accountId: 'work' });
  assert.equal(calls, 12);
});

test('readGitRepoStatus classifies 404, 429 rate limits, 403 auth, and degrades when Actions fail', async () => {
  const readNotFound = createGitRepoStatusReader(
    [{ id: 'public', label: 'Public', provider: 'github', apiOrigin: 'https://api.github.com' }],
    { fetcher: async () => jsonResponse({ message: 'Not Found' }, 404) },
  );
  await assert.rejects(
    readNotFound({ repo: 'owner/missing' }),
    (error: unknown) => error instanceof GitRepoStatusError && error.code === 'git_repo_not_found' && error.status === 404,
  );

  const readLimited = createGitRepoStatusReader(
    [{ id: 'public', label: 'Public', provider: 'github', apiOrigin: 'https://api.github.com' }],
    { fetcher: async () => jsonResponse({ message: 'rate limit' }, 403, { 'x-ratelimit-remaining': '0', 'retry-after': '120' }) },
  );
  await assert.rejects(
    readLimited({ repo: 'owner/repo' }),
    (error: unknown) => error instanceof GitRepoStatusError && error.code === 'git_rate_limited' && error.status === 429 && error.retryAfterSeconds === 120,
  );

  const readDegraded = createGitRepoStatusReader(
    [{ id: 'public', label: 'Public', provider: 'github', apiOrigin: 'https://api.github.com' }],
    {
      fetcher: async input => {
        const url = new URL(String(input));
        if (url.pathname === '/repos/owner/repo') {
          return jsonResponse({
            full_name: 'owner/repo',
            html_url: 'https://github.com/owner/repo',
            default_branch: 'main',
            open_issues_count: 3,
          });
        }
        return jsonResponse({ message: 'forbidden' }, 403);
      },
    },
  );
  const degraded = await readDegraded({ repo: 'owner/repo' });
  assert.equal(degraded.issues.openCount, 3);
  assert.equal(degraded.pullRequests.openCount, 0);
  assert.equal(degraded.actions.totalRecent, 0);
  assert.equal(degraded.actions.latestStatus, 'none');
});
