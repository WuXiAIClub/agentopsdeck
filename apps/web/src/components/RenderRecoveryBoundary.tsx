import React from 'react';
import { useI18n } from '../lib/i18n';
import { isModuleLoadError } from '../lib/module-load-error';

type Props = {
  children: React.ReactNode;
  scope?: 'app' | 'message' | 'tools' | 'notebook';
  plainText?: string | undefined;
  fallback?: React.ReactNode;
};
type State = { error: Error | null; retrying: boolean };

// A recovery is a React remount, never a reload, API mutation, or message resend.
// Keep this boundary outside the failed subtree so its retry budget survives.
export class RenderRecoveryBoundary extends React.Component<Props, State> {
  state: State = { error: null, retrying: false };
  private attempts = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private stableTimer?: ReturnType<typeof setTimeout>;

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error('Unexpected render failure'), retrying: false };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('AgentOpsDeck render failure', { scope: this.props.scope ?? 'app', error, componentStack: info.componentStack });
    clearTimeout(this.stableTimer);
    clearTimeout(this.retryTimer);
    // React.lazy caches a rejected import. Remounting cannot load the new
    // release, and automatic reload could discard an unsaved workspace draft.
    if (this.props.scope !== 'notebook' && !isModuleLoadError(error) && this.attempts < 1) {
      this.setState({ retrying: true });
      this.retryTimer = setTimeout(() => {
        this.attempts += 1;
        this.retry();
      }, 600);
    }
  }

  componentWillUnmount() {
    clearTimeout(this.retryTimer);
    clearTimeout(this.stableTimer);
  }

  private retry = () => {
    clearTimeout(this.retryTimer);
    clearTimeout(this.stableTimer);
    this.setState({ error: null, retrying: false });
    // Re-arm only after a full healthy minute, not on each streamed update.
    this.stableTimer = setTimeout(() => { if (!this.state.error) this.attempts = 0; }, 60_000);
  };

  render() {
    if (!this.state.error) return this.props.children;
    return <RecoveryView scope={this.props.scope} plainText={this.props.plainText} fallback={this.props.fallback} error={this.state.error} retrying={this.state.retrying} retry={this.retry} />;
  }
}

// A subscribed fallback can switch language even while its original subtree is broken.
function RecoveryView({ scope, plainText, fallback, error, retrying, retry }: {
  scope: Props['scope']; plainText: Props['plainText'];
  fallback: Props['fallback'];
  error: Error; retrying: boolean; retry: () => void;
}) {
    const { t } = useI18n();
    const app = !scope || scope === 'app';
    const moduleError = isModuleLoadError(error);
    return <section className={`render-recovery ${app ? 'render-recovery-app' : 'render-recovery-inline'}`} aria-label={t(app ? 'Application recovery' : 'Content recovery')}>
      <div className="render-recovery-body">
        <div className="render-recovery-heading">
          <span aria-hidden="true">↻</span>
          <span role="status">{t(moduleError ? 'This panel could not load' : retrying ? 'Restoring view…' : app ? 'This view needs a fresh start' : 'Simplified view')}</span>
          {!retrying && !moduleError && scope !== 'notebook' ? <button type="button" onClick={retry}>{t('Try again')}</button> : null}
        </div>
        <p>{t(scope === 'notebook' ? 'This notebook view could not load. You can close it and continue using the app.' : moduleError ? 'The app may have been updated, or the connection was interrupted. Save any open drafts, then reload. Messages will not be resent.' : app ? 'Messages will not be resent. Your saved text draft stays in this browser.'
          : scope === 'tools' ? 'Only this tool output could not be rendered. The rest of your conversation is available.'
            : 'Only this message could not be rendered. The rest of your conversation is available.')}</p>
        {!app && plainText ? <pre className="render-recovery-text">{plainText}</pre> : null}
        {fallback}
        {!retrying ? <details><summary>{t('Technical details')}</summary><pre>{error.message}</pre></details> : null}
        {(app || moduleError) && scope !== 'notebook' && !retrying ? <button type="button" className="render-recovery-reload" onClick={() => window.location.reload()}>{t('Reload page')}</button> : null}
      </div>
    </section>;
}
