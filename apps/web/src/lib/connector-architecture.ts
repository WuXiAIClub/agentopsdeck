import type { HubConnection, HubUser } from '../api.js';

export type ConnectorTunnelMode = 'direct' | 'reverse' | 'docker-sandbox';
export type ConnectorTopologyGroupBy = 'kind' | 'environment' | 'owner';

export type ReverseTunnelConfig = {
  hubUrl: string;
  environmentId: string;
  environmentLabel?: string | undefined;
  nodeLabel?: string | undefined;
  heartbeatIntervalSec?: number | undefined;
  reconnectBackoffMaxSec?: number | undefined;
};

export type ConnectorPoolGroup = {
  key: string;
  label: string;
  sublabel?: string | undefined;
  total: number;
  connected: number;
  degraded: number;
  disabled: number;
  reverseCount: number;
  healthScore: number;
  primaryConnectionId?: string | undefined;
  failoverConnectionIds: readonly string[];
  connections: readonly HubConnection[];
};

export type ConnectorTopologySummary = {
  totalConnections: number;
  connectedCount: number;
  degradedCount: number;
  disabledCount: number;
  reverseCount: number;
  uniqueOwners: number;
  uniqueEnvironments: number;
  overallHealthScore: number;
  groups: readonly ConnectorPoolGroup[];
};

const REVERSE_PROTOCOLS = ['reverse://', 'tunnel://', 'wss+reverse://', 'ws+reverse://'] as const;

export function isReverseTunnelConnection(conn: Pick<HubConnection, 'connectorUrl' | 'capabilities'>): boolean {
  const url = (conn.connectorUrl ?? '').trim().toLocaleLowerCase();
  if (REVERSE_PROTOCOLS.some(prefix => url.startsWith(prefix))) return true;
  if (conn.capabilities?.some(cap => cap.toLocaleLowerCase().includes('reverse'))) return true;
  return false;
}

export function buildReverseConnectorUri(environmentId: string, nodeLabel?: string): string {
  const cleanEnv = (environmentId.trim() || 'default-env').replace(/[^a-zA-Z0-9._-]/g, '-');
  const cleanNode = (nodeLabel?.trim() || 'node').replace(/[^a-zA-Z0-9._-]/g, '-');
  return `reverse://${cleanEnv}/${cleanNode}`;
}

/**
 * Generates the outbound reverse-connect CLI command so a Connector behind NAT/firewall
 * can dial out to the Hub without opening inbound ports.
 * Security contract: Never embeds raw bearer tokens in the command; uses $AOD_CONNECTOR_TOKEN env var.
 */
export function buildReverseConnectCommand(config: ReverseTunnelConfig): string {
  const hubBase = (config.hubUrl.trim() || 'https://hub.example.com').replace(/\/+$/, '');
  const wsEndpoint = hubBase.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:') + '/api/hub/v1/connector-tunnel';
  const envId = (config.environmentId.trim() || 'prod').replace(/[^a-zA-Z0-9._-]/g, '-');
  const heartbeat = Math.max(5, Math.min(120, Math.floor(config.heartbeatIntervalSec ?? 15)));
  const maxBackoff = Math.max(10, Math.min(300, Math.floor(config.reconnectBackoffMaxSec ?? 60)));
  const parts = [
    'agentopsdeck-connector connect-hub',
    `--hub-tunnel "${wsEndpoint}"`,
    `--env-id "${envId}"`,
  ];
  if (config.environmentLabel?.trim()) {
    parts.push(`--env-label "${config.environmentLabel.trim().replace(/"/g, '\\"')}"`);
  }
  if (config.nodeLabel?.trim()) {
    parts.push(`--label "${config.nodeLabel.trim().replace(/"/g, '\\"')}"`);
  }
  parts.push(
    `--heartbeat ${heartbeat}s`,
    `--reconnect-backoff-max ${maxBackoff}s`,
    '--token-env AOD_CONNECTOR_TOKEN',
  );
  return parts.join(' ');
}

export function scoreConnectionHealth(conn: HubConnection): number {
  if (conn.status === 'disabled') return 0;
  if (conn.status === 'degraded') return 35;
  let score = 90;
  if (conn.kind === 'local') score += 5;
  if (conn.hasCredential) score += 3;
  if (conn.capabilities && conn.capabilities.length > 0) score += 2;
  return Math.min(100, score);
}

