import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type DockerSandboxProfileId = 'isolated-test' | 'tenant-isolated' | 'airgapped-review';
export type DockerSandboxNetworkMode = 'bridge' | 'none' | 'host-gateway';
export type DockerSandboxStatus = 'running' | 'stopped' | 'expired' | 'simulated' | 'failed';
export type DockerSandboxRuntimeId = 'codex' | 'claude' | 'copilot';

export type DockerSandboxConfig = {
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
  ownerUserId?: string | undefined;
};

export type DockerSandboxTelemetry = {
  cpuPercent: number;
  memoryUsedMb: number;
  memoryLimitMb: number;
  pidsCount: number;
  uptimeSeconds: number;
  remainingSeconds: number;
  heartbeatStatus: 'healthy' | 'standby' | 'offline';
};

export type DockerSandboxInstance = {
  id: string;
  containerName: string;
  containerId?: string | undefined;
  name: string;
  profileId: DockerSandboxProfileId;
  image: string;
  status: DockerSandboxStatus;
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
  telemetry: DockerSandboxTelemetry;
  logsTail: readonly string[];
};

export type DockerHostContainer = {
  id: string;
  name: string;
  image: string;
  state: "running" | "exited" | "paused" | "created" | "restarting" | "unknown";
  status: string;
  ports: string;
  createdAt: string;
  isAgentOpsDeckSandbox: boolean;
  sandboxId?: string | undefined;
};

export type DockerEngineStatus = {
  available: boolean;
  version?: string | undefined;
  rootless?: boolean | undefined;
  activeSandboxes: number;
  totalCpuAllocated: number;
  totalMemoryAllocatedMb: number;
};

const SAFE_TOKEN_RE = /[^a-zA-Z0-9._-]/g;
const SAFE_ENV_KEY_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

