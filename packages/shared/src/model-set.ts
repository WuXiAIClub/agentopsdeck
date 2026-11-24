export const AOD_MODEL_SET_ID = 'agentopsdeck-model-set-v1' as const;

export const AOD_MODEL_SET_V1: readonly { alias: string }[] = Object.freeze([]);

/** Models exposed by the in-process Codex App Server (no provider prefix). */
export const AOD_CODEX_MODEL_SET_V1: readonly { alias: string }[] = Object.freeze([]);

export const AOD_CODEX_DEFAULT_MODEL = '' as const;

export type AgentOpsDeckModelSetId = typeof AOD_MODEL_SET_ID;
export type AgentOpsDeckModelAlias = typeof AOD_MODEL_SET_V1[number]['alias'];

export type GatewayModelSetStatus = {
  setId: AgentOpsDeckModelSetId;
  desired: Array<{ alias: string }>;
  observed: Array<{ alias: string; provider?: string; available?: boolean }>;
  missing: string[];
  extra?: string[];
  converged: boolean;
  source: 'gateway.status' | 'gateway.admin' | 'openclaw.config' | 'unknown';
  gatewayVersion?: string | undefined;
  compatible: boolean;
  updatedAt: number;
  error?: string | undefined;
  restartRequired?: boolean;
};

export type ConnectorUpdateStatus = {
  supported: boolean;
  currentVersion: string;
  currentRevision?: string | undefined;
  channel?: 'stable' | 'candidate' | 'manual';
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'installing' | 'restarting' | 'succeeded' | 'failed' | 'rolled_back';
  targetVersion?: string;
  targetRevision?: string | undefined;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastError?: string | undefined;
  rollbackAvailable: boolean;
  updatedAt: number;
  restartRequired?: boolean;
  manifestSha256?: string;
};

export type ConnectorCapabilities = {
  protocol?: import('./protocol.js').ProtocolRange;
  limits?: { maxMessageChars?: number; maxRequestsPerMinute?: number; maxSseConnections?: number };
  connector: { service: 'aod-connector'; version: string; revision?: string | undefined; build?: { revision: string; dirty: boolean } };
  environment: { idHint?: string | undefined; label?: string | undefined };
  features: Record<string, boolean>;
  /** Optional per-runtime restrictions; absent on older Connectors. */
  runtimes?: Record<string, { enabled: boolean; ready: boolean; status?: import('./index.js').AgentReadiness; ownerOnly: boolean; features: Record<string, boolean> }>;
  scopes: string[];
  gateway: {
    statusVisible: boolean;
    opsAllowed: boolean;
    version?: string | undefined;
    modelSet?: GatewayModelSetStatus;
  };
  update: ConnectorUpdateStatus;
};

export function isAgentOpsDeckModelSetId(value: unknown): value is AgentOpsDeckModelSetId {
  return value === AOD_MODEL_SET_ID;
}

export function canonicalModelAliases() {
  return AOD_MODEL_SET_V1.map((model) => model.alias);
}
