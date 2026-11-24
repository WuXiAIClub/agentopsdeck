import type { SessionSummary } from '@agentopsdeck/shared';
import { Server } from 'lucide-react';
import { sessionTone } from '../lib/session-tone';
export function ConnectorMark({ session }: { session: SessionSummary }) {
  const address = session as SessionSummary & { envConnectionId?: string; envConnectionLabel?: string };
  const label = address.envConnectionLabel || address.envConnectionId || 'Local Connector';
  const identity = address.envConnectionId || 'local';
  const tone = sessionTone('connector:' + identity);
  return <span className="connector-mark" title={`Connector: ${label} · ${identity}`} aria-label={`Connector: ${label}`}>
    <span className="connector-mark-icon" style={{ color: tone.accent }}><Server size={12} /></span>
    <span className="truncate">{label}</span>
  </span>;
}

export function SessionIdentityRow({ session }: { session: SessionSummary }) {
  // Runtime identity is not the user-defined OpenClaw agent name.
  const runtime = session.sessionRef?.runtimeId ?? session.source;
  const labels: Record<string, string> = { codex: 'Codex', hermes: 'Hermes', openclaw: 'OpenClaw', cc: 'CC', 'claude-code': 'CC', ghcp: 'GHCP' };
  const label = labels[runtime ?? ''] ?? 'OpenClaw';
  return <span className="session-identity-row">
    <ConnectorMark session={session} />
    <span className="session-runtime-label" data-runtime={runtime ?? 'openclaw'} aria-label={`Agent: ${label}`} title={session.agentId ? `${label} · ${session.agentId}` : label}>{label}</span>
  </span>;
}