export function summarizeConnectorTopology(
  connections: readonly HubConnection[],
  users: readonly HubUser[] = [],
  groupBy: ConnectorTopologyGroupBy = 'environment',
): ConnectorTopologySummary {
  const userMap = new Map(users.map(u => [u.id, u.label]));
  const owners = new Set<string>();
  const environments = new Set<string>();

  let connectedCount = 0;
  let degradedCount = 0;
  let disabledCount = 0;
  let reverseCount = 0;
  let scoreSum = 0;

  const bucketMap = new Map<string, { label: string; sublabel?: string | undefined; list: HubConnection[] }>();

  for (const conn of connections) {
    const ownerId = conn.ownerUserId ?? 'default';
    owners.add(ownerId);
    const envKey = conn.environmentId?.trim() || conn.environmentLabel?.trim() || (conn.kind === 'local' ? 'local' : conn.id);
    environments.add(envKey);

    if (conn.status === 'enabled') connectedCount += 1;
    else if (conn.status === 'degraded') degradedCount += 1;
    else if (conn.status === 'disabled') disabledCount += 1;

    if (isReverseTunnelConnection(conn)) reverseCount += 1;
    scoreSum += scoreConnectionHealth(conn);

    let bucketKey: string;
    let bucketLabel: string;
    let bucketSublabel: string | undefined;

    if (groupBy === 'owner') {
      const ownerName = conn.ownerUserLabel ?? userMap.get(ownerId) ?? ownerId;
      bucketKey = `owner:${ownerId}`;
      bucketLabel = ownerName;
      bucketSublabel = ownerId;
    } else if (groupBy === 'environment') {
      const envTitle = conn.environmentLabel?.trim() || conn.environmentId?.trim() || (conn.kind === 'local' ? 'Local Environment' : conn.label || conn.id);
      bucketKey = `env:${envKey.toLocaleLowerCase()}`;
      bucketLabel = envTitle;
      bucketSublabel = conn.environmentId && conn.environmentId !== envTitle ? conn.environmentId : undefined;
    } else {
      const isRev = isReverseTunnelConnection(conn);
      bucketKey = conn.kind === 'local' ? 'kind:local' : isRev ? 'kind:reverse' : 'kind:remote';
      bucketLabel = conn.kind === 'local' ? 'Local Node' : isRev ? 'Reverse Tunnel Connectors' : 'Direct Remote Connectors';
    }

    const bucket = bucketMap.get(bucketKey) ?? { label: bucketLabel, sublabel: bucketSublabel, list: [] };
    bucket.list.push(conn);
    bucketMap.set(bucketKey, bucket);
  }

  const groups: ConnectorPoolGroup[] = [...bucketMap.entries()].map(([key, bucket]) => {
    const sorted = [...bucket.list].sort((a, b) => scoreConnectionHealth(b) - scoreConnectionHealth(a));
    let cConn = 0;
    let cDeg = 0;
    let cDis = 0;
    let cRev = 0;
    let cScore = 0;
    for (const item of sorted) {
      if (item.status === 'enabled') cConn += 1;
      else if (item.status === 'degraded') cDeg += 1;
      else if (item.status === 'disabled') cDis += 1;
      if (isReverseTunnelConnection(item)) cRev += 1;
      cScore += scoreConnectionHealth(item);
    }
    const activeCandidates = sorted.filter(item => item.status !== 'disabled');
    const primary = activeCandidates[0];
    const failovers = activeCandidates.slice(1).map(item => item.id);

    return {
      key,
      label: bucket.label,
      sublabel: bucket.sublabel,
      total: sorted.length,
      connected: cConn,
      degraded: cDeg,
      disabled: cDis,
      reverseCount: cRev,
      healthScore: sorted.length > 0 ? Math.round(cScore / sorted.length) : 0,
      primaryConnectionId: primary?.id,
      failoverConnectionIds: failovers,
      connections: sorted,
    };
  });

  return {
    totalConnections: connections.length,
    connectedCount,
    degradedCount,
    disabledCount,
    reverseCount,
    uniqueOwners: owners.size,
    uniqueEnvironments: environments.size,
    overallHealthScore: connections.length > 0 ? Math.round(scoreSum / connections.length) : 100,
    groups,
  };
}

export type DockerSandboxProfileId = 'isolated-test' | 'tenant-isolated' | 'airgapped-review';
export type DockerSandboxNetworkMode = 'bridge' | 'none' | 'host-gateway';
export type DockerSandboxRuntimeId = 'codex' | 'claude' | 'copilot';
export type DockerSandboxArtifactTab = 'run' | 'compose' | 'dockerfile';

