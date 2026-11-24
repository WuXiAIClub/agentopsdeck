import { useI18n } from '../lib/i18n';

export function AdmissionHistoryNotice() {
  const { t } = useI18n();
  return <div role="status" data-admission-history-notice className="mb-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
    {t('Message accepted · history sync delayed. Do not resend.')}
  </div>;
}
