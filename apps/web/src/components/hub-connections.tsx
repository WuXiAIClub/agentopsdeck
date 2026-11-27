import { useI18n } from '../lib/i18n';
/**
 * HubConnectionsPanel — Multi-environment connection management UI
 *
 * Security contract:
 * - Bearer tokens are accepted only via a transient input field.
 * - Tokens are sent once to the server vault on create/test and immediately
 *   discarded from React state after the call resolves.
 * - No token is ever stored in localStorage, sessionStorage, or rendered in
 *   the DOM after submission.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronUp, Clock, Loader2, Pencil, Plus, RefreshCcw, ShieldCheck, Trash2, UserPlus, Users, Wifi, WifiOff, X } from 'lucide-react';
import { AGENTOPSDECK_VERSION, AGENTOPSDECK_BUILD, CONNECTOR_PROTOCOL, negotiateConnectorProtocol, type ConnectorCapabilities, type ConnectorUpdateStatus, type GatewayModelSetStatus } from '@agentopsdeck/shared';
import { api, recoveryEpoch, recoveryScope, type HubPrincipal, type ConnectorUser, type ConnectorUsersByConnection, type HubConnection, type HubConnectionTestResult, type HubUser } from '../api';
import { HubUserAccess } from './HubUserAccess';
import { AhpChat } from './AhpChat';
import { ConnectorMemberManager } from './AccessRoleMatrix';
import { HubLoginActivity } from './HubLoginActivity';
import { EnvironmentExecutionSettings } from './ExecutionSetup';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { cn } from '../lib/cn';
import { buildConnectorUpdateApplyPayload, canApplyConnectorUpdate, canRollbackConnectorUpdate, formatConnectorUpdateStatus, formatModelSetStatus } from '../lib/maintenance-controls';
import { MaintenanceRecoveryNotice, useMaintenanceRecovery, type MaintenanceRecovery } from './maintenance-recovery';
import { ConnectionControlRecoveryNotice, useConnectionControlRecovery, type ConnectionControlRecovery } from './connection-control-recovery';
import { AdmissionMaintenanceControls } from './admission-maintenance';
import { LifecycleControls, LifecycleRecoveryNotice, useLifecycleRecovery, type LifecycleRecovery } from './lifecycle-maintenance';
import { confirmAction } from './ui/confirm';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type PanelState = 'list' | 'add';

/** Interval (ms) for auto-polling the connection health from /api/hub/v1/connections. */
const HEALTH_POLL_INTERVAL_MS = 30_000;

type TestState =
  | { phase: 'idle' }
  | { phase: 'testing' }
  | { phase: 'done'; result: HubConnectionTestResult };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function connectionStatusBadge(conn: HubConnection): { label: string; variant: 'default' | 'running' | 'accent' | 'muted' | 'active' } {
  if (conn.status === 'degraded') return { label: 'degraded', variant: 'accent' };
  if (conn.status === 'disabled') return { label: 'disabled', variant: 'muted' };
  return { label: 'connected', variant: 'running' };
}

function envLabel(conn: HubConnection) {
  return conn.environmentLabel ?? conn.label ?? conn.id;
}

function ownerLabel(conn: HubConnection, users: HubUser[]) {
  return conn.ownerUserLabel
    ?? users.find((user) => user.id === conn.ownerUserId)?.label
    ?? conn.ownerUserId
    ?? 'default';
}

import { ConnectionHealthPill } from './ConnectionHealth';
import {
  buildReverseConnectCommand,
  buildReverseConnectorUri,
  isReverseTunnelConnection,
  scoreConnectionHealth,
  summarizeConnectorTopology,
  buildDockerSandboxBlueprint,
  DOCKER_SANDBOX_COMMON_SECRET_KEYS,
  DOCKER_SANDBOX_PRESETS,
  type ConnectorTopologyGroupBy,
  type ConnectorTunnelMode,
  type DockerSandboxArtifactTab,
  type DockerSandboxNetworkMode,
  type DockerSandboxProfileId,
  type DockerSandboxRuntimeId,
  type HubDockerEngineStatus,
  type HubDockerSandboxInstance,
} from '../lib/connector-architecture';
export { ConnectionHealthPill, connectionHealthSummary, EnvBadge } from './ConnectionHealth';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------
function MaintenanceControls({ conn, recovery, controlRecovery }: { conn: HubConnection; recovery: MaintenanceRecovery; controlRecovery: ConnectionControlRecovery }) {
  const { t: tr, locale } = useI18n();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [caps, setCaps] = useState<ConnectorCapabilities>();
  const [model, setModel] = useState<GatewayModelSetStatus>();
  const [update, setUpdate] = useState<ConnectorUpdateStatus>();
  const generation = useRef(0), pending = useRef(false);
  useEffect(() => {
    generation.current++;
    setCaps(undefined); setModel(undefined); setUpdate(undefined); setError(undefined); setToken(''); setBusy(undefined);
    return () => { generation.current++; };
  }, [conn.id, conn.ownerUserId, conn.updatedAt, conn.connectorUrl, conn.kind, conn.status, recovery.scope, recovery.epoch]);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    const epoch = recovery.epoch;
    const request = ++generation.current;
    setBusy('refresh'); setError(undefined);
    const results = await Promise.allSettled([
        api.hubConnectionCapabilities(conn.id),
        api.hubModelSetStatus(conn.id),
        api.hubUpdateStatus(conn.id),
      ]);
    if (request !== generation.current || epoch !== recoveryEpoch()) return;
    const [nextCaps, nextModel, nextUpdate] = results;
    setCaps(nextCaps.status === 'fulfilled' ? nextCaps.value : undefined);
    setModel(nextModel.status === 'fulfilled' ? nextModel.value : undefined);
    setUpdate(nextUpdate.status === 'fulfilled' ? nextUpdate.value : undefined);
    const failed = results.flatMap((result, index) => result.status === 'rejected' ? [['Capabilities', 'Model set', 'Update'][index]] : []);
    if (failed.length) setError(`${failed.join(', ')} unavailable. Other status panels remain usable; check Connector permissions and version.`);
    setBusy(undefined);
  }, [conn.id, recovery.epoch]);
  const run = async (name: string, fn: () => Promise<any>) => {
    if (pending.current || !recovery.scope || recovery.epoch !== recoveryEpoch()) return;
    pending.current = true;
    const request = ++generation.current;
    const scope = recovery.scope;
    const current = () => request === generation.current && scope === recoveryScope() && recovery.epoch === recoveryEpoch();
    setBusy(name); setError(undefined);
    try {
      if (['apply update', 'rollback update', 'reconcile model'].includes(name) && !await confirmAction({ title: tr('Maintain “{name}”?', { name: envLabel(conn) }), description: tr('This changes this Connector only. An approved release and maintenance permission are required; an active run must not be interrupted.'), confirmLabel: tr('Confirm maintenance') })) return;
      // A modal may outlive its account, connection or authority snapshot.
      // Never send a newly confirmed mutation using a stale closure.
      if (!current()) return;
      const result = await fn();
      if (!current()) return;
      if (name.includes('model')) setModel(result.status ?? result); else setUpdate(result);
    }
    catch (err) { if (current()) setError(err instanceof Error ? err.message : `${name} failed`); }
    finally { pending.current = false; if (current()) setBusy(undefined); }
  };
  const protocol = caps ? negotiateConnectorProtocol(caps.protocol) : undefined;
  return <div className="mt-3 rounded-xl border border-blue-100 bg-blue-50/50 p-2 sm:col-span-2">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-[0.68rem] font-black uppercase tracking-wide text-blue-700">{tr("Connector maintenance")}</p><Button type="button" size="sm" variant="secondary" className="h-7 rounded-xl px-2 text-[0.68rem]" disabled={!!busy} onClick={() => void refresh()}>{busy === 'refresh' ? <Loader2 size={11} className="animate-spin" /> : tr("Refresh status")}</Button></div>
    <div className="mt-2 grid gap-2 text-xs sm:grid-cols-3">
      <div className="rounded-lg bg-white/70 p-2"><b>Connector</b><br />{caps ? `${caps.connector.version} · ${(caps.connector.build?.revision ?? caps.connector.revision ?? 'unknown').slice(0, 12)}${caps.connector.build?.dirty ? ' · dirty' : ''}` : tr('not loaded')}</div>
      <div className="rounded-lg bg-white/70 p-2"><b>{tr("Model set")}</b><br />{formatModelSetStatus(model, locale)}</div>
      <div className="rounded-lg bg-white/70 p-2"><b>{tr("Update")}</b><br />{formatConnectorUpdateStatus(update, locale)}</div>
    </div>
    <p className="mt-2 break-words text-xs text-slate-600" data-connector-compatibility>
      Hub {AGENTOPSDECK_VERSION} · {AGENTOPSDECK_BUILD.revision.slice(0, 12)}{AGENTOPSDECK_BUILD.dirty ? ` · ${tr('dirty')}` : ''} · {tr('Protocol')} {CONNECTOR_PROTOCOL.min}–{CONNECTOR_PROTOCOL.max}
      {caps ? <> · {protocol ? tr('Compatible · protocol {version}', { version: protocol }) : tr('Incompatible protocol · update required')}
        {!caps.protocol ? ` · ${tr('Legacy v1 compatibility')}` : ''}</> : null}
    </p>
    <p className="mt-1 text-xs text-slate-500">{tr('Product versions identify releases. Protocol ranges determine compatibility; optional features require Connector capabilities.')}</p>
    {update?.restartRequired ? <p role="status" className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">{tr('Release installed; restart and business readiness are not verified. A node supervisor must finish maintenance.')}</p> : null}
    {error && <p className="mt-2 rounded-lg bg-red-50 px-2 py-1 text-xs font-semibold text-red-700">{error}</p>}
    <div className="mt-2 flex flex-wrap gap-1.5">
      <Input aria-label={tr("Maintenance credential")} className="h-8 max-w-[15rem] rounded-xl text-xs" type="password" placeholder={tr("Maintenance token (write-only)")} value={token} onChange={(e) => setToken(e.currentTarget.value)} />
      <Button type="button" size="sm" className="h-8 rounded-xl px-2 text-xs" disabled={!!busy || !token.trim()} onClick={() => void run('save credential', async () => { await api.hubSaveMaintenanceCredential(conn.id, { token }); setToken(''); return update ?? await api.hubUpdateStatus(conn.id); })}>{tr("Save credential")}</Button>
      <Button type="button" size="sm" variant="secondary" className="h-8 rounded-xl px-2 text-xs" disabled={!!busy || controlRecovery.blocked(conn.id)} onClick={() => void run('reconcile model', () => controlRecovery.send({connectionId: conn.id, operation: 'reconcile'}))}>{tr("Reconcile model set")}</Button>
      <Button type="button" size="sm" variant="secondary" className="h-8 rounded-xl px-2 text-xs" disabled={!!busy || controlRecovery.blocked(conn.id)} onClick={() => void run('check update', () => controlRecovery.send({connectionId: conn.id, operation: 'updateCheck'}))}>{tr("Check update")}</Button>
      <Button type="button" size="sm" variant="secondary" className="h-8 rounded-xl px-2 text-xs" disabled={!canApplyConnectorUpdate(!!busy || recovery.blocked(conn.id), update)} onClick={() => { const payload = update ? buildConnectorUpdateApplyPayload(update) : undefined; if (payload) void run('apply update', () => recovery.send({ connectionId: conn.id, operation: 'apply' }, payload)); }}>{tr("Apply approved update")}</Button>
      <Button type="button" size="sm" variant="secondary" className="h-8 rounded-xl px-2 text-xs" disabled={!canRollbackConnectorUpdate(!!busy || recovery.blocked(conn.id), update)} onClick={() => void run('rollback update', () => recovery.send({ connectionId: conn.id, operation: 'rollback' }, {}))}>{tr("Rollback Connector")}</Button>
    </div>
  </div>;
}