export type DockerSandboxPreset = {
  id: DockerSandboxProfileId;
  label: string;
  description: string;
  cpuLimit: number;
  memoryLimitMb: number;
  pidsLimit: number;
  workspaceTmpfsMb: number;
  ttlMinutes: number;
  networkMode: DockerSandboxNetworkMode;
  readOnlyRootfs: boolean;
  runtimes: readonly DockerSandboxRuntimeId[];
  secretEnvKeys: readonly string[];
};

export const DOCKER_SANDBOX_PRESETS: readonly DockerSandboxPreset[] = [
  {
    id: 'isolated-test',
    label: 'Isolated Test Sandbox',
    description: 'Ephemeral 1 vCPU / 2 GB container with Connector + Codex for isolated CI/PR verification.',
    cpuLimit: 1,
    memoryLimitMb: 2048,
    pidsLimit: 256,
    workspaceTmpfsMb: 1024,
    ttlMinutes: 60,
    networkMode: 'bridge',
    readOnlyRootfs: false,
    runtimes: ['codex'],
    secretEnvKeys: ['OPENAI_API_KEY'],
  },
  {
    id: 'tenant-isolated',
    label: 'Tenant Dedicated Workspace',
    description: 'Multi-tenant 2 vCPU / 4 GB isolated environment with capability drop & dedicated tmpfs.',
    cpuLimit: 2,
    memoryLimitMb: 4096,
    pidsLimit: 512,
    workspaceTmpfsMb: 2048,
    ttlMinutes: 240,
    networkMode: 'bridge',
    readOnlyRootfs: false,
    runtimes: ['codex', 'claude'],
    secretEnvKeys: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
  },
  {
    id: 'airgapped-review',
    label: 'Airgapped Audit Sandbox',
    description: 'Strict read-only rootfs and zero external network (--network none) for sensitive code review.',
    cpuLimit: 1,
    memoryLimitMb: 2048,
    pidsLimit: 192,
    workspaceTmpfsMb: 512,
    ttlMinutes: 45,
    networkMode: 'none',
    readOnlyRootfs: true,
    runtimes: ['codex'],
    secretEnvKeys: ['OPENAI_API_KEY'],
  },
] as const;

export const DOCKER_SANDBOX_COMMON_SECRET_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN',
  'COPILOT_GITHUB_TOKEN',
] as const;

export type DockerSandboxBlueprintInput = {
  hubUrl: string;
  environmentId: string;
  nodeLabel?: string | undefined;
  profileId?: DockerSandboxProfileId | undefined;
  image?: string | undefined;
  cpuLimit?: number | undefined;
  memoryLimitMb?: number | undefined;
  pidsLimit?: number | undefined;
  workspaceTmpfsMb?: number | undefined;
  ttlMinutes?: number | undefined;
  networkMode?: DockerSandboxNetworkMode | undefined;
  readOnlyRootfs?: boolean | undefined;
  runtimes?: readonly DockerSandboxRuntimeId[] | undefined;
  secretEnvKeys?: readonly string[] | undefined;
};

export type HubDockerSandboxTelemetry = {
  cpuPercent: number;
  memoryUsedMb: number;
  memoryLimitMb: number;
  pidsCount: number;
  uptimeSeconds: number;
  remainingSeconds: number;
  heartbeatStatus: 'healthy' | 'standby' | 'offline';
};

export type HubDockerSandboxInstance = {
  id: string;
  containerName: string;
  containerId?: string | undefined;
  name: string;
  profileId: DockerSandboxProfileId;
  image: string;
  status: 'running' | 'stopped' | 'expired' | 'simulated' | 'failed';
  cpuLimit: number;
  memoryLimitMb: number;
  pidsLimit: number;
  workspaceTmpfsMb: number;
  ttlMinutes: number;
  networkMode: DockerSandboxNetworkMode;
  readOnlyRootfs: boolean;
  runtimes: readonly DockerSandboxRuntimeId[];
  secretEnvKeys: readonly string[];
  environmentId: string;
  environmentLabel: string;
  ownerUserId: string;
  connectorUri: string;
  connectionId?: string | undefined;
  dockerRunCommand: string;
  dockerComposeYaml: string;
  dockerfileSnippet: string;
  createdAt: number;
  expiresAt: number;
  stoppedAt?: number | undefined;
  engineAvailable: boolean;
  telemetry: HubDockerSandboxTelemetry;
  logsTail: readonly string[];
};