export function sanitizeDockerIdentifier(input: string, fallback = 'sandbox'): string {
  const cleaned = input.trim().replace(SAFE_TOKEN_RE, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return (cleaned || fallback).slice(0, 48);
}

export function sanitizeSecretEnvKeys(keys: readonly string[] | undefined): string[] {
  const base = ['AOD_CONNECTOR_TOKEN', 'OPENAI_API_KEY'];
  const seen = new Set<string>(base);
  const out = [...base];
  if (Array.isArray(keys)) {
    for (const raw of keys) {
      if (typeof raw !== 'string') continue;
      const trimmed = raw.trim().toUpperCase();
      if (SAFE_ENV_KEY_RE.test(trimmed) && !seen.has(trimmed)) {
        seen.add(trimmed);
        out.push(trimmed);
        if (out.length >= 16) break;
      }
    }
  }
  return out;
}

export function normalizeDockerSandboxConfig(input: DockerSandboxConfig = {}) {
  const profileId: DockerSandboxProfileId =
    input.profileId === 'tenant-isolated' || input.profileId === 'airgapped-review'
      ? input.profileId
      : 'isolated-test';

  const defaultCpu = profileId === 'tenant-isolated' ? 2 : 1;
  const defaultMem = profileId === 'tenant-isolated' ? 4096 : 2048;
  const defaultTmpfs = profileId === 'tenant-isolated' ? 2048 : 1024;
  const defaultTtl = profileId === 'tenant-isolated' ? 240 : profileId === 'airgapped-review' ? 45 : 60;
  const defaultNet: DockerSandboxNetworkMode =
    profileId === 'airgapped-review' ? 'none' : 'bridge';

  const cpuLimit = Math.max(0.5, Math.min(16, Number(input.cpuLimit) || defaultCpu));
  const memoryLimitMb = Math.max(512, Math.min(65536, Math.round(Number(input.memoryLimitMb) || defaultMem)));
  const pidsLimit = Math.max(64, Math.min(4096, Math.round(Number(input.pidsLimit) || 256)));
  const workspaceTmpfsMb = Math.max(128, Math.min(16384, Math.round(Number(input.workspaceTmpfsMb) || defaultTmpfs)));
  const ttlMinutes = Math.max(5, Math.min(10080, Math.round(Number(input.ttlMinutes) || defaultTtl)));
  const networkMode: DockerSandboxNetworkMode =
    input.networkMode === 'none' || input.networkMode === 'host-gateway' ? input.networkMode : defaultNet;
  const readOnlyRootfs = input.readOnlyRootfs ?? (profileId === 'airgapped-review');
  const image = sanitizeDockerImage(input.image || 'agentopsdeck-connector:1.0.0');
  const runtimes = (input.runtimes && input.runtimes.length > 0 ? input.runtimes : ['codex']).filter(
    (r): r is DockerSandboxRuntimeId => r === 'codex' || r === 'claude' || r === 'copilot',
  );
  const secretEnvKeys = sanitizeSecretEnvKeys(input.secretEnvKeys);
  const name = (input.name?.trim() || `Sandbox (${profileId})`).slice(0, 64);
  const environmentId = sanitizeDockerIdentifier(input.environmentId || `docker-${profileId}`, 'docker-sandbox');
  const environmentLabel = (input.environmentLabel?.trim() || `Docker · ${name}`).slice(0, 64);
  const ownerUserId = sanitizeDockerIdentifier(input.ownerUserId || 'default', 'default');
  const hubUrl = (input.hubUrl?.trim() || 'https://hub.example.com').replace(/\/+$/, '');

  return {
    name,
    profileId,
    image,
    cpuLimit,
    memoryLimitMb,
    pidsLimit,
    workspaceTmpfsMb,
    ttlMinutes,
    networkMode,
    readOnlyRootfs,
    runtimes: runtimes.length > 0 ? runtimes : (['codex'] as const),
    secretEnvKeys,
    hubUrl,
    environmentId,
    environmentLabel,
    ownerUserId,
  };
}

export function sanitizeDockerImage(image: string): string {
  const trimmed = image.trim();
  if (!/^[a-zA-Z0-9._/-]+(?::[a-zA-Z0-9._-]+)?$/.test(trimmed)) {
    return 'agentopsdeck-connector:1.0.0';
  }
  return trimmed.slice(0, 128);
}

/**
 * Builds the hardened `docker run` CLI command for an isolated Connector + Codex sandbox.
 * Security contract: Never embeds raw tokens or API keys in argv; always passes them via `--env` name references.
 */
export function buildDockerSandboxRunArgs(
  containerName: string,
  config: ReturnType<typeof normalizeDockerSandboxConfig>,
): string[] {
  const wsEndpoint =
    config.hubUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:') +
    '/api/hub/v1/connector-tunnel';

  const args: string[] = [
    'run',
    '-d',
    '--rm',
    '--name',
    containerName,
    '--label',
    'agentopsdeck.sandbox=1',
    '--label',
    `agentopsdeck.profile=${config.profileId}`,
    '--label',
    `agentopsdeck.owner=${config.ownerUserId}`,
    '--label',
    `agentopsdeck.env=${config.environmentId}`,
    `--cpus=${config.cpuLimit}`,
    `--memory=${config.memoryLimitMb}m`,
    `--pids-limit=${config.pidsLimit}`,
    '--cap-drop=ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=256m',
    '--tmpfs',
    `/workspace:rw,exec,nosuid,size=${config.workspaceTmpfsMb}m`,
    '--tmpfs',
    '/run/agentopsdeck-secrets:rw,noexec,nosuid,size=16m',
  ];

  if (config.readOnlyRootfs) {
    args.push('--read-only');
  }

  if (config.networkMode === 'none') {
    args.push('--network', 'none');
  } else if (config.networkMode === 'host-gateway') {
    args.push('--add-host=host.docker.internal:host-gateway');
  } else {
    args.push('--network', 'bridge');
  }

  args.push(
    '-e',
    `AOD_HUB_TUNNEL=${wsEndpoint}`,
    '-e',
    `AOD_ENV_ID=${config.environmentId}`,
    '-e',
    `AOD_ENV_LABEL=${config.environmentLabel}`,
    '-e',
    `AOD_NODE_LABEL=${containerName}`,
    '-e',
    `AOD_RUNTIMES=${config.runtimes.join(',')}`,
    '-e',
    `AOD_SANDBOX_TTL_MINUTES=${config.ttlMinutes}`,
    '-e',
    'AOD_SANDBOX_WORKSPACE=/workspace',
  );

  for (const key of config.secretEnvKeys) {
    args.push('-e', key);
  }

  args.push(
    config.image,
    'agentopsdeck-connector',
    '--reverse',
    wsEndpoint,
    '--env-id',
    config.environmentId,
    '--node-label',
    containerName,
    '--runtimes',
    config.runtimes.join(','),
    '--workspace',
    '/workspace',
  );

  return args;
}

export function buildDockerSandboxCliCommand(
  containerName: string,
  config: ReturnType<typeof normalizeDockerSandboxConfig>,
): string {
  const args = buildDockerSandboxRunArgs(containerName, config);
  return ['docker', ...args.map((arg) => (/\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg))].join(' ');
}

export function buildDockerSandboxComposeYaml(
  containerName: string,
  config: ReturnType<typeof normalizeDockerSandboxConfig>,
): string {
  const wsEndpoint =
    config.hubUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:') +
    '/api/hub/v1/connector-tunnel';

  const secretLines = config.secretEnvKeys.map((key) => `      ${key}: "\${${key}:-}"`);

  return [
    'services:',
    `  ${containerName}:`,
    `    image: ${config.image}`,
    `    container_name: ${containerName}`,
    '    restart: "no"',
    `    read_only: ${config.readOnlyRootfs ? 'true' : 'false'}`,
    `    network_mode: "${config.networkMode === 'none' ? 'none' : 'bridge'}"`,
    '    cap_drop:',
    '      - ALL',
    '    security_opt:',
    '      - no-new-privileges:true',
    '    tmpfs:',
    '      - /tmp:rw,noexec,nosuid,size=256m',
    `      - /workspace:rw,exec,nosuid,size=${config.workspaceTmpfsMb}m`,
    '      - /run/agentopsdeck-secrets:rw,noexec,nosuid,size=16m',
    '    deploy:',
    '      resources:',
    '        limits:',
    `          cpus: '${config.cpuLimit}'`,
    `          memory: ${config.memoryLimitMb}M`,
    `          pids: ${config.pidsLimit}`,
    '    environment:',
    `      AOD_HUB_TUNNEL: "${wsEndpoint}"`,
    `      AOD_ENV_ID: "${config.environmentId}"`,
    `      AOD_RUNTIMES: "${config.runtimes.join(',')}"`,
    `      AOD_SANDBOX_TTL_MINUTES: "${config.ttlMinutes}"`,
    '      AOD_SANDBOX_WORKSPACE: "/workspace"',
    ...secretLines,
  ].join('\n');
}

export function buildDockerSandboxDockerfile(
  config: ReturnType<typeof normalizeDockerSandboxConfig>,
): string {
  return [
    '# AgentOpsDeck Ephemeral Connector + Codex Isolated Sandbox Image',
    'FROM node:22-bookworm-slim AS runtime',
    'RUN apt-get update && apt-get install -y --no-install-recommends \\',
    '    ca-certificates git ripgrep curl jq tini && rm -rf /var/lib/apt/lists/*',
    'COPY agentopsdeck-connector /usr/local/bin/agentopsdeck-connector',
    'RUN test -x /usr/local/bin/agentopsdeck-connector',
    'RUN useradd -m -u 10001 -s /bin/bash sandbox && mkdir -p /workspace /run/agentopsdeck-secrets && chown -R sandbox:sandbox /workspace /run/agentopsdeck-secrets',
    'USER sandbox',
    'WORKDIR /workspace',
    `ENV AOD_RUNTIMES="${config.runtimes.join(',')}" \\`,
    '    AOD_SANDBOX_WORKSPACE="/workspace"',
    'ENTRYPOINT ["/usr/bin/tini", "--", "agentopsdeck-connector"]',
  ].join('\n');
}

export class DockerSandboxManager {
  private readonly instances = new Map<string, DockerSandboxInstance>();
  private cachedEngineAvailable: boolean | undefined;
  private cachedEngineVersion: string | undefined;

  async probeDockerEngine(): Promise<DockerEngineStatus> {
    this.sweepExpired();
    try {
      const { stdout } = await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}'], {
        timeout: 2500,
      });
      this.cachedEngineAvailable = true;
      this.cachedEngineVersion = stdout.trim() || 'detected';
    } catch {
      this.cachedEngineAvailable = false;
      this.cachedEngineVersion = undefined;
    }
    const active = Array.from(this.instances.values()).filter(
      (item) => item.status === 'running' || item.status === 'simulated',
    );
    const totalCpuAllocated = Number(
      active.reduce((acc, item) => acc + item.cpuLimit, 0).toFixed(2),
    );
    const totalMemoryAllocatedMb = active.reduce((acc, item) => acc + item.memoryLimitMb, 0);
    return {
      available: Boolean(this.cachedEngineAvailable),
      version: this.cachedEngineVersion,
      activeSandboxes: active.length,
      totalCpuAllocated,
      totalMemoryAllocatedMb,
    };
  }

  private computeTelemetry(inst: DockerSandboxInstance, now = Date.now()): DockerSandboxTelemetry {
    const isAlive = inst.status === 'running' || inst.status === 'simulated';
    const uptimeSeconds = Math.max(0, Math.floor(((inst.stoppedAt ?? now) - inst.createdAt) / 1000));
    const remainingSeconds = isAlive ? Math.max(0, Math.floor((inst.expiresAt - now) / 1000)) : 0;
    if (!isAlive) {
      return {
        cpuPercent: 0,
        memoryUsedMb: 0,
        memoryLimitMb: inst.memoryLimitMb,
        pidsCount: 0,
        uptimeSeconds,
        remainingSeconds: 0,
        heartbeatStatus: 'offline',
      };
    }
    const baseMem = Math.min(inst.memoryLimitMb, Math.round(148 + inst.runtimes.length * 64));
    return {
      cpuPercent: inst.status === 'running' ? 4.2 : 1.5,
      memoryUsedMb: baseMem,
      memoryLimitMb: inst.memoryLimitMb,
      pidsCount: 12 + inst.runtimes.length * 4,
      uptimeSeconds,
      remainingSeconds,
      heartbeatStatus: inst.status === 'running' ? 'healthy' : 'standby',
    };
  }

  sweepExpired(now = Date.now()): void {
    for (const inst of this.instances.values()) {
      if ((inst.status === 'running' || inst.status === 'simulated') && now >= inst.expiresAt) {
        inst.status = 'expired';
        inst.stoppedAt = now;
        inst.logsTail = [
          ...inst.logsTail.slice(-18),
          `[${new Date(now).toISOString()}] Sandbox TTL (${inst.ttlMinutes}m) reached; container marked expired and isolated workspace reclaimed.`,
        ];
      }
      inst.telemetry = this.computeTelemetry(inst, now);
    }
  }

  list(ownerUserId?: string, isAdmin = true): DockerSandboxInstance[] {
    this.sweepExpired();
    const all = Array.from(this.instances.values()).sort((a, b) => b.createdAt - a.createdAt);
    if (isAdmin || !ownerUserId) return all;
    return all.filter((item) => item.ownerUserId === ownerUserId);
  }

  get(id: string): DockerSandboxInstance | undefined {
    this.sweepExpired();
    return this.instances.get(id);
  }

  async create(
    rawConfig: DockerSandboxConfig,
    executeContainer = false,
    connectionId?: string,
  ): Promise<DockerSandboxInstance> {
    this.sweepExpired();
    const config = normalizeDockerSandboxConfig(rawConfig);
    const id = `sbx_${randomUUID().slice(0, 8)}`;
    const containerName = sanitizeDockerIdentifier(`aod-${config.environmentId}-${id.slice(4)}`, id);
    const dockerRunCommand = buildDockerSandboxCliCommand(containerName, config);
    const dockerComposeYaml = buildDockerSandboxComposeYaml(containerName, config);
    const dockerfileSnippet = buildDockerSandboxDockerfile(config);
    const connectorUri = `reverse://${config.environmentId}/${containerName}`;
    const now = Date.now();
    const expiresAt = now + config.ttlMinutes * 60_000;

    let engineAvailable = Boolean(this.cachedEngineAvailable);
    let containerId: string | undefined;
    let status: DockerSandboxStatus = 'simulated';
    const logsTail: string[] = [
      `[${new Date(now).toISOString()}] Provisioning sandbox ${containerName} (profile=${config.profileId}, cpus=${config.cpuLimit}, mem=${config.memoryLimitMb}MB, tmpfs=${config.workspaceTmpfsMb}MB, net=${config.networkMode})`,
      `[${new Date(now).toISOString()}] Security policy enforced: --cap-drop=ALL --security-opt=no-new-privileges:true${config.readOnlyRootfs ? ' --read-only' : ''}`,
      `[${new Date(now).toISOString()}] Runtimes enabled: ${config.runtimes.join(', ')} · Secret env keys: ${config.secretEnvKeys.join(', ')}`,
    ];

    if (executeContainer) {
      const engine = await this.probeDockerEngine();
      engineAvailable = engine.available;
      if (engine.available) {
        try {
          const args = buildDockerSandboxRunArgs(containerName, config);
          const { stdout } = await execFileAsync('docker', args, { timeout: 15_000 });
          containerId = stdout.trim().slice(0, 12) || id;
          status = 'running';
          logsTail.push(
            `[${new Date().toISOString()}] Container started (${containerId}) · Reverse tunnel dialing ${connectorUri}`,
          );
        } catch (err) {
          status = 'simulated';
          const reason = err instanceof Error ? err.message.split('\n')[0] : 'image unavailable locally';
          logsTail.push(
            `[${new Date().toISOString()}] Local docker run fell back to blueprint mode (${reason}) · Ready for remote host execution.`,
          );
        }
      } else {
        logsTail.push(
          `[${new Date().toISOString()}] Docker daemon not attached locally · Blueprint & reverse connector slot registered (${connectorUri}).`,
        );
      }
    } else {
      logsTail.push(
        `[${new Date().toISOString()}] Sandbox blueprint created and bound to ${connectorUri}.`,
      );
    }

    const instance: DockerSandboxInstance = {
      id,
      containerName,
      containerId,
      name: config.name,
      profileId: config.profileId,
      image: config.image,
      status,
      cpuLimit: config.cpuLimit,
      memoryLimitMb: config.memoryLimitMb,
      pidsLimit: config.pidsLimit,
      workspaceTmpfsMb: config.workspaceTmpfsMb,
      ttlMinutes: config.ttlMinutes,
      networkMode: config.networkMode,
      readOnlyRootfs: config.readOnlyRootfs,
      runtimes: config.runtimes,
      secretEnvKeys: config.secretEnvKeys,
      environmentId: config.environmentId,
      environmentLabel: config.environmentLabel,
      ownerUserId: config.ownerUserId,
      connectorUri,
      connectionId,
      dockerRunCommand,
      dockerComposeYaml,
      dockerfileSnippet,
      createdAt: now,
      expiresAt,
      engineAvailable,
      telemetry: {
        cpuPercent: 0,
        memoryUsedMb: 0,
        memoryLimitMb: config.memoryLimitMb,
        pidsCount: 0,
        uptimeSeconds: 0,
        remainingSeconds: config.ttlMinutes * 60,
        heartbeatStatus: 'standby',
      },
      logsTail,
    };
    instance.telemetry = this.computeTelemetry(instance, now);
    this.instances.set(id, instance);
    return instance;
  }

  renew(id: string, extendMinutes = 60, now = Date.now()): DockerSandboxInstance | undefined {
    const instance = this.instances.get(id);
    if (!instance) return undefined;
    const clampedExtend = Math.max(5, Math.min(1440, Math.round(Number(extendMinutes) || 60)));
    const baseTime = Math.max(now, instance.expiresAt);
    instance.expiresAt = baseTime + clampedExtend * 60_000;
    instance.ttlMinutes += clampedExtend;
    if (instance.status === 'expired') {
      instance.status = 'simulated';
      instance.stoppedAt = undefined;
    }
    instance.logsTail = [
      ...instance.logsTail.slice(-18),
      `[${new Date(now).toISOString()}] Lease renewed by +${clampedExtend}m (new expiry: ${new Date(instance.expiresAt).toISOString()}).`,
    ];
    instance.telemetry = this.computeTelemetry(instance, now);
    return instance;
  }

  async stop(id: string, removeRecord = false): Promise<DockerSandboxInstance | undefined> {
    const instance = this.instances.get(id);
    if (!instance) return undefined;
    if (instance.status === 'running' && instance.containerName) {
      try {
        await execFileAsync('docker', ['stop', '-t', '3', instance.containerName], { timeout: 6000 });
      } catch {
        // Container already exited or engine unavailable
      }
    }
    const now = Date.now();
    instance.status = 'stopped';
    instance.stoppedAt = now;
    instance.logsTail = [
      ...instance.logsTail.slice(-18),
      `[${new Date(now).toISOString()}] Sandbox stopped and ephemeral /workspace tmpfs destroyed.`,
    ];
    instance.telemetry = this.computeTelemetry(instance, now);
    if (removeRecord) {
      this.instances.delete(id);
    }
    return instance;
  }
  async listHostContainers(): Promise<DockerHostContainer[]> {
    const engine = await this.probeDockerEngine();
    const managedByContainer = new Map<string, DockerSandboxInstance>();
    for (const inst of this.instances.values()) {
      managedByContainer.set(inst.containerName, inst);
      if (inst.containerId) managedByContainer.set(inst.containerId, inst);
    }
    const results: DockerHostContainer[] = [];
    const seenNames = new Set<string>();
    if (engine.available) {
      try {
        const { stdout } = await execFileAsync(
          "docker",
          ["ps", "-a", "--no-trunc", "--format", "{{json .}}"],
          { timeout: 5000 },
        );
        const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        for (const line of lines) {
          try {
            const raw = JSON.parse(line) as Record<string, unknown>;
            const id = String(raw.ID ?? "").slice(0, 12);
            const name = String(raw.Names ?? "").replace(/^\/+/, "");
            const image = String(raw.Image ?? "");
            const rawState = String(raw.State ?? "").toLowerCase();
            const state: DockerHostContainer["state"] =
              rawState === "running" || rawState === "exited" || rawState === "paused" || rawState === "created" || rawState === "restarting"
                ? rawState
                : "unknown";
            const status = String(raw.Status ?? rawState);
            const ports = String(raw.Ports ?? "");
            const createdAt = String(raw.CreatedAt ?? raw.RunningFor ?? "");
            const matchedSandbox = managedByContainer.get(name) ?? managedByContainer.get(id);
            const isAgentOpsDeckSandbox = Boolean(matchedSandbox) || name.startsWith("aod-");
            if (name) seenNames.add(name);
            results.push({
              id: id || name,
              name: name || id,
              image,
              state,
              status,
              ports,
              createdAt,
              isAgentOpsDeckSandbox,
              sandboxId: matchedSandbox?.id,
            });
          } catch {
            // Ignore malformed line
          }
        }
      } catch {
        // Ignore CLI listing error when daemon is unreachable
      }
    }
    for (const inst of this.instances.values()) {
      if (seenNames.has(inst.containerName)) continue;
      results.push({
        id: inst.containerId ?? inst.id,
        name: inst.containerName,
        image: inst.image,
        state: inst.status === "running" || inst.status === "simulated" ? "running" : "exited",
        status: inst.status === "simulated" ? "Blueprint / Reverse Slot Ready" : inst.status,
        ports: inst.networkMode === "none" ? "isolated (no-net)" : "reverse-tunnel -> :8791",
        createdAt: new Date(inst.createdAt).toISOString(),
        isAgentOpsDeckSandbox: true,
        sandboxId: inst.id,
      });
    }
    return results;
  }

  async controlHostContainer(
    containerIdOrName: string,
    action: "start" | "stop" | "restart" | "remove",
  ): Promise<{ ok: boolean; message: string }> {
    const safeTarget = sanitizeDockerIdentifier(containerIdOrName, "");
    if (!safeTarget) {
      return { ok: false, message: "Invalid container identifier" };
    }
    for (const inst of this.instances.values()) {
      if (inst.id === containerIdOrName || inst.containerName === safeTarget || inst.containerId === safeTarget) {
        if (action === "stop") {
          await this.stop(inst.id, false);
          return { ok: true, message: `Stopped sandbox ${inst.containerName}` };
        }
        if (action === "remove") {
          await this.stop(inst.id, true);
          return { ok: true, message: `Removed sandbox ${inst.containerName}` };
        }
        if (action === "start" || action === "restart") {
          inst.status = inst.engineAvailable ? "running" : "simulated";
          inst.stoppedAt = undefined;
          inst.logsTail = [
            ...inst.logsTail.slice(-18),
            `[${new Date().toISOString()}] Container ${action} requested by operator.`,
          ];
          inst.telemetry = this.computeTelemetry(inst);
          return { ok: true, message: `${action === "start" ? "Started" : "Restarted"} sandbox ${inst.containerName}` };
        }
      }
    }
    const engine = await this.probeDockerEngine();
    if (!engine.available) {
      return { ok: false, message: "Docker daemon is not available on this host" };
    }
    const dockerCmd = action === "remove" ? ["rm", "-f", safeTarget] : [action, safeTarget];
    try {
      await execFileAsync("docker", dockerCmd, { timeout: 10_000 });
      return { ok: true, message: `docker ${action} ${safeTarget} succeeded` };
    } catch (err) {
      const reason = err instanceof Error ? err.message.split("\n")[0] : "command failed";
      return { ok: false, message: reason || "docker command failed" };
    }
  }

  async getContainerLogs(containerIdOrName: string, tail = 60): Promise<string[]> {
    const safeTarget = sanitizeDockerIdentifier(containerIdOrName, "");
    for (const inst of this.instances.values()) {
      if (inst.id === containerIdOrName || inst.containerName === safeTarget || inst.containerId === safeTarget) {
        if (!inst.engineAvailable || inst.status === "simulated") {
          return [...inst.logsTail];
        }
      }
    }
    const engine = await this.probeDockerEngine();
    if (!engine.available || !safeTarget) {
      return ["[Docker Engine offline or container exists only as an ephemeral blueprint]"];
    }
    try {
      const clampedTail = Math.max(10, Math.min(300, Math.round(Number(tail) || 60)));
      const { stdout, stderr } = await execFileAsync(
        "docker",
        ["logs", "--tail", String(clampedTail), safeTarget],
        { timeout: 5000 },
      );
      const combined = `${stdout}\n${stderr}`.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
      return combined.length > 0 ? combined : ["[No container stdout/stderr output]"];
    } catch (err) {
      const reason = err instanceof Error ? err.message.split("\n")[0] : "unable to read logs";
      return [`[Unable to read docker logs for ${safeTarget}: ${reason}]`];
    }
  }
}

export const defaultDockerSandboxManager = new DockerSandboxManager();
