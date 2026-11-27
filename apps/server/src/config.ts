import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { parseMetricVolumes } from './system/metrics.js';
import { parseIssueSources, type IssueSource } from './connector/issue-sources.js';
import { parseResearchConfig, type ResearchConfig } from './hub/workspace-research.js';
import { parseWorkspaceBrowserConfig, type WorkspaceBrowserConfig } from './hub/workspace-browser.js';
import { parseWebsiteServices, type WebsiteService } from './connector/websites.js';
import { parseTerminalTargets, type TerminalTarget } from './connector/terminals.js';
import { parseBoardBindingPolicies, type BoardBindingPolicy } from './connector/board-bindings.js';
import { parseBoardAgentEndpoint } from './hub/workspace-board-bindings.js';
import { parseFileBoardPolicy, type FileBoardPolicy } from './connector/workspace-board-file-policy.js';
import { boardToolsDirectory } from './tools/workspace-board-worker.js';
import { parseWebsiteGateway, type WebsiteGatewayConfig } from './hub/website-gateway.js';
import { isIP } from 'node:net';
import { parseAuthTrustedProxies } from './auth/request-source.js';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermesConfig, type HermesConfig } from './hermes/config.js';
import { claudeConfig, type ClaudeConfig } from './claude/config.js';
import { copilotConfig, type CopilotConfig } from './copilot/config.js';
import { ahpConfig, type AhpConfig } from './ahp/config.js';
import { antigravityConfig, type AntigravityConfig } from './antigravity/config.js';
import { parseGitStatusAccounts, type GitStatusAccountConfig } from './git-status/config.js';
import { AGENTOPSDECK_VERSION } from '@agentopsdeck/shared';
import { parseLifecycleEndpoints, type LifecycleEndpoint } from './hub/lifecycle-client.js';
import { rolloutCachePolicyFromEnv, type RolloutCachePolicy } from './codex/rollout-cache-policy.js';

export type ServerRole = 'all' | 'hub' | 'connector';
export type NativeFileRoots = Readonly<{ home: string; configFile: string; configRequired: boolean }>;

export type ServerConfig = {
  inboundMediaDir: string;
  nativeFileRoots: NativeFileRoots;
  hermes?: HermesConfig;
  claude?: ClaudeConfig;
  copilot?: CopilotConfig;
  ahp?: AhpConfig;
  antigravity?: AntigravityConfig;
  gitStatusAccounts: GitStatusAccountConfig[];
  port: number;
  listenHost?: string;
  serverRole: ServerRole;
  gatewayWsUrl: string | undefined;
  adminRpcUrl: string | undefined;
  ownerToken: string | undefined;
  password: string | undefined;
  defaultAgentId: string;
  accessKey: string | undefined;
  sessionTitlesFile: string;
  sessionThinkingOverridesFile: string;
  hiddenSessionsFile: string;
  archivedSessionsFile: string;
  pinnedSessionsFile: string;
  passkeysFile: string;
  authSessionsFile: string;
  /** Opt-in same-host transactional auth. Legacy JSON files must be offline. */
  authSqliteFile?: string | undefined;
  mirrorOutboxFile: string;
  queueFile: string;
  artifactIndexFile: string;
  localOpenClawCli: boolean;
  publicBaseUrl: string | undefined;
  allowedOrigins: string[];
  sourcePreview?: { allowedDirs: string[]; approvalDirs?: string[] };
  /** Explicit per-agent workspace roots. Never inferred from a remote session. */
  fileBrowserRoots?: Record<string, string>;
  issueSources?: IssueSource[];
  issueLocalRead?: boolean;
  /** Separate operator allowlist; IDs only are exposed to metrics readers. */
  metricVolumes?: Record<string, string>;
  /** Local daily credential only; remote writes still require files:write. */
  fileBrowserLocalWrite?: boolean;
  websiteServices?: WebsiteService[];
  terminalTargets?: TerminalTarget[];
  boardBindingPolicies?: BoardBindingPolicy[];
  boardAgentEndpoint?: string;
  boardFiles?: FileBoardPolicy;
  boardFilesEnabled?: boolean;
  /** Separate in-process binding credential; never added to daily/default scopes. */
  boardLocalBinding?: boolean;
  terminalLocalAccess?: boolean;
  /** Explicit operator opt-in; never broadens remote/default credentials. */
  automationLocalManage?: boolean;
  websiteLocalAccess?: boolean;
  websiteLocalBrowse?: boolean;
  websiteLocalActions?: boolean;
  websiteLocalConnect?: boolean;
  websiteGateway?: WebsiteGatewayConfig;
  mediaBridge: {
    enabled: boolean;
    allowedDirs: string[];
    maxBytes: number;
  };
  mediaLibrary: {
    enabled: boolean;
    allowedDirs: string[];
    signingSecret: string | undefined;
    linkTtlSeconds: number;
  };
  artifactReceiver: {
    enabled: boolean;
    allowedDirs: string[];
    allowedDirectChildDirs: string[];
    directChildAllowedExtensions: string[];
    maxBytes: number;
    indexFile: string;
    injectCapability: boolean;
    allowGatewayClient: boolean;
    urlWrappedOrigins: string[];
  };
  authRateLimit: {
    maxFailures: number;
    windowMs: number;
    lockoutMs: number;
  };
  /** Socket peers allowed to append a verified X-Forwarded-For chain. */
  authTrustedProxies?: string[];
  connector: {
    environmentId: string;
    environmentLabel: string;
    tokenFile: string;
    usersDatabaseFile: string;
    bootstrapToken: string | undefined;
    version: string;
    revision: string | undefined;
    gatewayVersion: string | undefined;
    openclawConfigFile: string | undefined;
    modelAliases?: string[];
    updateEnabled: boolean;
    updateChannel: 'stable' | 'candidate' | 'manual';
    updateManifestUrl: string | undefined;
    updateStateFile: string;
    installRoot: string | undefined;
    currentSymlink: string | undefined;
  };
  hub: {
    browser?: WorkspaceBrowserConfig | undefined;
    research?: ResearchConfig | undefined;
    drawioEditorUrl?: string | undefined;
    enabled: boolean;
    lifecycleEndpoints?: LifecycleEndpoint[];
    allowLocalExecutionSetup?: boolean;
    defaultConnectionId: string;
    defaultConnectionLabel: string;
    localConnectorUrl: string | undefined;
    localConnectorToken: string | undefined;
    databaseFile: string;
    vaultSecret: string | undefined;
    legacyPreferencesOwner?: string | undefined;
  };
  codex: {
    boardToolsDirectory?: string | undefined;
    historyCache?: RolloutCachePolicy;
    enabled: boolean;
    command: string;
    homeDirectory?: string | undefined;
    defaultCwd: string;
    defaultModel: string;
    modelProvider?: string | undefined;
    modelProviderEnvironment?: Readonly<Record<string, string | undefined>> | undefined;
    toolImageCompatibility?: import('./codex/tool-image-compat.js').ToolImageCompatibilityOptions | undefined;
    modelChoices?: string[];
    autoCompactTokenLimit?: number | undefined;
    disableRemoteCompaction?: boolean | undefined;
    approvalPolicy: 'never' | 'on-request' | 'untrusted';
    queueFile: string;
    runtimeOverridesFile: string;
  };
};

