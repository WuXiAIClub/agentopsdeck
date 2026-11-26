export type GitRepoSelection = {
  accountId: string;
  repo: string;
};

const STORAGE_PREFIX = 'agentopsdeck.git-repo-selection.v1:';
const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const ACCOUNT_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function normalizeClientGitRepo(raw: string): string {
  return raw.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
}

export function validClientGitRepo(raw: string): boolean {
  const normalized = normalizeClientGitRepo(raw);
  if (!REPO_PATTERN.test(normalized)) return false;
  const [, name] = normalized.split('/');
  return Boolean(name && name !== '.' && name !== '..');
}

function validSelection(value: unknown): value is GitRepoSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every(key => key === 'accountId' || key === 'repo')
    && typeof record.accountId === 'string' && ACCOUNT_PATTERN.test(record.accountId)
    && typeof record.repo === 'string' && validClientGitRepo(record.repo);
}

function storageKey(scope: string): string | undefined {
  return /^[a-f0-9]{64}$/.test(scope) ? `${STORAGE_PREFIX}${scope}` : undefined;
}

function readEntries(scope: string): [string, GitRepoSelection][] {
  if (typeof localStorage === 'undefined') return [];
  const key = storageKey(scope);
  if (!key) return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > 32_768) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > 64) return [];
    return parsed.filter(
      (entry): entry is [string, GitRepoSelection] =>
        Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && entry[0].length <= 256 && validSelection(entry[1]),
    );
  } catch {
    return [];
  }
}

export function readGitRepoSelection(scope: string, cardId: string): GitRepoSelection | undefined {
  return readEntries(scope).find(([id]) => id === cardId)?.[1];
}

export function saveGitRepoSelection(scope: string, cardId: string, selection: GitRepoSelection): void {
  if (typeof localStorage === 'undefined') return;
  const key = storageKey(scope);
  if (!key || !cardId || cardId.length > 256 || !validSelection(selection)) return;
  try {
    const entries = readEntries(scope).filter(([id]) => id !== cardId);
    entries.push([cardId, { accountId: selection.accountId, repo: normalizeClientGitRepo(selection.repo) }]);
    localStorage.setItem(key, JSON.stringify(entries.slice(-64)));
  } catch {
    // Optional preference; never block a status read.
  }
}
