import { Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useI18n } from '../lib/i18n';
import { readStartupAuth, type StartupAuthStatus } from '../lib/startup-auth';
import { Button } from './ui/button';

export default function StartupAuth({ onChecked }: { onChecked: (status: StartupAuthStatus) => void }) {
  const { t } = useI18n();
  const [attempt, setAttempt] = useState(0);
  const [checking, setChecking] = useState(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setChecking(true); setFailed(false);
    // A revocation notification invalidates even a transport ignoring abort.
    const invalidated = () => { controller.abort(); setChecking(false); setFailed(true); };
    window.addEventListener('agentopsdeck:auth-required', invalidated);
    void readStartupAuth(signal => api.authStatus(signal), controller.signal).then(status => {
      if (status && !controller.signal.aborted) onChecked(status);
    }).catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    }).finally(() => {
      if (!controller.signal.aborted) setChecking(false);
    });
    return () => { controller.abort(); window.removeEventListener('agentopsdeck:auth-required', invalidated); };
  }, [attempt, onChecked]);

  const osDesktopBoot = typeof document !== 'undefined' && document.documentElement.dataset.osDesktopImmersive === 'true';
  if (!osDesktopBoot) {
    if (!failed) {
      return (
        <main className="fixed inset-0 grid place-items-center p-5" data-startup-auth="checking">
          <p role="status" className="sr-only">{t('Checking AgentOpsDeck auth…')}</p>
        </main>
      );
    }
    return (
      <main className="fixed inset-0 grid place-items-center bg-background/95 p-5 text-sm text-foreground">
        <div className="max-w-md space-y-3 rounded-xl border bg-card p-6 text-center shadow-sm" data-startup-auth={checking ? 'checking' : 'unavailable'}>
          <p role="alert" className="text-muted-foreground">
            {t('Sign-in status is temporarily unavailable. Your existing sign-in and saved view are preserved.')}
          </p>
          <Button
            disabled={checking}
            onClick={() => {
              setChecking(true);
              setAttempt(value => value + 1);
            }}
          >
            {t('Retry sign-in check')}
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main
      className="os-power-overlay is-auth-checking fixed inset-0 grid place-items-center p-5 text-sm font-semibold text-white"
      data-testid="os-power-overlay"
      data-power-phase="booting"
    >
      <div className="os-power-bg-grid" aria-hidden="true" />
      <div className="os-power-scanline" aria-hidden="true" />
      <div className="os-power-ambient-orb orb-cyan" aria-hidden="true" />
      <div className="os-power-ambient-orb orb-indigo" aria-hidden="true" />

      <div
        className="os-power-card max-w-lg text-center"
        data-startup-auth={checking ? 'checking' : 'unavailable'}
      >
        <span className="os-power-corner corner-tl" aria-hidden="true" />
        <span className="os-power-corner corner-tr" aria-hidden="true" />
        <span className="os-power-corner corner-bl" aria-hidden="true" />
        <span className="os-power-corner corner-br" aria-hidden="true" />

        <div className="os-power-hud-header" aria-hidden="true">
          <span className="os-power-hud-tag">{t('AGENTOPSDECK // QUANTUM KERNEL v2.4')}</span>
          <span className="os-power-hud-led">
            <i />
            {t('AUTH GATE')}
          </span>
        </div>

        <div className="os-power-reactor" aria-hidden="true">
          <span className="os-power-orbit orbit-outer" />
          <span className="os-power-orbit orbit-middle" />
          <span className="os-power-orbit orbit-inner" />
          <span className="os-power-radar-sweep" />
          <div className="os-power-emblem">
            <Sparkles size={28} />
            <span className="os-power-ring" />
          </div>
        </div>

        <strong className="os-power-title">{t('Starting AgentOpsDeck OS Desktop…')}</strong>

        {checking ? (
          <>
            <p role="status" className="os-power-subtitle">
              {t('Checking AgentOpsDeck auth…')}
            </p>
            <div className="os-power-modules-grid" aria-hidden="true">
              <div className="os-power-module-pill is-active">
                <span className="module-dot" />
                <span>{t('IDENTITY VAULT')}</span>
                <b>{t('SYNC')}</b>
              </div>
              <div className="os-power-module-pill">
                <span className="module-dot" />
                <span>{t('AGENT MESH')}</span>
                <b>{t('WAIT')}</b>
              </div>
              <div className="os-power-module-pill">
                <span className="module-dot" />
                <span>{t('FENCES COMPOSITOR')}</span>
                <b>{t('STANDBY')}</b>
              </div>
            </div>
            <div className="os-power-progress-wrap" aria-hidden="true">
              <div className="os-power-progress-meta">
                <span>{t('BOOT_SEQUENCE // STAGE 01')}</span>
                <span>24%</span>
              </div>
              <div className="os-power-progress-track">
                <div className="os-power-progress-bar" style={{ width: '24%' }} />
              </div>
            </div>
          </>
        ) : null}
        {failed ? (
          <div className="mt-2 space-y-3">
            <p role="alert" className="os-power-subtitle">
              {t('Sign-in status is temporarily unavailable. Your existing sign-in and saved view are preserved.')}
            </p>
            <Button
              disabled={checking}
              onClick={() => {
                setChecking(true);
                setAttempt(value => value + 1);
              }}
            >
              {t('Retry sign-in check')}
            </Button>
          </div>
        ) : null}
      </div>
    </main>
  );
}