const emptyToUndefined = (value: string | undefined) =>
  value && value.trim().length > 0 ? value.trim() : undefined;

function parseSourcePreviewRoots(value: string | undefined, name = 'AOD_SOURCE_PREVIEW_ROOTS'): string[] {
  if (!value?.trim()) return [];
  let roots: unknown;
  try { roots = JSON.parse(value); } catch { throw new Error(`${name} must be a JSON array of absolute project directories`); }
  if (!Array.isArray(roots) || roots.length > 32 || roots.some(root => typeof root !== 'string' || !isAbsolute(root)
    || /[\x00-\x1f\x7f]/.test(root) || dirname(resolve(root)) === resolve(root))) throw new Error(`${name} must be a JSON array of absolute project directories (not filesystem roots)`);
  return [...new Set((roots as string[]).map(root => resolve(root)))];
}

function optionalPositiveInt(value: string | undefined) {
  if (!value?.trim()) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('AOD_CODEX_AUTO_COMPACT_TOKEN_LIMIT must be a positive integer');
  return number;
}

export function parseFileBrowserRoots(value: string | undefined): Record<string, string> {
  if (!value?.trim()) return {};
  const invalid = () => new Error('AOD_FILE_ROOTS_JSON must be an object mapping agent IDs to absolute project directories');
  let roots: unknown;
  try { roots = JSON.parse(value); } catch { throw invalid(); }
  if (!roots || typeof roots !== 'object' || Array.isArray(roots) || Object.keys(roots).length > 32) throw invalid();
  const entries = Object.entries(roots);
  for (const [id, root] of entries) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ['__proto__', 'prototype', 'constructor'].includes(id)
      || typeof root !== 'string' || !isAbsolute(root) || /[\x00-\x1f\x7f]/.test(root)
      || dirname(resolve(root)) === resolve(root) || resolve(root) === resolve(homedir())) throw invalid();
  }
  return Object.fromEntries(entries.map(([id, root]) => [id, resolve(root as string)]));
}

