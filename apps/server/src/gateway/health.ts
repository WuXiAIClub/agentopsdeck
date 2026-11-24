import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GatewayHealth } from '@agentopsdeck/shared';
import type { AdminRpcClient } from './admin-client.js';
import type { GatewayWsClient } from './ws-client.js';

const execFileAsync = promisify(execFile);
const STATUS_PROBE_TIMEOUT_MS = 8_000;
const STATUS_PROBE_COOLDOWN_MS = 60_000;

let statusProbeInflight: Promise<OpenClawStatus> | undefined;
let statusProbeFailure: { error: Error; at: number } | undefined;

type OpenClawStatus = {
  runtimeVersion?: string;
  gateway?: {
    reachable?: boolean;
    url?: string;
    urlSource?: string;
    connectLatencyMs?: number;
    self?: { version?: string; host?: string; ip?: string; platform?: string };
    error?: string | null;
    authWarning?: string | null;
  };
  heartbeat?: { defaultAgentId?: string; agents?: unknown[] };
  agents?: { defaultId?: string };
  sessions?: { defaults?: { model?: string; selectedModel?: string; configuredModel?: string } };
  rpc?: { ok?: boolean; error?: string; server?: { version?: string } } | null;
  service?: unknown;
};

export async function readGatewayHealth(params: {
  admin: AdminRpcClient;
  gateway: GatewayWsClient;
  defaultAgentId: string;
  normalizeError: (error: unknown) => string;
  localOpenClawCli?: boolean;
  statusProbe?: () => Promise<OpenClawStatus>;
}): Promise<GatewayHealth> {
  const { admin, gateway, defaultAgentId, normalizeError } = params;
  const wsStatus = gateway.status();
  const localCliEnabled = params.localOpenClawCli !== false;
  if (!localCliEnabled && !wsStatus.configured && !wsStatus.url && !wsStatus.connected && !admin.status().configured) {
    return { ok: false, enabled: false, status: 'unknown', degraded: false, updatedAt: Date.now(),
      gatewayWs: { configured: false, connected: false }, adminRpc: admin.status(),
      details: { source: 'disabled' }, note: 'OpenClaw is disabled on this Connector. Codex runs independently.' };
  }
  const shouldProbeCli = localCliEnabled && wsStatus.connected !== true;
  const probe = params.statusProbe ?? readOpenClawStatus;
  let status: OpenClawStatus | undefined;
  let probeError: string | undefined;
  if (shouldProbeCli) {
    try {
      status = await probe();
    } catch (error) {
      probeError = normalizeError(error);
    }
  } else if (!localCliEnabled) {
    probeError = 'local OpenClaw CLI disabled for remote deployment';
  }
  const gatewayStatus = status?.gateway;
  // The `openclaw status --json` CLI probe is unreliable on some hosts (missing on PATH,
  // or hangs). When it is unavailable, fall back to the live WS connection state: if the
  // gateway control-plane WebSocket is connected, the gateway is reachable.
  const cliReachable = gatewayStatus?.reachable === true;
  const reachable = cliReachable || wsStatus.connected === true;
  const error = probeError ?? gatewayStatus?.error ?? gatewayStatus?.authWarning ?? undefined;

  const version = gatewayStatus?.self?.version ?? status?.runtimeVersion;
  const defaultModel = status?.sessions?.defaults?.selectedModel ?? status?.sessions?.defaults?.configuredModel ?? status?.sessions?.defaults?.model;
  return {
    ok: reachable,
    status: reachable ? 'online' : 'offline',
    degraded: false,
    ...(version ? { version } : {}),
    defaultAgentId: status?.agents?.defaultId ?? status?.heartbeat?.defaultAgentId ?? defaultAgentId,
    ...(defaultModel ? { defaultModel } : {}),
    updatedAt: Date.now(),
    gatewayWs: {
      configured: Boolean(gatewayStatus?.url ?? wsStatus.url),
      connected: wsStatus.connected,
      url: gatewayStatus?.url ?? wsStatus.url,
    },
    adminRpc: admin.status(),
    details: {
      source: wsStatus.connected === true
        ? (localCliEnabled ? 'gateway ws' : 'gateway ws + remote mode')
        : 'openclaw status --json',
      gateway: gatewayStatus,
      heartbeat: status?.heartbeat,
      service: status?.service,
      rpc: status?.rpc,
      deckGatewayClient: wsStatus,
      deckAdminRpc: admin.status(),
    },
    ...(error ? { error } : {}),
    note: reachable
      ? (wsStatus.connected === true ? 'Gateway is reachable via the live WebSocket connection.' : 'Gateway is reachable via OpenClaw status probe.')
      : 'Gateway is not reachable via OpenClaw status probe.',
  };
}

async function readOpenClawStatus(): Promise<OpenClawStatus> {
  const now = Date.now();
  if (statusProbeFailure && now - statusProbeFailure.at < STATUS_PROBE_COOLDOWN_MS) throw statusProbeFailure.error;
  if (statusProbeInflight) return statusProbeInflight;

  statusProbeInflight = executeOpenClawStatus().then((value) => {
    statusProbeFailure = undefined;
    return value;
  }).catch((error) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    statusProbeFailure = { error: normalized, at: Date.now() };
    throw normalized;
  }).finally(() => {
    statusProbeInflight = undefined;
  });
  return statusProbeInflight;
}

async function executeOpenClawStatus(): Promise<OpenClawStatus> {
  const cli = process.env.OPENCLAW_CLI_PATH || 'openclaw';
  const { stdout } = process.platform === 'win32'
    ? await execFileWithWindowsTreeTimeout(cli, ['status', '--json'], STATUS_PROBE_TIMEOUT_MS)
    : await execFileAsync(cli, ['status', '--json'], {
      timeout: STATUS_PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 8 * 1024 * 1024,
    });
  return JSON.parse(stdout) as OpenClawStatus;
}

function execFileWithWindowsTreeTimeout(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let timingOut = false;
    let settled = false;
    const child = execFile(command, args, {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      shell: true,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (timingOut || settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });

    const timer = setTimeout(() => {
      if (settled) return;
      timingOut = true;
      const timeoutError = new Error(`OpenClaw status probe timed out after ${timeoutMs}ms`);
      const finish = () => {
        if (settled) return;
        settled = true;
        reject(timeoutError);
      };
      if (!child.pid) {
        child.kill('SIGKILL');
        finish();
        return;
      }
      execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        timeout: 5_000,
        windowsHide: true,
      }, () => {
        child.kill('SIGKILL');
        finish();
      });
    }, timeoutMs);
    timer.unref();
  });
}
