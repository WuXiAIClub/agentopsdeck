import { useI18n } from '../lib/i18n';
import { AlertTriangle, Clock, Loader2, Wifi } from 'lucide-react';
import type { HubConnection } from '../api';
import { cn } from '../lib/cn';

/** Derive a concise health summary text from a connection list. */
export function connectionHealthSummary(connections: HubConnection[]): {
  enabled: number;
  degraded: number;
  disabled: number;
  total: number;
  statusLabel: string;
  allHealthy: boolean;
} {
  const enabled = connections.filter((c) => c.status === 'enabled').length;
  const degraded = connections.filter((c) => c.status === 'degraded').length;
  const disabled = connections.filter((c) => c.status === 'disabled').length;
  const total = connections.length;
  let statusLabel = 'No connections';
  if (total > 0) {
    if (degraded > 0) statusLabel = `${degraded} degraded`;
    else if (disabled === total) statusLabel = 'All disabled';
    else statusLabel = `${enabled} healthy`;
  }
  return { enabled, degraded, disabled, total, statusLabel, allHealthy: total > 0 && degraded === 0 && disabled < total };
}

// ---------------------------------------------------------------------------
// Health indicator pill — shown in the panel header and Gateway summary
// ---------------------------------------------------------------------------
export function ConnectionHealthPill({
  connections,
  lastPollAt,
  polling,
}: {
  connections: HubConnection[];
  lastPollAt?: number;
  polling?: boolean;
}) {
  const { t: tr } = useI18n();
  const summary = connectionHealthSummary(connections);
  if (summary.total === 0) return null;

  const pillClass = summary.degraded > 0
    ? 'border-red-200 bg-red-50 text-red-700'
    : summary.disabled === summary.total
      ? 'border-slate-200 bg-slate-50 text-slate-500'
      : 'border-emerald-200 bg-emerald-50 text-emerald-800';

  const icon = summary.degraded > 0
    ? <AlertTriangle size={10} className="shrink-0" />
    : polling
      ? <Loader2 size={10} className="shrink-0 animate-spin" />
      : <Wifi size={10} className="shrink-0" />;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[0.6rem] font-bold ${pillClass}`}
      title={lastPollAt ? tr('Last polled {time}', { time: new Date(lastPollAt).toLocaleTimeString() }) : undefined}
    >
      {icon}
      <span>{summary.degraded ? tr('{count} degraded', { count: summary.degraded }) : summary.disabled === summary.total ? tr('All disabled') : tr('{count} healthy', { count: summary.enabled })}</span>
      {lastPollAt && !polling && <Clock size={8} className="shrink-0 opacity-60" />}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Environment badge — used on session cards/details
// ---------------------------------------------------------------------------
export function EnvBadge({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  const { t: tr } = useI18n();
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border border-violet-200 bg-violet-50 px-1.5 py-px text-[0.58rem] font-black uppercase tracking-[0.06em] text-violet-700',
        className,
      )}
      title={tr('Environment: {name}', { name: label })}
    >
      {label}
    </span>
  );
}