export function loadConfig(env = process.env): ServerConfig {
  if (env === process.env) loadDotEnvDefaults(env);
  const stateDirectory = agentOpsDeckDataDirectory(env);
  const listenHost = emptyToUndefined(env.AOD_LISTEN_HOST) ?? '127.0.0.1';
  if (listenHost !== undefined && !isIP(listenHost)) throw new Error('AOD_LISTEN_HOST must be an IP address');
  if (!isLoopbackListenHost(listenHost) && !emptyToUndefined(env.AOD_ACCESS_KEY)) {
    throw new Error('Non-loopback AOD_LISTEN_HOST requires AOD_ACCESS_KEY');
  }
  const codexHome = emptyToUndefined(env.AOD_CODEX_HOME) ?? join(stateDirectory, 'codex-home');
  if (codexHome !== undefined && (!isAbsolute(codexHome) || codexHome.includes('\0'))) {
    throw new Error('AOD_CODEX_HOME must be an absolute path without null bytes');
  }
  const publicBaseUrl = normalizePublicBaseUrl(emptyToUndefined(env.AOD_PUBLIC_BASE_URL));
  const allowedOrigins = parseCsv(emptyToUndefined(env.AOD_ALLOWED_ORIGINS));
  const hermes = hermesConfig(env);
  const claude = claudeConfig(env);
  const copilot = copilotConfig(env);
  const ahp = ahpConfig(env);
  if (ahp && (parseServerRole(env.AOD_SERVER_ROLE) !== 'connector' || listenHost !== '127.0.0.1' || !env.AOD_DATA_DIR?.trim()
    || !env.AOD_CONNECTOR_BOOTSTRAP_TOKEN?.trim())) throw new Error('AHP requires a dedicated loopback Connector with independent state and a token');
  const antigravity = antigravityConfig(env);
  const gitStatusAccounts = parseGitStatusAccounts(env);
  const websiteGateway = parseWebsiteGateway(env);
  const compatUpstream = env.AOD_CODEX_GEMINI_TOOL_IMAGE_UPSTREAM?.trim()
    || env.AOD_CODEX_RESPONSES_COMPAT_UPSTREAM?.trim();
  const retryStale = env.AOD_CODEX_RETRY_STALE_CONNECTION_ITEMS === 'true';
  if (websiteGateway && (websiteGateway.port === Number(env.AOD_PORT ?? env.PORT ?? 8890)
    || parseServerRole(env.AOD_SERVER_ROLE) === 'connector' || env.AOD_HUB_ENABLED === 'false')) {
    throw new Error('Website gateway requires an enabled Hub and a separate listening port');
  }
  return {
    inboundMediaDir: join(stateDirectory, 'media', 'inbound'),
    nativeFileRoots: nativeFileRoots(env),
    ...(websiteGateway ? { websiteGateway } : {}),
    ...(hermes ? { hermes } : {}),
    ...(claude ? { claude } : {}),
    ...(copilot ? { copilot } : {}),
    ...(ahp ? { ahp } : {}),
    ...(antigravity ? { antigravity } : {}),
    gitStatusAccounts,
    port: Number(env.AOD_PORT ?? env.PORT ?? 8890),
    ...(listenHost !== undefined ? { listenHost } : {}),
    serverRole: parseServerRole(env.AOD_SERVER_ROLE),
    gatewayWsUrl: emptyToUndefined(env.AOD_OPENCLAW_GATEWAY_WS_URL),
    adminRpcUrl: emptyToUndefined(env.AOD_OPENCLAW_GATEWAY_ADMIN_RPC_URL),
    ownerToken: emptyToUndefined(env.AOD_OPENCLAW_GATEWAY_OWNER_TOKEN),
    password: emptyToUndefined(env.AOD_OPENCLAW_GATEWAY_PASSWORD),
    defaultAgentId: env.AOD_OPENCLAW_DEFAULT_AGENT_ID ?? 'main',
    accessKey: emptyToUndefined(env.AOD_ACCESS_KEY),
    sessionTitlesFile: env.AOD_SESSION_TITLES_FILE ?? join(stateDirectory, '.agentopsdeck-session-titles.json'),
    sessionThinkingOverridesFile: env.AOD_SESSION_THINKING_OVERRIDES_FILE ?? join(dirname(env.AOD_SESSION_TITLES_FILE ?? join(stateDirectory, '.agentopsdeck-session-titles.json')), '.agentopsdeck-session-thinking-overrides.json'),
    hiddenSessionsFile: env.AOD_HIDDEN_SESSIONS_FILE ?? join(dirname(env.AOD_SESSION_TITLES_FILE ?? join(stateDirectory, '.agentopsdeck-session-titles.json')), '.agentopsdeck-hidden-sessions.json'),
    archivedSessionsFile: env.AOD_ARCHIVED_SESSIONS_FILE ?? join(dirname(env.AOD_SESSION_TITLES_FILE ?? join(stateDirectory, '.agentopsdeck-session-titles.json')), '.agentopsdeck-archived-sessions.json'),
    pinnedSessionsFile: env.AOD_PINNED_SESSIONS_FILE ?? join(dirname(env.AOD_SESSION_TITLES_FILE ?? join(stateDirectory, '.agentopsdeck-session-titles.json')), '.agentopsdeck-pinned-sessions.json'),
    passkeysFile: env.AOD_PASSKEYS_FILE ?? join(stateDirectory, '.agentopsdeck-passkeys.json'),
    authSessionsFile: env.AOD_AUTH_SESSIONS_FILE ?? join(stateDirectory, '.agentopsdeck-sessions.json'),
    authSqliteFile: env.AOD_AUTH_SQLITE_FILE || undefined,
    mirrorOutboxFile: env.AOD_MIRROR_OUTBOX_FILE ?? join(stateDirectory, '.agentopsdeck-mirror-outbox.json'),
    queueFile: env.AOD_QUEUE_FILE ?? join(stateDirectory, '.agentopsdeck-queue.json'),
    artifactIndexFile: emptyToUndefined(env.AOD_ARTIFACT_INDEX_FILE) ?? join(stateDirectory, '.agentopsdeck-artifacts.json'),
    localOpenClawCli: env.AOD_LOCAL_OPENCLAW_CLI === 'true',
    publicBaseUrl,
    allowedOrigins,
    sourcePreview: { allowedDirs: parseSourcePreviewRoots(env.AOD_SOURCE_PREVIEW_ROOTS),
      ...(env.AOD_SOURCE_APPROVAL_ROOTS ? { approvalDirs: parseSourcePreviewRoots(env.AOD_SOURCE_APPROVAL_ROOTS, 'AOD_SOURCE_APPROVAL_ROOTS') } : {}) },
    fileBrowserRoots: parseFileBrowserRoots(env.AOD_FILE_ROOTS_JSON),
    issueSources: parseIssueSources(env.AOD_ISSUE_SOURCES_JSON, env),
    issueLocalRead: env.AOD_ISSUE_LOCAL_READ === 'true',
    metricVolumes: parseMetricVolumes(env.AOD_METRIC_VOLUMES_JSON),
    fileBrowserLocalWrite: env.AOD_FILE_LOCAL_WRITE === 'true',
    websiteServices: parseWebsiteServices(env.AOD_WEBSITES_JSON),
    terminalTargets: parseTerminalTargets(env.AOD_TERMINALS_JSON),
    boardBindingPolicies: parseBoardBindingPolicies(env.AOD_BOARD_BINDINGS_JSON),
    boardFilesEnabled: env.AOD_BOARD_FILES_ENABLED === 'true',
    ...(env.AOD_BOARD_FILES_JSON !== undefined ? { boardFiles: parseFileBoardPolicy(env.AOD_BOARD_FILES_JSON)! } : {}),
    boardLocalBinding: env.AOD_BOARD_LOCAL_BINDING === 'true',
    ...(env.AOD_BOARD_AGENT_ENDPOINT !== undefined ? { boardAgentEndpoint: parseBoardAgentEndpoint(env.AOD_BOARD_AGENT_ENDPOINT)! } : {}),
    terminalLocalAccess: env.AOD_TERMINAL_LOCAL_ACCESS === '1',
    automationLocalManage: env.AOD_AUTOMATION_LOCAL_MANAGE === '1',
    websiteLocalAccess: env.AOD_WEBSITES_LOCAL_ACCESS === 'true',
    websiteLocalBrowse: env.AOD_WEBSITES_LOCAL_BROWSE === 'true',
    websiteLocalActions: env.AOD_WEBSITES_LOCAL_ACTIONS === 'true',
    websiteLocalConnect: env.AOD_WEBSITES_LOCAL_CONNECT === 'true',
    mediaBridge: {
      enabled: env.AOD_MEDIA_BRIDGE_ENABLED !== 'false',
      allowedDirs: parseMediaBridgeAllowedDirs(env),
      maxBytes: positiveInt(env.AOD_MEDIA_BRIDGE_MAX_BYTES, 12 * 1024 * 1024),
    },
    mediaLibrary: {
      enabled: env.AOD_MEDIA_LIBRARY_ENABLED !== 'false' && parseCsv(emptyToUndefined(env.AOD_MEDIA_LIBRARY_DIRS)).length > 0,
      allowedDirs: parseCsv(emptyToUndefined(env.AOD_MEDIA_LIBRARY_DIRS)),
      signingSecret: emptyToUndefined(env.AOD_MEDIA_LIBRARY_SIGNING_SECRET),
      linkTtlSeconds: positiveInt(env.AOD_MEDIA_LIBRARY_LINK_TTL_SECONDS, 12 * 60 * 60),
    },
    artifactReceiver: {
      enabled: env.AOD_ARTIFACT_RECEIVER_ENABLED !== 'false',
      allowedDirs: parseArtifactAllowedDirs(env),
      allowedDirectChildDirs: parseArtifactAllowedDirectChildDirs(env),
      directChildAllowedExtensions: parseArtifactDirectChildAllowedExtensions(env),
      maxBytes: positiveInt(env.AOD_ARTIFACT_MAX_BYTES, 512 * 1024 * 1024),
      indexFile: emptyToUndefined(env.AOD_ARTIFACT_INDEX_FILE) ?? join(stateDirectory, '.agentopsdeck-artifacts.json'),
      injectCapability: env.AOD_ARTIFACT_CAPABILITY_INJECTION !== 'false',
      allowGatewayClient: env.AOD_ARTIFACT_GATEWAY_CLIENT_ENABLED !== 'false',
      urlWrappedOrigins: [...new Set([publicBaseUrl, ...allowedOrigins].filter((item): item is string => Boolean(item)))],
    },
    authRateLimit: {
      maxFailures: positiveInt(env.AOD_AUTH_MAX_FAILURES, 5),
      windowMs: positiveInt(env.AOD_AUTH_WINDOW_SECONDS, 15 * 60) * 1000,
      lockoutMs: positiveInt(env.AOD_AUTH_LOCKOUT_SECONDS, 15 * 60) * 1000,
    },
    authTrustedProxies: parseAuthTrustedProxies(env.AOD_AUTH_TRUSTED_PROXIES),
    connector: {
      environmentId: env.AOD_CONNECTOR_ENV_ID ?? 'local',
      environmentLabel: env.AOD_CONNECTOR_ENV_LABEL ?? 'Local OpenClaw',
      tokenFile: emptyToUndefined(env.AOD_CONNECTOR_TOKENS_FILE) ?? join(stateDirectory, '.agentopsdeck-connector-tokens.json'),
      usersDatabaseFile: emptyToUndefined(env.AOD_CONNECTOR_USERS_DATABASE_FILE) ?? join(stateDirectory, '.agentopsdeck-connector-users.sqlite'),
      bootstrapToken: emptyToUndefined(env.AOD_CONNECTOR_BOOTSTRAP_TOKEN) ?? emptyToUndefined(env.AOD_ACCESS_KEY),
      version: env.AOD_CONNECTOR_VERSION ?? AGENTOPSDECK_VERSION,
      revision: emptyToUndefined(env.AOD_CONNECTOR_REVISION),
      gatewayVersion: emptyToUndefined(env.OPENCLAW_GATEWAY_VERSION),
      openclawConfigFile: emptyToUndefined(env.OPENCLAW_CONFIG_FILE),
      modelAliases: parseCsv(env.AOD_OPENCLAW_MODEL_ALIASES),
      updateEnabled: env.AOD_CONNECTOR_UPDATE_ENABLED === 'true',
      updateChannel: parseUpdateChannel(env.AOD_CONNECTOR_UPDATE_CHANNEL),
      updateManifestUrl: normalizeHttpUrl(emptyToUndefined(env.AOD_CONNECTOR_UPDATE_MANIFEST_URL)),
      updateStateFile: emptyToUndefined(env.AOD_CONNECTOR_UPDATE_STATE_FILE) ?? join(stateDirectory, '.agentopsdeck-connector-update.json'),
      installRoot: emptyToUndefined(env.AOD_CONNECTOR_INSTALL_ROOT),
      currentSymlink: emptyToUndefined(env.AOD_CONNECTOR_CURRENT_SYMLINK),
    },
    hub: {
      browser: parseWorkspaceBrowserConfig(env),
      research: parseResearchConfig(env),
      // Disabled by default. Separate trusted HTTPS origin; see native draw.io hosting guide.
      drawioEditorUrl: emptyToUndefined(env.AOD_DRAWIO_EDITOR_URL),
      enabled: env.AOD_HUB_ENABLED !== 'false',
      lifecycleEndpoints: parseLifecycleEndpoints(env.AOD_HUB_LIFECYCLE_ENDPOINTS_JSON),
      allowLocalExecutionSetup: env.AOD_HUB_LOCAL_EXECUTION_SETUP === 'true',
      defaultConnectionId: env.AOD_HUB_LOCAL_CONNECTION_ID ?? 'local',
      defaultConnectionLabel: env.AOD_HUB_LOCAL_CONNECTION_LABEL ?? 'Local Connector',
      localConnectorUrl: normalizeConnectorHttpUrl(emptyToUndefined(env.AOD_HUB_LOCAL_CONNECTOR_URL)),
      localConnectorToken: emptyToUndefined(env.AOD_HUB_LOCAL_CONNECTOR_TOKEN),
      databaseFile: emptyToUndefined(env.AOD_HUB_DATABASE_FILE) ?? join(stateDirectory, '.agentopsdeck-hub.sqlite'),
      vaultSecret: emptyToUndefined(env.AOD_HUB_VAULT_SECRET) ?? emptyToUndefined(env.AOD_ACCESS_KEY),
      legacyPreferencesOwner: emptyToUndefined(env.AOD_HUB_LEGACY_PREFERENCES_OWNER),
    },
    codex: {
      boardToolsDirectory: boardToolsDirectory(env.AOD_CODEX_BOARD_TOOLS_DIR,
        [stateDirectory, emptyToUndefined(env.HOME) ?? emptyToUndefined(env.USERPROFILE) ?? homedir(),
          codexHome, env.AOD_CODEX_DEFAULT_CWD?.trim() || join(stateDirectory, 'workspace')]),
      historyCache: rolloutCachePolicyFromEnv(env),
      enabled: env.AOD_CODEX_ENABLED === 'true',
      // npm installs a PowerShell `.ps1` shim on Windows, which child_process
      // cannot execute directly. The sibling `.cmd` launcher is suitable for
      // a Node stdio child process.
      command: env.AOD_CODEX_COMMAND?.trim() || (process.platform === 'win32' ? 'codex.cmd' : 'codex'),
      homeDirectory: codexHome,
      defaultCwd: env.AOD_CODEX_DEFAULT_CWD?.trim() || join(stateDirectory, 'workspace'),
      // Empty means let the installed native runtime choose its own model.
      defaultModel: env.AOD_CODEX_DEFAULT_MODEL?.trim() || '',
      modelProvider: emptyToUndefined(env.AOD_CODEX_MODEL_PROVIDER?.trim()),
      ...(env.AOD_CODEX_ENV_PASSTHROUGH?.trim() ? { modelProviderEnvironment: parseCodexEnvPassthrough(env.AOD_CODEX_ENV_PASSTHROUGH, env) } : {}),
      toolImageCompatibility: compatUpstream ? {
        provider: env.AOD_CODEX_MODEL_PROVIDER?.trim() || '',
        upstreamBaseUrl: compatUpstream,
        ...(retryStale ? { retryStaleConnectionItems: true } : {}),
      } : undefined,
      modelChoices: parseCsv(env.AOD_CODEX_MODEL_CHOICES),
      autoCompactTokenLimit: optionalPositiveInt(env.AOD_CODEX_AUTO_COMPACT_TOKEN_LIMIT),
      disableRemoteCompaction: env.AOD_CODEX_DISABLE_REMOTE_COMPACTION === 'true',
      // The Deck is the control plane for this trusted local harness. Default
      // to no interactive Codex approval prompts; the App Server runs with
      // full filesystem access so tasks can work across local projects.
      approvalPolicy: parseCodexApprovalPolicy(env.AOD_CODEX_APPROVAL_POLICY),
      queueFile: env.AOD_CODEX_QUEUE_FILE ?? join(dirname(env.AOD_QUEUE_FILE ?? join(stateDirectory, '.agentopsdeck-queue.json')), '.agentopsdeck-codex-queue.json'),
      runtimeOverridesFile: env.AOD_CODEX_RUNTIME_OVERRIDES_FILE ?? join(dirname(env.AOD_QUEUE_FILE ?? join(stateDirectory, '.agentopsdeck-queue.json')), '.agentopsdeck-codex-runtime-overrides.json'),
    },
};
}

