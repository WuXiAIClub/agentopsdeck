import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { GitRepoAccountOption } from '@agentopsdeck/shared';

export type GitStatusAccountConfig = {
  id: string;
  label: string;
  provider: 'github';
  apiOrigin: string;
  token?: string;
  defaultRepo?: string;
  repos?: string[];
};

const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const ACCOUNT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_TOKEN_FILE_BYTES = 16 * 1024;
const DEFAULT_GITHUB_API_ORIGIN = 'https://api.github.com';

export function normalizeGitRepoSlug(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const trimmed = input.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  if (!REPO_PATTERN.test(trimmed)) return undefined;
  const [owner, name] = trimmed.split('/');
  if (!owner || !name || name === '.' || name === '..') return undefined;
  return `${owner}/${name}`;
}

function normalizeApiOrigin(raw: unknown): string {
  if (raw === undefined || raw === '') return DEFAULT_GITHUB_API_ORIGIN;
  if (typeof raw !== 'string' || raw.length > 256) throw new Error('Invalid GitHub API origin');
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error('Invalid GitHub API origin'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== raw || parsed.username || parsed.password) {
    throw new Error('GitHub API origin must be a canonical https:// origin without credentials');
  }
  return parsed.origin;
}

function validToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 8192 || /[\x00-\x20\x7f]/.test(trimmed)) {
    throw new Error('Invalid GitHub authentication token format');
  }
  return trimmed;
}

function readTokenFile(filePath: string): string {
  if (!isAbsolute(filePath) || /[\x00-\x1f\x7f]/.test(filePath)) {
    throw new Error('AOD_GITHUB_TOKEN_FILE must be an absolute path');
  }
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TOKEN_FILE_BYTES) {
    throw new Error('AOD_GITHUB_TOKEN_FILE must be a bounded regular file');
  }
  const token = validToken(readFileSync(filePath, 'utf8'));
  if (!token) throw new Error('AOD_GITHUB_TOKEN_FILE is empty');
  return token;
}

function validLabel(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Invalid Git account label');
  }
  return value.trim();
}

function parseRepoList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32) throw new Error('Invalid repository preset list');
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of value) {
    const slug = normalizeGitRepoSlug(item);
    if (!slug) throw new Error('Invalid repository slug in preset list');
    const key = slug.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(slug);
    }
  }
  return normalized.length ? normalized : undefined;
}

export function parseGitStatusAccounts(env: NodeJS.ProcessEnv): GitStatusAccountConfig[] {
  const accounts: GitStatusAccountConfig[] = [];
  const seen = new Set<string>();

  const rawJson = env.AOD_GIT_ACCOUNTS_JSON?.trim();
  if (rawJson) {
    const invalid = () => new Error('Invalid AOD_GIT_ACCOUNTS_JSON; expected bounded GitHub account definitions');
    if (Buffer.byteLength(rawJson) > 32 * 1024) throw invalid();
    let parsed: unknown;
    try { parsed = JSON.parse(rawJson); } catch { throw invalid(); }
    if (!Array.isArray(parsed) || parsed.length > 16) throw invalid();
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalid();
      const rec = entry as Record<string, unknown>;
      if (Object.keys(rec).some(key => !['id', 'label', 'provider', 'apiOrigin', 'tokenEnv', 'tokenFile', 'defaultRepo', 'repos'].includes(key))) {
        throw invalid();
      }
      if (typeof rec.id !== 'string' || !ACCOUNT_ID_PATTERN.test(rec.id) || seen.has(rec.id)) throw invalid();
      if (rec.provider !== undefined && rec.provider !== 'github') throw invalid();
      const label = validLabel(rec.label, rec.id);
      const apiOrigin = normalizeApiOrigin(rec.apiOrigin);
      let token: string | undefined;
      if (rec.tokenEnv !== undefined && rec.tokenFile !== undefined) throw invalid();
      if (rec.tokenEnv !== undefined) {
        if (typeof rec.tokenEnv !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(rec.tokenEnv)) throw invalid();
        token = validToken(env[rec.tokenEnv]);
        if (!token) throw invalid();
      } else if (rec.tokenFile !== undefined) {
        if (typeof rec.tokenFile !== 'string') throw invalid();
        token = readTokenFile(rec.tokenFile);
      }
      const defaultRepo = rec.defaultRepo !== undefined ? normalizeGitRepoSlug(rec.defaultRepo) : undefined;
      if (rec.defaultRepo !== undefined && !defaultRepo) throw invalid();
      const repos = parseRepoList(rec.repos);
      seen.add(rec.id);
      accounts.push({
        id: rec.id,
        label,
        provider: 'github',
        apiOrigin,
        ...(token ? { token } : {}),
        ...(defaultRepo ? { defaultRepo } : {}),
        ...(repos ? { repos } : {}),
      });
    }
  }

  const singleTokenFile = env.AOD_GITHUB_TOKEN_FILE?.trim();
  const singleTokenEnv = env.AOD_GITHUB_TOKEN?.trim();
  const singleDefaultRepo = env.AOD_GITHUB_DEFAULT_REPO?.trim();
  const singleApiOrigin = env.AOD_GITHUB_API_ORIGIN?.trim();
  const singleLabel = env.AOD_GITHUB_ACCOUNT_LABEL?.trim();
  if (singleTokenFile || singleTokenEnv || singleDefaultRepo || singleApiOrigin || singleLabel) {
    if (singleTokenFile && singleTokenEnv) {
      throw new Error('Configure either AOD_GITHUB_TOKEN_FILE or AOD_GITHUB_TOKEN, not both');
    }
    const token = singleTokenFile ? readTokenFile(singleTokenFile) : validToken(singleTokenEnv);
    const defaultRepo = singleDefaultRepo ? normalizeGitRepoSlug(singleDefaultRepo) : undefined;
    if (singleDefaultRepo && !defaultRepo) throw new Error('AOD_GITHUB_DEFAULT_REPO must be owner/repo');
    const apiOrigin = normalizeApiOrigin(singleApiOrigin);
    const id = seen.has('default') ? 'github-env' : 'default';
    if (!seen.has(id)) {
      seen.add(id);
      accounts.unshift({
        id,
        label: validLabel(singleLabel, 'GitHub'),
        provider: 'github',
        apiOrigin,
        ...(token ? { token } : {}),
        ...(defaultRepo ? { defaultRepo } : {}),
        ...(defaultRepo ? { repos: [defaultRepo] } : {}),
      });
    }
  }

  if (!seen.has('public')) {
    accounts.push({
      id: 'public',
      label: 'GitHub (Public)',
      provider: 'github',
      apiOrigin: DEFAULT_GITHUB_API_ORIGIN,
    });
  }

  return accounts;
}

export function publicGitAccountOptions(accounts: readonly GitStatusAccountConfig[]): GitRepoAccountOption[] {
  return accounts.map(account => ({
    id: account.id,
    label: account.label,
    provider: account.provider,
    authenticated: Boolean(account.token),
    ...(account.defaultRepo ? { defaultRepo: account.defaultRepo } : {}),
    ...(account.repos?.length ? { repos: [...account.repos] } : {}),
  }));
}