export type HubDockerEngineStatus = {
  available: boolean;
  version?: string | undefined;
  rootless?: boolean | undefined;
  activeSandboxes: number;
  totalCpuAllocated: number;
  totalMemoryAllocatedMb: number;
};

export type HubDockerSandboxCreatePayload = {
  name?: string | undefined;
  profileId?: DockerSandboxProfileId | undefined;
  image?: string | undefined;
  cpuLimit?: number | undefined;
  memoryLimitMb?: number | undefined;
  pidsLimit?: number | undefined;
  workspaceTmpfsMb?: number | undefined;
  ttlMinutes?: number | undefined;
  networkMode?: DockerSandboxNetworkMode | undefined;
  readOnlyRootfs?: boolean | undefined;
  runtimes?: readonly DockerSandboxRuntimeId[] | undefined;
  secretEnvKeys?: readonly string[] | undefined;
  hubUrl?: string | undefined;
  environmentId?: string | undefined;
  environmentLabel?: string | undefined;
};

export type DockerSandboxBlueprint = {
  containerName: string;
  connectorUri: string;
  dockerRunCommand: string;
  dockerComposeYaml: string;
  dockerfileSnippet: string;
  cpuLimit: number;
  memoryLimitMb: number;
  pidsLimit: number;
  workspaceTmpfsMb: number;
  ttlMinutes: number;
  networkMode: DockerSandboxNetworkMode;
  readOnlyRootfs: boolean;
  runtimes: readonly DockerSandboxRuntimeId[];
  secretEnvKeys: readonly string[];
};