export function redactedConfig(config: ServerConfig) {
  return {
    port: config.port,
    listenHost: config.listenHost,
    serverRole: config.serverRole,
    gatewayWsUrl: config.gatewayWsUrl ? 'configured' : undefined,
    adminRpcUrl: config.adminRpcUrl ? 'configured' : undefined,
    ownerToken: config.ownerToken ? redact(config.ownerToken) : undefined,
    password: config.password ? redact(config.password) : undefined,
    defaultAgentId: config.defaultAgentId,
    accessKey: config.accessKey ? redact(config.accessKey) : undefined,
    sessionTitlesFile: config.sessionTitlesFile,
    sessionThinkingOverridesFile: config.sessionThinkingOverridesFile,
    passkeysFile: config.passkeysFile,
    authSessionsFile: config.authSessionsFile,
    authSqliteFile: config.authSqliteFile,
    mirrorOutboxFile: config.mirrorOutboxFile,
    queueFile: config.queueFile,
    artifactIndexFile: config.artifactIndexFile,
    localOpenClawCli: config.localOpenClawCli,
    publicBaseUrl: config.publicBaseUrl,
    allowedOrigins: config.allowedOrigins,
    gitStatusAccounts: config.gitStatusAccounts.map(({ id, label, provider, defaultRepo, repos, token }) => ({
      id,
      label,
      provider,
      authenticated: Boolean(token),
      ...(defaultRepo ? { defaultRepo } : {}),
      ...(repos ? { repos } : {}),
    })),
    mediaBridge: config.mediaBridge,
    mediaLibrary: {
      ...config.mediaLibrary,
      signingSecret: config.mediaLibrary.signingSecret ? redact(config.mediaLibrary.signingSecret) : undefined,
    },
    artifactReceiver: config.artifactReceiver,
    authRateLimit: config.authRateLimit,
    connector: {
      environmentId: config.connector.environmentId,
      environmentLabel: config.connector.environmentLabel,
      tokenFile: config.connector.tokenFile,
      bootstrapToken: config.connector.bootstrapToken ? redact(config.connector.bootstrapToken) : undefined,
      version: config.connector.version,
      revision: config.connector.revision,
      gatewayVersion: config.connector.gatewayVersion,
      openclawConfigFile: config.connector.openclawConfigFile,
      updateEnabled: config.connector.updateEnabled,
      updateChannel: config.connector.updateChannel,
      updateManifestUrl: config.connector.updateManifestUrl,
      updateStateFile: config.connector.updateStateFile,
      installRoot: config.connector.installRoot,
      currentSymlink: config.connector.currentSymlink,
    },
    hub: {
      ...config.hub,
      vaultSecret: config.hub.vaultSecret ? redact(config.hub.vaultSecret) : undefined,
      browser: config.hub.browser ? { enabled: true } : undefined,
      research: config.hub.research ? { enabled: true } : undefined,
      localConnectorToken: config.hub.localConnectorToken ? redact(config.hub.localConnectorToken) : undefined,
    },
    codex: {
      ...config.codex,
      modelProviderEnvironment: config.codex.modelProviderEnvironment
        ? Object.fromEntries(Object.keys(config.codex.modelProviderEnvironment).map(key => [key, redact(key)])) : undefined,
      toolImageCompatibility: config.codex.toolImageCompatibility
        ? {
          enabled: true,
          provider: config.codex.toolImageCompatibility.provider,
          ...(config.codex.toolImageCompatibility.retryStaleConnectionItems ? { retryStaleConnectionItems: true } : {}),
        } : undefined,
    },
  };
}

