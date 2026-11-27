import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  CheckCircle2,
  CircleDot,
  CircleSlash,
  Clock3,
  ExternalLink,
  GitBranch,
  GitFork,
  GitPullRequest,
  GitPullRequestDraft,
  Loader2,
  Lock,
  Play,
  RefreshCw,
  Settings,
  ShieldCheck,
  Star,
  XCircle,
} from 'lucide-react';
import type { GitRepoAccountOption, GitRepoStatus, GitRepoWorkflowRun } from '@agentopsdeck/shared';
import { ApiResponseError, api, recoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import {
  normalizeClientGitRepo,
  readGitRepoSelection,
  saveGitRepoSelection,
  validClientGitRepo,
} from '../lib/git-repo-selection';
import { ResourceAction, ResourceTitle, ResourceToolbar } from './ResourceToolbar';
import { CardKindIcon } from './CardKindIcon';
import './git-repo-status-card.css';

export const GIT_REPO_AUTH_REFRESH_INTERVAL_MS = 5 * 60_000;
export const GIT_REPO_PUBLIC_REFRESH_INTERVAL_MS = 10 * 60_000;
export const GIT_REPO_RATE_LIMIT_BACKOFF_MS = 15 * 60_000;

type ViewTab = 'all' | 'prs' | 'actions';

type FetchState = {
  generation: number;
  repo: string;
  accountId: string;
  status?: GitRepoStatus;
  errorCode?: string;
};

function runTone(run: GitRepoWorkflowRun): 'success' | 'failure' | 'running' | 'draft' {
  if (run.status === 'queued' || run.status === 'in_progress') return 'running';
  if (run.conclusion === 'success') return 'success';
  if (run.conclusion === 'failure' || run.conclusion === 'timed_out' || run.conclusion === 'action_required') return 'failure';
  return 'draft';
}

export default function GitRepoStatusPanel({ scope, cardId = 'default' }: { scope: string; cardId?: string }) {
  const { t, locale } = useI18n();
  const datalistId = useId();
  const [accounts, setAccounts] = useState<GitRepoAccountOption[]>([]);
  const [accountsReady, setAccountsReady] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [draftRepo, setDraftRepo] = useState('');
  const [activeRepo, setActiveRepo] = useState('');
  const [inputError, setInputError] = useState(false);
  const [tab, setTab] = useState<ViewTab>('all');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [forceRefresh, setForceRefresh] = useState(false);
  const [result, setResult] = useState<FetchState>();
  const lastFetchedAtRef = useRef(0);
  const rateLimitedUntilRef = useRef(0);

  useEffect(() => {
    if (!scope || scope !== recoveryScope()) return;
    const controller = new AbortController();
    setAccountsReady(false);
    void api.gitAccounts(controller.signal).then(
      response => {
        if (controller.signal.aborted || scope !== recoveryScope()) return;
        const list = Array.isArray(response.accounts) ? response.accounts : [];
        setAccounts(list);
        const saved = readGitRepoSelection(scope, cardId);
        const preferredAccount = (saved && list.find(item => item.id === saved.accountId))
          ?? list[0];
        const nextAccountId = preferredAccount?.id ?? 'public';
        const nextRepo = saved?.repo ?? preferredAccount?.defaultRepo ?? preferredAccount?.repos?.[0] ?? '';
        setAccountId(nextAccountId);
        setDraftRepo(nextRepo);
        setActiveRepo(nextRepo);
        setAccountsReady(true);
      },
      () => {
        if (controller.signal.aborted || scope !== recoveryScope()) return;
        const saved = readGitRepoSelection(scope, cardId);
        setAccounts([{ id: 'public', label: 'GitHub', provider: 'github', authenticated: false }]);
        setAccountId(saved?.accountId ?? 'public');
        setDraftRepo(saved?.repo ?? '');
        setActiveRepo(saved?.repo ?? '');
        setAccountsReady(true);
      },
    );
    return () => controller.abort();
  }, [scope, cardId]);

  const currentAccount = useMemo(
    () => accounts.find(item => item.id === accountId) ?? accounts[0],
    [accounts, accountId],
  );
  const autoRefreshIntervalMs = currentAccount?.authenticated
    ? GIT_REPO_AUTH_REFRESH_INTERVAL_MS
    : GIT_REPO_PUBLIC_REFRESH_INTERVAL_MS;

  useEffect(() => {
    if (!scope || scope !== recoveryScope() || !activeRepo) return;
    const maybeAutoRefresh = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now < rateLimitedUntilRef.current) return;
      if (lastFetchedAtRef.current > 0 && now - lastFetchedAtRef.current < autoRefreshIntervalMs) return;
      setForceRefresh(false);
      setGeneration(value => value + 1);
    };
    const interval = window.setInterval(maybeAutoRefresh, autoRefreshIntervalMs);
    document.addEventListener('visibilitychange', maybeAutoRefresh);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', maybeAutoRefresh);
    };
  }, [scope, activeRepo, autoRefreshIntervalMs]);

  useEffect(() => {
    if (!scope || scope !== recoveryScope() || !accountsReady || !activeRepo) return;
    const controller = new AbortController();
    const requestAccount = accountId || accounts[0]?.id || 'public';
    void api.gitRepoStatus(activeRepo, requestAccount, controller.signal, forceRefresh).then(
      response => {
        if (controller.signal.aborted || scope !== recoveryScope()) return;
        lastFetchedAtRef.current = Date.now();
        rateLimitedUntilRef.current = 0;
        setResult({ generation, repo: activeRepo, accountId: requestAccount, status: response.status });
      },
      error => {
        if (controller.signal.aborted || scope !== recoveryScope()) return;
        const errorCode = error instanceof ApiResponseError ? error.message : 'git_repo_status_unavailable';
        lastFetchedAtRef.current = Date.now();
        if (errorCode === 'git_rate_limited') {
          rateLimitedUntilRef.current = Date.now() + GIT_REPO_RATE_LIMIT_BACKOFF_MS;
        }
        setResult({ generation, repo: activeRepo, accountId: requestAccount, errorCode });
      },
    );
    return () => controller.abort();
  }, [scope, accountsReady, activeRepo, accountId, generation, forceRefresh, accounts]);

  const presetRepos = useMemo(() => {
    const list = [...(currentAccount?.defaultRepo ? [currentAccount.defaultRepo] : []), ...(currentAccount?.repos ?? [])];
    return [...new Set(list)];
  }, [currentAccount]);

  if (!scope || scope !== recoveryScope()) return null;

  const busy = Boolean(activeRepo) && (
    !result || result.generation !== generation || result.repo !== activeRepo || result.accountId !== (accountId || accounts[0]?.id || 'public')
  );
  const status = result && result.repo === activeRepo && result.accountId === (accountId || accounts[0]?.id || 'public') ? result.status : undefined;
  const errorCode = result && result.repo === activeRepo && result.accountId === (accountId || accounts[0]?.id || 'public') ? result.errorCode : undefined;

  const numberFormat = new Intl.NumberFormat(locale);
  const percentFormat = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });

  const applyRepo = (rawRepo: string, nextAccount = accountId || accounts[0]?.id || 'public') => {
    const normalized = normalizeClientGitRepo(rawRepo);
    if (!validClientGitRepo(normalized)) {
      setInputError(true);
      return;
    }
    setInputError(false);
    setDraftRepo(normalized);
    setAccountId(nextAccount);
    setActiveRepo(normalized);
    setSettingsOpen(false);
    rateLimitedUntilRef.current = 0;
    setForceRefresh(false);
    setGeneration(value => value + 1);
    saveGitRepoSelection(scope, cardId, { accountId: nextAccount, repo: normalized });
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    applyRepo(draftRepo);
  };

  const handleAccountChange = (nextId: string) => {
    setAccountId(nextId);
    const chosen = accounts.find(item => item.id === nextId);
    const candidate = draftRepo.trim() || chosen?.defaultRepo || chosen?.repos?.[0] || '';
    if (candidate && validClientGitRepo(candidate)) {
      applyRepo(candidate, nextId);
    } else if (chosen?.defaultRepo) {
      applyRepo(chosen.defaultRepo, nextId);
    }
  };

  const errorMessage = (code: string | undefined): string => {
    if (code === 'git_repo_not_found') return t('Repository not found or access denied. Verify owner/repo and account permissions.');
    if (code === 'git_rate_limited') return t('GitHub API rate limit reached. Configure a GitHub token or retry later.');
    if (code === 'git_auth_required') return t('Authentication is required for this repository.');
    if (code === 'invalid_git_repo') return t('Enter a valid repository in owner/repo format.');
    return t('Repository status unavailable. Try refreshing.');
  };

  const runStatusLabel = (run: GitRepoWorkflowRun): string => {
    if (run.status === 'queued') return t('Queued');
    if (run.status === 'in_progress') return t('Running');
    if (run.conclusion === 'success') return t('Passed');
    if (run.conclusion === 'failure' || run.conclusion === 'timed_out' || run.conclusion === 'action_required') return t('Failed');
    if (run.conclusion === 'cancelled') return t('Cancelled');
    if (run.conclusion === 'skipped') return t('Skipped');
    return t('Completed');
  };

  const actionRate = status?.actions.successRate ?? null;
  const actionTileState = !status ? undefined
    : status.actions.runningCount > 0 && status.actions.latestStatus === 'running' ? 'running'
    : status.actions.latestStatus === 'failure' || (actionRate !== null && actionRate < 0.7) ? 'failure'
    : status.actions.latestStatus === 'success' ? 'success'
    : undefined;
  const readyPrCount = status ? Math.max(0, status.pullRequests.openCount - status.pullRequests.draftCount) : 0;
  const cardTitle = status ? `${t('Git repository status')} · ${status.repository.fullName}` : t('Git repository status');

  const showSettings = settingsOpen || !activeRepo || inputError;

  return (
    <section className="git-repo-card" aria-label={t('Git repository status')} aria-busy={busy}>
      <ResourceTitle>{cardTitle}</ResourceTitle>
      <ResourceToolbar>
        <ResourceAction
          label={t('Repository settings')}
          aria-expanded={showSettings}
          aria-pressed={settingsOpen}
          onClick={() => setSettingsOpen(open => !open)}
        >
          <Settings size={15} />
        </ResourceAction>
        <ResourceAction
          label={t('Refresh')}
          disabled={busy || !activeRepo}
          onClick={() => {
            rateLimitedUntilRef.current = 0;
            setForceRefresh(true);
            setGeneration(value => value + 1);
          }}
        >
          <RefreshCw size={15} className={busy ? 'git-repo-refreshing' : undefined} />
        </ResourceAction>
      </ResourceToolbar>

      <div className="git-repo-body">
        <div className="git-repo-hero">
          <span className="workspace-glass-emblem" aria-hidden="true">
            <CardKindIcon kind="git-repo-status" />
          </span>
          <div className="git-repo-hero-main">
            <div className="git-repo-kicker">
              <span>{status ? status.accountLabel : currentAccount?.label ?? t('Git repository status')}</span>
              {status && (
                <span className="git-repo-chip" data-muted>
                  {status.repository.isPrivate ? <Lock size={11} aria-hidden="true" /> : <ShieldCheck size={11} aria-hidden="true" />}
                  {status.repository.isPrivate ? t('Private') : t('Public')}
                </span>
              )}
              {status && (
                <span className="git-repo-chip" data-muted>
                  <GitBranch size={11} aria-hidden="true" />
                  {status.repository.defaultBranch}
                </span>
              )}
            </div>
            <div className="git-repo-title-row">
              {status ? (
                <a className="git-repo-title-link" href={status.repository.url} target="_blank" rel="noopener noreferrer">
                  <span>{status.repository.fullName}</span>
                  <ExternalLink size={14} aria-hidden="true" />
                </a>
              ) : (
                <strong>{activeRepo || t('Monitor a Git repository')}</strong>
              )}
            </div>
            {status?.repository.description && <p className="git-repo-description">{status.repository.description}</p>}
          </div>
          {status && (
            <div className="git-repo-hero-stats" aria-label={t('Repository metrics')}>
              <span className="git-repo-chip" title={t('Stars')}>
                <Star size={12} aria-hidden="true" />
                {numberFormat.format(status.repository.stars)}
              </span>
              <span className="git-repo-chip" title={t('Forks')}>
                <GitFork size={12} aria-hidden="true" />
                {numberFormat.format(status.repository.forks)}
              </span>
            </div>
          )}
        </div>

        {showSettings && (
          <>
            <form className="git-repo-picker" onSubmit={handleSubmit} aria-label={t('Select Git repository')}>
              {accounts.length > 0 && (
                <select
                  name="git-repo-account"
                  aria-label={t('Git account')}
                  value={accountId}
                  onChange={event => handleAccountChange(event.target.value)}
                >
                  {accounts.map(account => (
                    <option key={account.id} value={account.id}>
                      {account.label}
                    </option>
                  ))}
                </select>
              )}
              <input
                type="text"
                name="git-repo-slug"
                list={presetRepos.length ? datalistId : undefined}
                aria-label={t('Repository (owner/repo)')}
                placeholder={t('Repository (owner/repo)')}
                value={draftRepo}
                onChange={event => {
                  setDraftRepo(event.target.value);
                  if (inputError) setInputError(false);
                }}
                spellCheck={false}
                autoComplete="off"
              />
              {presetRepos.length > 0 && (
                <datalist id={datalistId}>
                  {presetRepos.map(slug => <option key={slug} value={slug} />)}
                </datalist>
              )}
              <button type="submit" className="git-repo-picker-submit" disabled={busy || !draftRepo.trim()}>
                <Play size={12} aria-hidden="true" />
                <span>{t('Load')}</span>
              </button>
            </form>

            {presetRepos.length > 0 && (
              <div className="git-repo-presets" role="group" aria-label={t('Configured repositories')}>
                {presetRepos.map(slug => (
                  <button
                    key={slug}
                    type="button"
                    aria-pressed={activeRepo.toLowerCase() === slug.toLowerCase()}
                    onClick={() => applyRepo(slug)}
                  >
                    {slug}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {inputError && <p className="git-repo-alert" role="alert">{t('Enter a valid repository in owner/repo format.')}</p>}
        {!activeRepo && !inputError && (
          <p className="git-repo-empty">
            {t('Enter a GitHub repository (owner/repo) to inspect open pull requests, issues, and workflow runs.')}
          </p>
        )}
        {busy && !status && activeRepo && <p role="status">{t('Loading…')}</p>}
        {!busy && errorCode && <p className="git-repo-alert" role="alert">{errorMessage(errorCode)}</p>}

        {status && (
          <>
            <ul className="git-repo-metrics" role="list" aria-label={t('Repository status summary')}>
              <li className="git-repo-metric-tile" data-state={actionTileState}>
                <div className="git-repo-dial" aria-hidden="true">
                  <svg viewBox="0 0 72 72" focusable="false">
                    <circle cx="36" cy="36" r="30" />
                    <circle
                      className="git-repo-arc"
                      cx="36"
                      cy="36"
                      r="30"
                      pathLength="100"
                      strokeDasharray={`${(actionRate ?? 0) * 100} 100`}
                    />
                  </svg>
                  <strong>{actionRate === null ? '—' : percentFormat.format(actionRate)}</strong>
                </div>
                <div className="git-repo-metric-reading">
                  <span className="git-repo-metric-label">{t('Actions pass rate')}</span>
                  <strong className="git-repo-metric-value">
                    {status.actions.latestStatus === 'running'
                      ? t('Running')
                      : status.actions.latestStatus === 'success'
                        ? t('Healthy')
                        : status.actions.latestStatus === 'failure'
                          ? t('Failing')
                          : status.actions.totalRecent > 0
                            ? t('Neutral')
                            : t('No runs')}
                  </strong>
                  <small className="git-repo-metric-sub">
                    {t('{passed} passed · {failed} failed · {running} running', {
                      passed: status.actions.passingCount,
                      failed: status.actions.failingCount,
                      running: status.actions.runningCount,
                    })}
                  </small>
                </div>
                <progress
                  className="git-repo-progress"
                  aria-label={t('Actions pass rate')}
                  aria-valuetext={actionRate === null ? t('No completed runs') : t('Pass rate: {percent}', { percent: percentFormat.format(actionRate) })}
                  max={1}
                  value={actionRate ?? 0}
                />
              </li>

              <li className="git-repo-metric-tile" data-state={status.pullRequests.openCount > 0 ? 'running' : 'success'}>
                <div className="git-repo-kpi-badge" aria-hidden="true">
                  <GitPullRequest size={22} />
                </div>
                <div className="git-repo-metric-reading">
                  <span className="git-repo-metric-label">{t('Open pull requests')}</span>
                  <strong className="git-repo-metric-value">{numberFormat.format(status.pullRequests.openCount)}</strong>
                  <small className="git-repo-metric-sub">
                    {t('{ready} ready · {draft} draft', {
                      ready: readyPrCount,
                      draft: status.pullRequests.draftCount,
                    })}
                  </small>
                </div>
              </li>

              <li className="git-repo-metric-tile" data-state={status.issues.openCount > 0 ? 'low' : 'success'}>
                <div className="git-repo-kpi-badge" aria-hidden="true">
                  <CircleDot size={22} />
                </div>
                <div className="git-repo-metric-reading">
                  <span className="git-repo-metric-label">{t('Open issues')}</span>
                  <strong className="git-repo-metric-value">{numberFormat.format(status.issues.openCount)}</strong>
                  <small className="git-repo-metric-sub">
                    {status.repository.pushedAt
                      ? <>{t('Last push')} · <time dateTime={new Date(status.repository.pushedAt).toISOString()}>{new Date(status.repository.pushedAt).toLocaleString(locale)}</time></>
                      : t('Excludes pull requests')}
                  </small>
                </div>
              </li>
            </ul>

            <div className="git-repo-tabs" role="group" aria-label={t('Filter repository activity')}>
              <button type="button" aria-pressed={tab === 'all'} onClick={() => setTab('all')}>
                <span>{t('Overview')}</span>
              </button>
              <button type="button" aria-pressed={tab === 'prs'} onClick={() => setTab('prs')}>
                <span>{t('Pull requests')}</span>
                <span className="git-repo-tab-count">{numberFormat.format(status.pullRequests.openCount)}</span>
              </button>
              <button type="button" aria-pressed={tab === 'actions'} onClick={() => setTab('actions')}>
                <span>{t('Workflow runs')}</span>
                <span className="git-repo-tab-count">{numberFormat.format(status.actions.totalRecent)}</span>
              </button>
            </div>

            {(tab === 'all' || tab === 'prs') && (
              <div className="git-repo-section" role="group" aria-label={t('Pull requests')}>
                <h3>
                  <GitPullRequest size={14} aria-hidden="true" />
                  <span>{t('Pull requests')}</span>
                </h3>
                {status.pullRequests.items.length === 0 ? (
                  <p className="git-repo-empty">{t('No open pull requests.')}</p>
                ) : (
                  <ul className="git-repo-list" role="list">
                    {status.pullRequests.items.map(pr => (
                      <li key={pr.number}>
                        <a className="git-repo-item" href={pr.url} target="_blank" rel="noopener noreferrer">
                          <span className="git-repo-item-icon" data-tone={pr.state === 'draft' ? 'draft' : 'success'} aria-hidden="true">
                            {pr.state === 'draft' ? <GitPullRequestDraft size={14} /> : <GitPullRequest size={14} />}
                          </span>
                          <div className="git-repo-item-main">
                            <div className="git-repo-item-head">
                              <span className="git-repo-item-title">
                                <span className="git-repo-item-number">#{pr.number}</span>
                                {pr.title}
                              </span>
                              <span className="git-repo-pill" data-tone={pr.state === 'draft' ? 'draft' : 'success'}>
                                {pr.state === 'draft' ? t('Draft') : t('Open')}
                              </span>
                            </div>
                            <div className="git-repo-item-meta">
                              <span>{pr.author}</span>
                              {pr.headRef && (
                                <span className="git-repo-branch">
                                  <GitBranch size={11} aria-hidden="true" />
                                  {pr.headRef}{pr.baseRef ? ` → ${pr.baseRef}` : ''}
                                </span>
                              )}
                              <time dateTime={new Date(pr.updatedAt).toISOString()}>
                                {new Date(pr.updatedAt).toLocaleString(locale)}
                              </time>
                            </div>
                          </div>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {(tab === 'all' || tab === 'actions') && (
              <div className="git-repo-section" role="group" aria-label={t('Workflow runs')}>
                <h3>
                  <Play size={14} aria-hidden="true" />
                  <span>{t('Workflow runs')}</span>
                </h3>
                {status.actions.runs.length === 0 ? (
                  <p className="git-repo-empty">{t('No recent workflow runs found.')}</p>
                ) : (
                  <ul className="git-repo-list" role="list">
                    {status.actions.runs.map(run => {
                      const tone = runTone(run);
                      return (
                        <li key={run.id}>
                          <a className="git-repo-item" href={run.url} target="_blank" rel="noopener noreferrer">
                            <span className="git-repo-item-icon" data-tone={tone} aria-hidden="true">
                              {tone === 'success' ? <CheckCircle2 size={14} />
                                : tone === 'failure' ? <XCircle size={14} />
                                  : tone === 'running' ? <Loader2 size={14} className="git-repo-refreshing" />
                                    : <CircleSlash size={14} />}
                            </span>
                            <div className="git-repo-item-main">
                              <div className="git-repo-item-head">
                                <span className="git-repo-item-title">{run.name}</span>
                                <span className="git-repo-pill" data-tone={tone}>{runStatusLabel(run)}</span>
                              </div>
                              <div className="git-repo-item-meta">
                                <span className="git-repo-branch">
                                  <GitBranch size={11} aria-hidden="true" />
                                  {run.branch}
                                </span>
                                <span>{run.event}</span>
                                <time dateTime={new Date(run.updatedAt).toISOString()}>
                                  {new Date(run.updatedAt).toLocaleString(locale)}
                                </time>
                              </div>
                            </div>
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}

            <div className="git-repo-sample" role="status">
              <span className="git-repo-sample-group">
                <Clock3 size={13} aria-hidden="true" />
                <span>
                  {t('Status checked at')} ·{' '}
                  <time dateTime={new Date(status.sampledAt).toISOString()}>
                    {new Date(status.sampledAt).toLocaleString(locale)}
                  </time>
                </span>
              </span>
              {status.rateLimit?.remaining !== null && status.rateLimit?.limit !== null && status.rateLimit && (
                <span className="git-repo-sample-group">
                  {t('API remaining: {remaining}/{limit}', {
                    remaining: status.rateLimit.remaining,
                    limit: status.rateLimit.limit,
                  })}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
