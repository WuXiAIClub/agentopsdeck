export type GitRepoAccountOption = {
  id: string;
  label: string;
  provider: 'github';
  authenticated: boolean;
  defaultRepo?: string;
  repos?: string[];
};

export type GitRepoPullRequestSummary = {
  number: number;
  title: string;
  state: 'open' | 'draft' | 'merged' | 'closed';
  author: string;
  url: string;
  updatedAt: number;
  headRef?: string;
  baseRef?: string;
  comments?: number;
};

export type GitRepoWorkflowRun = {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | 'unknown';
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | 'neutral' | 'stale' | null;
  branch: string;
  event: string;
  url: string;
  updatedAt: number;
};

export type GitRepoStatus = {
  sampledAt: number;
  provider: 'github';
  accountId: string;
  accountLabel: string;
  authenticated: boolean;
  repository: {
    owner: string;
    name: string;
    fullName: string;
    description: string | null;
    url: string;
    defaultBranch: string;
    isPrivate: boolean;
    stars: number;
    forks: number;
    pushedAt: number | null;
  };
  pullRequests: {
    openCount: number;
    draftCount: number;
    items: GitRepoPullRequestSummary[];
  };
  issues: {
    openCount: number;
  };
  actions: {
    totalRecent: number;
    passingCount: number;
    failingCount: number;
    runningCount: number;
    successRate: number | null;
    latestStatus: 'success' | 'failure' | 'running' | 'neutral' | 'none';
    runs: GitRepoWorkflowRun[];
  };
  rateLimit?: {
    remaining: number | null;
    limit: number | null;
    resetAt: number | null;
  };
};