function parseServerRole(value: string | undefined): ServerRole {
  return value === 'hub' || value === 'connector' || value === 'all' ? value : 'all';
}

function parseCsv(value: string | undefined) {
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

function parseUpdateChannel(value: string | undefined): 'stable' | 'candidate' | 'manual' {
  return value === 'candidate' || value === 'manual' ? value : 'stable';
}

const FORBIDDEN_CODEX_PASSTHROUGH = /^(?:AOD_.*|LD_.*|DYLD_.*|NODE_OPTIONS|PYTHONPATH|PYTHONHOME|RUBYOPT|PERL5OPT|JAVA_TOOL_OPTIONS|BASH_ENV|ENV|SHELLOPTS|PS4|IFS|CDPATH|GLOBIGNORE|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|XDG_.*|TMPDIR|TMP|TEMP|PATH|CODEX_HOME|HERMES_HOME|OPENCLAW_.*)$/i;

function parseCodexEnvPassthrough(value: string | undefined, env: NodeJS.ProcessEnv): Readonly<Record<string, string | undefined>> | undefined {
  const names = parseCsv(value);
  if (!names.length) return undefined;
  const result: Record<string, string | undefined> = Object.create(null);
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || FORBIDDEN_CODEX_PASSTHROUGH.test(name)) {
      throw new Error(`Invalid or forbidden AOD_CODEX_ENV_PASSTHROUGH variable name: ${name}`);
    }
    const resolved = env[name];
    if (typeof resolved === 'string' && resolved.length > 0 && !/[\x00\r\n]/.test(resolved)) {
      result[name] = resolved;
    }
  }
  return Object.freeze(result);
}

