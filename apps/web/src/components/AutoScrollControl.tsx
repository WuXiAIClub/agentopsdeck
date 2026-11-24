import { ArrowDownToLine, Pause } from 'lucide-react';
import { useI18n } from '../lib/i18n';
export function AutoScrollControl({ enabled, onChange }: { enabled: boolean; onChange: () => void }) {
  const { t } = useI18n();
  return <button type="button" data-caption-priority={50} role="switch" aria-checked={enabled} aria-label={t(enabled ? 'Disable auto-scroll' : 'Enable auto-scroll')}
    title={t(enabled ? 'Follow new messages to the bottom' : 'Keep your reading position')} onClick={onChange}
    className="auto-scroll-control" data-enabled={enabled}>
    {enabled ? <ArrowDownToLine size={14} /> : <Pause size={14} />}<span>{t('Auto-scroll')}</span><span className="auto-scroll-state">{t(enabled ? 'On' : 'Off')}</span>
  </button>;
}