export function sanitizeSecretEnvKeyList(keys?: readonly string[] | undefined): string[] {
  if (!keys || keys.length === 0) return ['OPENAI_API_KEY'];
  const seen = new Set<string>();
  for (const raw of keys) {
    const clean = String(raw ?? '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, '');
    if (/^[A-Z_][A-Z0-9_]{1,63}$/.test(clean) && clean !== 'AOD_CONNECTOR_TOKEN') {
      seen.add(clean);
    }
    if (seen.size >= 12) break;
  }
  return seen.size > 0 ? [...seen] : ['OPENAI_API_KEY'];
}

export function buildDockerSandboxBlueprint(input: DockerSandboxBlueprintInput): DockerSandboxBlueprint {
  const preset =
    DOCKER_SANDBOX_PRESETS.find((item) => item.id === input.profileId) ?? DOCKER_SANDBOX_PRESETS[0]!;
  const cleanEnv = (input.environmentId.trim() || `docker-${preset.id}`)
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 36);
  const cleanNode = (input.nodeLabel?.trim() || preset.id)
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 36);
  const containerName = `aod-sbx-${cleanEnv}-${cleanNode}`.toLocaleLowerCase().slice(0, 48);
  const connectorUri = `reverse://${cleanEnv}/${containerName}`;
  const hubBase = (input.hubUrl.trim() || 'https://hub.example.com').replace(/\/+$/, '');
  const wsEndpoint =
    hubBase.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:') + '/api/hub/v1/connector-tunnel';
  const cpuLimit = Math.max(0.5, Math.min(16, Number(input.cpuLimit) || preset.cpuLimit));
  const memoryLimitMb = Math.max(512, Math.min(65536, Math.round(Number(input.memoryLimitMb) || preset.memoryLimitMb)));
  const pidsLimit = Math.max(64, Math.min(4096, Math.round(Number(input.pidsLimit) || preset.pidsLimit)));
  const workspaceTmpfsMb = Math.max(128, Math.min(16384, Math.round(Number(input.workspaceTmpfsMb) || preset.workspaceTmpfsMb)));
  const ttlMinutes = Math.max(5, Math.min(10080, Math.round(Number(input.ttlMinutes) || preset.ttlMinutes)));
  const networkMode: DockerSandboxNetworkMode = input.networkMode ?? preset.networkMode;
  const readOnlyRootfs = input.readOnlyRootfs ?? preset.readOnlyRootfs;
  const image = (input.image?.trim() || 'agentopsdeck-connector:1.0.0').replace(/[^a-zA-Z0-9._/:-]/g, '');
  const runtimeList: DockerSandboxRuntimeId[] =
    input.runtimes && input.runtimes.length > 0
      ? [...new Set(input.runtimes)]
      : [...preset.runtimes];
  const runtimes = runtimeList.join(',');
  const secretEnvKeys = sanitizeSecretEnvKeyList(input.secretEnvKeys ?? preset.secretEnvKeys);

  const runParts = [
    'docker run -d --rm',
    `--name ${containerName}`,
    '--label agentopsdeck.sandbox=1',
    `--label agentopsdeck.profile=${preset.id}`,
    `--cpus=${cpuLimit}`,
    `--memory=${memoryLimitMb}m`,
    `--pids-limit=${pidsLimit}`,
    '--cap-drop=ALL',
    '--security-opt no-new-privileges:true',
    '--tmpfs /tmp:rw,noexec,nosuid,size=256m',
    `--tmpfs /workspace:rw,nosuid,size=${workspaceTmpfsMb}m`,
    '--tmpfs /run/agentopsdeck-secrets:rw,noexec,nosuid,size=16m',
    '--workdir /workspace',
  ];
  if (readOnlyRootfs) runParts.push('--read-only');
  if (networkMode === 'none') runParts.push('--network none');
  else if (networkMode === 'host-gateway') runParts.push('--add-host=host.docker.internal:host-gateway');
  else runParts.push('--network bridge');

  runParts.push(
    `-e AOD_HUB_TUNNEL="${wsEndpoint}"`,
    `-e AOD_ENV_ID="${cleanEnv}"`,
    `-e AOD_RUNTIMES="${runtimes}"`,
    `-e AOD_SANDBOX_TTL_MINUTES="${ttlMinutes}"`,
    '-e AOD_CONNECTOR_TOKEN',
    ...secretEnvKeys.map((key) => `-e ${key}`),
    image,
  );

  const dockerComposeYaml = [
    'services:',
    `  ${containerName}:`,
    `    image: ${image}`,
    `    container_name: ${containerName}`,
    '    init: true',
    `    read_only: ${readOnlyRootfs ? 'true' : 'false'}`,
    `    network_mode: ${networkMode === 'none' ? 'none' : 'bridge'}`,
    '    security_opt:',
    '      - no-new-privileges:true',
    '    cap_drop:',
    '      - ALL',
    '    tmpfs:',
    '      - /tmp:rw,noexec,nosuid,size=256m',
    `      - /workspace:rw,nosuid,size=${workspaceTmpfsMb}m`,
    '      - /run/agentopsdeck-secrets:rw,noexec,nosuid,size=16m',
    '    deploy:',
    '      resources:',
    '        limits:',
    `          cpus: '${cpuLimit}'`,
    `          memory: ${memoryLimitMb}M`,
    `          pids: ${pidsLimit}`,
    '    environment:',
    `      AOD_HUB_TUNNEL: "${wsEndpoint}"`,
    `      AOD_ENV_ID: "${cleanEnv}"`,
    `      AOD_RUNTIMES: "${runtimes}"`,
    `      AOD_SANDBOX_TTL_MINUTES: "${ttlMinutes}"`,
    '      AOD_CONNECTOR_TOKEN: "${AOD_CONNECTOR_TOKEN:-}"',
    ...secretEnvKeys.map((key) => `      ${key}: "\${${key}:-}"`),
  ].join('\n');

  const dockerfileSnippet = [
    '# Ephemeral AgentOpsDeck Connector + Codex Isolated Sandbox Image',
    'FROM node:22-bookworm-slim',
    'RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep tini \\',
    '  && rm -rf /var/lib/apt/lists/*',
    'COPY agentopsdeck-connector /usr/local/bin/agentopsdeck-connector',
    'RUN test -x /usr/local/bin/agentopsdeck-connector',
    'RUN useradd -m -u 10001 -s /bin/bash sandbox && mkdir -p /workspace /run/agentopsdeck-secrets \\',
    '  && chown -R sandbox:sandbox /workspace /run/agentopsdeck-secrets',
    'USER sandbox',
    'WORKDIR /workspace',
    `ENV AOD_RUNTIMES="${runtimes}" \\`,
    '    AOD_SECRETS_DIR="/run/agentopsdeck-secrets"',
    'ENTRYPOINT ["/usr/bin/tini", "--", "agentopsdeck-connector", "connect-hub"]',
  ].join('\n');

  return {
    containerName,
    connectorUri,
    dockerRunCommand: runParts.join(' '),
    dockerComposeYaml,
    dockerfileSnippet,
    cpuLimit,
    memoryLimitMb,
    pidsLimit,
    workspaceTmpfsMb,
    ttlMinutes,
    networkMode,
    readOnlyRootfs,
    runtimes: runtimeList,
    secretEnvKeys,
  };
}