function parseCodexApprovalPolicy(value: string | undefined): 'never' | 'on-request' | 'untrusted' {
  return value === 'on-request' || value === 'untrusted' ? value : 'never';
}

function parseMediaBridgeAllowedDirs(env: NodeJS.ProcessEnv) {
  const configured = env.AOD_MEDIA_BRIDGE_ALLOWED_DIRS;
  if (configured !== undefined) return parseCsv(configured);
  return [
    tmpdir(),
    join(nativeHome(env), 'media', 'outbound'),
  ];
}

export function nativeHome(env: NodeJS.ProcessEnv) {
  return emptyToUndefined(env.AOD_OPENCLAW_HOME)
    ?? join(agentOpsDeckDataDirectory(env), 'openclaw-home');
}

export function nativeFileRoots(env: NodeJS.ProcessEnv): NativeFileRoots {
  const home = resolve(nativeHome(env));
  const configured = emptyToUndefined(env.AOD_OPENCLAW_CONFIG_FILE);
  return Object.freeze({ home, configFile: configured ? resolve(configured) : join(home, 'openclaw.json'), configRequired: Boolean(configured) });
}

export function isLoopbackListenHost(host: string) {
  if (isIP(host) === 4) return host.split('.')[0] === '127';
  if (isIP(host) !== 6) return false;
  const normalized = new URL(`http://[${host}]/`).hostname;
  return normalized === '[::1]';
}

