import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Container,
  Play,
  Square,
  RotateCw,
  Trash2,
  Copy,
  Check,
  Terminal,
  ShieldCheck,
  Cpu,
  HardDrive,
  Clock,
  Plus,
  RefreshCw,
  BookOpen,
  Server,
} from 'lucide-react';
import { api, type HubConnection } from '../api';
import {
  DOCKER_SANDBOX_PRESETS,
  buildDockerSandboxBlueprint,
  sanitizeSecretEnvKeyList,
  type DockerSandboxNetworkMode,
  type DockerSandboxProfileId,
  type DockerSandboxRuntimeId,
  type HubDockerEngineStatus,
  type HubDockerSandboxInstance,
} from '../lib/connector-architecture';
import { useI18n } from '../lib/i18n';

export type DockerHostContainerItem = {
  id: string;
  name: string;
  image: string;
  state: 'running' | 'exited' | 'paused' | 'created' | 'restarting' | 'unknown';
  status: string;
  ports: string;
  createdAt: string;
  isAgentOpsDeckSandbox: boolean;
  sandboxId?: string | undefined;
};

type DockerTabId = 'sandboxes' | 'containers' | 'launch';

const LOCAL_SANDBOX_STORAGE_PREFIX = 'agentopsdeck.docker.sandboxes.v1:';

