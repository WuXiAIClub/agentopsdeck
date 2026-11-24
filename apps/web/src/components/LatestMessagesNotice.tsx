import { RefreshCcw } from 'lucide-react';
import { useI18n } from '../lib/i18n';

export function LatestMessagesNotice({ active }: { active: boolean }) {
  const { t } = useI18n();
  if (!active) return null;
  return <div className="pointer-events-none flex justify-center py-1" role="status" aria-live="polite" data-latest-messages-loading>
    <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-100 bg-white/95 px-3 py-1 text-xs font-semibold text-blue-700 shadow-sm backdrop-blur">
      <RefreshCcw size={12} className="motion-safe:animate-spin" aria-hidden="true" />
      {t('Reading latest messages…')}
    </span>
  </div>;
}