export function agentOpsDeckDataDirectory(env: NodeJS.ProcessEnv) {
  const configured = emptyToUndefined(env.AOD_DATA_DIR);
  const home = emptyToUndefined(env.HOME) ?? emptyToUndefined(env.USERPROFILE) ?? homedir();
  const directory = configured ?? join(emptyToUndefined(env.XDG_DATA_HOME) ?? (process.platform === 'win32'
    ? emptyToUndefined(env.LOCALAPPDATA) ?? join(home, 'AppData', 'Local') : join(home, '.local', 'share')), 'agentopsdeck');
  if (!isAbsolute(directory) || /[\x00-\x1f\x7f]/.test(directory) || dirname(resolve(directory)) === resolve(directory)) {
    throw new Error('AOD_DATA_DIR must resolve to an absolute, non-root path');
  }
  return directory;
}

function parseArtifactAllowedDirs(env: NodeJS.ProcessEnv) {
  const configured = env.AOD_ARTIFACT_ALLOWED_DIRS;
  if (configured !== undefined) return parseCsv(configured);
  const mediaLibraryDirs = parseCsv(emptyToUndefined(env.AOD_MEDIA_LIBRARY_DIRS));
  const openclawRoot = nativeHome(env);
  const workspaceDirs = openclawRoot && existsSync(openclawRoot)
    ? readdirSync(openclawRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('workspace'))
      .map((entry) => join(openclawRoot, entry.name))
    : [];
  return [
    tmpdir(),
    process.cwd(),
    join(openclawRoot, 'media'),
    ...workspaceDirs,
    ...mediaLibraryDirs,
  ];
}