function ConnectionRow({
  conn,
  users,
  recovery,
  controlRecovery,
  lifecycleRecovery,
  onDelete,
  onRename,
  poolRole,
}: {
  conn: HubConnection;
  users: HubUser[];
  recovery: MaintenanceRecovery;
  controlRecovery: ConnectionControlRecovery;
  lifecycleRecovery: LifecycleRecovery;
  onDelete: (id: string) => void;
  onRename: (id: string, label: string) => Promise<void>;
  poolRole?: 'primary' | 'failover' | undefined;
}) {
  const { t: tr } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [memberExecution, setMemberExecution] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [savingRename, setSavingRename] = useState(false);
  const [renameValue, setRenameValue] = useState(envLabel(conn));
  const badge = connectionStatusBadge(conn);
  const isReverse = isReverseTunnelConnection(conn);
  const healthScore = scoreConnectionHealth(conn);
  const identity = JSON.stringify([recovery.scope, recovery.epoch, conn.id, conn.ownerUserId, conn.connectorUrl, conn.updatedAt, conn.status]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  useEffect(() => () => { currentIdentity.current = ''; }, []);

  async function handleDelete() {
    if (!await confirmAction({ title: tr('Remove “{name}”?', { name: envLabel(conn) }),
      description: tr('Active remote sessions will become unavailable in this Hub. This does not delete them on the Connector.'), confirmLabel: tr('Remove') })) return;
    if (currentIdentity.current !== identity || !recovery.scope || recovery.epoch !== recoveryEpoch()) return;
    setDeleting(true);
    try {
      await onDelete(conn.id);
    } finally {
      setDeleting(false);
    }
  }

  async function handleRename() {
    const next = renameValue.trim();
    if (!next || next === envLabel(conn)) { setEditing(false); setRenameValue(envLabel(conn)); return; }
    setSavingRename(true);
    try {
      await onRename(conn.id, next);
      setEditing(false);
    } finally {
      setSavingRename(false);
    }
  }

  return (
    <li className="rounded-2xl border border-white/70 bg-white/60 px-3 py-2.5 shadow-sm">
      <div className="flex min-w-0 items-center gap-3">
        {conn.status === 'degraded'
          ? <WifiOff size={16} className="shrink-0 text-red-500" aria-hidden="true" />
          : <Wifi size={16} className={cn('shrink-0', conn.status === 'disabled' ? 'text-slate-400' : 'text-emerald-600')} aria-hidden="true" />}

        <div className="min-w-0 flex-1">
          {editing ? <div className="flex min-w-0 items-center gap-1.5">
            <Input
              aria-label={tr('Rename {name}', { name: envLabel(conn) })}
              className="h-8 rounded-xl text-sm font-bold"
              value={renameValue}
              autoFocus
              onChange={(event) => setRenameValue(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleRename();
                if (event.key === 'Escape') { setEditing(false); setRenameValue(envLabel(conn)); }
              }}
            />
            <Button type="button" size="sm" className="h-8 rounded-xl px-2 text-xs" disabled={savingRename} onClick={() => void handleRename()}>{savingRename ? <Loader2 size={12} className="animate-spin" /> : tr('Save')}</Button>
          </div> : <p className="truncate text-sm font-bold text-slate-900">{envLabel(conn)}</p>}
          <p className="truncate text-xs text-slate-500">{conn.kind === 'local' ? tr('local connector') : conn.connectorUrl ?? conn.id}</p>
          <p className="truncate text-[0.68rem] font-semibold text-blue-700">{tr("Owner ·")} {ownerLabel(conn, users)} <span className="text-blue-400">({conn.ownerUserId ?? 'default'})</span></p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {isReverse && (
            <Badge variant="default" className="hidden border-indigo-200 bg-indigo-50 text-[0.62rem] text-indigo-700 sm:inline-flex" title={tr("Reverse Tunnel (Outbound NAT Traversal)")}>
              ⇄ {tr("Reverse")}
            </Badge>
          )}
          {poolRole === 'primary' && (
            <Badge variant="running" className="hidden text-[0.62rem] sm:inline-flex" title={tr("Primary route in environment pool")}>
              ★ {tr("Primary")}
            </Badge>
          )}
          {poolRole === 'failover' && (
            <Badge variant="muted" className="hidden text-[0.62rem] sm:inline-flex" title={tr("Standby failover route in environment pool")}>
              {tr("Failover")}
            </Badge>
          )}
          <span className="hidden rounded-lg bg-slate-100 px-1.5 py-0.5 font-mono text-[0.62rem] font-bold text-slate-600 sm:inline" title={tr("Connection health score")}>
            {healthScore}%
          </span>
          <Badge variant={badge.variant} className="hidden text-[0.65rem] sm:inline-flex">{badge.label}</Badge>
          {conn.hasCredential && (
            <span className="hidden text-[0.65rem] font-semibold text-emerald-700 sm:inline" title={tr("Credential stored server-side")}>🔒</span>
          )}
          <button
            type="button"
            className="grid h-7 w-7 place-items-center rounded-xl text-slate-500 hover:bg-blue-50 hover:text-blue-600 disabled:opacity-40"
            disabled={savingRename || deleting}
            onClick={() => { setEditing((value) => !value); setRenameValue(envLabel(conn)); }}
            aria-label={tr('Rename connection {name}', { name: envLabel(conn) })}
            title={tr("Rename environment")}
          >
            <Pencil size={13} />
          </button>
          {conn.kind === 'remote' && (
            <button
              type="button"
              className="grid h-7 w-7 place-items-center rounded-xl text-slate-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
              disabled={deleting}
              onClick={() => void handleDelete()}
              aria-label={tr('Delete connection {name}', { name: envLabel(conn) })}
              title={tr("Delete connection")}
            >
              {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
            </button>
          )}
          <button
            type="button"
            className="grid h-7 w-7 place-items-center rounded-xl text-slate-500 hover:bg-slate-100"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={tr(expanded ? 'Collapse details' : 'Expand details')}
          >
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        </div>
      </div>

      <div className="mt-2">
        <button type="button" className="py-1 text-xs font-semibold text-blue-700" aria-expanded={memberExecution} onClick={() => setMemberExecution(value => !value)}>{tr("Member execution")}</button>
        {memberExecution ? <EnvironmentExecutionSettings key={JSON.stringify([recovery.scope, conn.id])} connectionId={conn.id} /> : null}
      </div>
      {expanded && (
        <dl className="mt-2.5 grid gap-1 border-t border-slate-100 pt-2.5 text-xs sm:grid-cols-2">
          <div><dt className="font-bold text-slate-500 uppercase tracking-wide text-[0.6rem]">{tr("Kind")}</dt><dd className="text-slate-800">{conn.kind}</dd></div>
          <div><dt className="font-bold text-slate-500 uppercase tracking-wide text-[0.6rem]">{tr("Status")}</dt><dd className="text-slate-800">{conn.status}</dd></div>
          <div><dt className="font-bold text-slate-500 uppercase tracking-wide text-[0.6rem]">{tr("Owner")}</dt><dd className="text-slate-800 truncate">{ownerLabel(conn, users)} ({conn.ownerUserId ?? 'default'})</dd></div>
          {conn.environmentId && <div><dt className="font-bold text-slate-500 uppercase tracking-wide text-[0.6rem]">{tr("Env ID")}</dt><dd className="text-slate-800 truncate">{conn.environmentId}</dd></div>}
          {conn.capabilities && <div className="sm:col-span-2"><dt className="font-bold text-slate-500 uppercase tracking-wide text-[0.6rem]">{tr("Capabilities")}</dt><dd className="text-slate-800">{conn.capabilities.join(', ')}</dd></div>}
          {conn.connectorUrl && <div className="sm:col-span-2"><dt className="font-bold text-slate-500 uppercase tracking-wide text-[0.6rem]">{tr("Connector URL")}</dt><dd className="text-slate-800 truncate">{conn.connectorUrl}</dd></div>}
          {'error' in conn && conn.error && <div className="sm:col-span-2"><dt className="font-bold text-red-500 uppercase tracking-wide text-[0.6rem]">{tr("Last error")}</dt><dd className="text-red-700">{String(conn.error)}</dd></div>}
            <MaintenanceControls conn={conn} recovery={recovery} controlRecovery={controlRecovery} />
            {conn.status !== 'disabled' && <AhpChat key={identity} connectionId={conn.id} />}
            <AdmissionMaintenanceControls key={JSON.stringify([recovery.scope, conn.id])} connectionId={conn.id} recovery={recovery} />
            {conn.kind === 'remote' && <LifecycleControls key={JSON.stringify([recovery.scope, recovery.epoch, conn.id, conn.updatedAt])} connectionId={conn.id} recovery={lifecycleRecovery} />}
        </dl>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Add Connection Form
// ---------------------------------------------------------------------------
function AddConnectionForm({
  onSave,
  onCancel,
  onSandboxLaunched,
}: {
  onSave: (conn: HubConnection) => void;
  onCancel: () => void;
  onSandboxLaunched?: (sandbox: HubDockerSandboxInstance, conn?: HubConnection) => void;
}) {
  const { t: tr } = useI18n();
  const [tunnelMode, setTunnelMode] = useState<ConnectorTunnelMode>('direct');
  const [label, setLabel] = useState('');
  const [connectorUrl, setConnectorUrl] = useState('');
  const [environmentLabel, setEnvironmentLabel] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [copiedCompose, setCopiedCompose] = useState(false);
  const [copiedDockerfile, setCopiedDockerfile] = useState(false);
  const [sandboxProfile, setSandboxProfile] = useState<DockerSandboxProfileId>('isolated-test');
  const [sandboxCpu, setSandboxCpu] = useState<number>(1);
  const [sandboxMemoryMb, setSandboxMemoryMb] = useState<number>(2048);
  const [sandboxTmpfsMb, setSandboxTmpfsMb] = useState<number>(1024);
  const [sandboxPidsLimit, setSandboxPidsLimit] = useState<number>(256);
  const [sandboxTtlMinutes, setSandboxTtlMinutes] = useState<number>(60);
  const [sandboxNetworkMode, setSandboxNetworkMode] = useState<DockerSandboxNetworkMode>('bridge');
  const [sandboxReadOnly, setSandboxReadOnly] = useState(false);
  const [sandboxRuntimes, setSandboxRuntimes] = useState<DockerSandboxRuntimeId[]>(['codex']);
  const [sandboxSecretKeys, setSandboxSecretKeys] = useState<string[]>(['OPENAI_API_KEY']);
  const [customSecretKey, setCustomSecretKey] = useState('');
  const [sandboxArtifactTab, setSandboxArtifactTab] = useState<DockerSandboxArtifactTab>('run');
  const [launchingSandbox, setLaunchingSandbox] = useState(false);

  const reverseUri = useMemo(
    () => buildReverseConnectorUri(environmentId || environmentLabel || 'prod', label || 'edge-node'),
    [environmentId, environmentLabel, label],
  );
  const reverseCommand = useMemo(
    () => buildReverseConnectCommand({
      hubUrl: typeof window !== 'undefined' ? window.location.origin : 'https://hub.example.com',
      environmentId: environmentId || environmentLabel || 'prod',
      environmentLabel: environmentLabel || undefined,
      nodeLabel: label || undefined,
    }),
    [environmentId, environmentLabel, label],
  );

  const dockerBlueprint = useMemo(
    () => buildDockerSandboxBlueprint({
      hubUrl: typeof window !== 'undefined' ? window.location.origin : 'https://hub.example.com',
      environmentId: environmentId || environmentLabel || 'sandbox',
      nodeLabel: label || sandboxProfile,
      profileId: sandboxProfile,
      cpuLimit: sandboxCpu,
      memoryLimitMb: sandboxMemoryMb,
      workspaceTmpfsMb: sandboxTmpfsMb,
      pidsLimit: sandboxPidsLimit,
      ttlMinutes: sandboxTtlMinutes,
      networkMode: sandboxNetworkMode,
      readOnlyRootfs: sandboxReadOnly || sandboxProfile === 'airgapped-review',
      runtimes: sandboxRuntimes,
      secretEnvKeys: sandboxSecretKeys,
    }),
    [
      environmentId,
      environmentLabel,
      label,
      sandboxProfile,
      sandboxCpu,
      sandboxMemoryMb,
      sandboxTmpfsMb,
      sandboxPidsLimit,
      sandboxTtlMinutes,
      sandboxNetworkMode,
      sandboxReadOnly,
      sandboxRuntimes,
      sandboxSecretKeys,
    ],
  );

  function applySandboxPreset(presetId: DockerSandboxProfileId) {
    const preset = DOCKER_SANDBOX_PRESETS.find((item) => item.id === presetId) ?? DOCKER_SANDBOX_PRESETS[0]!;
    setSandboxProfile(preset.id);
    setSandboxCpu(preset.cpuLimit);
    setSandboxMemoryMb(preset.memoryLimitMb);
    setSandboxTmpfsMb(preset.workspaceTmpfsMb);
    setSandboxPidsLimit(preset.pidsLimit);
    setSandboxTtlMinutes(preset.ttlMinutes);
    setSandboxNetworkMode(preset.networkMode);
    setSandboxReadOnly(preset.readOnlyRootfs);
    setSandboxRuntimes([...preset.runtimes]);
    setSandboxSecretKeys([...preset.secretEnvKeys]);
  }

  async function handleLaunchDockerSandbox() {
    setFormError(undefined);
    setLaunchingSandbox(true);
    try {
      const res = await api.hubCreateDockerSandbox({
        name: label.trim() || `${sandboxProfile}-sandbox`,
        profileId: sandboxProfile,
        cpuLimit: sandboxCpu,
        memoryLimitMb: sandboxMemoryMb,
        workspaceTmpfsMb: sandboxTmpfsMb,
        pidsLimit: sandboxPidsLimit,
        ttlMinutes: sandboxTtlMinutes,
        networkMode: sandboxNetworkMode,
        readOnlyRootfs: sandboxReadOnly || sandboxProfile === 'airgapped-review',
        runtimes: sandboxRuntimes,
        secretEnvKeys: sandboxSecretKeys,
        hubUrl: typeof window !== 'undefined' ? window.location.origin : 'https://hub.example.com',
        environmentId: environmentId.trim() || `docker-${sandboxProfile}`,
        environmentLabel: environmentLabel.trim() || label.trim() || `Docker Sandbox (${sandboxProfile})`,
      });
      if (onSandboxLaunched) {
        onSandboxLaunched(res.sandbox, res.connection);
      } else if (res.connection) {
        onSave(res.connection);
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setLaunchingSandbox(false);
    }
  }

  useEffect(() => {
    if (tunnelMode === 'reverse') {
      setConnectorUrl(reverseUri);
    } else if (tunnelMode === 'docker-sandbox') {
      setConnectorUrl(dockerBlueprint.connectorUri);
    } else if (connectorUrl.startsWith('reverse://')) {
      setConnectorUrl('');
    }
  }, [tunnelMode, reverseUri, dockerBlueprint.connectorUri]);
  // token is stored only in a ref so it is never in React state and cannot
  // accidentally be serialised/persisted. The ref and DOM input are cleared immediately after use.
  const tokenRef = useRef('');
  const tokenInputRef = useRef<HTMLInputElement | null>(null);
  const [saving, setSaving] = useState(false);
  const [testState, setTestState] = useState<TestState>({ phase: 'idle' });
  const [formError, setFormError] = useState<string>();

  async function handleTest() {
    const url = connectorUrl.trim();
    if (!url) { setFormError('Connector URL is required to test.'); return; }
    setFormError(undefined);
    setTestState({ phase: 'testing' });
    try {
      const payload: { connectorUrl: string; token?: string } = { connectorUrl: url };
      if (tokenRef.current) payload.token = tokenRef.current;
      tokenRef.current = '';
      if (tokenInputRef.current) tokenInputRef.current.value = '';
      const result = await api.hubTestConnection(payload);
      setTestState({ phase: 'done', result });
    } catch (err) {
      tokenRef.current = '';
      if (tokenInputRef.current) tokenInputRef.current.value = '';
      setTestState({ phase: 'done', result: { ok: false, connectorUrl: url, error: err instanceof Error ? err.message : String(err), updatedAt: Date.now() } });
    }
  }

  async function handleSave() {
    const url = connectorUrl.trim();
    if (!url) { setFormError('Connector URL is required.'); return; }
    setFormError(undefined);
    setSaving(true);
    const token = tokenRef.current;
    // Clear token holders before the async call to minimise exposure window.
    tokenRef.current = '';
    if (tokenInputRef.current) tokenInputRef.current.value = '';
    try {
      const payload: Parameters<typeof api.hubCreateConnection>[0] = { connectorUrl: url };
      if (label.trim()) payload.label = label.trim();
      if (token) payload.token = token;
      if (environmentId.trim()) payload.environmentId = environmentId.trim();
      if (environmentLabel.trim()) payload.environmentLabel = environmentLabel.trim();
      const { connection } = await api.hubCreateConnection(payload);
      onSave(connection);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-black uppercase tracking-[0.14em] text-slate-500">{tr("Add remote connector")}</p>
        <button type="button" className="grid h-7 w-7 place-items-center rounded-xl text-slate-400 hover:bg-slate-100" onClick={onCancel} aria-label={tr("Cancel")}><X size={14} /></button>
      </div>

      <div className="flex gap-1.5 rounded-xl bg-white/80 p-1 ring-1 ring-blue-100" role="tablist" aria-label={tr("Connection mode")}>
        <button
          type="button"
          role="tab"
          aria-selected={tunnelMode === 'direct'}
          className={cn(
            "flex-1 rounded-lg px-2.5 py-1.5 text-xs font-bold transition",
            tunnelMode === 'direct' ? "bg-blue-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"
          )}
          onClick={() => setTunnelMode('direct')}
        >
          {tr("Direct HTTP/S (Hub dials Connector)")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tunnelMode === 'reverse'}
          className={cn(
            "flex-1 rounded-lg px-2.5 py-1.5 text-xs font-bold transition",
            tunnelMode === 'reverse' ? "bg-indigo-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"
          )}
          onClick={() => setTunnelMode('reverse')}
        >
          ⇄ {tr("Reverse Tunnel (NAT / Outbound)")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tunnelMode === 'docker-sandbox'}
          className={cn(
            "flex-1 rounded-lg px-2.5 py-1.5 text-xs font-bold transition",
            tunnelMode === 'docker-sandbox' ? "bg-emerald-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"
          )}
          onClick={() => setTunnelMode('docker-sandbox')}
        >
          🐳 {tr("Docker + Codex Sandbox")}
        </button>
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-xs font-bold text-slate-600 mb-1" htmlFor="hc-url">
            {tunnelMode === 'reverse' ? tr("Reverse Tunnel URI") : tr("Connector URL")} <span className="text-red-500">*</span>
          </label>
          <Input
            id="hc-url"
            type={tunnelMode === 'reverse' ? "text" : "url"}
            placeholder="https://my-connector.example.com"
            value={connectorUrl}
            onChange={(e) => setConnectorUrl(e.currentTarget.value)}
            className="h-9 rounded-xl text-sm font-mono"
            autoComplete="off"
          />
        </div>

        {tunnelMode === 'reverse' && (
          <div className="rounded-xl border border-indigo-200 bg-indigo-50/80 p-3 text-xs text-indigo-950">
            <div className="flex items-center justify-between gap-2">
              <span className="font-bold">{tr("Outbound Reverse Connect Command (run on remote node)")}</span>
              <button
                type="button"
                className="rounded-lg bg-indigo-600 px-2 py-0.5 text-[0.68rem] font-bold text-white hover:bg-indigo-700"
                onClick={() => {
                  void navigator.clipboard?.writeText(reverseCommand);
                  setCopiedCmd(true);
                  window.setTimeout(() => setCopiedCmd(false), 1800);
                }}
              >
                {copiedCmd ? tr("Copied") : tr("Copy CLI")}
              </button>
            </div>
            <pre className="mt-1.5 overflow-x-auto rounded-lg bg-slate-900 p-2 font-mono text-[0.68rem] text-emerald-300">{reverseCommand}</pre>
            <p className="mt-1 text-[0.68rem] text-indigo-700">
              {tr("No inbound port required on the remote machine. The Connector dials out to Hub over WebSocket and auto-reconnects.")}
            </p>
          </div>
        )}

        {tunnelMode === 'docker-sandbox' && (
          <div className="space-y-2.5 rounded-xl border border-emerald-200 bg-emerald-50/80 p-3 text-xs text-emerald-950" data-docker-sandbox-builder>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-bold">{tr("Isolated Docker Connector + Codex Sandbox")}</span>
              <div className="flex items-center gap-1">
                {DOCKER_SANDBOX_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => applySandboxPreset(preset.id)}
                    className={cn(
                      "rounded-lg px-2 py-0.5 text-[0.66rem] font-bold transition",
                      sandboxProfile === preset.id ? "bg-emerald-600 text-white" : "bg-white text-emerald-800 hover:bg-emerald-100"
                    )}
                  >
                    {preset.id}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-4">
              <label className="block text-[0.68rem] font-bold text-emerald-900">
                {tr("vCPU Limit")}
                <select
                  id="hc-docker-cpu"
                  name="hc-docker-cpu"
                  value={sandboxCpu}
                  onChange={(e) => setSandboxCpu(Number(e.currentTarget.value))}
                  className="mt-0.5 block w-full rounded-lg border border-emerald-200 bg-white px-2 py-1 text-xs font-semibold text-slate-800"
                >
                  {[0.5, 1, 2, 4, 8, 16].map((v) => (
                    <option key={v} value={v}>{`${v} vCPU`}</option>
                  ))}
                </select>
              </label>
              <label className="block text-[0.68rem] font-bold text-emerald-900">
                {tr("Memory (RAM)")}
                <select
                  id="hc-docker-ram"
                  name="hc-docker-ram"
                  value={sandboxMemoryMb}
                  onChange={(e) => setSandboxMemoryMb(Number(e.currentTarget.value))}
                  className="mt-0.5 block w-full rounded-lg border border-emerald-200 bg-white px-2 py-1 text-xs font-semibold text-slate-800"
                >
                  {[1024, 2048, 4096, 8192, 16384].map((v) => (
                    <option key={v} value={v}>{`${v} MB`}</option>
                  ))}
                </select>
              </label>
              <label className="block text-[0.68rem] font-bold text-emerald-900">
                {tr("/workspace tmpfs")}
                <select
                  id="hc-docker-tmpfs"
                  name="hc-docker-tmpfs"
                  value={sandboxTmpfsMb}
                  onChange={(e) => setSandboxTmpfsMb(Number(e.currentTarget.value))}
                  className="mt-0.5 block w-full rounded-lg border border-emerald-200 bg-white px-2 py-1 text-xs font-semibold text-slate-800"
                >
                  {[256, 512, 1024, 2048, 4096, 8192].map((v) => (
                    <option key={v} value={v}>{`${v} MB`}</option>
                  ))}
                </select>
              </label>
              <label className="block text-[0.68rem] font-bold text-emerald-900">
                {tr("Lease TTL")}
                <select
                  id="hc-docker-ttl"
                  name="hc-docker-ttl"
                  value={sandboxTtlMinutes}
                  onChange={(e) => setSandboxTtlMinutes(Number(e.currentTarget.value))}
                  className="mt-0.5 block w-full rounded-lg border border-emerald-200 bg-white px-2 py-1 text-xs font-semibold text-slate-800"
                >
                  {[15, 30, 45, 60, 120, 240, 480, 1440].map((v) => (
                    <option key={v} value={v}>{v >= 60 ? `${v / 60}h (${v}m)` : `${v}m`}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="block text-[0.68rem] font-bold text-emerald-900">
                {tr("Network Isolation")}
                <select
                  id="hc-docker-net"
                  name="hc-docker-net"
                  value={sandboxNetworkMode}
                  onChange={(e) => setSandboxNetworkMode(e.currentTarget.value as DockerSandboxNetworkMode)}
                  className="mt-0.5 block w-full rounded-lg border border-emerald-200 bg-white px-2 py-1 text-xs font-semibold text-slate-800"
                >
                  <option value="bridge">{tr("Bridge (Outbound NAT)")}</option>
                  <option value="none">{tr("Air-Gapped (none)")}</option>
                  <option value="host-gateway">{tr("Host Gateway")}</option>
                </select>
              </label>
              <div className="text-[0.68rem] font-bold text-emerald-900">
                <span>{tr("Agent Runtimes")}</span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {(['codex', 'claude', 'copilot'] as const).map((rt) => {
                    const active = sandboxRuntimes.includes(rt);
                    return (
                      <button
                        key={rt}
                        type="button"
                        onClick={() => {
                          setSandboxRuntimes((prev) =>
                            prev.includes(rt)
                              ? prev.length > 1 ? prev.filter((item) => item !== rt) : prev
                              : [...prev, rt]
                          );
                        }}
                        className={cn(
                          "rounded-md px-2 py-0.5 text-[0.65rem] font-bold uppercase transition",
                          active ? "bg-emerald-700 text-white" : "bg-white text-emerald-800 ring-1 ring-emerald-200"
                        )}
                      >
                        {rt}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="flex flex-col justify-end pb-0.5 text-[0.68rem] text-emerald-900">
                <label className="inline-flex items-center gap-1.5 font-bold">
                  <input
                    id="hc-docker-ro"
                    name="hc-docker-ro"
                    type="checkbox"
                    checked={dockerBlueprint.readOnlyRootfs}
                    onChange={(e) => setSandboxReadOnly(e.currentTarget.checked)}
                  />
                  {tr("Read-only RootFS")}
                </label>
                <span className="text-[0.62rem] text-emerald-700">
                  {`cap-drop=ALL · no-new-privileges · pids=${dockerBlueprint.pidsLimit}`}
                </span>
              </div>
            </div>
            <div className="rounded-lg border border-emerald-200/80 bg-white/80 p-2">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <span className="text-[0.66rem] font-bold text-emerald-900">
                  {tr("Vault Env Key References (passed as name-only -e KEY, never plaintext)")}
                </span>
                <div className="flex flex-wrap gap-1">
                  {DOCKER_SANDBOX_COMMON_SECRET_KEYS.map((key) => {
                    const selected = sandboxSecretKeys.includes(key);
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() =>
                          setSandboxSecretKeys((prev) =>
                            prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
                          )
                        }
                        className={cn(
                          "rounded px-1.5 py-0.5 font-mono text-[0.62rem] font-bold transition",
                          selected ? "bg-emerald-600 text-white" : "bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                        )}
                      >
                        {selected ? '✓ ' : '+ '}{key}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="mt-1.5 flex items-center gap-1.5">
                <Input
                  id="hc-docker-secret-key"
                  name="hc-docker-secret-key"
                  placeholder={tr("CUSTOM_API_KEY")}
                  value={customSecretKey}
                  onChange={(e) => setCustomSecretKey(e.currentTarget.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
                  className="h-7 max-w-[13rem] rounded-lg font-mono text-[0.68rem]"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="h-7 rounded-lg px-2 text-[0.65rem]"
                  disabled={!customSecretKey.trim()}
                  onClick={() => {
                    const clean = customSecretKey.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
                    if (clean && !sandboxSecretKeys.includes(clean)) {
                      setSandboxSecretKeys((prev) => [...prev, clean]);
                    }
                    setCustomSecretKey('');
                  }}
                >
                  + {tr("Add Env Key")}
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <div className="flex items-center gap-1 rounded-lg bg-white p-0.5 ring-1 ring-emerald-200">
                {([
                  { id: 'run', label: 'docker run' },
                  { id: 'compose', label: 'docker-compose.yml' },
                  { id: 'dockerfile', label: 'Dockerfile' },
                ] as const).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setSandboxArtifactTab(tab.id)}
                    className={cn(
                      "rounded-md px-2 py-0.5 font-mono text-[0.65rem] font-bold transition",
                      sandboxArtifactTab === tab.id ? "bg-slate-900 text-emerald-300" : "text-slate-600 hover:bg-slate-100"
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  className="rounded-lg bg-emerald-600 px-2 py-0.5 text-[0.68rem] font-bold text-white hover:bg-emerald-700"
                  onClick={() => {
                    void navigator.clipboard?.writeText(dockerBlueprint.dockerRunCommand);
                    setCopiedCmd(true);
                    window.setTimeout(() => setCopiedCmd(false), 1800);
                  }}
                >
                  {copiedCmd ? tr("Copied") : tr("Copy docker run")}
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-slate-800 px-2 py-0.5 text-[0.68rem] font-bold text-white hover:bg-slate-900"
                  onClick={() => {
                    void navigator.clipboard?.writeText(dockerBlueprint.dockerComposeYaml);
                    setCopiedCompose(true);
                    window.setTimeout(() => setCopiedCompose(false), 1800);
                  }}
                >
                  {copiedCompose ? tr("Copied") : tr("Copy compose.yml")}
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-slate-700 px-2 py-0.5 text-[0.68rem] font-bold text-white hover:bg-slate-800"
                  onClick={() => {
                    void navigator.clipboard?.writeText(dockerBlueprint.dockerfileSnippet);
                    setCopiedDockerfile(true);
                    window.setTimeout(() => setCopiedDockerfile(false), 1800);
                  }}
                >
                  {copiedDockerfile ? tr("Copied") : tr("Copy Dockerfile")}
                </button>
              </div>
            </div>
            <pre className="max-h-44 overflow-auto rounded-lg bg-slate-900 p-2 font-mono text-[0.66rem] text-emerald-300">
              {sandboxArtifactTab === 'run'
                ? dockerBlueprint.dockerRunCommand
                : sandboxArtifactTab === 'compose'
                  ? dockerBlueprint.dockerComposeYaml
                  : dockerBlueprint.dockerfileSnippet}
            </pre>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-emerald-100/80 px-2.5 py-1.5">
              <span className="text-[0.66rem] font-semibold text-emerald-950">
                {tr("One-click orchestrate on Hub host or register reverse:// sandbox endpoint:")}
              </span>
              <Button
                type="button"
                size="sm"
                className="h-7 rounded-lg bg-emerald-700 px-2.5 text-[0.68rem] font-bold text-white hover:bg-emerald-800"
                disabled={launchingSandbox || saving}
                onClick={() => void handleLaunchDockerSandbox()}
              >
                {launchingSandbox ? <><Loader2 size={11} className="mr-1 animate-spin" />{tr("Launching Sandbox…")}</> : <>🐳 {tr("Launch Ephemeral Sandbox Now")}</>}
              </Button>
            </div>
          </div>
        )}

        <div>
          <label className="block text-xs font-bold text-slate-600 mb-1" htmlFor="hc-label">{tr("Label")}</label>
          <Input
            id="hc-label"
            placeholder={tr("Production connector")}
            value={label}
            onChange={(e) => setLabel(e.currentTarget.value)}
            className="h-9 rounded-xl text-sm"
          />
        </div>

        <div>
          <label className="block text-xs font-bold text-slate-600 mb-1" htmlFor="hc-env-label">{tr("Environment label")}</label>
          <Input
            id="hc-env-label"
            placeholder={tr("Production")}
            value={environmentLabel}
            onChange={(e) => setEnvironmentLabel(e.currentTarget.value)}
            className="h-9 rounded-xl text-sm"
          />
        </div>

        <div>
          <label className="block text-xs font-bold text-slate-600 mb-1" htmlFor="hc-env-id">{tr("Environment ID")}</label>
          <Input
            id="hc-env-id"
            placeholder="prod"
            value={environmentId}
            onChange={(e) => setEnvironmentId(e.currentTarget.value)}
            className="h-9 rounded-xl text-sm"
          />
        </div>

        <div>
          <label className="block text-xs font-bold text-slate-600 mb-1" htmlFor="hc-token">
            {tr("Bearer token")}
            <span className="ml-2 text-[0.65rem] font-normal text-slate-400">{tr("(sent once to server vault — not stored or displayed after submit)")}</span>
          </label>
          <Input
            id="hc-token"
            ref={tokenInputRef}
            type="password"
            placeholder={tr("Optional")}
            autoComplete="new-password"
            onChange={(e) => { tokenRef.current = e.currentTarget.value; }}
            className="h-9 rounded-xl text-sm"
          />
        </div>
      </div>

      {formError && (
        <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{formError}</p>
      )}

      {testState.phase === 'done' && (
        <div className={cn('rounded-xl border px-3 py-2 text-xs', testState.result.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700')}>
          {testState.result.ok
            ? <span className="flex items-center gap-1.5"><Check size={12} className="shrink-0" /> {tr("Connection successful")}</span>
            : <span>{tr("Test failed:")} {testState.result.error ?? tr('unknown error')}</span>}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 pt-1">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-8 rounded-xl text-xs"
          disabled={testState.phase === 'testing' || saving}
          onClick={() => void handleTest()}
        >
          {testState.phase === 'testing' ? <><Loader2 size={12} className="animate-spin mr-1" />{tr("Testing…")}</> : tr("Test")}
        </Button>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" size="sm" className="h-8 rounded-xl text-xs" onClick={onCancel}>{tr("Cancel")}</Button>
          <Button
            type="button"
            size="sm"
            className="h-8 rounded-xl text-xs"
            disabled={saving || !connectorUrl.trim()}
            onClick={() => void handleSave()}
          >
            {saving ? <><Loader2 size={12} className="animate-spin mr-1" />{tr("Saving…")}</> : <><Plus size={12} className="mr-1" />{tr("Add")}</>}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Panel
// ---------------------------------------------------------------------------
export function AccessControlPage({
  principal,
  users,
  connections,
  connectorConnections,
  loading,
  connectorLoading,
  hubUnavailable = false,
  connectorUnavailable = false,
  onCreate,
  onRename,
  onCreateConnectorUser,
  onRenameConnectorUser,
}: {
  principal?: HubPrincipal | undefined;
  users: HubUser[];
  connections: HubConnection[];
  connectorConnections: ConnectorUsersByConnection[];
  loading: boolean;
  connectorLoading: boolean;
  hubUnavailable?: boolean;
  connectorUnavailable?: boolean;
  onCreate: (label: string) => Promise<HubUser>;
  onRename: (id: string, label: string) => Promise<void>;
  onCreateConnectorUser: (connectionId: string, label: string) => Promise<void>;
  onRenameConnectorUser: (connectionId: string, id: string, label: string) => Promise<void>;
}) {
  const { t: tr } = useI18n();
  const [newLabel, setNewLabel] = useState('');
  const [savingNew, setSavingNew] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [editingLabel, setEditingLabel] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState('');
  const [accessUserId, setAccessUserId] = useState<string>();
  const accessUser = users.find(user => user.id === accessUserId);
  const accessPanel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (accessUser && !window.matchMedia('(min-width: 1024px)').matches) accessPanel.current?.scrollIntoView({ block: 'start' });
  }, [accessUser?.id]);
  const visibleUsers = users.filter(user => `${user.label} ${user.id}`.toLowerCase().includes(search.trim().toLowerCase()));

  async function handleCreate() {
    if (savingNew || loading) return;
    const label = newLabel.trim();
    if (!label) { setError('User label is required.'); return; }
    setError(undefined);
    setSavingNew(true);
    try {
      const created = await onCreate(label);
      setNewLabel('');
      setAccessUserId(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingNew(false);
    }
  }

  async function handleRename(user: HubUser) {
    if (savingEdit || loading) return;
    const label = editingLabel.trim();
    if (!label) { setError('User label is required.'); return; }
    if (label === user.label) { setEditingId(undefined); return; }
    setError(undefined);
    setSavingEdit(true);
    try {
      await onRename(user.id, label);
      setEditingId(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingEdit(false);
    }
  }

  const connectionCountByUser = useMemo(() => {
    const counts = new Map<string, number>();
    for (const connection of connections) {
      const ownerId = connection.ownerUserId ?? 'default';
      counts.set(ownerId, (counts.get(ownerId) ?? 0) + 1);
    }
    return counts;
  }, [connections]);

  const defaultUser = users.find((user) => user.id === 'default');

  return (
    <Card className="min-w-0 overflow-hidden border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-3 sm:px-4" aria-label={tr("People overview")}>
        <div className="flex min-w-0 items-center gap-2">
          <ShieldCheck size={20} className="shrink-0 text-blue-600" />
          <h3 className="text-lg font-bold tracking-tight text-slate-950">{tr("People & access")}</h3>
          {loading ? <Loader2 size={16} className="shrink-0 animate-spin text-blue-600" /> : null}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
          <span><strong className="text-slate-900">{loading ? '…' : hubUnavailable ? tr("Unavailable") : users.length}</strong> {tr("people")}</span>
          <span><strong className="text-slate-900">{connections.length}</strong> {tr("environments")}</span>
          <span><strong className="text-slate-900">{connectorLoading ? '…' : connectorUnavailable ? tr("Unavailable") : connectorConnections.reduce((sum, connection) => sum + connection.users.length, 0)}</strong> {tr("connector accounts")}</span>
        </div>
      </div>

      <details className="border-b border-slate-100 px-3 py-2 sm:px-4">
        <summary className="cursor-pointer text-xs font-semibold text-slate-500">{tr("How access works")}</summary>
      <div className="mt-3 grid gap-3 md:grid-cols-3" aria-label={tr("How access works")}>
        <div><p className="text-sm font-black text-slate-900">{tr("1. Hub identity")}</p><p className="mt-1 text-xs leading-relaxed text-slate-600">{tr("A person or owner record in this Hub. A separate member login key is required to sign in. Record names are not usernames or passwords.")}</p></div>
        <div><p className="text-sm font-black text-slate-900">{tr("2. Environment access")}</p><p className="mt-1 text-xs leading-relaxed text-slate-600">{tr("Ownership or an explicit grant determines access. A new Hub user does not inherit the default owner's environments or sessions.")}</p></div>
        <div><p className="text-sm font-black text-slate-900">{tr("3. Connector identity")}</p><p className="mt-1 text-xs leading-relaxed text-slate-600">{tr("A node-local account, separate from Hub login and from the Codex/OpenClaw installation. Matching names do not link these identities.")}</p></div>
        <p className="text-xs leading-relaxed text-slate-500 md:col-span-3">{tr("Create a Hub record, then open Manage access to issue a member login key and share a Codex session.")} {defaultUser ? tr('Default owner record: {name}.', { name: defaultUser.label }) : ''} {tr("Environment counts include only this login's visible connections.")} <a href="#/shared" className="text-blue-700 underline">{tr("Shared with me")}</a></p>
        <p className="text-xs md:col-span-3">{principal ? tr('Signed in as {user} · {role}', { user: principal.userId, role: tr(principal.admin ? 'Administrator' : 'Member — user and login-key administration is unavailable') }) : tr('Checking permissions — administration disabled.')}</p>
      </div>
      </details>

      <div className="grid items-start gap-4 p-3 sm:p-4 lg:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)]" aria-label={tr("People workspace")}>
        <div className="min-w-0">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-slate-950">{tr("People")}</p>
            </div>
            <Users size={18} className="shrink-0 text-blue-500" />
          </div>

          {principal?.admin ? <form className="mt-2 flex flex-wrap gap-2" aria-label={tr("Add a person")} onSubmit={event => { event.preventDefault(); void handleCreate(); }}>
            <Input aria-label={tr("New Hub user label")} className="h-9 min-w-0 flex-[1_1_10rem] text-sm" placeholder={tr("New person's name")} value={newLabel} disabled={savingNew || loading || hubUnavailable} maxLength={120} onChange={event => setNewLabel(event.currentTarget.value)} />
            <Button type="submit" size="sm" className="h-9" disabled={savingNew || loading || hubUnavailable || !newLabel.trim()}>
              {savingNew ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />} {tr("Create Hub record")}
            </Button>
          </form> : null}
          {error ? <p role="alert" className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{error}</p> : null}
          <Input aria-label={tr("Search Hub users")} className="mt-3" placeholder={tr("Search by name or record ID")} value={search} onChange={event => setSearch(event.currentTarget.value)} />

          <ul className="mt-2 grid gap-2 lg:max-h-[calc(100dvh-19rem)] lg:overflow-y-auto" aria-label={tr("Hub people")}>
            {visibleUsers.map((user) => {
              const ownedCount = connectionCountByUser.get(user.id) ?? 0;
              return (
                <li key={user.id} className={`group min-w-0 rounded-xl border p-2 transition-colors ${accessUserId === user.id ? 'border-blue-300 bg-blue-50/60' : 'border-slate-200 bg-white hover:border-blue-200'}`}>
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-blue-100 text-sm font-bold text-blue-700">
                      {user.label.trim().slice(0, 1).toUpperCase() || 'U'}
                    </div>
                    <div className="min-w-0 flex-1">
                      {editingId === user.id ? (
                        <Input
                          aria-label={tr('Rename user {name}', { name: user.label })}
                          className="h-8 rounded-xl text-sm font-bold"
                          autoFocus
                          disabled={savingEdit}
                          maxLength={120}
                          value={editingLabel}
                          onChange={(event) => setEditingLabel(event.currentTarget.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void handleRename(user);
                            if (event.key === 'Escape') setEditingId(undefined);
                          }}
                        />
                      ) : (
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-black text-slate-950">{user.label}</p>
                          {user.id === 'default' ? <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[0.62rem] font-black uppercase tracking-[0.08em] text-blue-700">default</span> : null}
                        </div>
                      )}
                      <p className="mt-0.5 text-xs text-slate-500">{tr(ownedCount === 1 ? '{count} owned environment' : '{count} owned environments', { count: ownedCount })}</p>
                    </div>
                    {principal?.admin ? editingId === user.id ? (
                      <Button type="button" size="sm" className="h-8 rounded-xl px-2 text-xs" disabled={savingEdit} onClick={() => void handleRename(user)}>
                        {savingEdit ? <Loader2 size={12} className="animate-spin" /> : tr('Save')}
                      </Button>
                    ) : (
                      <button
                        type="button"
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-xl text-slate-500 opacity-80 transition hover:bg-blue-50 hover:text-blue-600 group-hover:opacity-100"
                        onClick={() => { setEditingId(user.id); setEditingLabel(user.label); }}
                        aria-label={tr('Rename user {name}', { name: user.label })}
                        title={tr("Rename user")}
                      >
                        <Pencil size={14} />
                      </button>
                    ) : null}
                    {editingId === user.id ? <Button type="button" variant="ghost" size="sm" disabled={savingEdit} onClick={() => setEditingId(undefined)}>{tr("Cancel")}</Button> : null}
                  </div>
                  {principal?.admin ? <div className="mt-1 flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      {user.usage ? <details className="text-xs text-slate-500">
                        <summary className="cursor-pointer py-1">{user.usage.lastLoginAt ? tr('Last login {date}', { date: new Date(user.usage.lastLoginAt).toLocaleDateString() }) : tr('No member login recorded')}</summary>
                        <p className="mt-1">{tr("Login:")} {user.usage.lastLoginAt ? new Date(user.usage.lastLoginAt).toLocaleString() : tr('Not recorded')}</p>
                        <p className="mt-1">{tr("Active:")} {user.usage.lastActiveAt ? new Date(user.usage.lastActiveAt).toLocaleString() : tr('Not recorded')}</p>
                      </details> : null}
                    </div>
                    <Button type="button" size="sm" variant="secondary" className="h-7 shrink-0 px-2 text-xs" aria-label={tr("Manage access")} aria-pressed={accessUserId === user.id} disabled={loading || hubUnavailable} onClick={() => setAccessUserId(user.id)}>{tr("Access")}</Button>
                  </div> : null}
                </li>
              );
            })}
            {!loading && visibleUsers.length === 0 ? <li className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">{tr(users.length ? 'No matching Hub users.' : 'No Hub user records loaded.')}</li> : null}
          </ul>
        </div>

        <div ref={accessPanel} className="min-w-0 scroll-mt-3 space-y-2 lg:sticky lg:top-0" aria-label={tr("Selected person access")}>
          {principal?.admin && accessUser ? <>
            <div className="flex justify-end"><Button size="sm" variant="ghost" onClick={() => setAccessUserId(undefined)}>{tr("Close access panel")}</Button></div>
            <HubUserAccess key={recoveryScope() + ':' + accessUser.id} user={accessUser} actorUserId={principal.userId} connections={connections.filter(connection => connection.ownerUserId === principal.userId)} />
          </> : principal?.admin ? <div className="hidden rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center lg:block">
            <p className="text-sm font-semibold text-slate-700">{tr("Select a person to manage access")}</p>
            <p className="mt-1 text-xs text-slate-500">{tr("Roles, environments and login keys appear here.")}</p>
          </div> : principal ? <ConnectorMemberManager /> : null}
        </div>
      </div>

      {principal?.admin ? <HubLoginActivity key={recoveryScope()} users={users} /> : null}
      <details className="border-t border-slate-200 p-5">
      <summary className="cursor-pointer text-sm font-semibold text-slate-600">{tr("Advanced · Connector accounts")}</summary>
      <p className="mt-2 text-xs text-slate-500">{tr("Node-local records, not member logins. You do not need one to share a Codex environment.")}</p>
      <ConnectorUsersPanel
        connections={connectorConnections}
        loading={connectorLoading}
        unavailable={connectorUnavailable}
        onCreate={onCreateConnectorUser}
        onRename={onRenameConnectorUser}
      />
      </details>
    </Card>
  );
}

export const HubUsersPanel = AccessControlPage;

function ConnectorUsersPanel({
  connections,
  loading,
  unavailable,
  onCreate,
  onRename,
}: {
  connections: ConnectorUsersByConnection[];
  loading: boolean;
  unavailable: boolean;
  onCreate: (connectionId: string, label: string) => Promise<void>;
  onRename: (connectionId: string, id: string, label: string) => Promise<void>;
}) {
  const { t: tr } = useI18n();
  return (
    <div className="border-t border-blue-100 bg-slate-50/70 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-black text-slate-950">{tr("Connector-local accounts")}</p>
          <p className="mt-1 max-w-3xl text-xs text-slate-500">{tr("Grouped by environment. These records are not website logins, OS users, or separate Codex subscriptions. Adding one does not change the current connection credential.")}</p>
        </div>
        {loading ? <Loader2 size={18} className="shrink-0 animate-spin text-blue-500" /> : <ShieldCheck size={18} className="shrink-0 text-blue-500" />}
      </div>

      <div className="mt-4 grid gap-3">
        {connections.map((connection) => (
          <fieldset key={connection.id} disabled={loading} className="min-w-0"><ConnectorUsersConnectionCard connection={connection} onCreate={onCreate} onRename={onRename} /></fieldset>
        ))}
        {!loading && connections.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500">{unavailable ? tr('Account directory could not be loaded. Refresh directories to retry.') : tr('No connector environments are available for connector user management.')}</div> : null}
      </div>
    </div>
  );
}

function ConnectorUsersConnectionCard({
  connection,
  onCreate,
  onRename,
}: {
  connection: ConnectorUsersByConnection;
  onCreate: (connectionId: string, label: string) => Promise<void>;
  onRename: (connectionId: string, id: string, label: string) => Promise<void>;
}) {
  const { t: tr } = useI18n();
  const [newLabel, setNewLabel] = useState('');
  const [savingNew, setSavingNew] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [editingLabel, setEditingLabel] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [error, setError] = useState<string>();
  const label = envLabel(connection);

  async function handleCreate() {
    if (savingNew) return;
    const next = newLabel.trim();
    if (!next) { setError('Connector account label is required.'); return; }
    setError(undefined);
    setSavingNew(true);
    try {
      await onCreate(connection.id, next);
      setNewLabel('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingNew(false);
    }
  }

  async function handleRename(user: ConnectorUser) {
    if (savingEdit) return;
    const next = editingLabel.trim();
    if (!next) { setError('Connector account label is required.'); return; }
    if (next === user.label) { setEditingId(undefined); return; }
    setError(undefined);
    setSavingEdit(true);
    try {
      await onRename(connection.id, user.id, next);
      setEditingId(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingEdit(false);
    }
  }

  return (
    <section className="rounded-3xl border border-white bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <p className="truncate text-sm font-black text-slate-950">{label}</p>
            <Badge variant={connection.supported ? 'running' : 'muted'} className="text-[0.62rem]">{tr(connection.supported ? 'Directory available' : 'Directory unavailable')}</Badge>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[0.62rem] font-black uppercase tracking-[0.08em] text-slate-500">{connection.kind}</span>
          </div>
          <p className="mt-1 break-all text-xs text-slate-500">{connection.environmentId ?? connection.id} · {connection.supported ? tr('{count} accounts', { count: connection.userCount }) : tr('account count unknown')}</p>
          <p className="mt-1 text-xs text-slate-500">{tr("Hub owner:")} {connection.ownerUserLabel ?? connection.ownerUserId ?? tr('Not reported')}</p>
        </div>
        {connection.supported ? (
          <div className="flex w-full min-w-0 max-w-sm gap-2 sm:w-auto sm:flex-1">
            <Input
              aria-label={tr('New connector account for {name}', { name: label })}
              className="h-9 rounded-2xl bg-white text-sm"
              placeholder={tr("New connector account")}
              value={newLabel}
              disabled={savingNew}
              maxLength={120}
              onChange={(event) => setNewLabel(event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void handleCreate(); }}
            />
            <Button type="button" className="h-9 rounded-2xl px-3 text-xs font-black" disabled={savingNew || !newLabel.trim()} onClick={() => void handleCreate()}>
              {savingNew ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} {tr("Add")}
            </Button>
          </div>
        ) : null}
      </div>

      {error ? <p className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{error}</p> : null}
      {connection.error ? <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">{connection.error}</p> : null}

      {connection.supported ? (
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {connection.users.map((user) => (
            <li key={user.id} className="rounded-2xl border border-slate-200/80 bg-slate-50 px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-white text-xs font-black text-blue-700 ring-1 ring-blue-100">{user.label.trim().slice(0, 1).toUpperCase() || 'C'}</div>
                <div className="min-w-0 flex-1">
                  {editingId === user.id ? (
                    <Input
                      aria-label={tr('Rename connector account {name}', { name: user.label })}
                      className="h-8 rounded-xl text-sm font-bold"
                      autoFocus
                      disabled={savingEdit}
                      maxLength={120}
                      value={editingLabel}
                      onChange={(event) => setEditingLabel(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void handleRename(user);
                        if (event.key === 'Escape') setEditingId(undefined);
                      }}
                    />
                  ) : <p className="truncate text-sm font-black text-slate-900">{user.label}</p>}
                  <p className="text-[0.68rem] text-slate-500">{tr(user.id === 'default' ? 'Default node account' : 'Local record · not a login')}</p>
                  <p className="mt-1 break-all font-mono text-[0.62rem] text-slate-400">ID: {user.id}</p>
                </div>
                {editingId === user.id ? (
                  <Button type="button" size="sm" className="h-8 rounded-xl px-2 text-xs" disabled={savingEdit} onClick={() => void handleRename(user)}>
                    {savingEdit ? <Loader2 size={12} className="animate-spin" /> : tr('Save')}
                  </Button>
                ) : (
                  <button
                    type="button"
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-xl text-slate-500 transition hover:bg-blue-50 hover:text-blue-600"
                    onClick={() => { setEditingId(user.id); setEditingLabel(user.label); }}
                    aria-label={tr('Rename connector account {name}', { name: user.label })}
                    title={tr("Rename connector account")}
                  >
                    <Pencil size={14} />
                  </button>
                )}
                {editingId === user.id ? <Button type="button" variant="ghost" size="sm" disabled={savingEdit} onClick={() => setEditingId(undefined)}>{tr("Cancel")}</Button> : null}
              </div>
            </li>
          ))}
          {connection.users.length === 0 ? <li className="rounded-2xl border border-dashed border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500 sm:col-span-2">{tr("No connector accounts yet.")}</li> : null}
        </ul>
      ) : null}
    </section>
  );
}

export function HubConnectionsPanel({
  /** Connections already fetched from /sessions/state — shown immediately without extra request */
  initialConnections,
}: {
  initialConnections?: HubConnection[];
}) {
  const { t: tr } = useI18n();
  const maintenanceRecovery = useMaintenanceRecovery();
  const controlRecovery = useConnectionControlRecovery();
  const lifecycleRecovery = useLifecycleRecovery();
  const [connections, setConnections] = useState<HubConnection[]>(initialConnections ?? []);
  const [users, setUsers] = useState<HubUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [loading, setLoading] = useState(!initialConnections);
  const [panelState, setPanelState] = useState<PanelState>('list');
  const [error, setError] = useState<string>();
  const [lastPollAt, setLastPollAt] = useState<number | undefined>();
  const [dockerEngine, setDockerEngine] = useState<HubDockerEngineStatus | undefined>();
  const [dockerSandboxes, setDockerSandboxes] = useState<HubDockerSandboxInstance[]>([]);
  const [sandboxBusyId, setSandboxBusyId] = useState<string | undefined>();
  const [expandedSandboxLogId, setExpandedSandboxLogId] = useState<string | undefined>();

  const refreshDockerSandboxes = useCallback(async () => {
    try {
      const res = await api.hubDockerSandboxes();
      setDockerEngine(res.engine);
      setDockerSandboxes(res.sandboxes ?? []);
    } catch {
      // Optional endpoint; ignore on older hubs
    }
  }, []);

  const refresh = useCallback(async () => {
    setError(undefined);
    setLoading(true);
    try {
      // Use sessions/state for polling so transient fan-in health (degraded/error)
      // is reflected, not only the persisted connection rows from /connections.
      const data = await api.sessionsState();
      if (data.connections) setConnections(data.connections);
      else setConnections((await api.hubConnections()).connections);
      setLastPollAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshUsers = useCallback(async () => {
    setUsersLoading(true);
    try {
      const data = await api.hubUsers();
      setUsers(data.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUsersLoading(false);
    }
  }, []);

  // The shell already owns the live sessions/state snapshot. Do not create a
  // second poller when that data is supplied (including an empty list).
  useEffect(() => {
    if (initialConnections !== undefined) {
      setConnections(initialConnections);
      setLoading(false);
      setLastPollAt(Date.now());
    }
  }, [initialConnections]);
  useEffect(() => { void refreshUsers(); }, [refreshUsers]);
  useEffect(() => { void refreshDockerSandboxes(); }, [refreshDockerSandboxes]);
  const hasLiveConnections = initialConnections !== undefined;
  useEffect(() => {
    if (hasLiveConnections) return;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh();
    }, HEALTH_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [hasLiveConnections, refresh]);

  const connectionsWithOwnerLabels = useMemo(() => connections.map((connection) => {
    if (connection.ownerUserLabel) return connection;
    const user = users.find((item) => item.id === (connection.ownerUserId ?? 'default'));
    return user ? { ...connection, ownerUserLabel: user.label } : connection;
  }), [connections, users]);

  // When parent passes fresh connections from /sessions/state, prefer them by id
  // because they include transient fan-in health/errors that /connections may not.
  useEffect(() => {
    if (!initialConnections || initialConnections.length === 0) return;
    setConnections((current) => {
      const incoming = new Map(initialConnections.map((conn) => [conn.id, conn]));
      const merged = current.map((conn) => incoming.get(conn.id) ?? conn);
      for (const conn of initialConnections) {
        if (!current.some((existing) => existing.id === conn.id)) merged.push(conn);
      }
      return merged;
    });
    setLastPollAt(Date.now());
  }, [initialConnections]);

  async function handleDelete(id: string) {
    await api.hubDeleteConnection(id);
    setConnections((current) => current.filter((c) => c.id !== id));
  }

  async function handleRename(id: string, label: string) {
    const { connection } = await api.hubUpdateConnection(id, { label, environmentLabel: label });
    setConnections((current) => current.map((conn) => conn.id === id ? connection : conn));
  }

  async function handleCreateUser(label: string) {
    const { user } = await api.hubCreateUser({ label });
    setUsers((current) => [...current.filter((item) => item.id !== user.id), user]);
  }

  async function handleRenameUser(id: string, label: string) {
    const { user } = await api.hubUpdateUser(id, { label });
    setUsers((current) => current.map((item) => item.id === id ? user : item));
    setConnections((current) => current.map((connection) => connection.ownerUserId === id ? { ...connection, ownerUserLabel: user.label } : connection));
  }

  function handleSaved(conn: HubConnection) {
    setConnections((current) => {
      const without = current.filter((c) => c.id !== conn.id);
      return [...without, conn];
    });
    setPanelState('list');
  }

  function handleSandboxLaunched(sandbox: HubDockerSandboxInstance, conn?: HubConnection) {
    setDockerSandboxes((current) => [sandbox, ...current.filter((item) => item.id !== sandbox.id)]);
    if (conn) {
      setConnections((current) => [...current.filter((c) => c.id !== conn.id), conn]);
    }
    setPanelState('list');
    void refreshDockerSandboxes();
  }

  async function handleRenewSandbox(sandboxId: string) {
    setSandboxBusyId(sandboxId);
    try {
      const { sandbox } = await api.hubRenewDockerSandbox(sandboxId, 60);
      setDockerSandboxes((current) => current.map((item) => (item.id === sandbox.id ? sandbox : item)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSandboxBusyId(undefined);
    }
  }

  async function handleStopSandbox(sandboxId: string, removeRecord: boolean) {
    setSandboxBusyId(sandboxId);
    try {
      const { sandbox } = await api.hubStopDockerSandbox(sandboxId, removeRecord);
      if (removeRecord) {
        setDockerSandboxes((current) => current.filter((item) => item.id !== sandboxId));
      } else {
        setDockerSandboxes((current) => current.map((item) => (item.id === sandbox.id ? sandbox : item)));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSandboxBusyId(undefined);
    }
  }

  const [groupBy, setGroupBy] = useState<ConnectorTopologyGroupBy>('environment');
  const topology = useMemo(
    () => summarizeConnectorTopology(connectionsWithOwnerLabels, users, groupBy),
    [connectionsWithOwnerLabels, users, groupBy],
  );

  return (
    <div className="space-y-4">
      <Card className="border-white/70 bg-white/70 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-600">{tr("Hub Connections")}</p>
          <h3 className="mt-0.5 text-lg font-black tracking-[-0.03em] text-slate-950">{tr("Environments")}</h3>
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
            <span>{tr("Manage local and remote Connector connections. Tokens are stored server-side and never displayed.")}</span>
            <a href="#/shared" className="text-blue-700 underline">{tr("Shared with me")}</a>
            <ConnectionHealthPill connections={connectionsWithOwnerLabels} {...(lastPollAt !== undefined ? { lastPollAt } : {})} polling={loading} />
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="grid h-8 w-8 place-items-center rounded-xl text-slate-500 hover:bg-slate-100 disabled:opacity-40"
            disabled={loading}
            onClick={() => void refresh()}
            aria-label={tr("Refresh connections")}
          >
            <RefreshCcw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          {panelState === 'list' && (
            <Button type="button" size="sm" className="h-8 rounded-xl text-xs" onClick={() => setPanelState('add')}>
              <Plus size={13} className="mr-1" />{tr("Add remote")}
            </Button>
          )}
        </div>
      </div>

      {error && (
        <p className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{error}</p>
      )}

      <MaintenanceRecoveryNotice recovery={maintenanceRecovery} />
      <ConnectionControlRecoveryNotice recovery={controlRecovery} />
      <LifecycleRecoveryNotice recovery={lifecycleRecovery} />
      {panelState === 'add' ? (
        <div className="mt-4 rounded-2xl border border-blue-100 bg-blue-50/60 p-4">
          <AddConnectionForm
            onSave={handleSaved}
            onCancel={() => setPanelState('list')}
            onSandboxLaunched={handleSandboxLaunched}
          />
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          {loading && connectionsWithOwnerLabels.length === 0 && (
            <p className="text-sm text-slate-500">{tr("Loading connections…")}</p>
          )}

          {connectionsWithOwnerLabels.length > 0 && (
            <div className="rounded-2xl border border-slate-200/80 bg-slate-50/80 p-3" data-connector-topology>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-black text-slate-800">{tr("Topology Matrix")}</span>
                  <span className="rounded-lg bg-white px-2 py-0.5 font-semibold text-slate-600 shadow-xs">
                    {topology.uniqueEnvironments} {tr("Envs")} · {topology.uniqueOwners} {tr("Owners")} · {topology.totalConnections} {tr("Nodes")}
                  </span>
                  {topology.reverseCount > 0 && (
                    <span className="rounded-lg bg-indigo-50 px-2 py-0.5 font-semibold text-indigo-700">
                      ⇄ {topology.reverseCount} {tr("Reverse NAT")}
                    </span>
                  )}
                  <span className="rounded-lg bg-emerald-50 px-2 py-0.5 font-mono font-bold text-emerald-700">
                    {tr("Pool Health")} {topology.overallHealthScore}%
                  </span>
                </div>
                <div className="flex items-center gap-1 rounded-xl bg-white p-0.5 text-[0.68rem] font-bold ring-1 ring-slate-200" role="tablist" aria-label={tr("Group connectors by")}>
                  {([
                    { id: 'environment', label: tr("By Env Pool") },
                    { id: 'owner', label: tr("By User") },
                    { id: 'kind', label: tr("By Mode") },
                  ] as const).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={groupBy === tab.id}
                      className={cn(
                        "rounded-lg px-2 py-1 transition",
                        groupBy === tab.id ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-100"
                      )}
                      onClick={() => setGroupBy(tab.id)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {topology.groups.map((group) => (
            <div key={group.key} className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 px-1">
                <div className="flex items-center gap-2">
                  <p className="text-[0.72rem] font-black uppercase tracking-[0.12em] text-slate-600">{group.label}</p>
                  {group.sublabel && <span className="font-mono text-[0.65rem] text-slate-400">({group.sublabel})</span>}
                  {group.failoverConnectionIds.length > 0 && (
                    <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[0.62rem] font-bold text-blue-700">
                      {tr('HA Pool · 1 Primary + {count} Failover', { count: group.failoverConnectionIds.length })}
                    </span>
                  )}
                </div>
                <span className="font-mono text-[0.65rem] font-semibold text-slate-500">
                  {group.connected}/{group.total} {tr("ready")} · {group.healthScore}%
                </span>
              </div>
              <ul className="space-y-2">
                {group.connections.map((conn) => {
                  const poolRole = group.total > 1
                    ? (group.primaryConnectionId === conn.id ? 'primary' : group.failoverConnectionIds.includes(conn.id) ? 'failover' : undefined)
                    : undefined;
                  return (
                    <ConnectionRow
                      key={`${maintenanceRecovery.scope}:${conn.id}`}
                      conn={conn}
                      users={users}
                      recovery={maintenanceRecovery}
                      controlRecovery={controlRecovery}
                      lifecycleRecovery={lifecycleRecovery}
                      onDelete={handleDelete}
                      onRename={handleRename}
                      poolRole={poolRole}
                    />
                  );
                })}
              </ul>
            </div>
          ))}

          {!loading && connectionsWithOwnerLabels.length === 0 && (
            <p className="text-sm text-slate-500">{tr("No connections configured. Add a remote Connector to aggregate sessions from another environment.")}</p>
          )}

          {(dockerSandboxes.length > 0 || dockerEngine) && (
            <div className="mt-4 rounded-2xl border border-emerald-200/80 bg-emerald-50/50 p-3.5" data-docker-sandboxes-fleet>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-black uppercase tracking-[0.12em] text-emerald-900">
                    🐳 {tr("Ephemeral Docker + Codex Sandboxes")}
                  </span>
                  {dockerEngine && (
                    <Badge variant={dockerEngine.available ? 'running' : 'muted'} className="text-[0.62rem]">
                      {dockerEngine.available
                        ? `Docker ${dockerEngine.version ?? 'Engine'}${dockerEngine.rootless ? ' (rootless)' : ''}`
                        : tr('Blueprint / Simulated Mode')}
                    </Badge>
                  )}
                  {dockerEngine && (
                    <span className="rounded-lg bg-white px-2 py-0.5 font-mono text-[0.65rem] font-semibold text-emerald-800">
                      {`${dockerEngine.activeSandboxes} ${tr("active")} · ${dockerEngine.totalCpuAllocated} vCPU · ${dockerEngine.totalMemoryAllocatedMb} MB`}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-7 rounded-lg px-2 text-[0.68rem]"
                    onClick={() => void refreshDockerSandboxes()}
                  >
                    <RefreshCcw size={11} className="mr-1" />{tr("Refresh")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 rounded-lg bg-emerald-600 px-2.5 text-[0.68rem] text-white hover:bg-emerald-700"
                    onClick={() => setPanelState('add')}
                  >
                    + {tr("New Sandbox")}
                  </Button>
                </div>
              </div>

              {dockerSandboxes.length === 0 ? (
                <p className="mt-2 text-xs text-emerald-800/80">
                  {tr("No ephemeral Docker sandboxes running. Click '+ New Sandbox' to launch an isolated Connector + Codex container.")}
                </p>
              ) : (
                <ul className="mt-2.5 space-y-2">
                  {dockerSandboxes.map((sbx) => {
                    const remainingMin = Math.max(0, Math.round(sbx.telemetry.remainingSeconds / 60));
                    const isActive = sbx.status === 'running' || sbx.status === 'simulated';
                    const showLogs = expandedSandboxLogId === sbx.id;
                    return (
                      <li key={sbx.id} className="rounded-xl border border-emerald-200/80 bg-white p-2.5 text-xs shadow-2xs">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-black text-slate-900">{sbx.name}</span>
                            <Badge variant={isActive ? 'running' : 'muted'} className="text-[0.62rem]">
                              {sbx.status}
                            </Badge>
                            <span className="rounded bg-emerald-50 px-1.5 py-0.5 font-mono text-[0.62rem] font-bold text-emerald-800">
                              {sbx.profileId}
                            </span>
                            <span className="font-mono text-[0.65rem] text-slate-500">
                              {`${sbx.cpuLimit} vCPU · ${sbx.memoryLimitMb} MB · tmpfs ${sbx.workspaceTmpfsMb} MB · ${sbx.networkMode}`}
                            </span>
                            {sbx.readOnlyRootfs && (
                              <span className="rounded bg-amber-50 px-1.5 py-0.5 font-mono text-[0.6rem] font-bold text-amber-800">
                                {tr("RO-RootFS")}
                              </span>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono text-[0.65rem] font-semibold text-emerald-700">
                              {`TTL ${remainingMin}m`}
                            </span>
                            <button
                              type="button"
                              className="rounded-lg bg-slate-100 px-2 py-0.5 text-[0.65rem] font-bold text-slate-700 hover:bg-slate-200"
                              onClick={() => setExpandedSandboxLogId(showLogs ? undefined : sbx.id)}
                            >
                              {showLogs ? tr("Hide Logs") : tr("Audit & CLI")}
                            </button>
                            {isActive && (
                              <button
                                type="button"
                                disabled={sandboxBusyId === sbx.id}
                                className="rounded-lg bg-emerald-100 px-2 py-0.5 text-[0.65rem] font-bold text-emerald-800 hover:bg-emerald-200 disabled:opacity-50"
                                onClick={() => void handleRenewSandbox(sbx.id)}
                              >
                                {tr("+60m TTL")}
                              </button>
                            )}
                            {isActive ? (
                              <button
                                type="button"
                                disabled={sandboxBusyId === sbx.id}
                                className="rounded-lg bg-red-50 px-2 py-0.5 text-[0.65rem] font-bold text-red-700 hover:bg-red-100 disabled:opacity-50"
                                onClick={() => void handleStopSandbox(sbx.id, false)}
                              >
                                {tr("Stop")}
                              </button>
                            ) : (
                              <button
                                type="button"
                                disabled={sandboxBusyId === sbx.id}
                                className="rounded-lg bg-slate-100 px-2 py-0.5 text-[0.65rem] font-bold text-slate-600 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
                                onClick={() => void handleStopSandbox(sbx.id, true)}
                              >
                                {tr("Remove")}
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-3 font-mono text-[0.62rem] text-slate-500">
                          <span>{`URI: ${sbx.connectorUri}`}</span>
                          <span>{`${tr("Runtimes")}: ${sbx.runtimes.join(",")}`}</span>
                          <span>{`${tr("Vault Keys")}: ${sbx.secretEnvKeys.join(", ")}`}</span>
                        </div>
                        {showLogs && (
                          <div className="mt-2 space-y-1.5 border-t border-slate-100 pt-2">
                            <pre className="max-h-28 overflow-auto rounded-lg bg-slate-900 p-2 font-mono text-[0.62rem] text-emerald-300">
                              {sbx.dockerRunCommand}
                            </pre>
                            {sbx.logsTail.length > 0 && (
                              <pre className="max-h-28 overflow-auto rounded-lg bg-slate-950 p-2 font-mono text-[0.62rem] text-slate-300">
                                {sbx.logsTail.join('\n')}
                              </pre>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
      </Card>
    </div>
  );
}
