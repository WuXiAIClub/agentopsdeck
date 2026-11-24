import { Eye } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { ResourceAction, ResourceToolbar } from './ResourceToolbar';

/** Local display control, independent of editing bindings or file-sync grants. */
export function CardConnectionsButton() {
  const { t } = useI18n();
  return <ResourceToolbar><ResourceAction label={t('Toggle card connections')} onClick={event =>
    event.currentTarget.closest('[data-workspace-pane]')?.dispatchEvent(new Event('agentopsdeck:binding-lines', { bubbles: true }))
  }><Eye size={15} /></ResourceAction></ResourceToolbar>;
}