function parseArtifactAllowedDirectChildDirs(env: NodeJS.ProcessEnv) {
  const configured = env.AOD_ARTIFACT_ALLOWED_DIRECT_CHILD_DIRS;
  if (configured !== undefined) return parseCsv(configured);
  // A configured recursive allowlist is a complete boundary, not an addition
  // to an implicit native-home grant. Unset legacy deployments retain defaults.
  if (env.AOD_ARTIFACT_ALLOWED_DIRS !== undefined) return [];
  return [nativeHome(env)];
}

function parseArtifactDirectChildAllowedExtensions(env: NodeJS.ProcessEnv) {
  const configured = emptyToUndefined(env.AOD_ARTIFACT_DIRECT_CHILD_ALLOWED_EXTENSIONS);
  const value = configured ?? '.xlsx,.xls,.csv,.tsv,.pdf,.docx,.pptx,.zip,.tar,.tgz,.gz,.png,.jpg,.jpeg,.webp';
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function normalizePublicBaseUrl(value: string | undefined) {
  return normalizeHttpUrl(value);
}

function normalizeConnectorHttpUrl(value: string | undefined) {
  return normalizeHttpUrl(value);
}

function normalizeHttpUrl(value: string | undefined) {
  if (!value) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function redact(_value: string) {
  return '***';
}

function loadDotEnvDefaults(env: NodeJS.ProcessEnv) {
  for (const file of dotEnvCandidates(process.cwd())) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
      if (!match) continue;
      const key = match[1];
      const rawValue = match[2];
      if (!key || rawValue === undefined) continue;
      if (env[key] !== undefined) continue;
      env[key] = stripEnvQuotes(rawValue.trim());
    }
    return;
  }
}

function dotEnvCandidates(start: string) {
  const configured = process.env.AOD_CONFIG_FILE;
  if (configured) {
    if (!isAbsolute(configured) || /[\x00-\x1f\x7f]/.test(configured)) throw new Error('AOD_CONFIG_FILE must be an absolute path');
    if (!existsSync(configured)) throw new Error('AOD_CONFIG_FILE does not exist');
    return [configured];
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  return [...new Set([join(root, '.env')])];
}

function stripEnvQuotes(value: string) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
