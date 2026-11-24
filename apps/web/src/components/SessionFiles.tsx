import { lazy, Suspense, useEffect, useState } from 'react';
import { Files, FolderOpen } from 'lucide-react';
import type { ChatMessage, SessionSummary } from '@agentopsdeck/shared';
import { usePublishSessionDirectory } from './WorkspaceFileLinks';
import { useI18n } from '../lib/i18n';
import { CaptionIconButton } from './CaptionIconButton';
const FilePanel = lazy(() => import('./SessionFilePanel'));

export function SessionFiles({ sessionKey, session, messages, caption = false }: { sessionKey: string; session?: SessionSummary; messages: ChatMessage[]; caption?: boolean }) {
  const { t } = useI18n();
  const publish = usePublishSessionDirectory();
  const connectionId = (session as (SessionSummary & { envConnectionId?: string }) | undefined)?.envConnectionId;
  const agentId = session?.agentId;
  useEffect(() => {
    if (!publish || !connectionId || !agentId) return;
    let active = true;
    // File extraction stays outside the initial chat bundle. This observes
    // already-loaded messages only; it never polls the Session or filesystem.
    void import('../lib/session-files').then(({ collectSessionFiles }) => {
      if (!active) return;
      const sourcePath = collectSessionFiles(messages, sessionKey).files
        .filter(file => file.changeAt !== undefined && file.change !== 'deleted')
        .sort((a, b) => b.changeAt! - a.changeAt!)[0]?.path;
      publish(sessionKey, sourcePath ? { sessionKey, connectionId, agentId, sourcePath } : undefined);
    });
    return () => { active = false; };
  }, [publish, sessionKey, connectionId, agentId, messages]);
  const [open, setOpen] = useState(false);
  return <>
    {caption ? <CaptionIconButton priority={95} className="session-files-trigger" label={t('Session files')} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><FolderOpen size={14} aria-hidden="true" /></CaptionIconButton>
      : <button type="button" className="session-insights-trigger session-files-trigger desktop-chat-toolbar-control" title={t('Session files')} aria-label={t('Session files')} aria-haspopup="dialog" onClick={() => setOpen(true)}><Files size={15} /><span>{t('Files')}</span></button>}
    {open ? <Suspense fallback={<span role="status">{t('Loading…')}</span>}><FilePanel key={sessionKey} sessionKey={sessionKey} messages={messages} close={() => setOpen(false)} /></Suspense> : null}
  </>;
}