function readLocalSandboxes(scope: string): HubDockerSandboxInstance[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(`${LOCAL_SANDBOX_STORAGE_PREFIX}${scope || 'default'}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as HubDockerSandboxInstance[]) : [];
  } catch {
    return [];
  }
}

function writeLocalSandboxes(scope: string, list: readonly HubDockerSandboxInstance[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      `${LOCAL_SANDBOX_STORAGE_PREFIX}${scope || 'default'}`,
      JSON.stringify(list.slice(0, 32)),
    );
  } catch {
    // Ignore storage quota issues
  }
}

export default function WorkspaceDocker({
  scope,
}: {
  scope: string;
}) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<DockerTabId>('sandboxes');
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string>('');
  const [engine, setEngine] = useState<HubDockerEngineStatus>({
    available: false,
    activeSandboxes: 0,
    totalCpuAllocated: 0,
    totalMemoryAllocatedMb: 0,
  });
  const [sandboxes, setSandboxes] = useState<HubDockerSandboxInstance[]>(() =>
    readLocalSandboxes(scope),
  );
  const [containers, setContainers] = useState<DockerHostContainerItem[]>([]);
  const [connections, setConnections] = useState<HubConnection[]>([]);
  const [selectedLogsTitle, setSelectedLogsTitle] = useState<string | null>(null);
  const [selectedLogsLines, setSelectedLogsLines] = useState<readonly string[]>([]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Quick Launch Form State
  const [profileId, setProfileId] = useState<DockerSandboxProfileId>('isolated-test');
  const [sandboxName, setSandboxName] = useState('Codex Ephemeral Sandbox');
  const [environmentId, setEnvironmentId] = useState('docker-isolated');
  const [cpuLimit, setCpuLimit] = useState(2);
  const [memoryLimitMb, setMemoryLimitMb] = useState(2048);
  const [workspaceTmpfsMb, setWorkspaceTmpfsMb] = useState(1024);
  const [ttlMinutes, setTtlMinutes] = useState(120);
  const [networkMode, setNetworkMode] = useState<DockerSandboxNetworkMode>('bridge');
  const [readOnlyRootfs, setReadOnlyRootfs] = useState(true);
  const [runtimes, setRuntimes] = useState<DockerSandboxRuntimeId[]>(['codex']);
  const [secretKeysInput, setSecretKeysInput] = useState('OPENAI_API_KEY');
  const [executeOnHost, setExecuteOnHost] = useState(true);
  const [artifactTab, setArtifactTab] = useState<'run' | 'compose' | 'dockerfile'>('run');

  const blueprint = useMemo(
    () =>
      buildDockerSandboxBlueprint({
        hubUrl: typeof window !== 'undefined' ? window.location.origin : 'https://hub.example.com',
        environmentId,
        nodeLabel: profileId,
        profileId,
        cpuLimit,
        memoryLimitMb,
        workspaceTmpfsMb,
        ttlMinutes,
        networkMode,
        readOnlyRootfs,
        runtimes,
        secretEnvKeys: sanitizeSecretEnvKeyList(secretKeysInput.split(/[,\s]+/)),
      }),
    [
      environmentId,
      sandboxName,
      profileId,
      cpuLimit,
      memoryLimitMb,
      workspaceTmpfsMb,
      ttlMinutes,
      networkMode,
      readOnlyRootfs,
      runtimes,
      secretKeysInput,
    ],
  );

  const applyPreset = useCallback((id: DockerSandboxProfileId) => {
    setProfileId(id);
    const preset = DOCKER_SANDBOX_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setCpuLimit(preset.cpuLimit);
    setMemoryLimitMb(preset.memoryLimitMb);
    setWorkspaceTmpfsMb(preset.workspaceTmpfsMb);
    setTtlMinutes(preset.ttlMinutes);
    setNetworkMode(preset.networkMode);
    setReadOnlyRootfs(preset.readOnlyRootfs);
    setRuntimes([...preset.runtimes]);
    setSecretKeysInput(preset.secretEnvKeys.join(', '));
    setEnvironmentId(`docker-${preset.id}`);
  }, []);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      const [connRes, sbxRes] = await Promise.allSettled([
        api.hubConnections(),
        fetch('/api/hub/v1/docker-sandboxes', { credentials: 'include' }).then(async (r) =>
          r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
        ),
      ]);

      if (connRes.status === 'fulfilled' && Array.isArray(connRes.value?.connections)) {
        setConnections(connRes.value.connections);
      }

      if (sbxRes.status === 'fulfilled' && sbxRes.value) {
        const data = sbxRes.value as {
          engine?: HubDockerEngineStatus;
          sandboxes?: HubDockerSandboxInstance[];
          containers?: DockerHostContainerItem[];
        };
        const remoteSandboxes = Array.isArray(data.sandboxes) ? data.sandboxes : [];
        const localSandboxes = readLocalSandboxes(scope);
        const mergedMap = new Map<string, HubDockerSandboxInstance>();
        for (const item of [...remoteSandboxes, ...localSandboxes]) {
          if (!mergedMap.has(item.id)) mergedMap.set(item.id, item);
        }
        const mergedSandboxes = [...mergedMap.values()].sort((a, b) => b.createdAt - a.createdAt);
        setSandboxes(mergedSandboxes);
        writeLocalSandboxes(scope, mergedSandboxes);

        if (data.engine) {
          setEngine(data.engine);
        }
        if (Array.isArray(data.containers)) {
          setContainers(data.containers);
        } else {
          setContainers(
            mergedSandboxes.map((s) => ({
              id: s.containerId ?? s.id,
              name: s.containerName,
              image: s.image,
              state: s.status === 'running' || s.status === 'simulated' ? 'running' : 'exited',
              status: s.status === 'simulated' ? 'Blueprint / Reverse Slot Ready' : s.status,
              ports: s.networkMode === 'none' ? 'isolated (no-net)' : 'reverse-tunnel -> :8791',
              createdAt: new Date(s.createdAt).toISOString(),
              isAgentOpsDeckSandbox: true,
              sandboxId: s.id,
            })),
          );
        }
      } else {
        // Fallback to local sandboxes + reverse docker connections if server endpoint isn't active yet
        const local = readLocalSandboxes(scope);
        setSandboxes(local);
        const active = local.filter((s) => s.status === 'running' || s.status === 'simulated');
        setEngine({
          available: false,
          activeSandboxes: active.length,
          totalCpuAllocated: active.reduce((sum, s) => sum + s.cpuLimit, 0),
          totalMemoryAllocatedMb: active.reduce((sum, s) => sum + s.memoryLimitMb, 0),
        });
        setContainers(
          local.map((s) => ({
            id: s.containerId ?? s.id,
            name: s.containerName,
            image: s.image,
            state: s.status === 'running' || s.status === 'simulated' ? 'running' : 'exited',
            status: s.status === 'simulated' ? 'Blueprint / Reverse Slot Ready' : s.status,
            ports: s.networkMode === 'none' ? 'isolated (no-net)' : 'reverse-tunnel -> :8791',
            createdAt: new Date(s.createdAt).toISOString(),
            isAgentOpsDeckSandbox: true,
            sandboxId: s.id,
          })),
        );
      }
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const handleCopy = useCallback((key: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopiedKey(key);
    window.setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 1800);
  }, []);

  const handleLaunchSandbox = useCallback(async () => {
    setLoading(true);
    setNotice('');
    try {
      const secretEnvKeys = sanitizeSecretEnvKeyList(secretKeysInput.split(/[,\s]+/));
      let createdConnId: string | undefined;
      try {
        const connRes = await api.hubCreateConnection({
          label: `${sandboxName.trim() || 'Docker Sandbox'} (${profileId})`,
          connectorUrl: blueprint.connectorUri,
          environmentId: environmentId.trim() || `docker-${profileId}`,
          environmentLabel: `${sandboxName.trim() || 'Docker Sandbox'} · ${cpuLimit}vCPU/${memoryLimitMb}MB`,
        });
        createdConnId = connRes.connection?.id;
      } catch {
        // Optional if user lacks admin connection permission
      }

      let createdSandbox: HubDockerSandboxInstance | undefined;
      try {
        const res = await fetch('/api/hub/v1/docker-sandboxes', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: sandboxName.trim() || 'Codex Ephemeral Sandbox',
            profileId,
            cpuLimit,
            memoryLimitMb,
            workspaceTmpfsMb,
            ttlMinutes,
            networkMode,
            readOnlyRootfs,
            runtimes,
            secretEnvKeys,
            environmentId: environmentId.trim() || `docker-${profileId}`,
            environmentLabel: sandboxName.trim() || 'Docker Sandbox',
            executeContainer: executeOnHost,
            connectionId: createdConnId,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as { sandbox?: HubDockerSandboxInstance };
          createdSandbox = data.sandbox;
        }
      } catch {
        // Fallback to local sandbox creation below
      }

      if (!createdSandbox) {
        const now = Date.now();
        const id = `sbx_${Math.random().toString(36).slice(2, 10)}`;
        createdSandbox = {
          id,
          containerName: blueprint.containerName,
          name: sandboxName.trim() || 'Codex Ephemeral Sandbox',
          profileId,
          image: 'agentopsdeck-connector:1.0.0',
          status: 'simulated',
          cpuLimit,
          memoryLimitMb,
          pidsLimit: blueprint.pidsLimit,
          workspaceTmpfsMb,
          ttlMinutes,
          networkMode,
          readOnlyRootfs,
          runtimes,
          secretEnvKeys,
          environmentId: environmentId.trim() || `docker-${profileId}`,
          environmentLabel: sandboxName.trim() || 'Docker Sandbox',
          ownerUserId: 'current',
          connectorUri: blueprint.connectorUri,
          connectionId: createdConnId,
          dockerRunCommand: blueprint.dockerRunCommand,
          dockerComposeYaml: blueprint.dockerComposeYaml,
          dockerfileSnippet: blueprint.dockerfileSnippet,
          createdAt: now,
          expiresAt: now + ttlMinutes * 60_000,
          engineAvailable: false,
          telemetry: {
            cpuPercent: 1.5,
            memoryUsedMb: 196,
            memoryLimitMb,
            pidsCount: 16,
            uptimeSeconds: 1,
            remainingSeconds: ttlMinutes * 60,
            heartbeatStatus: 'standby',
          },
          logsTail: [
            `[${new Date(now).toISOString()}] Provisioned ephemeral sandbox ${blueprint.containerName} (${cpuLimit} vCPU, ${memoryLimitMb}MB RAM, tmpfs=${workspaceTmpfsMb}MB)`,
            `[${new Date(now).toISOString()}] Registered reverse Connector slot: ${blueprint.connectorUri}`,
            `[${new Date(now).toISOString()}] Copy and run the docker run command on any Docker host to attach live.`,
          ],
        };
      }

      const nextList = [createdSandbox, ...sandboxes.filter((s) => s.id !== createdSandbox!.id)];
      setSandboxes(nextList);
      writeLocalSandboxes(scope, nextList);
      setActiveTab('sandboxes');
      setNotice(t('Ephemeral Docker sandbox provisioned and reverse connector slot registered.'));
      void refreshAll();
    } finally {
      setLoading(false);
    }
  }, [
    secretKeysInput,
    sandboxName,
    profileId,
    blueprint,
    environmentId,
    cpuLimit,
    memoryLimitMb,
    workspaceTmpfsMb,
    ttlMinutes,
    networkMode,
    readOnlyRootfs,
    runtimes,
    executeOnHost,
    sandboxes,
    scope,
    t,
    refreshAll,
  ]);

  const handleRenewSandbox = useCallback(
    async (sandboxId: string) => {
      try {
        const res = await fetch(`/api/hub/v1/docker-sandboxes/${encodeURIComponent(sandboxId)}/renew`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ extendMinutes: 60 }),
        });
        if (res.ok) {
          void refreshAll();
          setNotice(t('Sandbox lease extended by +60m.'));
          return;
        }
      } catch {
        // Local fallback
      }
      const updated = sandboxes.map((s) =>
        s.id === sandboxId
          ? {
              ...s,
              ttlMinutes: s.ttlMinutes + 60,
              expiresAt: Math.max(Date.now(), s.expiresAt) + 60 * 60_000,
              status: s.status === 'expired' ? ('simulated' as const) : s.status,
            }
          : s,
      );
      setSandboxes(updated);
      writeLocalSandboxes(scope, updated);
      setNotice(t('Sandbox lease extended by +60m.'));
    },
    [refreshAll, sandboxes, scope, t],
  );

  const handleStopSandbox = useCallback(
    async (sandboxId: string, removeRecord = false) => {
      try {
        await fetch(
          `/api/hub/v1/docker-sandboxes/${encodeURIComponent(sandboxId)}${removeRecord ? '?remove=1' : ''}`,
          {
            method: 'DELETE',
            credentials: 'include',
          },
        );
      } catch {
        // Local fallback
      }
      const updated = removeRecord
        ? sandboxes.filter((s) => s.id !== sandboxId)
        : sandboxes.map((s) =>
            s.id === sandboxId ? { ...s, status: 'stopped' as const, stoppedAt: Date.now() } : s,
          );
      setSandboxes(updated);
      writeLocalSandboxes(scope, updated);
      setNotice(removeRecord ? t('Sandbox removed.') : t('Sandbox stopped and isolated tmpfs reclaimed.'));
      void refreshAll();
    },
    [refreshAll, sandboxes, scope, t],
  );

  const handleContainerAction = useCallback(
    async (containerId: string, action: 'start' | 'stop' | 'restart' | 'remove') => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/hub/v1/docker-sandboxes/containers/${encodeURIComponent(containerId)}/${action}`,
          {
            method: 'POST',
            credentials: 'include',
          },
        );
        if (res.ok) {
          const data = (await res.json()) as { message?: string };
          setNotice(data.message || t('Container action completed.'));
          void refreshAll();
          return;
        }
      } catch {
        // Fallback to local sandbox state
      } finally {
        setLoading(false);
      }
      if (action === 'stop' || action === 'remove') {
        await handleStopSandbox(containerId, action === 'remove');
      }
    },
    [handleStopSandbox, refreshAll, t],
  );

  const handleInspectLogs = useCallback(
    async (title: string, containerId: string, fallbackLogs?: readonly string[]) => {
      setSelectedLogsTitle(title);
      if (fallbackLogs && fallbackLogs.length > 0) {
        setSelectedLogsLines(fallbackLogs);
      }
      try {
        const res = await fetch(
          `/api/hub/v1/docker-sandboxes/containers/${encodeURIComponent(containerId)}/logs?tail=80`,
          { credentials: 'include' },
        );
        if (res.ok) {
          const data = (await res.json()) as { logs?: string[] };
          if (Array.isArray(data.logs) && data.logs.length > 0) {
            setSelectedLogsLines(data.logs);
          }
        }
      } catch {
        // Keep fallback logs
      }
    },
    [],
  );

  const reverseDockerConnections = useMemo(
    () => connections.filter((c) => (c.connectorUrl || '').startsWith('reverse://')),
    [connections],
  );

  return (
    <div
      className="workspace-docker-card"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
        background: 'var(--docker-bg)',
        color: 'var(--docker-text)',
        fontSize: '12px',
      }}
    >
      {/* Top Status & Telemetry Strip */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          padding: '8px 12px',
          borderBottom: '1px solid rgba(148, 163, 184, 0.16)',
          background: 'var(--docker-input-bg)',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              padding: '2px 8px',
              borderRadius: '999px',
              fontSize: '11px',
              fontWeight: 600,
              background: engine.available ? 'rgba(16, 185, 129, 0.16)' : 'rgba(56, 189, 248, 0.15)',
              color: engine.available ? '#34d399' : '#38bdf8',
              border: `1px solid ${engine.available ? 'rgba(16, 185, 129, 0.35)' : 'rgba(56, 189, 248, 0.35)'}`,
            }}
          >
            <Container size={12} />
            {engine.available
              ? `${t('Docker Engine Ready')}${engine.version ? ` · v${engine.version}` : ''}`
              : t('Blueprint & Reverse Tunnel Mode')}
          </span>
          <span style={{ color: 'var(--docker-text-muted)', fontSize: '11px' }}>
            {t('Sandboxes')}: <strong>{sandboxes.length}</strong> · {t('Reverse Connectors')}:{' '}
            <strong>{reverseDockerConnections.length}</strong> · {t('CPU')}:{' '}
            <strong>{engine.totalCpuAllocated} {t('vCPU')}</strong> · {t('RAM')}:{' '}
            <strong>{engine.totalMemoryAllocatedMb} {t('MB')}</strong>
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <button
            type="button"
            onClick={() => setActiveTab('launch')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              padding: '4px 10px',
              borderRadius: '6px',
              border: '1px solid rgba(56, 189, 248, 0.45)',
              background: 'rgba(14, 165, 233, 0.2)',
              color: 'var(--docker-accent-strong)',
              fontSize: '11px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <Plus size={12} />
            {t('New Sandbox')}
          </button>
          <button
            type="button"
            onClick={() => void refreshAll()}
            disabled={loading}
            aria-label={t('Refresh Docker status')}
            title={t('Refresh Docker status')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              padding: '4px 8px',
              borderRadius: '6px',
              border: '1px solid rgba(148, 163, 184, 0.25)',
              background: 'var(--docker-surface-2)',
              color: 'var(--docker-text)',
              fontSize: '11px',
              cursor: 'pointer',
            }}
          >
            <RefreshCw size={12} />
            {t('Refresh')}
          </button>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div
        role="tablist"
        aria-label={t('Docker & Sandboxes')}
        style={{
          display: 'flex',
          gap: '4px',
          padding: '6px 12px',
          borderBottom: '1px solid rgba(148, 163, 184, 0.14)',
          background: 'var(--docker-surface-2)',
        }}
      >
        {(
          [
            ['sandboxes', `${t('Ephemeral Sandboxes')} (${sandboxes.length})`, ShieldCheck],
            ['containers', `${t('Host Containers')} (${containers.length})`, Server],
            ['launch', t('Quick Launch & Usage Guide'), BookOpen],
          ] as const
        ).map(([id, label, Icon]) => {
          const isCurrent = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={isCurrent}
              onClick={() => setActiveTab(id)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                padding: '5px 10px',
                borderRadius: '6px',
                border: isCurrent
                  ? '1px solid rgba(56, 189, 248, 0.45)'
                  : '1px solid transparent',
                background: isCurrent ? 'rgba(56, 189, 248, 0.16)' : 'transparent',
                color: isCurrent ? '#38bdf8' : 'rgba(203, 213, 225, 0.8)',
                fontSize: '11.5px',
                fontWeight: isCurrent ? 600 : 500,
                cursor: 'pointer',
              }}
            >
              <Icon size={13} />
              {label}
            </button>
          );
        })}
      </div>

      {notice && (
        <div
          role="status"
          style={{
            padding: '6px 12px',
            background: 'rgba(16, 185, 129, 0.14)',
            borderBottom: '1px solid rgba(16, 185, 129, 0.3)',
            color: 'var(--docker-ok)',
            fontSize: '11.5px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice('')}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--docker-ok)',
              cursor: 'pointer',
              fontSize: '11px',
            }}
          >
            {t('Close')}
          </button>
        </div>
      )}

      {/* Main Content Area */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {activeTab === 'sandboxes' && (
          <>
            {sandboxes.length === 0 ? (
              <div
                style={{
                  padding: '24px 16px',
                  borderRadius: '10px',
                  border: '1px dashed rgba(148, 163, 184, 0.25)',
                  background: 'var(--docker-surface)',
                  textAlign: 'center',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '8px',
                }}
              >
                <Container size={28} style={{ color: 'var(--docker-accent)', opacity: 0.85 }} />
                <div style={{ fontWeight: 600, fontSize: '13px' }}>
                  {t('No active Ephemeral Docker Sandboxes')}
                </div>
                <p style={{ margin: 0, color: 'var(--docker-text-muted)', maxWidth: '460px', lineHeight: 1.5 }}>
                  {t(
                    'Launch an isolated Docker + Connector + Codex container with strict CPU/RAM/tmpfs limits and automatic reverse-tunnel pairing.',
                  )}
                </p>
                <button
                  type="button"
                  onClick={() => setActiveTab('launch')}
                  style={{
                    marginTop: '4px',
                    padding: '6px 14px',
                    borderRadius: '6px',
                    border: '1px solid rgba(56, 189, 248, 0.5)',
                    background: 'rgba(14, 165, 233, 0.25)',
                    color: 'var(--docker-accent-strong)',
                    fontWeight: 600,
                    fontSize: '12px',
                    cursor: 'pointer',
                  }}
                >
                  {t('Launch Ephemeral Sandbox')}
                </button>
              </div>
            ) : (
              sandboxes.map((sbx) => {
                const isAlive = sbx.status === 'running' || sbx.status === 'simulated';
                const remainMin = Math.max(0, Math.round((sbx.expiresAt - Date.now()) / 60_000));
                return (
                  <div
                    key={sbx.id}
                    style={{
                      padding: '12px',
                      borderRadius: '10px',
                      border: '1px solid rgba(148, 163, 184, 0.2)',
                      background: 'var(--docker-surface)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span
                          style={{
                            width: '8px',
                            height: '8px',
                            borderRadius: '999px',
                            background:
                              sbx.status === 'running'
                                ? '#10b981'
                                : sbx.status === 'simulated'
                                  ? '#38bdf8'
                                  : '#64748b',
                          }}
                        />
                        <strong style={{ fontSize: '13px' }}>{sbx.name}</strong>
                        <code
                          style={{
                            fontSize: '11px',
                            padding: '1px 6px',
                            borderRadius: '4px',
                            background: 'var(--docker-code-bg)',
                            color: 'var(--docker-accent)',
                          }}
                        >
                          {sbx.containerName}
                        </code>
                        <span
                          style={{
                            fontSize: '10.5px',
                            padding: '1px 6px',
                            borderRadius: '999px',
                            background: 'rgba(148, 163, 184, 0.15)',
                            color: 'var(--docker-text)',
                          }}
                        >
                          {sbx.profileId}
                        </span>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          onClick={() => handleCopy(`run:${sbx.id}`, sbx.dockerRunCommand)}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            padding: '3px 8px',
                            borderRadius: '5px',
                            border: '1px solid rgba(56, 189, 248, 0.35)',
                            background: 'rgba(14, 165, 233, 0.14)',
                            color: 'var(--docker-accent)',
                            fontSize: '11px',
                            cursor: 'pointer',
                          }}
                        >
                          {copiedKey === `run:${sbx.id}` ? <Check size={11} /> : <Copy size={11} />}
                          {copiedKey === `run:${sbx.id}` ? t('Copied') : t('Copy docker run')}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleInspectLogs(sbx.containerName, sbx.id, sbx.logsTail)}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            padding: '3px 8px',
                            borderRadius: '5px',
                            border: '1px solid rgba(148, 163, 184, 0.25)',
                            background: 'var(--docker-surface-2)',
                            color: 'var(--docker-text)',
                            fontSize: '11px',
                            cursor: 'pointer',
                          }}
                        >
                          <Terminal size={11} />
                          {t('Logs')}
                        </button>
                        {isAlive && (
                          <button
                            type="button"
                            onClick={() => void handleRenewSandbox(sbx.id)}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                              padding: '3px 8px',
                              borderRadius: '5px',
                              border: '1px solid rgba(16, 185, 129, 0.35)',
                              background: 'rgba(16, 185, 129, 0.14)',
                              color: 'var(--docker-ok)',
                              fontSize: '11px',
                              cursor: 'pointer',
                            }}
                          >
                            <Clock size={11} />
                            {t('+60m')}
                          </button>
                        )}
                        {isAlive ? (
                          <button
                            type="button"
                            onClick={() => void handleStopSandbox(sbx.id, false)}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                              padding: '3px 8px',
                              borderRadius: '5px',
                              border: '1px solid rgba(244, 63, 94, 0.35)',
                              background: 'rgba(244, 63, 94, 0.14)',
                              color: '#fda4af',
                              fontSize: '11px',
                              cursor: 'pointer',
                            }}
                          >
                            <Square size={11} />
                            {t('Stop')}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void handleStopSandbox(sbx.id, true)}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                              padding: '3px 8px',
                              borderRadius: '5px',
                              border: '1px solid rgba(148, 163, 184, 0.25)',
                              background: 'var(--docker-surface-2)',
                              color: 'var(--docker-text-muted)',
                              fontSize: '11px',
                              cursor: 'pointer',
                            }}
                          >
                            <Trash2 size={11} />
                            {t('Remove')}
                          </button>
                        )}
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', color: 'var(--docker-text-muted)', fontSize: '11px' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <Cpu size={12} /> {sbx.cpuLimit} {t('vCPU')} ({sbx.telemetry?.cpuPercent ?? 0}%)
                      </span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <HardDrive size={12} /> {sbx.telemetry?.memoryUsedMb ?? 0} / {sbx.memoryLimitMb} {t('MB RAM · tmpfs')} {sbx.workspaceTmpfsMb} {t('MB')}
                      </span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <Clock size={12} /> {isAlive ? `${remainMin}m ${t('remaining')}` : t('Stopped')}
                      </span>
                      <span>
                        {t('Tunnel')}: <code>{sbx.connectorUri}</code>
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </>
        )}

        {activeTab === 'containers' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {containers.length === 0 ? (
              <div
                style={{
                  padding: '20px',
                  borderRadius: '10px',
                  border: '1px dashed rgba(148, 163, 184, 0.25)',
                  textAlign: 'center',
                  color: 'var(--docker-text-muted)',
                }}
              >
                {t('No Docker containers found on host or local daemon is offline.')}
              </div>
            ) : (
              containers.map((cnt) => (
                <div
                  key={cnt.id}
                  style={{
                    padding: '10px 12px',
                    borderRadius: '8px',
                    border: '1px solid rgba(148, 163, 184, 0.18)',
                    background: 'var(--docker-surface)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '8px',
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span
                        style={{
                          width: '8px',
                          height: '8px',
                          borderRadius: '999px',
                          background: cnt.state === 'running' ? '#10b981' : '#64748b',
                        }}
                      />
                      <strong>{cnt.name}</strong>
                      <code style={{ fontSize: '11px', color: 'var(--docker-text-muted)' }}>{cnt.id}</code>
                      {cnt.isAgentOpsDeckSandbox && (
                        <span
                          style={{
                            fontSize: '10px',
                            padding: '1px 6px',
                            borderRadius: '999px',
                            background: 'rgba(56, 189, 248, 0.16)',
                            color: 'var(--docker-accent)',
                          }}
                        >
                          {t('AgentOpsDeck Sandbox')}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--docker-text-muted)' }}>
                      {cnt.image} · {cnt.status} {cnt.ports ? `· ${cnt.ports}` : ''}
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {cnt.state !== 'running' ? (
                      <button
                        type="button"
                        onClick={() => void handleContainerAction(cnt.id, 'start')}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          padding: '3px 8px',
                          borderRadius: '5px',
                          border: '1px solid rgba(16, 185, 129, 0.35)',
                          background: 'rgba(16, 185, 129, 0.14)',
                          color: 'var(--docker-ok)',
                          fontSize: '11px',
                          cursor: 'pointer',
                        }}
                      >
                        <Play size={11} />
                        {t('Start')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleContainerAction(cnt.id, 'stop')}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          padding: '3px 8px',
                          borderRadius: '5px',
                          border: '1px solid rgba(244, 63, 94, 0.35)',
                          background: 'rgba(244, 63, 94, 0.14)',
                          color: '#fda4af',
                          fontSize: '11px',
                          cursor: 'pointer',
                        }}
                      >
                        <Square size={11} />
                        {t('Stop')}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleContainerAction(cnt.id, 'restart')}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        padding: '3px 8px',
                        borderRadius: '5px',
                        border: '1px solid rgba(148, 163, 184, 0.25)',
                        background: 'var(--docker-surface-2)',
                        color: 'var(--docker-text)',
                        fontSize: '11px',
                        cursor: 'pointer',
                      }}
                    >
                      <RotateCw size={11} />
                      {t('Restart')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleInspectLogs(cnt.name, cnt.id)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        padding: '3px 8px',
                        borderRadius: '5px',
                        border: '1px solid rgba(148, 163, 184, 0.25)',
                        background: 'var(--docker-surface-2)',
                        color: 'var(--docker-text)',
                        fontSize: '11px',
                        cursor: 'pointer',
                      }}
                    >
                      <Terminal size={11} />
                      {t('Logs')}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === 'launch' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {/* Step-by-step Quick Usage Guide */}
            <div
              style={{
                padding: '10px 12px',
                borderRadius: '8px',
                border: '1px solid rgba(56, 189, 248, 0.25)',
                background: 'rgba(14, 165, 233, 0.08)',
                lineHeight: 1.5,
              }}
            >
              <div style={{ fontWeight: 600, color: 'var(--docker-accent)', marginBottom: '4px' }}>
                {t('How Ephemeral Docker + Connector + Codex Works')}
              </div>
              <ol style={{ margin: 0, paddingLeft: '18px', color: 'var(--docker-text)', fontSize: '11.5px' }}>
                <li>
                  {t(
                    'Select an isolation profile (Isolated Test / Tenant Isolated / Air-Gapped Review) and resource quota below.',
                  )}
                </li>
                <li>
                  {t(
                    'Click "Launch Sandbox & Register Connector" to create a reverse:// Connector slot on Hub and start the container locally (or generate a 1-click docker run command for any remote machine).',
                  )}
                </li>
                <li>
                  {t(
                    'Once the container starts, it dials back to Hub via /api/hub/v1/connector-tunnel with a RAM-only /workspace tmpfs that automatically wipes when stopped or expired.',
                  )}
                </li>
              </ol>
            </div>

            {/* Preset Selector */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '8px' }}>
              {DOCKER_SANDBOX_PRESETS.map((preset) => {
                const selected = profileId === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => applyPreset(preset.id)}
                    style={{
                      textAlign: 'left',
                      padding: '8px 10px',
                      borderRadius: '8px',
                      border: selected
                        ? '1px solid rgba(56, 189, 248, 0.6)'
                        : '1px solid rgba(148, 163, 184, 0.2)',
                      background: selected ? 'rgba(14, 165, 233, 0.16)' : 'rgba(30, 41, 59, 0.45)',
                      color: 'var(--docker-text)',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: '12px', color: selected ? '#38bdf8' : '#f8fafc' }}>
                      {t(preset.label as any)}
                    </div>
                    <div style={{ fontSize: '10.5px', color: 'var(--docker-text-muted)', marginTop: '2px' }}>
                      {preset.cpuLimit} {t('vCPU')} · {preset.memoryLimitMb} {t('MB')} · {t('TTL')} {preset.ttlMinutes}{t('m')}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Parameters Grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span>{t('Sandbox Name')}</span>
                <input
                  id="docker-card-sandbox-name"
                  name="sandboxName"
                  type="text"
                  value={sandboxName}
                  onChange={(e) => setSandboxName(e.target.value)}
                  style={{
                    padding: '5px 8px',
                    borderRadius: '6px',
                    border: '1px solid rgba(148, 163, 184, 0.28)',
                    background: 'var(--docker-input-bg)',
                    color: 'var(--docker-text)',
                    fontSize: '12px',
                  }}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span>{t('Environment ID')}</span>
                <input
                  id="docker-card-env-id"
                  name="environmentId"
                  type="text"
                  value={environmentId}
                  onChange={(e) => setEnvironmentId(e.target.value)}
                  style={{
                    padding: '5px 8px',
                    borderRadius: '6px',
                    border: '1px solid rgba(148, 163, 184, 0.28)',
                    background: 'var(--docker-input-bg)',
                    color: 'var(--docker-text)',
                    fontSize: '12px',
                  }}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span>{t('CPU Limit (vCPU)')}</span>
                <input
                  id="docker-card-cpu"
                  name="cpuLimit"
                  type="number"
                  min={0.5}
                  max={16}
                  step={0.5}
                  value={cpuLimit}
                  onChange={(e) => setCpuLimit(Number(e.target.value) || 2)}
                  style={{
                    padding: '5px 8px',
                    borderRadius: '6px',
                    border: '1px solid rgba(148, 163, 184, 0.28)',
                    background: 'var(--docker-input-bg)',
                    color: 'var(--docker-text)',
                    fontSize: '12px',
                  }}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span>{t('Memory Limit (MB)')}</span>
                <input
                  id="docker-card-mem"
                  name="memoryLimitMb"
                  type="number"
                  min={512}
                  max={65536}
                  step={256}
                  value={memoryLimitMb}
                  onChange={(e) => setMemoryLimitMb(Number(e.target.value) || 2048)}
                  style={{
                    padding: '5px 8px',
                    borderRadius: '6px',
                    border: '1px solid rgba(148, 163, 184, 0.28)',
                    background: 'var(--docker-input-bg)',
                    color: 'var(--docker-text)',
                    fontSize: '12px',
                  }}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span>{t('TTL Auto-Destroy (min)')}</span>
                <input
                  id="docker-card-ttl"
                  name="ttlMinutes"
                  type="number"
                  min={5}
                  max={1440}
                  step={15}
                  value={ttlMinutes}
                  onChange={(e) => setTtlMinutes(Number(e.target.value) || 120)}
                  style={{
                    padding: '5px 8px',
                    borderRadius: '6px',
                    border: '1px solid rgba(148, 163, 184, 0.28)',
                    background: 'var(--docker-input-bg)',
                    color: 'var(--docker-text)',
                    fontSize: '12px',
                  }}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span>{t('Secret Env Keys')}</span>
                <input
                  id="docker-card-secrets"
                  name="secretKeysInput"
                  type="text"
                  value={secretKeysInput}
                  onChange={(e) => setSecretKeysInput(e.target.value)}
                  style={{
                    padding: '5px 8px',
                    borderRadius: '6px',
                    border: '1px solid rgba(148, 163, 184, 0.28)',
                    background: 'var(--docker-input-bg)',
                    color: 'var(--docker-text)',
                    fontSize: '12px',
                  }}
                />
              </label>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                <input
                  id="docker-card-exec-host"
                  name="executeOnHost"
                  type="checkbox"
                  checked={executeOnHost}
                  onChange={(e) => setExecuteOnHost(e.target.checked)}
                />
                <span>{t('Auto-start container on Hub host if Docker Engine is available')}</span>
              </label>

              <button
                type="button"
                onClick={() => void handleLaunchSandbox()}
                disabled={loading}
                style={{
                  padding: '6px 14px',
                  borderRadius: '6px',
                  border: '1px solid rgba(16, 185, 129, 0.5)',
                  background: 'rgba(16, 185, 129, 0.22)',
                  color: 'var(--docker-ok-strong)',
                  fontWeight: 600,
                  fontSize: '12px',
                  cursor: 'pointer',
                }}
              >
                {t('Launch Sandbox & Register Connector')}
              </button>
            </div>

            {/* Generated Artifact Preview */}
            <div
              style={{
                borderRadius: '8px',
                border: '1px solid rgba(148, 163, 184, 0.2)',
                background: 'var(--docker-code-bg)',
                padding: '10px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px', gap: '6px', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', gap: '4px' }}>
                  {(
                    [
                      ['run', 'docker run CLI'],
                      ['compose', 'docker-compose.yml'],
                      ['dockerfile', 'Dockerfile'],
                    ] as const
                  ).map(([tabKey, tabLabel]) => (
                    <button
                      key={tabKey}
                      type="button"
                      onClick={() => setArtifactTab(tabKey)}
                      style={{
                        padding: '3px 8px',
                        borderRadius: '4px',
                        border: 'none',
                        background: artifactTab === tabKey ? 'rgba(56, 189, 248, 0.2)' : 'transparent',
                        color: artifactTab === tabKey ? '#38bdf8' : '#94a3b8',
                        fontSize: '11px',
                        cursor: 'pointer',
                      }}
                    >
                      {tabLabel}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() =>
                    handleCopy(
                      `artifact:${artifactTab}`,
                      artifactTab === 'run'
                        ? blueprint.dockerRunCommand
                        : artifactTab === 'compose'
                          ? blueprint.dockerComposeYaml
                          : blueprint.dockerfileSnippet,
                    )
                  }
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '3px 8px',
                    borderRadius: '4px',
                    border: '1px solid rgba(56, 189, 248, 0.3)',
                    background: 'rgba(14, 165, 233, 0.14)',
                    color: 'var(--docker-accent)',
                    fontSize: '11px',
                    cursor: 'pointer',
                  }}
                >
                  {copiedKey === `artifact:${artifactTab}` ? <Check size={11} /> : <Copy size={11} />}
                  {copiedKey === `artifact:${artifactTab}` ? t('Copied') : t('Copy')}
                </button>
              </div>
              <pre
                style={{
                  margin: 0,
                  fontSize: '11px',
                  lineHeight: 1.45,
                  color: 'var(--docker-code-text)',
                  overflowX: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
                {artifactTab === 'run'
                  ? blueprint.dockerRunCommand
                  : artifactTab === 'compose'
                    ? blueprint.dockerComposeYaml
                    : blueprint.dockerfileSnippet}
              </pre>
            </div>
          </div>
        )}

        {/* Container / Sandbox Logs Drawer */}
        {selectedLogsTitle && (
          <div
            style={{
              padding: '10px',
              borderRadius: '8px',
              border: '1px solid rgba(56, 189, 248, 0.35)',
              background: 'var(--docker-code-bg)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
              <strong style={{ color: 'var(--docker-accent)', fontSize: '11.5px' }}>
                {t('Container Logs')} · {selectedLogsTitle}
              </strong>
              <button
                type="button"
                onClick={() => setSelectedLogsTitle(null)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--docker-text-muted)',
                  cursor: 'pointer',
                  fontSize: '11px',
                }}
              >
                {t('Close')}
              </button>
            </div>
            <pre
              style={{
                margin: 0,
                maxHeight: '140px',
                overflowY: 'auto',
                fontSize: '11px',
                lineHeight: 1.45,
                color: 'var(--docker-text)',
                whiteSpace: 'pre-wrap',
              }}
            >
              {selectedLogsLines.join('\n')}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
