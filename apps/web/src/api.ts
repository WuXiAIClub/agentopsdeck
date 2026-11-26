import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import type { ConnectionControlTarget } from './lib/connection-control-recovery.js';
import { parseHubAccountAccess, type HubAccountAccess } from './lib/hub-user-access.js';
import { parseSessionRevocation } from './lib/session-revocation.js';
import { HISTORY_ASYNC_HEADER, isHistoryPending } from '@agentopsdeck/shared';
import { readGoalControlSnapshot, type GoalControl } from '@agentopsdeck/shared';
import { retryAfterMilliseconds } from './lib/retry-after.js';
import { validateSessionSkills, validateNativeTokenUsage, validateNativeTokenUsageExport, tokenSnapshotSelection, tokenSnapshotRequestId, validateNativeTokenSnapshot } from '@agentopsdeck/shared';
import { readInteractionSnapshot, readInteractionView, type InteractionMode, type InteractionSubmission } from '@agentopsdeck/shared';
import { createInteractionReads } from './lib/session-interactions.js';
import { createHistoryReadCoalescer, HistoryPreparing, readPreparedHistory } from './lib/history-preparation.js';
import type { HistoryReadSchedule } from './lib/history-read-scheduler.js';
import type {
  WorkspacePreferences,
  AgentSummary,
  ChatMessage,
  DeckEvent,
  CompactSessionResponse,
  CreateSessionResponse,
  FileBrowserListResponse,
  FileBrowserPreviewResponse,
  FileBrowserRoot,
  GatewayHealth,
  SendDeliveryMode,
  SendMessageResponse,
  CommandReceipt,
  SessionSettingsResult,
  QueuedMessagePage,
  SharedQueuedCommandPage,
  SharedGrantPage,
  NodeGrantPolicy,
  SharedSessionDirectoryPage,
  SharedSessionAccessHints,
  SessionExecutionSnapshot,
  SendMessageUpload,
  SessionSummary,
  SessionsState,
  ConnectorCapabilities,
  SessionFilePage,
  ConnectorUpdateStatus,
  GatewayModelSetStatus,
  MediaLibraryListResponse,
} from '@agentopsdeck/shared';
import { createFreshRead, createInFlightCoalescer } from './lib/refresh-control.js';
import { resolveApiBaseUrl } from './lib/api-base.js';
import { configuredResourceOrigins, routeResourceUrl } from './lib/resource-url.js';
import { isSourceMediaUrl, isSourcePreview, sourceFailure } from './lib/source-preview.js';
import { sourcePreviewCache } from './lib/source-preview-cache.js';
import { sessionPreviewCache, previewKey } from './lib/session-preview-cache.js';
import { createNavigationHistory } from './lib/navigation-history.js';
import { createSessionReadVersions } from './lib/session-read-versions.js';
import { createWorkspaceSyncTransport } from './lib/workspace-sync-transport.js';
import { workspaceSyncPreference, setWorkspaceSyncScope, markWorkspaceSyncUnavailable, subscribeWorkspaceSyncPreference } from './lib/workspace-sync-preference.js';
import { createConditionalHistoryCache, restoreConditionalHistory, restoreHistoryDelta, HISTORY_DELTA_HEADER } from './lib/conditional-history.js';
import { CommandRejectedError, creationPath, maintenancePath, newCommandKey, type CreationTarget, type MaintenanceTarget } from './lib/command-recovery.js';
import { readConnectorAdmissionStatus } from './lib/maintenance-controls.js';
import { lifecyclePath, type LifecycleTarget } from './lib/command-recovery.js';
import type { ConnectorLifecycleReceipt, ConnectorLifecycleStatus } from '@agentopsdeck/shared';
import type { SessionListSnapshot } from './lib/session-snapshot.js';
import { ownerSessionPath, queueMutationPath, sessionAddress, sessionMessagePayload, sharedGrantSessionsPath, type SharedGrantTarget, type SessionTarget } from './lib/session-address.js';
import { validateSessionFileRebuild, type SessionFileRebuild } from '@agentopsdeck/shared';
import { browserDiagnostics } from './lib/browser-diagnostics.js';
import { classifyRequestPriority, requestGovernor } from './lib/request-governor.js';

// ---------------------------------------------------------------------------
// Hub Connection types (frontend-only; server uses the full HubConnection from
// hub-store, but the public API surface is a subset without credentials).
// ---------------------------------------------------------------------------
export type HubConnectionStatus = 'enabled' | 'disabled' | 'degraded';
export type HubPrincipal = { userId: string; admin: boolean };
export type HubRoleState = { role: 'member' | 'admin'; version: number };
export type ConnectorRole = 'none' | 'admin' | 'developer' | 'observer';
export type EnvironmentMode = 'disabled' | 'developer' | 'observer';
export type AccessConnection = { id: string; ownerUserId: string; label: string; nodeVersion: number; verified: boolean; creationReady: boolean; appointAdministrators: boolean; owner: boolean };
export type AccessDirectory = { administrator: boolean; connections: AccessConnection[]; users: HubUser[] };
export type ConnectorMembership = { role: ConnectorRole; version: number; nodeVersion: number; editable: boolean; environments: { codex: EnvironmentMode; openclaw: 'disabled' | 'observer' }; legacyCount: number; legacyBroad: number; inherited: 'hub-admin' | 'owner' | null; grantSetDigest?: string };
function membershipPath(connection: AccessConnection, userId: string) {
  return `/api/hub/v1/access/${encodeURIComponent(connection.ownerUserId)}/connections/${encodeURIComponent(connection.id)}/members/${encodeURIComponent(userId)}`;
}
export type HubLoginKey = { id: string; createdAt: number; lastLoginAt?: number | null; lastUsedAt?: number | null; lastActiveAt?: number | null; loginCount?: number };
export type HubNodeGrant = { id: string; userId: string; version: number; nodeVersion: number; revoked: boolean; policy: NodeGrantPolicy; derived?: boolean };
export type HubNodeGrantPage = { nodeVersion: number; verified: boolean; executionConfigured: boolean; creationConfigured?: boolean; grants: HubNodeGrant[]; nextCursor: string | null };
export type SharedCreationEnvironment = { ownerUserId: string; connectionId: string; label: string; kind: 'local' | 'remote'; status: HubConnection['status'] };
export type HubExecutionIssuer = { hubId: string; localSetupAllowed: boolean; issuer: { issuerId: string; nodeId: string; version: number; creationAllowed?: boolean } | null };
export type HubConnectionKind = 'local' | 'remote';

export type HubConnection = {
  id: string;
  nodeId?: string;
  ownerUserId?: string;
  ownerUserLabel?: string;
  kind: HubConnectionKind;
  label: string;
  connectorUrl?: string;
  status: HubConnectionStatus;
  environmentId?: string;
  environmentLabel?: string;
  capabilities?: string[];
  /** True when a credential token has been stored server-side (never the token itself). */
  hasCredential?: boolean;
  createdAt?: number;
  updatedAt?: number;
  /** Only present when status is degraded — last error message from polling/fanin. */
  error?: string;
};

export type HubInfo = {
  service: string;
  version: string;
  build?: { revision: string; dirty: boolean };
  mode: string;
  features: Record<string, boolean>;
};

export type HubUser = {
  id: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  usage?: { lastLoginAt: number | null; lastActiveAt: number | null };
};

export type ConnectorUser = {
  id: string;
  label: string;
  createdAt: number;
  updatedAt: number;
};

export type ConnectorUsersByConnection = HubConnection & {
  supported: boolean;
  users: ConnectorUser[];
  userCount: number;
  error?: string;
};

export type HubConnectionTestResult = {
  ok: boolean;
  connectorUrl?: string;
  connector?: unknown;
  health?: unknown;
  error?: string;
  updatedAt: number;
};

/** Extended SessionsState that includes Hub connection list when returned by /api/hub/v1/sessions/state */
export type HubSessionsState = SessionListSnapshot & {
  connections?: HubConnection[];
  hiddenCount?: number;
  archivedCount?: number;
  pinnedCount?: number;
};

export type HubDeckEvent = DeckEvent & { envConnectionId?: string; remoteEventId?: string };

const ACCESS_KEY_STORAGE = 'agentopsdeck.accessKey';
const API_BASE_URL_STORAGE = 'agentopsdeck.apiBaseUrl';
const DEFAULT_TIMEOUT_MS = 25_000;
const LONG_TIMEOUT_MS = 45_000;
const readRequestCoalescer = createInFlightCoalescer<string>();
const historyReads = createHistoryReadCoalescer();
const conditionalHistoryCache = createConditionalHistoryCache();
const workspaceSyncTransport = createWorkspaceSyncTransport({
  enabled: () => workspaceSyncPreference().enabled && !workspaceSyncPreference().unavailable,
  unsupported: markWorkspaceSyncUnavailable, fetch: (input, init) => fetch(input, init),
});
export const workspaceSyncMetrics = workspaceSyncTransport.metrics;
// Stable minute-scale calibration, independent from the optional Preview
// transport. Only cached latest windows participate; changed windows are fetched
// through their normal route. A missing endpoint falls back without changing
// the user's Preview preference.
let calibrationUnavailable = false;
const historyCalibrationTransport = createWorkspaceSyncTransport({
  enabled: () => !calibrationUnavailable,
  unsupported: () => { calibrationUnavailable = true; }, fetch: (...args) => fetch(...args),
});
export const historyCalibrationMetrics = historyCalibrationTransport.metrics;
type MessagePage = { messages: ChatMessage[]; totalCount?: number; hiddenCount?: number; updatedAt: number; revision?: string; sourceCursor?: string; historyStatus?: import('@agentopsdeck/shared').SessionHistoryStatus; limits?: { maxMessageChars: number }; access?: SharedSessionAccessHints };
const navigationHistory = createNavigationHistory<MessagePage>();
const sessionReadVersions = createSessionReadVersions();
const conditionalBaseVersions = createSessionReadVersions();
const historyVersion = (path: string) => sessionReadVersions.capture(path.split('/messages?')[0]!);
const conditionalBaseVersion = (path: string) => conditionalBaseVersions.capture(path.split('/messages?')[0]!);
const historyRequestKey = (path: string) => `${requestKey(path)} history:${historyVersion(path).revision}`;
export const invalidateNavigationHistory = navigationHistory.clear;
let snapshotGeneration = 0;
let metadataGeneration = 0;
const readAgents = createFreshRead<{ agents: AgentSummary[]; updatedAt: number }>();
const readGateway = createFreshRead<GatewayHealth>();
let forbiddenAgentsScopeKey: string | undefined;
let forbiddenGatewayScopeKey: string | undefined;
const FORBIDDEN_LOCAL_RUNTIME_STORAGE_PREFIX = 'agentopsdeck.forbidden-local-runtime.';
function isLocalRuntimeForbiddenInStorage(kind: 'agents' | 'gateway'): boolean {
  if (!activeRecoveryScope || typeof window === 'undefined') return false;
  try { return window.sessionStorage?.getItem(`${FORBIDDEN_LOCAL_RUNTIME_STORAGE_PREFIX}${kind}.${activeRecoveryScope}`) === '1'; } catch { return false; }
}
function markLocalRuntimeForbiddenInStorage(kind: 'agents' | 'gateway') {
  if (!activeRecoveryScope || typeof window === 'undefined') return;
  try { window.sessionStorage?.setItem(`${FORBIDDEN_LOCAL_RUNTIME_STORAGE_PREFIX}${kind}.${activeRecoveryScope}`, '1'); } catch {}
}
export function invalidateMetadataReads() { metadataGeneration += 1; }
// Reads after a stream reset or settings confirmation must not join an older body.
export function invalidateSnapshotReads() { snapshotGeneration += 1; sessionReadVersions.clear(); conditionalBaseVersions.clear(); workspaceSyncTransport.reset(false); historyCalibrationTransport.reset(false); conditionalHistoryCache.clear(); navigationHistory.clear(); }
/** Admission changes only this transcript. Never cancel another session's
 * batch/calibration jobs or invalidate the shared owner event connection. Old
 * revision cache entries remain bounded and cannot be reused by new reads. */
export function invalidateSessionSnapshotReads(target: SessionTarget) {
  const path = sessionAddress(target).path;
  sessionReadVersions.invalidate(path);
  conditionalBaseVersions.invalidate(path);
  navigationHistory.clear(key => sessionAddress(key).path === path);
}
/** This feed belongs to the current OWNER catalog. A connection ID is scoped
 * to that owner; a shared resource can have the same ID under another owner.
 * Exact shared feeds own their own catch-up, including the first read before
 * access hints allow that feed to start. Never strand it on an owner reset. */
export function invalidateStreamSnapshotReads(event: Pick<HubDeckEvent, 'envConnectionId'>) {
  const prefix = event.envConnectionId ? `${event.envConnectionId}:` : undefined;
  sessionReadVersions.invalidateMatching(path => {
    const match = /^\/api\/hub\/v1\/sessions\/([^/]+)$/.exec(path);
    return !!match && (!prefix || decodeURIComponent(match[1]!).startsWith(prefix));
  });
  navigationHistory.clear(key => {
    const address = sessionAddress(key);
    return !address.shared && (!prefix || address.key.startsWith(prefix));
  });
  // New metadata reads must not join a snapshot predating upstream catch-up;
  // already-running history reads on other Connectors stay valid.
  invalidateMetadataReads();
}
let previousWorkspaceSyncEnabled = workspaceSyncPreference().enabled;
subscribeWorkspaceSyncPreference(() => {
  const enabled = workspaceSyncPreference().enabled;
  if (enabled === previousWorkspaceSyncEnabled) return;
  previousWorkspaceSyncEnabled = enabled;
  // Switching transport must release old in-flight coalesced reads as well.
  // Unsupported-Hub fallback only changes `unavailable`, not this preference.
  invalidateSnapshotReads();
});
let activeRecoveryScope: string | undefined;
const bindingReads = createHistoryReadCoalescer();
let recoveryGeneration = 0;
const recoveryListeners = new Set<() => void>();
export function subscribeRecoveryScope(listener: () => void) {
  recoveryListeners.add(listener);
  return () => { recoveryListeners.delete(listener); };
}
export function setRecoveryScope(scope: string | undefined) {
  const next = scope && /^[a-f0-9]{64}$/.test(scope) ? scope : undefined;
  const changed = activeRecoveryScope !== next;
  if (changed) { workspaceSyncTransport.reset(); historyCalibrationTransport.reset(); calibrationUnavailable = false; }
  setWorkspaceSyncScope(next);
  if (changed) { recoveryGeneration += 1; forbiddenAgentsScopeKey = undefined; forbiddenGatewayScopeKey = undefined; browserDiagnostics.clear(); sessionReadVersions.clear(); conditionalBaseVersions.clear(); sessionPreviewCache.clear(); conditionalHistoryCache.clear(); navigationHistory.clear(); }
  if (activeRecoveryScope && activeRecoveryScope !== next) sourcePreviewCache.clear();
  activeRecoveryScope = next;
  if (changed) recoveryListeners.forEach(listener => listener());
}
export function recoveryScope() { return activeRecoveryScope; }
export function recoveryEpoch() { return recoveryGeneration; }

export class AuthRequiredError extends Error {
  constructor(message = 'AgentOpsDeck access key required') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export class ApiResponseError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs?: number) { super(message); this.name = 'ApiResponseError'; }
}

async function readJson<T>(path: string, init?: RequestInit & { timeoutMs?: number; conditionalHistory?: boolean; calibration?: boolean; itemPriority?: number }, snapshot = false): Promise<T> {
  // A lifecycle-owned abort must not cancel another consumer's coalesced GET,
  // or make a newly mounted consumer inherit an already aborted request.
  if (init?.signal) return json<T>(path, init);
  return readRequestCoalescer.run(`${requestKey(path, init)}${snapshot ? ` snapshot:${snapshotGeneration}:${metadataGeneration}` : ''}`, () => json<T>(path, init));
}

/** One owner through headers AND body. Cancellation never authorizes replay.
 * In particular, an old account's late 401 cannot log out a new account. */
async function rawResponse<T>(path: string, consume: (response: Response, current: () => void) => Promise<T>, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const epoch = recoveryGeneration, started = Date.now(), endGovernor = requestGovernor.beginRequest();
  let serverTimingHeader: string | null = null;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), init?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const { timeoutMs: _timeoutMs, signal: callerSignal, ...requestInit } = init ?? {};
  const abort = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener('abort', abort, { once: true });
  if (callerSignal?.aborted) abort();
  let status: number | undefined, completed = false;
  const current = () => {
    if (epoch !== recoveryGeneration) throw new AuthRequiredError('Authenticated account changed');
    callerSignal?.throwIfAborted();
    if (controller.signal.aborted) throw new Error('Request timed out. The backend will keep running; refresh in a moment.');
  };
  try {
    current();
    const response = await fetch(apiUrl(path), {
      ...requestInit,
      signal: controller.signal,
      credentials: requestInit.credentials ?? 'include',
      ...(requestInit.headers ? { headers: requestInit.headers } : {}),
    });
    status = response.status;
    serverTimingHeader = response.headers.get('server-timing');
    current();
    const value = await consume(response, current);
    current(); completed = true;
    return value;
  } catch (error) {
    current();
    throw error;
  } finally {
    window.clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', abort);
    endGovernor();
    const elapsedMs = Date.now() - started;
    if (epoch === recoveryGeneration) {
      requestGovernor.record({ path, method: init?.method ?? 'GET', status, elapsedMs, cancelled: Boolean(callerSignal?.aborted), timedOut: Boolean(!callerSignal?.aborted && controller.signal.aborted), serverTiming: serverTimingHeader });
      browserDiagnostics.record(callerSignal?.aborted ? 'request-cancelled'
      : controller.signal.aborted ? 'request-timeout' : status && status >= 400 ? 'request-http'
      : completed ? 'request-ok' : 'request-failed', { status, elapsedMs,
        mutation: !['GET', 'HEAD'].includes((init?.method ?? 'GET').toUpperCase()) });
    }
  }
}

export async function json<T>(path: string, init?: RequestInit & { timeoutMs?: number; conditionalHistory?: boolean; calibration?: boolean; itemPriority?: number }): Promise<T> {
  const started = Date.now();
  const endGovernor = requestGovernor.beginRequest();
  const scope = activeRecoveryScope;
  const epoch = recoveryGeneration;
  const scoped = path !== '/api/hub/v1/me' && (path.startsWith('/api/hub/v1/') || path.startsWith('/api/sessions/'));
  const passkeyManagement = path === '/api/auth/passkeys' || (path.startsWith('/api/auth/passkeys/') && !path.startsWith('/api/auth/passkeys/login/'));
  const accountBound = scoped || passkeyManagement || path.startsWith('/api/files/') || path === '/api/media-library' || path.startsWith('/api/media-library?');
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), init?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const { timeoutMs: _timeoutMs, signal: callerSignal, conditionalHistory, calibration, itemPriority, ...requestInit } = init ?? {};
  const normalizedPriority = itemPriority !== undefined && Number.isFinite(itemPriority) ? Math.max(-10, Math.min(20, Math.trunc(itemPriority))) : undefined;
  const snapshotEpoch = snapshotGeneration;
  const version = conditionalHistory ? historyVersion(path) : undefined;
  const baseVersion = conditionalHistory ? conditionalBaseVersion(path) : undefined;
  const historyKey = conditionalHistory && scope ? `${requestKey(path, init)} base:${baseVersion!.revision}` : undefined;
  const previousHistory = historyKey ? conditionalHistoryCache.get(historyKey) : undefined;
  const abort = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener('abort', abort, { once: true });
  if (callerSignal?.aborted) abort();
  let response: Response | undefined;
  let invalidFormat = false;
  let bodyComplete = false;
  let body: any;
  try {
    callerSignal?.throwIfAborted();
    const fetchInit: RequestInit = {
      ...requestInit,
      signal: controller.signal,
      credentials: 'include',
      headers: { 'content-type': 'application/json', ...(scoped && scope ? { 'x-agentopsdeck-recovery-scope': scope } : {}),
        ...(historyKey ? { [HISTORY_DELTA_HEADER]: '1' } : {}),
        ...(previousHistory ? { 'if-none-match': previousHistory.etag } : {}), ...(requestInit.headers ?? {}) },
    };
    // Only owned latest chat windows participate. Shared grant routes, history
    // pagination and hover previews retain their existing authorization/lifecycle.
    const match = conditionalHistory && scope && workspaceSyncPreference().enabled && !workspaceSyncPreference().unavailable
      ? /^\/api\/hub\/v1\/sessions\/([^/]+)\/messages\?limit=(\d+)$/.exec(path) : null;
    const check = calibration && scope && previousHistory && !calibrationUnavailable
      ? /^\/api\/hub\/v1\/sessions\/([^/]+)\/messages\?limit=(\d+)$/.exec(path) : null;
    if (check && Number(check[2]) > 8 && Number(check[2]) <= 500) {
      response = await historyCalibrationTransport.read({ sessionKey: decodeURIComponent(check[1]!), limit: Number(check[2]), etag: previousHistory!.etag, ...(normalizedPriority !== undefined ? { priority: normalizedPriority } : {}) },
        { group: `${apiUrl('/api/hub/v1/workspace/check')}:${scope}:${epoch}:${snapshotEpoch}`, url: apiUrl('/api/hub/v1/workspace/check'),
          headers: { 'x-agentopsdeck-recovery-scope': scope!, [HISTORY_ASYNC_HEADER]: '1' }, signal: controller.signal, legacy: () => fetch(apiUrl(path), fetchInit) });
      // Only the metadata endpoint marks a changed window. Do not clone/parse a
      // potentially large transcript returned by an older Hub's legacy fallback.
      if (response.status === 200 && response.headers.get('x-agentopsdeck-history-check') === 'changed') {
        void response.body?.cancel().catch(() => {});
        if (epoch !== recoveryEpoch() || snapshotEpoch !== snapshotGeneration || !version?.valid) throw new DOMException('History calibration scope changed', 'AbortError');
        response = await fetch(apiUrl(path), fetchInit);
      }
    } else response = match && Number(match[2]) > 8 && Number(match[2]) <= 500
      ? await workspaceSyncTransport.read({ sessionKey: decodeURIComponent(match[1]!), limit: Number(match[2]), ...(previousHistory ? { etag: previousHistory.etag } : {}), ...(normalizedPriority !== undefined ? { priority: normalizedPriority } : {}) },
        { group: `${apiUrl('/api/hub/v1/workspace/sync')}:${scope}:${epoch}:${snapshotEpoch}`,
          url: apiUrl('/api/hub/v1/workspace/sync'), headers: { 'x-agentopsdeck-recovery-scope': scope!, [HISTORY_ASYNC_HEADER]: '1' }, signal: controller.signal,
          legacy: () => fetch(apiUrl(path), fetchInit) })
      : await fetch(apiUrl(path), fetchInit);
    if (accountBound && epoch !== recoveryGeneration) throw new AuthRequiredError('Authenticated account changed');
    // Keep the deadline and caller cancellation active through the response
    // body, not just response headers (receipt streams can stall after headers).
    body = response.status === 304 && conditionalHistory
      ? restoreConditionalHistory(previousHistory, response.headers.get('etag'), response.headers.get('x-agentopsdeck-history-meta'))
      : response.status === 204 ? undefined : await response.json().catch(() => {
        if (response!.ok) { invalidFormat = true; throw new ApiResponseError('Invalid JSON response. Check the original operation before retrying.', 502); }
        return {};
      });
    if (!response.ok && (!body || typeof body !== 'object')) body = {};
    if (response.ok && conditionalHistory && response.headers.get(HISTORY_DELTA_HEADER) === '1')
      body = restoreHistoryDelta(previousHistory, body);
    if (response.status === 202 && conditionalHistory && !isHistoryPending(body)) {
      invalidFormat = true;
      throw new ApiResponseError('Invalid history preparation response', 502);
    }
    if (controller.signal.aborted) throw controller.signal.reason;
    bodyComplete = true;
  } catch (error) {
    // A pane/transport cancellation is not a network timeout and must not
    // invalidate another reader's last verified conditional base.
    if (accountBound && epoch !== recoveryGeneration) throw new AuthRequiredError('Authenticated account changed');
    if (callerSignal?.aborted) throw callerSignal.reason;
    if (historyKey) conditionalHistoryCache.remove(historyKey);
    if (controller.signal.aborted) throw new Error('Request timed out. The backend will keep running; refresh in a moment.');
    throw error;
  } finally {
    window.clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', abort);
    endGovernor();
    const elapsedMs = Date.now() - started;
    if (epoch === recoveryGeneration) {
      requestGovernor.record({
        path,
        method: init?.method ?? 'GET',
        status: response?.status,
        elapsedMs,
        priority: classifyRequestPriority(path, init?.method ?? 'GET', { calibration, conditionalHistory }),
        cancelled: Boolean(callerSignal?.aborted),
        timedOut: Boolean(!callerSignal?.aborted && controller.signal.aborted),
        serverTiming: response?.headers.get('server-timing'),
      });
      browserDiagnostics.record(callerSignal?.aborted ? 'request-cancelled'
      : controller.signal.aborted ? 'request-timeout' : invalidFormat ? 'request-format'
      : response && response.status >= 400 ? 'request-http' : bodyComplete ? 'request-ok' : 'request-failed',
      { status: response?.status, elapsedMs,
        mutation: !['GET', 'HEAD'].includes((init?.method ?? 'GET').toUpperCase()) });
    }
  }
  if (accountBound && epoch !== recoveryGeneration) throw new AuthRequiredError('Authenticated account changed');
  if (response.status === 202 && conditionalHistory) {
    throw new HistoryPreparing(body.retryAfterMs);
  }
  if (historyKey && !response.ok && response.status !== 304) conditionalHistoryCache.remove(historyKey);
  if (response.status === 409 && body.error === 'Authenticated account or Hub changed; reload before continuing') {
    window.dispatchEvent(new CustomEvent('agentopsdeck:auth-required'));
    throw new AuthRequiredError(body.error);
  }
  if (response.status === 401) {
    window.dispatchEvent(new CustomEvent('agentopsdeck:auth-required'));
    throw new AuthRequiredError(body.error ?? 'unauthorized');
  }
  if (version && !version.valid) throw new DOMException('Session history changed', 'AbortError');
  if (!response.ok && !(response.status === 304 && conditionalHistory)) {
    if (historyKey) conditionalHistoryCache.remove(historyKey);
    if (body.command?.state === 'rejected') throw new CommandRejectedError(body.error ?? response.statusText);
    throw new ApiResponseError(body.error ?? response.statusText, response.status, retryAfterMilliseconds(response.headers.get('retry-after')));
  }
  if (historyKey && response.status !== 304 && snapshotEpoch === snapshotGeneration && baseVersion?.valid) conditionalHistoryCache.put(historyKey, response.headers.get('etag'), body);
  return body as T;
}

function requestKey(path: string, init?: RequestInit & { timeoutMs?: number }) {
  const method = String(init?.method ?? 'GET').toUpperCase();
  return `${method} ${apiUrl(path)} ${activeRecoveryScope ?? ''} ${recoveryGeneration}`;
}

export function apiUrl(path: string) {
  const base = apiBaseUrl();
  if (/^(?:https?:\/\/|\/\/)/i.test(path)) return routeResourceUrl(path, base || window.location.origin, [window.location.origin, ...configuredResourceOrigins]);
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return path;
  if (!base) return path;
  const normalizedBase = base.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (normalizedBase.endsWith('/api') && normalizedPath.startsWith('/api/')) {
    return `${normalizedBase}${normalizedPath.slice('/api'.length)}`;
  }
  return `${normalizedBase}${normalizedPath}`;
}

export function apiBaseUrl() {
  return resolveApiBaseUrl(window.location, window.localStorage.getItem(API_BASE_URL_STORAGE),
    (window as Window & { __AGENTOPSDECK_API_BASE_URL__?: unknown }).__AGENTOPSDECK_API_BASE_URL__);
}

export function setApiBaseUrl(value: string | undefined) {
  const trimmed = value?.trim();
  if (trimmed) window.localStorage.setItem(API_BASE_URL_STORAGE, trimmed);
  else window.localStorage.removeItem(API_BASE_URL_STORAGE);
}

export function forgetStoredAccessKey() {
  window.localStorage.removeItem(ACCESS_KEY_STORAGE);
}

export function mediaUrl(url: string) {
  return apiUrl(url);
}

export async function downloadMediaUrl(url: string) {
  const routed = mediaUrl(url);
  const serviceOrigin = new URL(apiBaseUrl() || window.location.origin).origin;
  const credentials = new URL(routed, window.location.href).origin === serviceOrigin ? 'include' : 'omit';
  return rawResponse(routed, async response => {
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent('agentopsdeck:auth-required'));
      throw new AuthRequiredError('unauthorized');
    }
    if (!response.ok) {
      const body = await response.json().catch(async () => ({ error: await response.text().catch(() => response.statusText) }));
      throw new Error(body?.error || response.statusText || `Download failed (${response.status})`);
    }
    return response.blob();
  }, { timeoutMs: LONG_TIMEOUT_MS, credentials });
}

export async function sourcePreviewUrl(url: string, signal: AbortSignal) {
  return readSourcePreviewResponse(url, signal);
}

async function readSourcePreviewResponse(url: string, signal: AbortSignal) {
  if (!isSourceMediaUrl(url)) throw new Error('Source preview is unavailable for this reference.');
  return rawResponse(url, async response => {
    if (response.status === 401 || response.status === 403) throw new Error('You no longer have permission to preview this source.');
    if (response.status === 404) throw sourceFailure(response.headers.get('x-agentopsdeck-source-error'), response.headers.get('x-agentopsdeck-source-approval'));
    if (!response.ok) throw new Error('Source preview could not be loaded. Please try again.');
    // The Connector bounds snippets, but a remote Connector is still untrusted input.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty source preview.');
    let size = 0; const chunks: Uint8Array[] = [];
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength;
        if (size > 640 * 1024) throw new Error('Source preview is too large.'); chunks.push(value); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isSourcePreview(value)) throw new Error('Invalid source preview.');
    return value;
  }, { signal, timeoutMs: 15_000 });
}

export async function sourcePreviewApproval(url: string, approve: boolean) {
  if (!isSourceMediaUrl(url) || url.includes('/shared/')) throw new Error('Source approval requires the Connector owner.');
  const result = await json<{ ok: boolean }>(`${url}/approval`, { method: approve ? 'POST' : 'DELETE' });
  if (result?.ok !== true) throw new Error('Source approval was not confirmed.');
  // Exact-file approval/revocation can affect multiple references. Never leave
  // an older authorized snippet alive in another card after revocation.
  sourcePreviewCache.clear();
}

export function eventStreamUrl(target?: SessionTarget) {
  const query = activeRecoveryScope ? `?recoveryScope=${encodeURIComponent(activeRecoveryScope)}` : '';
  const address = target === undefined ? undefined : sessionAddress(target);
  // Owner sessions share the account feed; delegated reads use a precise feed.
  return apiUrl(`${address?.shared ? address.path : '/api/hub/v1'}/events/stream${query}`);
}

export type FileRequestScope = { type: 'gateway' } | { type: 'agent'; agentId: string; connectionId?: string };
function fileScopePath(scope: FileRequestScope) {
  if (scope.type === 'agent' && scope.connectionId) return `/api/hub/v1/connections/${encodeURIComponent(scope.connectionId)}/files/agents/${encodeURIComponent(scope.agentId)}`;
  return scope.type === 'gateway' ? '/api/files/gateway' : `/api/files/agents/${encodeURIComponent(scope.agentId)}`;
}

function fileQuery(path: string, inline = false) {
  const params = new URLSearchParams({ path });
  if (inline) params.set('inline', '1');
  return params.toString();
}

async function fileJson<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  return fileResponse(path, response => response.json() as Promise<T>, init);
}

/** Keep account identity and deadline bound through the entire transfer body.
 * Never retry writes here: timeout does not prove that a file wasn't written. */
async function fileResponse<T>(path: string, consume: (response: Response) => Promise<T>, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const scope = activeRecoveryScope;
  const { timeoutMs = LONG_TIMEOUT_MS, signal, ...requestInit } = init ?? {};
  const headers = new Headers(requestInit.headers);
  if (scope && path.startsWith('/api/hub/v1/')) headers.set('x-agentopsdeck-recovery-scope', scope);
  return rawResponse(path, async (response, current) => {
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent('agentopsdeck:auth-required'));
      throw new AuthRequiredError('unauthorized');
    }
    if (!response.ok) {
      const parsed = await response.json().catch(() => ({}));
      const body = parsed && typeof parsed === 'object' ? parsed : {};
      current();
      if (response.status === 409 && body.error === 'Authenticated account or Hub changed; reload before continuing') {
        window.dispatchEvent(new CustomEvent('agentopsdeck:auth-required'));
        throw new AuthRequiredError(body.error);
      }
      throw new ApiResponseError(body.error || response.statusText || `File request failed (${response.status})`, response.status,
        retryAfterMilliseconds(response.headers.get('retry-after')));
    }
    return consume(response);
  }, { ...requestInit, headers, ...(signal ? { signal } : {}), timeoutMs });
}

export type AuthStatus = {
  authenticated: boolean;
  recoveryScope?: string;
  passkeys: { available: boolean; count: number };
};

export type AuthAuditRecord = {
  id: string;
  ts: number;
  event: string;
  outcome: string;
  keyIdentityHash?: string;
  ipHash?: string;
  userAgentHash?: string;
  reason?: string;
  failureCount?: number;
  retryAfterSeconds?: number;
  passkeyCredentialHash?: string;
  userId?: string;
  keyId?: string;
  actorUserId?: string;
  authMethod?: 'member' | 'administrator';
};

export type AuthAuditPage = { records: AuthAuditRecord[]; nextCursor?: string; persistent: boolean; retentionDays?: number; maxRecords: number; startedAt?: number };

export type SafePasskey = {
  id: string;
  label: string;
  transports: string[];
  createdAt: number;
  lastUsedAt?: number;
};

export const api = {
  weixinStatus: (signal: AbortSignal) => json<import('@agentopsdeck/shared').WeixinStatus>('/api/hub/v1/weixin', { signal, cache: 'no-store' }),
  weixinStart: (id: string, signal: AbortSignal) => json<import('@agentopsdeck/shared').WeixinStatus>('/api/hub/v1/weixin/bindings', { method: 'POST', body: JSON.stringify({ id }), signal, timeoutMs: 20000 }),
  weixinPoll: (id: string, verify: string | undefined, signal: AbortSignal) => json<{ state: string; status: import('@agentopsdeck/shared').WeixinStatus }>(`/api/hub/v1/weixin/bindings/${encodeURIComponent(id)}/poll`, { method: 'POST', body: JSON.stringify(verify ? { verify } : {}), signal, timeoutMs: 40000 }),
  weixinRemove: (id: string, signal: AbortSignal) => json<{ removed: boolean }>(`/api/hub/v1/weixin/bindings/${encodeURIComponent(id)}`, { method: 'DELETE', signal }),
  fileCard: (id: string, signal?: AbortSignal) => json<import('@agentopsdeck/shared').WorkspaceFileCard & { revision: number }>(`/api/hub/v1/workspace/file-cards/${encodeURIComponent(id)}`, { signal: signal ?? null, cache: 'no-store' }),
  fileCardConfiguration: (id: string, signal?: AbortSignal) => json<{ document: (import('@agentopsdeck/shared').WorkspaceFileCard & { revision: number }) | null }>(`/api/hub/v1/workspace/file-cards/${encodeURIComponent(id)}/configuration`, { signal: signal ?? null, cache: 'no-store' }),
  saveFileCardDocument: (id: string, value: import('@agentopsdeck/shared').WorkspaceFileCardWrite, bindingId: string | null, signal?: AbortSignal) => json<import('@agentopsdeck/shared').WorkspaceFileCard & { revision: number }>(`/api/hub/v1/workspace/file-cards/${encodeURIComponent(id)}/document`, { method: 'PUT', headers: { 'X-AgentOpsDeck-File-Binding': bindingId ?? 'none' }, body: JSON.stringify(value), signal: signal ?? null }),
  saveFileCardConfiguration: (id: string, value: import('@agentopsdeck/shared').WorkspaceFileCardWrite, signal?: AbortSignal) => json<import('@agentopsdeck/shared').WorkspaceFileCard & { revision: number }>(`/api/hub/v1/workspace/file-cards/${encodeURIComponent(id)}/configuration`, { method: 'PUT', body: JSON.stringify(value), signal: signal ?? null }),
  fileCardBinding: (id: string, signal?: AbortSignal) => bindingReads(`${activeRecoveryScope ?? ''}:card:${id}:${snapshotGeneration}`, sig => json<{ enabled: boolean; binding: import('./lib/workspace-file-board.js').FileBoardBinding | null }>(`/api/hub/v1/workspace/file-cards/${encodeURIComponent(id)}/file-binding`, { signal: sig, cache: 'no-store' }), signal),
  includeFileCardArchive: (id: string, binding: string, input: { requestId: string; revision: number }, signal?: AbortSignal) => json<{ notAdmitted: true } | { receipt: { mutationId: string; state: 'saved' | 'conflict' | 'uncertain' } }>(`/api/hub/v1/workspace/file-cards/${encodeURIComponent(id)}/file-binding/${encodeURIComponent(binding)}/include-archive`, { method: 'POST', body: JSON.stringify(input), signal: signal ?? null, cache: 'no-store' }),
  fileCardCapabilities: (id: string, signal?: AbortSignal) => json<{ writable: boolean }>(`/api/hub/v1/workspace/file-cards/${encodeURIComponent(id)}/file-binding/capabilities`, { signal: signal ?? null, cache: 'no-store' }),
  writeFileCard: (id: string, binding: string, value: import('@agentopsdeck/shared').WorkspaceFileCardWrite, signal?: AbortSignal) => json<{ receipt: { mutationId: string; state: 'saved' | 'conflict' | 'uncertain' } }>(`/api/hub/v1/workspace/file-cards/${encodeURIComponent(id)}/file-binding/${encodeURIComponent(binding)}/writes`, { method: 'POST', body: JSON.stringify(value), signal: signal ?? null }),
  inspectFileCardWrite: (id: string, binding: string, mutation: string, signal?: AbortSignal) => json<{ receipt: { mutationId: string; state: 'saved' | 'conflict' | 'uncertain' } }>(`/api/hub/v1/workspace/file-cards/${encodeURIComponent(id)}/file-binding/${encodeURIComponent(binding)}/writes/${encodeURIComponent(mutation)}`, { signal: signal ?? null, cache: 'no-store' }),
  bindFileCard: (id: string, input: import('./lib/workspace-file-board.js').FileBoardIntent, signal?: AbortSignal) => json<{ binding: import('./lib/workspace-file-board.js').FileBoardBinding }>(`/api/hub/v1/workspace/file-cards/${encodeURIComponent(id)}/file-binding`, { method: 'POST', body: JSON.stringify(input), signal: signal ?? null, cache: 'no-store' }),
  inspectFileCard: (id: string, binding: string, signal?: AbortSignal) => json<{ binding: import('./lib/workspace-file-board.js').FileBoardBinding }>(`/api/hub/v1/workspace/file-cards/${encodeURIComponent(id)}/file-binding/${encodeURIComponent(binding)}`, { signal: signal ?? null, cache: 'no-store' }),
  cancelFileCard: (id: string, binding: string, signal: AbortSignal) => json<{ cancelled: true; cleanup: 'confirmed' | 'pending' }>(`/api/hub/v1/workspace/file-cards/${encodeURIComponent(id)}/file-binding/${encodeURIComponent(binding)}/cancel`, { method: 'POST', signal, cache: 'no-store' }),
  revokeFileCard: (id: string, binding: string, signal?: AbortSignal) => json<{ binding: import('./lib/workspace-file-board.js').FileBoardBinding; cleanup: 'confirmed' | 'pending' }>(`/api/hub/v1/workspace/file-cards/${encodeURIComponent(id)}/file-binding/${encodeURIComponent(binding)}`, { method: 'DELETE', signal: signal ?? null, cache: 'no-store' }),
  authStatus: (signal?: AbortSignal) => readJson<AuthStatus>('/api/auth/status', signal ? { signal } : undefined),
  loginWithAccessKey: (key: string) => json<{ ok: boolean; passkeys: AuthStatus['passkeys'] }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ accessKey: key }),
  }),
  logout: () => json<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  authAudit: (limit = 100) => readJson<{ records: AuthAuditRecord[] }>(`/api/auth/audit?limit=${limit}`),
  authActivity: (userId = '', before = '') => readJson<AuthAuditPage>(`/api/auth/audit?page=true&limit=25${userId ? `&userId=${encodeURIComponent(userId)}` : ''}${before ? `&before=${encodeURIComponent(before)}` : ''}`),
  passkeys: (signal?: AbortSignal) => readJson<{ passkeys: SafePasskey[] }>('/api/auth/passkeys', { signal: signal ?? null }),
  revokePasskey: (id: string, signal?: AbortSignal) => json<{ ok: boolean; reauthenticate?: boolean }>(`/api/auth/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE', signal: signal ?? null }),
  passkeyRegistrationOptions: (signal?: AbortSignal) => json<PublicKeyCredentialCreationOptionsJSON>('/api/auth/passkeys/register/options', { method: 'POST', signal: signal ?? null }),
  verifyPasskeyRegistration: (response: unknown, label?: string, signal?: AbortSignal) => json<{ ok: boolean; passkeys: AuthStatus['passkeys'] }>('/api/auth/passkeys/register/verify', {
    method: 'POST', signal: signal ?? null,
    body: JSON.stringify(label ? { credential: response, label } : response),
  }),
  passkeyLoginOptions: () => json<PublicKeyCredentialRequestOptionsJSON>('/api/auth/passkeys/login/options', { method: 'POST' }),
  verifyPasskeyLogin: (response: unknown) => json<{ ok: boolean; passkeys: AuthStatus['passkeys'] }>('/api/auth/passkeys/login/verify', {
    method: 'POST',
    body: JSON.stringify(response),
  }),
  workspacePreferences: (signal?: AbortSignal) => json<WorkspacePreferences>('/api/hub/v1/workspace/preferences', signal ? { signal } : undefined),
  workspaceBoard: (id: string, signal?: AbortSignal) => json<import('@agentopsdeck/shared').BoardDocument & { fileBinding?: import('./lib/workspace-file-board.js').FileBoardBinding }>(`/api/hub/v1/workspace/boards/${encodeURIComponent(id)}`, signal ? { signal } : undefined),
  fileBoardBinding: (id: string, signal?: AbortSignal) => bindingReads(`${activeRecoveryScope ?? ''}:board:${id}:${snapshotGeneration}`, sig => json<{ enabled: boolean; binding: import('./lib/workspace-file-board.js').FileBoardBinding | null }>(`/api/hub/v1/workspace/boards/${encodeURIComponent(id)}/file-binding`, { signal: sig, cache: 'no-store' }), signal),
  fileBoardCapabilities: (id: string, signal?: AbortSignal) => json<{ writable: boolean }>(`/api/hub/v1/workspace/boards/${encodeURIComponent(id)}/file-binding/capabilities`, { signal: signal ?? null, cache: 'no-store' }),
  writeFileBoard: (id: string, binding: string, value: import('@agentopsdeck/shared').BoardWrite) => json<{ receipt: { mutationId: string; state: 'saved' | 'conflict' | 'uncertain' } }>(`/api/hub/v1/workspace/boards/${encodeURIComponent(id)}/file-binding/${encodeURIComponent(binding)}/writes`, { method: 'POST', body: JSON.stringify(value) }),
  cancelFileBoard: (id: string, binding: string, signal: AbortSignal) => json<{ cancelled: true; cleanup: 'confirmed' | 'pending' }>(`/api/hub/v1/workspace/boards/${encodeURIComponent(id)}/file-binding/${encodeURIComponent(binding)}/cancel`, { method: 'POST', signal, cache: 'no-store' }),
  bindFileBoard: (id: string, input: import('./lib/workspace-file-board.js').FileBoardIntent, signal?: AbortSignal) => json<{ binding: import('./lib/workspace-file-board.js').FileBoardBinding }>(`/api/hub/v1/workspace/boards/${encodeURIComponent(id)}/file-binding`, { method: 'POST', body: JSON.stringify(input), signal: signal ?? null, cache: 'no-store' }),
  inspectFileBoard: (id: string, binding: string, signal?: AbortSignal) => json<{ binding: import('./lib/workspace-file-board.js').FileBoardBinding }>(`/api/hub/v1/workspace/boards/${encodeURIComponent(id)}/file-binding/${encodeURIComponent(binding)}`, { signal: signal ?? null, cache: 'no-store' }),
  revokeFileBoard: (id: string, binding: string, signal?: AbortSignal) => json<{ binding: import('./lib/workspace-file-board.js').FileBoardBinding; cleanup: 'confirmed' | 'pending' }>(`/api/hub/v1/workspace/boards/${encodeURIComponent(id)}/file-binding/${encodeURIComponent(binding)}`, { method: 'DELETE', signal: signal ?? null, cache: 'no-store' }),
  workspaceCards: (signal: AbortSignal) => json<{ cards: import('@agentopsdeck/shared').CardSummary[] }>('/api/hub/v1/workspace/cards', { signal }),
  workspaceCard: (id: string, signal: AbortSignal) => json<import('@agentopsdeck/shared').CardDocument>(`/api/hub/v1/workspace/cards/${encodeURIComponent(id)}`, { signal }),
  saveWorkspaceCard: (id: string, value: import('@agentopsdeck/shared').CardWrite, signal: AbortSignal) => json<import('@agentopsdeck/shared').CardDocument>(`/api/hub/v1/workspace/cards/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(value), signal }),
  workspaceBoards: (signal?: AbortSignal) => json<{ boards: import('@agentopsdeck/shared').BoardSummary[] }>('/api/hub/v1/workspace/boards', signal ? { signal } : undefined),
  workspaceBoardSummary: (id: string, signal?: AbortSignal) => json<import('@agentopsdeck/shared').BoardSummary>(`/api/hub/v1/workspace/boards/${encodeURIComponent(id)}/summary`, signal ? { signal } : undefined),
  boardGrants: (id: string, signal?: AbortSignal) => json<{ capabilities: import('./lib/workspace-board-access.js').BoardGrant[] }>(`/api/hub/v1/workspace/boards/${encodeURIComponent(id)}/capabilities`, { ...(signal ? { signal } : {}), cache: 'no-store' }),
  boardBindings: (id: string, signal: AbortSignal) => json<{ enabled: boolean; bindings: import('./lib/workspace-board-binding.js').BoardSessionBinding[] }>(`/api/hub/v1/workspace/boards/${encodeURIComponent(id)}/bindings`, { signal, cache: 'no-store' }),
  bindBoardSession: (id: string, value: import('./lib/workspace-board-binding.js').BoardSessionBindingInput, signal: AbortSignal) => json<{ binding: import('./lib/workspace-board-binding.js').BoardSessionBinding }>(`/api/hub/v1/workspace/boards/${encodeURIComponent(id)}/bindings`, { method: 'POST', body: JSON.stringify(value), signal, cache: 'no-store' }),
  prepareBoardDelegation: (id: string, value: import('./lib/workspace-delegation.js').DelegationInput, signal: AbortSignal) => json<{ batch: import('./lib/workspace-delegation.js').DelegationBatch }>(`/api/hub/v1/workspace/boards/${encodeURIComponent(id)}/delegations`, { method: 'POST', body: JSON.stringify(value), signal, cache: 'no-store' }),
  boardDelegation: (id: string, batch: string, action: 'inspect' | 'confirm' | 'cancel', signal: AbortSignal) => json<{ batch: import('./lib/workspace-delegation.js').DelegationBatch | null; cancelled?: boolean; batchId?: string }>(`/api/hub/v1/workspace/boards/${encodeURIComponent(id)}/delegations/${encodeURIComponent(batch)}${action === 'confirm' ? '/confirm' : ''}`, { method: action === 'inspect' ? 'GET' : action === 'confirm' ? 'POST' : 'DELETE', ...(action === 'confirm' ? { body: '{}' } : {}), signal, cache: 'no-store' }),
  inspectBoardBinding: (id: string, requestId: string, signal: AbortSignal) => json<{ binding: import('./lib/workspace-board-binding.js').BoardSessionBinding }>(`/api/hub/v1/workspace/boards/${encodeURIComponent(id)}/bindings/${encodeURIComponent(requestId)}`, { signal, cache: 'no-store' }),
  revokeBoardBinding: (id: string, requestId: string, signal: AbortSignal) => json<{ binding: import('./lib/workspace-board-binding.js').BoardSessionBinding; cleanup: string }>(`/api/hub/v1/workspace/boards/${encodeURIComponent(id)}/bindings/${encodeURIComponent(requestId)}`, { method: 'DELETE', signal, cache: 'no-store' }),
  cancelBoardBindingIntent: (id: string, requestId: string, signal: AbortSignal) => json<{ cancelled: true; requestId: string; binding: import('./lib/workspace-board-binding.js').BoardSessionBinding | null }>(`/api/hub/v1/workspace/boards/${encodeURIComponent(id)}/bindings/${encodeURIComponent(requestId)}/cancel-intent`, { method: 'POST', body: '{}', signal, cache: 'no-store' }),
  issueBoardGrant: (id: string, value: import('./lib/workspace-board-access.js').BoardGrantInput) => json<{ capability: import('./lib/workspace-board-access.js').BoardGrant; token: string }>(`/api/hub/v1/workspace/boards/${encodeURIComponent(id)}/capabilities`, { method: 'POST', body: JSON.stringify(value), cache: 'no-store' }),
  revokeBoardGrant: (id: string, grantId: string) => json<{ revoked: boolean }>(`/api/hub/v1/workspace/boards/${encodeURIComponent(id)}/capabilities/${encodeURIComponent(grantId)}`, { method: 'DELETE', cache: 'no-store' }),
  boardAudit: (id: string, before?: number, signal?: AbortSignal) => json<{ events: import('./lib/workspace-board-access.js').BoardAuditEvent[] }>(`/api/hub/v1/workspace/boards/${encodeURIComponent(id)}/audit${before === undefined ? '' : `?before=${before}`}`, { ...(signal ? { signal } : {}), cache: 'no-store' }),
  saveWorkspaceBoard: (id: string, value: import('@agentopsdeck/shared').BoardWrite) => json<import('@agentopsdeck/shared').BoardDocument>(`/api/hub/v1/workspace/boards/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(value) }),
  workspaceDrawings: (signal?: AbortSignal) => json<{ drawings: import('@agentopsdeck/shared').DrawingSummary[] }>('/api/hub/v1/workspace/drawings', { ...(signal ? { signal } : {}) }),
  workspaceLayouts: (kind: 'current' | 'saved', signal: AbortSignal) => json<{ revision: number; content: string | null }>(`/api/hub/v1/workspace/layouts/${kind}`, { signal, cache: 'no-store' }),
  saveWorkspaceLayouts: (kind: 'current' | 'saved', value: { revision: number; content: string }, signal: AbortSignal) => json<{ revision: number; content: string | null }>(`/api/hub/v1/workspace/layouts/${kind}`, { method: 'PUT', body: JSON.stringify(value), signal, cache: 'no-store' }),
  workspaceNativeDrawioConfig: (signal?: AbortSignal) => json<{ editorUrl: string | null }>('/api/hub/v1/workspace/native-drawio/config', { ...(signal ? { signal } : {}) }),
  workspaceNativeDrawioCatalog: (signal?: AbortSignal) => json<{ drawings: import('@agentopsdeck/shared').NativeDrawioSummary[] }>('/api/hub/v1/workspace/native-drawio', { ...(signal ? { signal } : {}) }),
  workspaceNativeDrawio: (id: string, signal?: AbortSignal) => json<import('@agentopsdeck/shared').NativeDrawioDocument>(`/api/hub/v1/workspace/native-drawio/${encodeURIComponent(id)}`, { ...(signal ? { signal } : {}) }),
  saveWorkspaceNativeDrawio: (id: string, value: import('@agentopsdeck/shared').NativeDrawioWrite) => json<import('@agentopsdeck/shared').NativeDrawioDocument>(`/api/hub/v1/workspace/native-drawio/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(value) }),
  workspaceDrawing: (id: string, signal?: AbortSignal) => json<import('@agentopsdeck/shared').DrawingDocument>(`/api/hub/v1/workspace/drawings/${encodeURIComponent(id)}`, { ...(signal ? { signal } : {}) }),
  saveWorkspaceDrawing: (id: string, value: import('@agentopsdeck/shared').DrawingWrite) => json<import('@agentopsdeck/shared').DrawingDocument>(`/api/hub/v1/workspace/drawings/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(value) }),
  sessionNotebook: (target: SessionTarget) => json<import('./lib/session-notebook.js').NotebookDocument>(`${sessionAddress(target).path}/notebook`),
  completionSummary: (sessions: string[]) => json<{ items: { sessionKey: string; displayTarget: string; generation: string; latestSequence: number; readThrough: number; unread: boolean; coverage: 'observed' | 'gap' }[] }>('/api/hub/v1/completions/summary', { method: 'POST', body: JSON.stringify({ sessions }) }),
  observeCompletion: (sessionKey: string) => json<{ token: string; generation: string; throughSequence: number; expiresAt: number; turnId?: string }>('/api/hub/v1/completions/observe', { method: 'POST', body: JSON.stringify({ sessionKey }) }),
  readCompletion: (sessionKey: string, token: string, throughSequence: number, requestId: string) => json<{ throughSequence: number }>('/api/hub/v1/completions/read', { method: 'POST', body: JSON.stringify({ sessionKey, token, throughSequence, requestId }) }),
  notebookArchive: (target: SessionTarget | undefined, id = 'default') => json<import('./lib/session-notebook.js').NotebookDocument>(target === undefined ? `/api/hub/v1/notebooks/${encodeURIComponent(id)}/archive` : `${sessionAddress(target).path}/notebook/archive`),
  searchNotebook: (target: SessionTarget | undefined, id: string, query: string, archive: boolean) => json<{ hotRevision: number; coldRevision: number | null; results: { area: 'hot' | 'cold'; revision: number; start: number; end: number; text: string }[] }>(`${target === undefined ? `/api/hub/v1/notebooks/${encodeURIComponent(id)}` : `${sessionAddress(target).path}/notebook`}/search?${new URLSearchParams({ q: query, ...(archive ? { archive: '1' } : {}) })}`),
  moveNotebook: (target: SessionTarget | undefined, id: string, input: { requestId: string; direction: 'archive' | 'restore'; hotRevision: number; coldRevision: number; ranges: { start: number; end: number; sha256: string }[] }) => json<{ hotRevision: number; coldRevision: number; moved: number }>(`${target === undefined ? `/api/hub/v1/notebooks/${encodeURIComponent(id)}` : `${sessionAddress(target).path}/notebook`}/moves`, { method: 'POST', body: JSON.stringify(input) }),
  notebookMoveReceipt: (target: SessionTarget | undefined, id: string, requestId: string) => json<{ hotRevision: number; coldRevision: number; moved: number }>(`${target === undefined ? `/api/hub/v1/notebooks/${encodeURIComponent(id)}` : `${sessionAddress(target).path}/notebook`}/moves/${encodeURIComponent(requestId)}`),
  saveNotebookArchive: (target: SessionTarget | undefined, id: string, value: Pick<import('./lib/session-notebook.js').NotebookDocument, 'text' | 'revision' | 'resourceId'>) => json<import('./lib/session-notebook.js').NotebookDocument>(target === undefined ? `/api/hub/v1/notebooks/${encodeURIComponent(id)}/archive` : `${sessionAddress(target).path}/notebook/archive`, { method: 'PUT', headers: { 'x-agentopsdeck-notebook-format': 'styled-markdown-v2' }, body: JSON.stringify(value) }),
  hubNotebook: () => json<import('./lib/session-notebook.js').NotebookDocument>('/api/hub/v1/notebook'),
  hubNotebooks: (after?: string) => json<{ items: import('./lib/session-notebook.js').NotebookDocument[]; nextCursor: string | null }>(`/api/hub/v1/notebooks${after ? `?after=${encodeURIComponent(after)}` : ''}`),
  hubNotebookById: (id: string, layout = false) => json<import('./lib/session-notebook.js').NotebookDocument>(`/api/hub/v1/notebooks/${encodeURIComponent(id)}${layout ? '/layout' : ''}`),
  saveHubNotebookById: (id: string, value: Pick<import('./lib/session-notebook.js').NotebookDocument, 'text' | 'revision' | 'resourceId'>, layout = false) => json<import('./lib/session-notebook.js').NotebookDocument>(`/api/hub/v1/notebooks/${encodeURIComponent(id)}${layout ? '/layout' : ''}`, { method: 'PUT', headers: { 'x-agentopsdeck-notebook-format': 'styled-markdown-v2' }, body: JSON.stringify(value) }),
  saveHubNotebook: (value: { resourceId: string; text: string; revision: number }) =>
    json<import('./lib/session-notebook.js').NotebookDocument>('/api/hub/v1/notebook', { method: 'PUT', headers: { 'x-agentopsdeck-notebook-format': 'styled-markdown-v2' }, body: JSON.stringify(value) }),
  saveSessionNotebook: (target: SessionTarget, value: { resourceId: string; text: string; revision: number }) =>
    json<import('./lib/session-notebook.js').NotebookDocument>(`${sessionAddress(target).path}/notebook`, { method: 'PUT', headers: { 'x-agentopsdeck-notebook-format': 'styled-markdown-v2' }, body: JSON.stringify(value) }),
  saveWorkspacePreferences: (value: WorkspacePreferences, signal?: AbortSignal) => json<WorkspacePreferences>('/api/hub/v1/workspace/preferences', {
    method: 'PUT', body: JSON.stringify(value), ...(signal ? { signal } : {}),
  }),
  sessionsState: (options: { includeHidden?: boolean; includeArchived?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (options.includeHidden) params.set('includeHidden', '1');
    if (options.includeArchived) params.set('includeArchived', '1');
    const query = params.toString();
    return readJson<HubSessionsState>(`/api/hub/v1/sessions/state${query ? `?${query}` : ''}`, undefined, true);
  },
  cachedSessionMessages: (sessionKey: SessionTarget, limit = 200) => recoveryScope()
    ? navigationHistory.get(historyRequestKey(`${sessionAddress(sessionKey).path}/messages?limit=${limit}`)) : undefined,
  sessionMessages: async (sessionKey: SessionTarget, limit = 200, signal?: AbortSignal, before?: string, calibration = false, schedule?: HistoryReadSchedule) => {
    const scope = recoveryScope(), epoch = recoveryEpoch(), previewEpoch = sessionPreviewCache.epoch(), started = Date.now(), address = sessionAddress(sessionKey);
    const navigationEpoch = navigationHistory.epoch(), snapshotEpoch = snapshotGeneration;
    const path = `${address.path}/messages?limit=${limit}${before === undefined ? '' : `&before=${encodeURIComponent(before)}`}`;
    const version = historyVersion(path), cacheKey = historyRequestKey(path);
    let result: MessagePage;
    try {
      result = await historyReads(`${cacheKey}:${epoch}:${snapshotEpoch}`, ownedSignal => {
        const check = () => {
          if (epoch !== recoveryEpoch()) throw new AuthRequiredError('Authenticated account changed');
          if (snapshotEpoch !== snapshotGeneration) throw new DOMException('History transport changed', 'AbortError');
          if (!version.valid) throw new DOMException('Session history changed', 'AbortError');
        };
        const read = () => {
          // A queued attempt must recheck its authority before network access.
          ownedSignal.throwIfAborted(); check();
          const rawPriority = schedule?.priority?.();
          return readJson<MessagePage>(path, { timeoutMs: LONG_TIMEOUT_MS, conditionalHistory: true, calibration,
            ...(rawPriority !== undefined ? { itemPriority: rawPriority } : {}),
            headers: { [HISTORY_ASYNC_HEADER]: '1' }, signal: ownedSignal }, true);
        };
        // A negotiated 202 retry delay holds no scheduler slot. One preparing
        // session must not block startup of unrelated panes for two minutes.
        return readPreparedHistory(() => schedule ? schedule(read, ownedSignal) : read(), check, ownedSignal);
      }, signal, { immediate: !schedule, onImmediateJoin: schedule?.expedite });
    } catch (error) {
      if (!signal?.aborted && !(error instanceof DOMException && error.name === 'AbortError') && epoch === recoveryEpoch())
        navigationHistory.clear(key => key === address.key);
      throw error;
    }
    if (result.historyStatus !== 'cached' && before === undefined && limit > 8 && scope && epoch === recoveryEpoch() && !signal?.aborted)
      navigationHistory.put(cacheKey, address.key, result, navigationEpoch);
    // First-page full chat reads warm previews at no extra transport cost. Older
    // pagination must never replace the cached latest messages.
    if (result.historyStatus !== 'cached' && before === undefined && limit > 8 && scope && epoch === recoveryEpoch() && previewEpoch === sessionPreviewCache.epoch() && !signal?.aborted)
      sessionPreviewCache.seed(previewKey(scope, address.key), result.messages, started);
    return result;
  },
  sessionMessageDetail: (sessionKey: SessionTarget, messageId: string, signal?: AbortSignal) =>
    readJson<{ message: ChatMessage; updatedAt: number }>(`${sessionAddress(sessionKey).path}/messages/${encodeURIComponent(messageId)}`, signal ? { signal } : undefined),
  requestSessionRecovery: (sessionKey: string, expectedRunId: string, signal: AbortSignal) =>
    json<{ requested: true }>(`${ownerSessionPath(sessionKey)}/recovery`, {
      method: 'POST', body: JSON.stringify({ expectedRunId }), signal, timeoutMs: 12_000,
    }),
  stopSessionBackgroundTerminals: (sessionKey: string, expectedRunId: string, signal: AbortSignal) =>
    json<{ stopped: true }>(`${ownerSessionPath(sessionKey)}/background-terminals/stop`, {
      method: 'POST', body: JSON.stringify({ expectedRunId }), signal, timeoutMs: 32_000,
    }),
  sessionFileIndexAvailable: async (sessionKey: string, signal: AbortSignal) => {
    const address = sessionAddress(sessionKey);
    // Shared sessions and standalone/legacy addresses keep the loaded-message
    // panel. Never probe their owner endpoint with another user's authority.
    if (address.shared || !/^[A-Za-z0-9._-]+:[A-Za-z0-9_-]+$/.test(address.key)) return false;
    const connection = address.key.split(':')[0]!;
    const capabilities = await readJson<ConnectorCapabilities>(`/api/hub/v1/connections/${encodeURIComponent(connection)}/capabilities`, { signal });
    return capabilities.features?.sessionFileIndex === true;
  },
  sessionTokenUsage: async (sessionKey: string, from: number, to: number, bucketMs: number, signal: AbortSignal) => {
    const result = validateNativeTokenUsage(await json<unknown>(`${ownerSessionPath(sessionKey)}/token-usage?${new URLSearchParams({ from: String(from), to: String(to), bucketMs: String(bucketMs) })}`, { signal }));
    if (result.from !== from || result.to !== to || result.bucketMs !== bucketMs) throw new Error('Mismatched token usage range');
    return result;
  },
  sessionTokenUsageExport: async (sessionKey: string, from: number, to: number, bucketMs: number, signal: AbortSignal) => {
    const result = validateNativeTokenUsageExport(await json<unknown>(`${ownerSessionPath(sessionKey)}/token-usage/export?${new URLSearchParams({ from: String(from), to: String(to), bucketMs: String(bucketMs) })}`, { signal }));
    if (result.usage.from !== from || result.usage.to !== to || result.usage.bucketMs !== bucketMs) throw new Error('Mismatched token export range');
    return result;
  },
  sessionTokenSnapshot: async (sessionKey: string, selection: { requestId: string; from: number; to: number; bucketMs: number }, signal: AbortSignal) => {
    const input = tokenSnapshotSelection(selection);
    const result = validateNativeTokenSnapshot(await json<unknown>(`${ownerSessionPath(sessionKey)}/token-usage/snapshots`, { method: 'POST', body: JSON.stringify(input), signal }));
    if (result.requestId !== input.requestId || result.data.usage.from !== input.from || result.data.usage.to !== input.to || result.data.usage.bucketMs !== input.bucketMs) throw Error('Mismatched snapshot');
    return result;
  },
  sessionTokenSnapshotReceipt: async (sessionKey: string, id: string, signal: AbortSignal) => {
    const requestId = tokenSnapshotRequestId(id);
    const result = validateNativeTokenSnapshot(await json<unknown>(`${ownerSessionPath(sessionKey)}/token-usage/snapshots/${requestId}`, { signal }));
    if (result.requestId !== requestId) throw Error('Mismatched snapshot receipt');
    return result;
  },
  sessionSkills: async (sessionKey: string, signal: AbortSignal) =>
    validateSessionSkills(await json<unknown>(`${ownerSessionPath(sessionKey)}/skills`, { signal })),
  sessionInteractions: async (sessionKey: string, signal: AbortSignal) => {
    const value = readInteractionSnapshot(await json<unknown>(`${ownerSessionPath(sessionKey)}/interactions`, { signal }));
    if (!value) throw new Error('Invalid interaction snapshot');
    return value;
  },
  sessionInteractionCapability: async (sessionKey: string, signal: AbortSignal): Promise<boolean | undefined> => {
    // Validate owner routing before any request. This feature advertises route
    // registration, not runtime readiness or permission to answer a question.
    ownerSessionPath(sessionKey);
    const match = /^([A-Za-z0-9._-]+):[A-Za-z0-9_-]+$/.exec(sessionKey);
    if (!match) return undefined;
    try {
      const capabilities = await readJson<ConnectorCapabilities>(`/api/hub/v1/connections/${encodeURIComponent(match[1]!)}/capabilities`, { signal });
      const available = capabilities?.features?.interactions;
      return typeof available === 'boolean' ? available : undefined;
    } catch (error) {
      // Older capability endpoints are optional. Auth/network failures are not
      // evidence of a legacy server and must not start another owner request.
      if (error instanceof ApiResponseError && error.status === 404) return undefined;
      throw error;
    }
  },
  setInteractionMode: async (sessionKey: string, mode: InteractionMode, signal: AbortSignal) => {
    const result = await json<{ mode?: unknown }>(`${ownerSessionPath(sessionKey)}/interaction-mode`, { method: 'PATCH', signal, body: JSON.stringify({ mode }) });
    if (result?.mode !== mode) throw new Error('Invalid interaction mode receipt');
    return { mode };
  },
  answerInteraction: async (sessionKey: string, requestId: string, answer: InteractionSubmission, signal: AbortSignal) => {
    const value = readInteractionView(await json<unknown>(`${ownerSessionPath(sessionKey)}/interactions/${encodeURIComponent(requestId)}/answer`, {
      method: 'POST', signal, body: JSON.stringify(answer),
    }));
    if (!value || value.request.requestId !== requestId || value.request.runId !== answer.runId) throw new Error('Invalid interaction receipt');
    return value;
  },
  sessionFiles: (sessionKey: string, signal: AbortSignal, cursor?: string) =>
    readJson<SessionFilePage>(`${ownerSessionPath(sessionKey)}/files${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { signal }),
  rebuildSessionFiles: async (sessionKey: string, signal: AbortSignal, job?: { id: string; step: number }, cancel = false) =>
    validateSessionFileRebuild(await json<SessionFileRebuild>(`${ownerSessionPath(sessionKey, true)}/files/rebuild${job ? `/${encodeURIComponent(job.id)}` : ''}`, {
      signal, method: cancel ? 'DELETE' : 'POST', ...(job && !cancel ? { body: JSON.stringify({ step: job.step }) } : {}),
    })),
  sessionGuidance: (sessionKey: string, signal: AbortSignal) =>
    json<import('./lib/session-guidance.js').GuidanceSnapshot>(`${ownerSessionPath(sessionKey)}/guidance`, { signal, cache: 'no-store' }),
  sessionAutomation: (sessionKey: string, signal: AbortSignal) =>
    json<unknown>(`${ownerSessionPath(sessionKey)}/automation`, { signal, cache: 'no-store' }),
  automationConfiguration: (sessionKey: string, id: string, signal: AbortSignal, input?: import('@agentopsdeck/shared').AutomationConfiguration) =>
    json<unknown>(`${ownerSessionPath(sessionKey)}/automation/configuration/${encodeURIComponent(id)}`, {
      signal, cache: 'no-store', ...(input ? { method: 'POST', body: JSON.stringify(input) } : {}),
    }),
  saveSessionGuidance: (sessionKey: string, input: {revision:number;text:string;enabled:boolean}, signal:AbortSignal) =>
    json<import('./lib/session-guidance.js').GuidanceSnapshot>(`${ownerSessionPath(sessionKey)}/guidance`, {method:'PUT',body:JSON.stringify(input),signal,cache:'no-store'}),
  prepareGuidanceSubmission: (sessionKey:string,input:{requestId:string;revision:number;input?:string},signal:AbortSignal) =>
    json<import('./lib/session-guidance.js').GuidanceResult>(`${ownerSessionPath(sessionKey)}/guidance/submissions`,{method:'POST',body:JSON.stringify(input),signal,cache:'no-store'}),
  guidanceSubmission: (sessionKey:string,id:string,action:'inspect'|'submit'|'cancel',signal:AbortSignal) =>
    json<import('./lib/session-guidance.js').GuidanceResult>(`${ownerSessionPath(sessionKey)}/guidance/submissions/${encodeURIComponent(id)}${action==='submit'?'/submit':''}`,{method:action==='inspect'?'GET':action==='cancel'?'DELETE':'POST',...(action==='submit'?{body:'{}'}:{}),signal,cache:'no-store'}),
  sessionGoal: async (sessionKey: string, signal: AbortSignal) => {
    const value = readGoalControlSnapshot(await json<unknown>(`${ownerSessionPath(sessionKey)}/goal`, { signal, cache: 'no-store' }));
    if (!value) throw new Error('Goal observation unavailable');
    return value;
  },
  updateSettings: (sessionKey: string, payload: { title: string } | { model: string | null; thinking?: string | null } | { goal: GoalControl }, key: string, scope: string) =>
    json<Partial<SessionSettingsResult> & { command?: CommandReceipt }>(ownerSessionPath(sessionKey, true), {
      method: 'PATCH', headers: { 'idempotency-key': key, 'x-agentopsdeck-recovery-scope': scope }, body: JSON.stringify(payload),
    }),
  settingsCommand: (sessionKey: string, key: string, scope: string, signal?: AbortSignal) =>
    json<{ command: CommandReceipt }>(`${ownerSessionPath(sessionKey)}/settings-commands/${encodeURIComponent(key)}`, {
      cache: 'no-store', timeoutMs: 12_000, headers: { 'x-agentopsdeck-recovery-scope': scope }, ...(signal ? { signal } : {}),
    }),
  hideSession: (sessionKey: string, hidden = true) =>
    json<{ ok: boolean; sessionKey: string; hidden: boolean; updatedAt: number }>(`${ownerSessionPath(sessionKey, true)}/visibility`, {
      method: 'PATCH',
      body: JSON.stringify({ hidden }),
    }),
  archiveSession: (sessionKey: string, archived = true) =>
    json<{ ok: boolean; sessionKey: string; archived: boolean; updatedAt: number }>(`${ownerSessionPath(sessionKey, true)}/archive`, {
      method: 'PATCH',
      body: JSON.stringify({ archived }),
    }),
  pinSession: (sessionKey: string, pinned = true) =>
    json<{ ok: boolean; sessionKey: string; pinned: boolean; updatedAt: number }>(`${ownerSessionPath(sessionKey, true)}/pin`, {
      method: 'PATCH',
      body: JSON.stringify({ pinned }),
    }),
  deleteSession: (sessionKey: string, key: string, scope: string) =>
    json<{ ok: boolean; status?: string; command?: CommandReceipt }>(ownerSessionPath(sessionKey, true), {
      method: 'DELETE', headers: { 'idempotency-key': key, 'x-agentopsdeck-recovery-scope': scope },
    }).then(result => {
      if (result.ok !== true) throw new Error('Deletion outcome is unknown; the session has not been removed from this view.');
      return result;
    }),
  deletionCommand: (sessionKey: string, key: string, scope: string, signal?: AbortSignal) =>
    json<{ command: CommandReceipt }>(`${ownerSessionPath(sessionKey)}/deletion-commands/${encodeURIComponent(key)}`, {
      cache: 'no-store', timeoutMs: 12_000, headers: { 'x-agentopsdeck-recovery-scope': scope }, ...(signal ? { signal } : {}),
    }),
  messageCommand: (sessionKey: SessionTarget, key: string, scope?: string, signal?: AbortSignal) =>
    json<{ command: CommandReceipt }>(`${sessionAddress(sessionKey).path}/commands/${encodeURIComponent(key)}`, {
      cache: 'no-store', timeoutMs: 12_000, ...(scope ? { headers: { 'x-agentopsdeck-recovery-scope': scope } } : {}), ...(signal ? { signal } : {}),
    }),
  sendMessage: (sessionKey: SessionTarget, message: string, deliveryMode: SendDeliveryMode = 'web-only', media: SendMessageUpload[] = [], idempotencyKey = newCommandKey(), scope?: string, expectedRunId?: string) =>
    json<SendMessageResponse>(`${sessionAddress(sessionKey).path}/messages`, {
      method: 'POST',
      timeoutMs: LONG_TIMEOUT_MS,
      ...(scope ? { headers: { 'x-agentopsdeck-recovery-scope': scope } } : {}),
      body: JSON.stringify(sessionMessagePayload(sessionKey, message, deliveryMode, media, idempotencyKey, expectedRunId)),
    }),
  compactSession: (sessionKey: string, sdk = false, idempotencyKey = newCommandKey(), scope?: string) =>
    json<CompactSessionResponse>(`${ownerSessionPath(sessionKey, !sdk)}/compact`, {
      method: 'POST',
      timeoutMs: LONG_TIMEOUT_MS,
      ...(scope ? { headers: { 'x-agentopsdeck-recovery-scope': scope } } : {}),
      body: JSON.stringify({ idempotencyKey }),
    }),
  compactCommand: (sessionKey: string, key: string, scope: string, signal?: AbortSignal) =>
    json<{ command: CommandReceipt }>(`${ownerSessionPath(sessionKey)}/compact-commands/${encodeURIComponent(key)}`, {
      cache: 'no-store', timeoutMs: 12_000, headers: { 'x-agentopsdeck-recovery-scope': scope }, ...(signal ? { signal } : {}),
    }),
  createSession: (agentId: string, label?: string, connectionId = 'local', idempotencyKey = newCommandKey(), scope?: string, ownerUserId?: string) =>
    json<Partial<CreateSessionResponse> & { command?: CommandReceipt }>(creationPath({ connectionId, agentId, ...(ownerUserId ? { ownerUserId } : {}) }), {
      method: 'POST',
      ...(scope ? { headers: { 'x-agentopsdeck-recovery-scope': scope } } : {}),
      body: JSON.stringify({ label, idempotencyKey }),
    }),
  verifyCreationConnection: (connectionId: string, scope: string) =>
    json<{ connection: HubConnection & { nodeId?: string; identityStatus?: string } }>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/verify`, {
      method: 'POST', headers: { 'x-agentopsdeck-recovery-scope': scope },
    }),
  creationCommand: (target: CreationTarget, key: string, scope: string, signal?: AbortSignal) =>
    json<{ command: CommandReceipt }>(`${creationPath(target)}/creation-commands/${encodeURIComponent(key)}`, {
      cache: 'no-store', headers: { 'x-agentopsdeck-recovery-scope': scope }, ...(signal ? { signal } : {}),
    }),
  agents: (maxAgeMs = 0) => {
    const scopeKey = requestKey('/api/agents');
    if (forbiddenAgentsScopeKey === scopeKey || isLocalRuntimeForbiddenInStorage('agents')) {
      forbiddenAgentsScopeKey = scopeKey;
      return Promise.resolve({ agents: [], updatedAt: 0 });
    }
    return readAgents(`${scopeKey} ${snapshotGeneration}:${metadataGeneration}`, maxAgeMs,
      () => readJson<{ agents: AgentSummary[]; updatedAt: number }>('/api/agents', { timeoutMs: 12_000 }, true).catch(error => {
        if (error instanceof ApiResponseError && error.status === 403 && requestKey('/api/agents') === scopeKey) {
          forbiddenAgentsScopeKey = scopeKey;
          markLocalRuntimeForbiddenInStorage('agents');
          return { agents: [], updatedAt: 0 };
        }
        throw error;
      }));
  },
  gatewayStatus: (maxAgeMs = 0) => {
    const scopeKey = requestKey('/api/gateway/status');
    if (forbiddenGatewayScopeKey === scopeKey || isLocalRuntimeForbiddenInStorage('gateway')) {
      forbiddenGatewayScopeKey = scopeKey;
      return Promise.resolve({ ok: false, enabled: false, status: 'offline' as const, updatedAt: 0 } satisfies GatewayHealth);
    }
    return readGateway(`${scopeKey} ${snapshotGeneration}:${metadataGeneration}`, maxAgeMs,
      () => readJson<GatewayHealth>('/api/gateway/status', { timeoutMs: 12_000 }, true).catch(error => {
        if (error instanceof ApiResponseError && error.status === 403 && requestKey('/api/gateway/status') === scopeKey) {
          forbiddenGatewayScopeKey = scopeKey;
          markLocalRuntimeForbiddenInStorage('gateway');
          return { ok: false, enabled: false, status: 'offline' as const, updatedAt: 0 } satisfies GatewayHealth;
        }
        throw error;
      }));
  },
  mediaLibrary: (root?: string, path = '', signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (root !== undefined) params.set('root', root);
    if (path) params.set('path', path);
    const query = params.toString();
    return readJson<MediaLibraryListResponse>(`/api/media-library${query ? `?${query}` : ''}`, signal ? { signal } : undefined);
  },
  mediaPlaybackUrl: (url: string) => apiUrl(url),
  fileRoots: () => readJson<{ roots: FileBrowserRoot[] }>('/api/files/roots'),
  connectorFileRoots: (connectionId: string) => readJson<{ roots: { agentId: string; label: string; readOnly: boolean }[] }>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/files/roots`),
  issueSources: (connectionId: string, signal?: AbortSignal) => readJson<unknown>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/issues/sources`, signal ? { signal } : undefined),
  issueItems: (connectionId: string, sourceId: string, state: string, cursor?: string, signal?: AbortSignal, kind: 'issue' | 'work_item' = 'issue') => {
    const query = new URLSearchParams({ state, kind }); if (cursor) query.set('cursor', cursor);
    return readJson<unknown>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/issues/${encodeURIComponent(sourceId)}/items?${query}`, signal ? { signal } : undefined);
  },
  gitTreeRoots: (connectionId: string, signal?: AbortSignal) => readJson<{ roots: { repositoryRef: string; label: string }[]; readOnly: true }>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/files/git/roots`, signal ? { signal } : undefined),
  gitFilePreview: (connectionId: string, repositoryRef: string, pathToken: string, signal: AbortSignal) => readJson<unknown>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/files/git/${encodeURIComponent(repositoryRef)}/preview?${new URLSearchParams({pathToken})}`, {signal}),
  gitTree: (connectionId: string, repositoryRef: string, pathToken?: string, cursor?: string, signal?: AbortSignal) => {
    const query = new URLSearchParams(); if (pathToken) query.set('pathToken', pathToken); if (cursor) query.set('cursor', cursor);
    return readJson<unknown>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/files/git/${encodeURIComponent(repositoryRef)}/tree?${query}`, signal ? { signal } : undefined);
  },
  saveFileText: (scope: FileRequestScope, path: string, text: string, revision: string) =>
    json<{ revision: string }>(`${fileScopePath(scope)}/text`, { method: 'POST', body: JSON.stringify({ path, text, revision }) }),
  runtimeModels: (connectionId: string, runtime: string, signal?: AbortSignal) =>
    readJson<{ models: Array<{ id: string; label: string }> }>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/models/${encodeURIComponent(runtime)}`, signal ? { signal } : undefined),
  fileList: (scope: FileRequestScope, path = '', signal?: AbortSignal) =>
    readJson<FileBrowserListResponse>(`${fileScopePath(scope)}?${fileQuery(path)}`, signal ? { signal } : undefined),
  fileSourceDirectory: (scope: FileRequestScope, sourcePath: string, signal: AbortSignal) =>
    readJson<FileBrowserListResponse>(`${fileScopePath(scope)}?${new URLSearchParams({ sourcePath })}`, { signal }),
  filePreview: (scope: FileRequestScope, path: string) =>
    readJson<FileBrowserPreviewResponse>(`${fileScopePath(scope)}/preview?${fileQuery(path)}`),
  fileDownloadUrl: (scope: FileRequestScope, path: string, inline = false) =>
    apiUrl(`${fileScopePath(scope)}/download?${fileQuery(path, inline)}`),
  downloadFile: (scope: FileRequestScope, path: string, signal?: AbortSignal) =>
    fileResponse(`${fileScopePath(scope)}/download?${fileQuery(path)}`, response => response.blob(), signal ? { signal } : {}),
  uploadFile: (scope: FileRequestScope, path: string, file: File) => {
    const form = new FormData();
    form.set('file', file);
    return fileJson<{ ok: boolean; entry?: unknown }>(`${fileScopePath(scope)}/upload?${fileQuery(path)}`, { method: 'POST', body: form, timeoutMs: LONG_TIMEOUT_MS });
  },
  renameFile: (scope: FileRequestScope, path: string, name: string) =>
    json<{ ok: boolean; entry?: unknown }>(`${fileScopePath(scope)}/rename`, { method: 'PATCH', body: JSON.stringify({ path, name }) }),
  deleteFile: (scope: FileRequestScope, path: string) =>
    json<{ ok: boolean }>(`${fileScopePath(scope)}?${fileQuery(path)}`, { method: 'DELETE' }),
  queuedMessages: (sessionKey: string, cursor = '0', signal?: AbortSignal) =>
    readJson<QueuedMessagePage>(`${ownerSessionPath(sessionKey)}/queue?cursor=${encodeURIComponent(cursor)}`, signal ? { signal } : undefined),
  sharedSessionExecution: (sessionKey: SessionTarget, signal?: AbortSignal) => {
    const address = sessionAddress(sessionKey);
    if (!address.shared) throw new Error('Shared session address required');
    return readJson<SessionExecutionSnapshot>(`${address.path}/state`, signal ? { signal } : undefined, true);
  },
  sessionCollaborators: (sessionKey: SessionTarget, signal?: AbortSignal) => {
    const address = sessionAddress(sessionKey);
    return readJson<{ collaborators: HubNodeGrant[]; candidates?: Array<{ id: string; label: string; canChat: boolean }> }>(`${address.path}/collaborators`, signal ? { signal } : undefined);
  },
  shareSession: (sessionKey: SessionTarget, userId: string, role: 'observer' | 'collaborator') => {
    const address = sessionAddress(sessionKey);
    return json<{ grant: HubNodeGrant }>(`${address.path}/collaborators`, { method: 'POST', body: JSON.stringify({ userId, role }) });
  },
  updateSessionCollaborator: (sessionKey: SessionTarget, grant: HubNodeGrant, permissions: { role: 'observer' | 'collaborator'; live: boolean; queue: boolean; media: boolean }) => {
    const address = sessionAddress(sessionKey);
    return json<{ grant: HubNodeGrant }>(`${address.path}/collaborators/${encodeURIComponent(grant.id)}`, { method: 'PUT', body: JSON.stringify({ version: grant.version, ...permissions }) });
  },
  revokeSessionCollaborator: async (sessionKey: SessionTarget, grant: HubNodeGrant) => {
    const address = sessionAddress(sessionKey);
    return parseSessionRevocation(await json<unknown>(`${address.path}/collaborators/${encodeURIComponent(grant.id)}`, { method: 'DELETE', body: JSON.stringify({ version: grant.version }) }), true);
  },
  sessionCollaboratorRevocation: async (sessionKey: SessionTarget, grant: { id: string; version: number }, signal?: AbortSignal) => {
    const address = sessionAddress(sessionKey);
    if (!grant.id || !Number.isSafeInteger(grant.version) || grant.version < 1) throw new Error('Original grant version required');
    return parseSessionRevocation(await readJson<unknown>(`${address.path}/collaborators/${encodeURIComponent(grant.id)}/revocation?version=${grant.version}`, signal ? { signal } : undefined));
  },
  sharedQueuedMessages: (sessionKey: SessionTarget, cursor?: string, signal?: AbortSignal) => {
    const address = sessionAddress(sessionKey);
    if (!address.shared) throw new Error('Shared session address required');
    return readJson<SharedQueuedCommandPage>(`${address.path}/queue${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`, signal ? { signal } : undefined);
  },
  updateQueuedMessage: (sessionKey: SessionTarget, messageId: string, message: string, version: string, key: string, scope: string) =>
    json<{ ok: boolean; command?: CommandReceipt }>(queueMutationPath(sessionKey, messageId), {
      method: 'PATCH',
      headers: { 'if-match': JSON.stringify(version), 'idempotency-key': key, 'x-agentopsdeck-recovery-scope': scope },
      body: JSON.stringify({ message }),
    }),
  cancelQueuedMessage: (sessionKey: SessionTarget, messageId: string, version: string, key: string, scope: string) =>
    json<{ ok: boolean; command?: CommandReceipt }>(queueMutationPath(sessionKey, messageId), {
      method: 'DELETE', headers: { 'if-match': JSON.stringify(version), 'idempotency-key': key, 'x-agentopsdeck-recovery-scope': scope } }),
  queueMutationCommand: (sessionKey: SessionTarget, messageId: string, key: string, scope: string, signal?: AbortSignal) =>
    json<{ command: CommandReceipt }>(`${queueMutationPath(sessionKey, messageId)}/commands/${encodeURIComponent(key)}`, {
      cache: 'no-store', timeoutMs: 12_000, headers: { 'x-agentopsdeck-recovery-scope': scope }, ...(signal ? { signal } : {}),
    }),
  restartGateway: () => json<{ ok: boolean; result: unknown; gateway: GatewayHealth; updatedAt: number }>('/api/gateway/restart', { method: 'POST' }),
  // Hub connection management
  hubInfo: () => readJson<HubInfo>('/api/hub/v1/info'),
  hubMe: () => json<HubPrincipal>('/api/hub/v1/me'),
  accessDirectory: () => readJson<AccessDirectory>('/api/hub/v1/access/directory'),
  hubRole: (userId: string) => readJson<HubRoleState>(`/api/hub/v1/access/users/${encodeURIComponent(userId)}/hub-role`),
  saveHubRole: (userId: string, payload: HubRoleState) => json<HubRoleState>(`/api/hub/v1/access/users/${encodeURIComponent(userId)}/hub-role`, { method: 'PUT', body: JSON.stringify(payload) }),
  connectorMembership: (connection: AccessConnection, userId: string) => readJson<ConnectorMembership>(membershipPath(connection, userId)),
  saveConnectorMembership: (connection: AccessConnection, userId: string, payload: Pick<ConnectorMembership, 'role' | 'version' | 'environments' | 'grantSetDigest'> & { nodeVersion: number; migrateLegacy: boolean }) => json<ConnectorMembership>(membershipPath(connection, userId), { method: 'PUT', body: JSON.stringify(payload) }),
  hubLoginKeys: (userId: string) => readJson<{ keys: HubLoginKey[] }>(`/api/hub/v1/users/${encodeURIComponent(userId)}/login-keys`),
  hubUserAccess: async (userId: string) => parseHubAccountAccess(await readJson<unknown>(`/api/hub/v1/users/${encodeURIComponent(userId)}/access`), userId),
  hubChangeUserAccess: async (userId: string, change: { status: HubAccountAccess['status']; expectedVersion: number }) =>
    parseHubAccountAccess(await json<unknown>(`/api/hub/v1/users/${encodeURIComponent(userId)}/access`, { method: 'PATCH', body: JSON.stringify(change) }), userId, change),
  hubIssueLoginKey: (userId: string) => json<{ id: string; token: string }>(`/api/hub/v1/users/${encodeURIComponent(userId)}/login-keys`, { method: 'POST' }),
  hubRevokeLoginKey: (userId: string, keyId: string) => json<{ ok: boolean }>(`/api/hub/v1/users/${encodeURIComponent(userId)}/login-keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' }),
  hubNodeGrants: (connectionId: string, after?: string) => readJson<HubNodeGrantPage>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/grants?limit=50${after ? `&after=${encodeURIComponent(after)}` : ''}`),
  hubExecutionIssuer: (connectionId: string) => readJson<HubExecutionIssuer>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/execution-issuer`),
  hubSetupLocalExecution: (connectionId: string, nodeVersion: number, createSessions = false) => json<{ issuer: NonNullable<HubExecutionIssuer['issuer']> }>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/execution-issuer/local`, { method: 'POST', body: JSON.stringify({ confirm: true, nodeVersion, ...(createSessions ? { createSessions: true } : {}) }) }),
  sharedCreationEnvironments: (after?: string, signal?: AbortSignal) => readJson<{ environments: SharedCreationEnvironment[]; nextCursor: string | null }>(`/api/hub/v1/shared/creation-environments${after ? `?after=${encodeURIComponent(after)}` : ''}`, signal ? { signal } : undefined),
  hubConfigureExecution: (connectionId: string, token: string) => json<HubExecutionIssuer>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/execution-issuer`, { method: 'PUT', body: JSON.stringify({ token }) }),
  hubDisableExecution: (connectionId: string) => json<{ ok: boolean }>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/execution-issuer`, { method: 'DELETE' }),
  hubUpdateNodeGrant: (connectionId: string, grant: HubNodeGrant, nodeVersion: number, policy: NodeGrantPolicy) => json<{ grant: HubNodeGrant }>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/grants/${encodeURIComponent(grant.id)}`, { method: 'PUT', body: JSON.stringify({ version: grant.version, nodeVersion, policy }) }),
  hubCreateNodeGrant: (connectionId: string, payload: { userId: string; nodeVersion: number; policy: NodeGrantPolicy }) => json<{ grant: HubNodeGrant }>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/grants`, { method: 'POST', body: JSON.stringify(payload) }),
  hubRevokeNodeGrant: (connectionId: string, grant: HubNodeGrant) => json<{ grant: HubNodeGrant }>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/grants/${encodeURIComponent(grant.id)}`, { method: 'DELETE', body: JSON.stringify({ version: grant.version }) }),
  hubUsers: () => readJson<{ users: HubUser[]; updatedAt: number }>('/api/hub/v1/users'),
  hubCreateUser: (payload: { label: string }) => json<{ user: HubUser; updatedAt: number }>('/api/hub/v1/users', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  hubUpdateUser: (id: string, payload: { label: string }) => json<{ user: HubUser; updatedAt: number }>(`/api/hub/v1/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  }),
  hubConnectorUsers: () => readJson<{ connections: ConnectorUsersByConnection[]; updatedAt: number }>('/api/hub/v1/connector-users'),
  hubCreateConnectorUser: (connectionId: string, payload: { label: string }) => json<{ user: ConnectorUser; updatedAt: number }>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/connector-users`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  hubUpdateConnectorUser: (connectionId: string, id: string, payload: { label: string }) => json<{ user: ConnectorUser; updatedAt: number }>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/connector-users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  }),
  hubConnections: () => readJson<{ connections: HubConnection[]; updatedAt: number }>('/api/hub/v1/connections'),
  prepareUsageManifest: (input: import('./lib/usage-manifest.js').UsageManifestInput, signal: AbortSignal) =>
    json<{manifest:import('./lib/usage-manifest.js').UsageManifestView}>('/api/hub/v1/usage-manifests', {method:'POST',body:JSON.stringify(input),signal,cache:'no-store'}),
  usageManifest: (id:string, action:'inspect'|'confirm'|'continue'|'cancel', signal:AbortSignal) =>
    json<{manifest:import('./lib/usage-manifest.js').UsageManifestView|null;cancelled?:boolean;requestId?:string}>(`/api/hub/v1/usage-manifests/${encodeURIComponent(id)}${action==='confirm'||action==='continue'?'/'+action:''}`,
      {method:action==='inspect'?'GET':action==='cancel'?'DELETE':'POST',...(action==='confirm'||action==='continue'?{body:'{}'}:{}),signal,cache:'no-store'}),
  prepareTaskSession: (board: string, input: import('./lib/workspace-task-session.js').TaskSessionInput, signal: AbortSignal) =>
    json<{ receipt: import('./lib/workspace-task-session.js').TaskSessionReceipt }>(`/api/hub/v1/workspace/boards/${encodeURIComponent(board)}/task-sessions`, { method: 'POST', body: JSON.stringify(input), signal, cache: 'no-store' }),
  taskSession: (board: string, id: string, action: 'inspect'|'create'|'bind'|'cancel', signal: AbortSignal) =>
    json<{ receipt: import('./lib/workspace-task-session.js').TaskSessionReceipt|null; cancelled?: boolean; requestId?: string }>(`/api/hub/v1/workspace/boards/${encodeURIComponent(board)}/task-sessions/${encodeURIComponent(id)}${action==='create'||action==='bind'?'/'+action:''}`,
      { method: action==='inspect'?'GET':action==='cancel'?'DELETE':'POST', ...(action==='create'||action==='bind'?{body:'{}'}:{}), signal, cache:'no-store' }),
  metricSources: (signal: AbortSignal) => readJson<{ sources: { key: string; kind: 'hub' | 'connector'; id: string; label: string }[] }>('/api/hub/v1/system/metrics/sources', { signal }),
  systemMetrics: (kind: 'hub' | 'connector', key: string, signal: AbortSignal) => readJson<import('@agentopsdeck/shared').SystemMetrics>(`/api/hub/v1/system/metrics/${kind === 'hub' ? 'hub' : `connectors/${encodeURIComponent(key)}`}`, { signal }),
  websiteConnections: (signal: AbortSignal) => readJson<{ connections: HubConnection[] }>('/api/hub/v1/connections', { signal }),
  terminalTargets: (connection: string, signal: AbortSignal) => json<{ targets: { id: string; label: string; kind: 'local' | 'ssh' }[] }>(`/api/hub/v1/connections/${encodeURIComponent(connection)}/terminals/targets`, { signal }),
  terminalStart: (connection: string, targetId: string, cols: number, rows: number, signal: AbortSignal) => json<{ id: string }>(`/api/hub/v1/connections/${encodeURIComponent(connection)}/terminals`, { method: 'POST', body: JSON.stringify({ targetId, requestId: crypto.randomUUID(), cols, rows }), signal }),
  terminalInput: (connection: string, id: string, sequence: number, data: string, signal: AbortSignal) => json<{ accepted: boolean }>(`/api/hub/v1/connections/${encodeURIComponent(connection)}/terminals/${encodeURIComponent(id)}/input`, { method: 'POST', body: JSON.stringify({ sequence, data }), signal }),
  terminalResize: (connection: string, id: string, cols: number, rows: number, signal: AbortSignal) => json<unknown>(`/api/hub/v1/connections/${encodeURIComponent(connection)}/terminals/${encodeURIComponent(id)}/resize`, { method: 'POST', body: JSON.stringify({ cols, rows }), signal }),
  terminalOutput: (connection: string, id: string, cursor: number, signal: AbortSignal) => json<{ data: string; cursor: number; truncated: boolean; more: boolean; running: boolean }>(`/api/hub/v1/connections/${encodeURIComponent(connection)}/terminals/${encodeURIComponent(id)}/output?cursor=${cursor}`, { signal, timeoutMs: 35_000 }),
  terminalStop: (connection: string, id: string) => json<unknown>(`/api/hub/v1/connections/${encodeURIComponent(connection)}/terminals/${encodeURIComponent(id)}`, { method: 'DELETE', timeoutMs: 4000 }),
  researchConfig: (signal: AbortSignal) => readJson<unknown>('/api/hub/v1/workspace/research/config', { signal }),
  quickChatConfig: (signal: AbortSignal) => json<unknown>('/api/hub/v1/quick-chat', { signal }),
  quickChatProfile: (id: string, value: { revision: number; name: string; target: string; model: string; outputLimit: number }, signal: AbortSignal) =>
    json<unknown>(`/api/hub/v1/quick-chat/profiles/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(value), signal }),
  quickChatSend: (value: { requestId: string; profileId: string; revision: number; input: string; history?: Array<{ role: 'user' | 'assistant'; content: string }> }, signal: AbortSignal) =>
    json<unknown>('/api/hub/v1/quick-chat/requests', { method: 'POST', body: JSON.stringify(value), signal, timeoutMs: 50_000 }),
  quickChatRequest: (id: string, action: 'inspect' | 'clear' | 'cancel', signal: AbortSignal) =>
    json<unknown>(`/api/hub/v1/quick-chat/requests/${encodeURIComponent(id)}${action === 'clear' ? '/result' : action === 'cancel' ? '/cancel' : ''}`,
      { method: action === 'clear' ? 'DELETE' : action === 'cancel' ? 'POST' : 'GET', signal }),
  browserConfig: (signal: AbortSignal) => json<{ enabled: boolean; hosts: string[] }>('/api/hub/v1/workspace/browser/config', { signal }),
  browserStart: (id: string, signal: AbortSignal) => json<import('./lib/workspace-browser.js').BrowserState>('/api/hub/v1/workspace/browser/sessions', { method: 'POST', body: JSON.stringify({ id }), signal, timeoutMs: 20_000 }),
  browserFrame: (id: string, hash: string, signal: AbortSignal) => json<import('./lib/workspace-browser.js').BrowserFrame>(`/api/hub/v1/workspace/browser/sessions/${encodeURIComponent(id)}/frame${hash ? `?hash=${encodeURIComponent(hash)}` : ''}`, { signal, timeoutMs: 10_000 }),
  browserAction: (id: string, seq: number, action: import('./lib/workspace-browser.js').BrowserInput, signal: AbortSignal) => json<import('./lib/workspace-browser.js').BrowserState>(`/api/hub/v1/workspace/browser/sessions/${encodeURIComponent(id)}/actions`, { method: 'POST', body: JSON.stringify({ ...action, seq }), signal, timeoutMs: 18_000 }),
  browserStop: (id: string) => json<unknown>(`/api/hub/v1/workspace/browser/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', timeoutMs: 4000 }),
  researchSearch: (query: string, signal: AbortSignal) => json<unknown>('/api/hub/v1/workspace/research/search', { method: 'POST', body: JSON.stringify({ query }), signal, timeoutMs: 16_000 }),
  researchRead: (searchId: string, sourceId: string, signal: AbortSignal, retain = false) => json<unknown>('/api/hub/v1/workspace/research/read', {
    method: 'POST', body: JSON.stringify({ searchId, sourceId, consent: true, ...(retain ? { retain: true } : {}) }), signal, timeoutMs: 20_000,
  }),
  researchReadManySynthesize: (searchId: string, selections: import('@agentopsdeck/shared').ResearchReadingSelection[], signal: AbortSignal, model?: string) => json<unknown>('/api/hub/v1/workspace/research/read/synthesize-many', {
    method: 'POST', body: JSON.stringify({ searchId, selections, consent: true, ...(model ? { model } : {}) }), signal, timeoutMs: 50_000,
  }),
  researchReadSynthesize: (searchId: string, articleId: string, mode: 'full' | 'selection', range: import('@agentopsdeck/shared').ResearchReadingRange | undefined, signal: AbortSignal, model?: string) => json<unknown>('/api/hub/v1/workspace/research/read/synthesize', {
    method: 'POST', body: JSON.stringify({ searchId, articleId, mode, ...(mode === 'selection' ? { range } : {}), consent: true, ...(model ? { model } : {}) }), signal, timeoutMs: 50_000,
  }),
  remoteDevices: (signal?: AbortSignal) => json<{ devices: import('@agentopsdeck/shared').RemoteDevice[] }>('/api/hub/v1/workspace/remote/devices', { ...(signal ? { signal } : {}) }),
  remoteEnable: (snapshot: import('@agentopsdeck/shared').RemoteSnapshot, signal: AbortSignal) => json<{ device: import('@agentopsdeck/shared').RemoteDevice; hostToken: string }>('/api/hub/v1/workspace/remote/devices', { method: 'POST', body: JSON.stringify(snapshot), signal }),
  remoteDisable: (id: string) => json<{ ok: boolean }>(`/api/hub/v1/workspace/remote/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  remoteUpdate: (id: string, hostToken: string, snapshot: import('@agentopsdeck/shared').RemoteSnapshot, signal: AbortSignal) => json<import('@agentopsdeck/shared').RemoteDevice>(`/api/hub/v1/workspace/remote/devices/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'X-Workspace-Host': hostToken }, body: JSON.stringify(snapshot), signal }),
  remoteReceive: (id: string, hostToken: string, signal: AbortSignal) => json<{ command: import('@agentopsdeck/shared').RemoteDelivery | null }>(`/api/hub/v1/workspace/remote/devices/${encodeURIComponent(id)}/receive`, { headers: { 'X-Workspace-Host': hostToken }, signal, timeoutMs: 30_000 }),
  remoteAck: (id: string, hostToken: string, command: string, result: import('@agentopsdeck/shared').RemoteOutcome, signal: AbortSignal) => json<{ ok: boolean }>(`/api/hub/v1/workspace/remote/devices/${encodeURIComponent(id)}/ack`, { method: 'POST', headers: { 'X-Workspace-Host': hostToken }, body: JSON.stringify({ id: command, result }), signal }),
  remoteCommand: (id: string, command: import('@agentopsdeck/shared').RemoteCommand, signal: AbortSignal) => json<{ result: import('@agentopsdeck/shared').RemoteOutcome }>(`/api/hub/v1/workspace/remote/devices/${encodeURIComponent(id)}/commands`, { method: 'POST', body: JSON.stringify(command), signal, timeoutMs: 12_000 }),
  researchSynthesize: (searchId: string, sourceIds: string[], signal: AbortSignal, model?: string) => json<unknown>('/api/hub/v1/workspace/research/synthesize', {
    method: 'POST', body: JSON.stringify({ searchId, sourceIds, consent: true, ...(model ? { model } : {}) }), signal, timeoutMs: 50_000,
  }),
  websiteCatalog: (connectionId: string, signal: AbortSignal) => readJson<unknown>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/websites/catalog`, { signal }),
  websiteActions: (connectionId: string, serviceId: string, signal: AbortSignal) => readJson<unknown>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/website-actions/catalog/${encodeURIComponent(serviceId)}`, { signal }),
  websiteActionOpen: (connectionId: string, serviceId: string, actionId: string, signal: AbortSignal, previousAccessId?: string) => json<unknown>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/website-actions`, { method: 'POST', body: JSON.stringify({ serviceId, actionId, ...(previousAccessId ? { previousAccessId } : {}) }), signal }),
  websiteActionExecute: (connectionId: string, id: string, body: string, signal: AbortSignal) => json<unknown>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/website-actions/${encodeURIComponent(id)}/execute`, { method: 'POST', body: JSON.stringify({ body }), signal, timeoutMs: 15_000 }),
  websiteActionReceipt: (connectionId: string, id: string, signal: AbortSignal) => readJson<unknown>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/website-actions/${encodeURIComponent(id)}`, { signal }),
  websiteActionClose: (connectionId: string, id: string) => json<unknown>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/website-actions/${encodeURIComponent(id)}`, { method: 'DELETE', timeoutMs: 4000 }),
  websiteSnapshot: (connectionId: string, serviceId: string, signal: AbortSignal) => readJson<unknown>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/websites/${encodeURIComponent(serviceId)}/snapshot`, { signal }),
  websiteAccessOpen: (connectionId: string, serviceId: string, signal: AbortSignal) => json<unknown>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/website-access`, { method: 'POST', body: JSON.stringify({ serviceId }), signal }),
  websiteAccessBrowser: (connectionId: string, accessId: string, signal: AbortSignal) => json<unknown>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/website-access/${encodeURIComponent(accessId)}/browser`, { method: 'POST', body: '{}', signal }),
  websiteAccessClose: (connectionId: string, accessId: string) => json<unknown>(`/api/hub/v1/connections/${encodeURIComponent(connectionId)}/website-access/${encodeURIComponent(accessId)}`, { method: 'DELETE' }),
  sharedGrants: (after?: string, signal?: AbortSignal) => readJson<SharedGrantPage>(
    `/api/hub/v1/shared/grants?limit=50${after ? `&after=${encodeURIComponent(after)}` : ''}`, signal ? { signal } : undefined),
  sharedGrantSessions: (target: SharedGrantTarget, after?: string, signal?: AbortSignal) => readJson<SharedSessionDirectoryPage>(
    `${sharedGrantSessionsPath(target)}?limit=50${after ? `&after=${encodeURIComponent(after)}` : ''}`, signal ? { signal } : undefined),
  hubCreateConnection: (payload: {
    label?: string;
    connectorUrl: string;
    /** Bearer token — sent once to server-side vault; never stored/displayed after submit. */
    token?: string;
    environmentId?: string;
    environmentLabel?: string;
    capabilities?: string[];
    enabled?: boolean;
  }) => json<{ connection: HubConnection; updatedAt: number }>('/api/hub/v1/connections', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  hubUpdateConnection: (id: string, payload: { label?: string; environmentLabel?: string; environmentId?: string; enabled?: boolean }) =>
    json<{ connection: HubConnection; updatedAt: number }>(`/api/hub/v1/connections/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  hubDeleteConnection: (id: string) => json<{ ok: boolean }>(`/api/hub/v1/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  hubSaveMaintenanceCredential: (id: string, payload: { token: string }) => json<{ ok: boolean; hasMaintenanceCredential: boolean; updatedAt: number }>(`/api/hub/v1/connections/${encodeURIComponent(id)}/maintenance-credential`, { method: 'PUT', body: JSON.stringify(payload) }),
  hubLifecycleStatus: (id: string, scope: string, signal?: AbortSignal) => readJson<ConnectorLifecycleStatus>(
    `/api/hub/v1/connections/${encodeURIComponent(id)}/lifecycle/status`, { timeoutMs: 12_000, headers: { 'x-agentopsdeck-recovery-scope': scope }, ...(signal ? { signal } : {}) }),
  hubLifecycleCommand: (target: LifecycleTarget, key: string, scope: string, signal?: AbortSignal) => json<ConnectorLifecycleReceipt>(lifecyclePath(target), {
    method: 'POST', timeoutMs: 12_000, headers: { 'x-agentopsdeck-recovery-scope': scope }, body: JSON.stringify({ idempotencyKey: key }), ...(signal ? { signal } : {}),
  }),
  hubLifecycleReceipt: (target: LifecycleTarget, key: string, scope: string, signal?: AbortSignal) => readJson<ConnectorLifecycleReceipt>(
    `${lifecyclePath(target)}/${encodeURIComponent(key)}`, { timeoutMs: 12_000, headers: { 'x-agentopsdeck-recovery-scope': scope }, ...(signal ? { signal } : {}) }),
  hubConnectionAgents: (id: string, signal?: AbortSignal) => readJson<{ agents: AgentSummary[] }>(`/api/hub/v1/connections/${encodeURIComponent(id)}/agents`, { ...(signal ? { signal } : {}), timeoutMs: 12_000 }),
  hubConnectionCapabilities: (id: string) => readJson<ConnectorCapabilities>(`/api/hub/v1/connections/${encodeURIComponent(id)}/capabilities`),
  hubModelSetStatus: (id: string) => readJson<GatewayModelSetStatus>(`/api/hub/v1/connections/${encodeURIComponent(id)}/gateway/model-set`),
  hubReconcileModelSet: (id: string, key: string, scope: string) => json<{ status?: GatewayModelSetStatus; ok?: boolean; restartRequired?: boolean }>(`/api/hub/v1/connections/${encodeURIComponent(id)}/gateway/model-set/reconcile`, { method: 'POST', headers: {'x-agentopsdeck-recovery-scope': scope}, body: JSON.stringify({ idempotencyKey: key }) }),
  hubUpdateStatus: (id: string) => readJson<ConnectorUpdateStatus>(`/api/hub/v1/connections/${encodeURIComponent(id)}/update/status`),
  hubAdmissionStatus: async (id: string, scope: string, signal?: AbortSignal) => {
    const result = readConnectorAdmissionStatus(await readJson<unknown>(`/api/hub/v1/connections/${encodeURIComponent(id)}/maintenance/status`,
      { headers: { 'x-agentopsdeck-recovery-scope': scope }, ...(signal ? { signal } : {}) }));
    if (!result) throw new Error('Connector admission status unavailable');
    return result;
  },
  hubCheckUpdate: (id: string, key: string, scope: string) => json<ConnectorUpdateStatus>(`/api/hub/v1/connections/${encodeURIComponent(id)}/update/check`, { method: 'POST', headers: {'x-agentopsdeck-recovery-scope': scope}, body: JSON.stringify({ channel: 'stable', idempotencyKey: key }) }),
  hubControlReceipt: (target: ConnectionControlTarget, key: string, scope: string, signal?: AbortSignal) => readJson<{command: unknown}>(
    `/api/hub/v1/connections/${encodeURIComponent(target.connectionId)}/control/receipts/${encodeURIComponent(key)}?${new URLSearchParams({operation: target.operation})}`,
    {timeoutMs: 12_000, headers: {'x-agentopsdeck-recovery-scope': scope}, ...(signal ? {signal} : {})}),
  hubMaintenanceCommand: async (target: MaintenanceTarget, key: string, scope: string, payload: { version?: string; revision?: string | undefined; manifestSha256?: string; fenceId?: string }) => {
    const { command, ...body } = await json<Partial<ConnectorUpdateStatus> & { command?: CommandReceipt }>(maintenancePath(target), {
      method: 'POST', headers: { 'x-agentopsdeck-recovery-scope': scope }, body: JSON.stringify({ ...payload, idempotencyKey: key }),
    });
    return command ? { ...command, ...(command.state === 'accepted' ? { result: { status: 200, body } } : {}) } : undefined;
  },
  hubMaintenanceReceipt: (target: MaintenanceTarget, key: string, scope: string, signal?: AbortSignal) => readJson<{ command: CommandReceipt }>(
    `${maintenancePath(target)}/${encodeURIComponent(key)}`, { timeoutMs: 12_000, headers: { 'x-agentopsdeck-recovery-scope': scope }, ...(signal ? { signal } : {}) }),
  hubTestConnection: (payload: { connectorUrl: string; token?: string }) => json<HubConnectionTestResult>('/api/hub/v1/connections/test', {
    method: 'POST',
    body: JSON.stringify(payload),
    timeoutMs: LONG_TIMEOUT_MS,
  }),
  hubDockerSandboxes: (signal?: AbortSignal) =>
    readJson<{
      engine: import('./lib/connector-architecture.js').HubDockerEngineStatus;
      sandboxes: import('./lib/connector-architecture.js').HubDockerSandboxInstance[];
    }>('/api/hub/v1/docker-sandboxes', signal ? { signal } : undefined),
  hubCreateDockerSandbox: (payload: import('./lib/connector-architecture.js').HubDockerSandboxCreatePayload) =>
    json<{
      sandbox: import('./lib/connector-architecture.js').HubDockerSandboxInstance;
      connection?: HubConnection | undefined;
    }>('/api/hub/v1/docker-sandboxes', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  hubRenewDockerSandbox: (sandboxId: string, extendMinutes = 60) =>
    json<{
      sandbox: import('./lib/connector-architecture.js').HubDockerSandboxInstance;
    }>(`/api/hub/v1/docker-sandboxes/${encodeURIComponent(sandboxId)}/renew`, {
      method: 'POST',
      body: JSON.stringify({ extendMinutes }),
    }),
  hubStopDockerSandbox: (sandboxId: string, remove = false) =>
    json<{
      sandbox: import('./lib/connector-architecture.js').HubDockerSandboxInstance;
    }>(`/api/hub/v1/docker-sandboxes/${encodeURIComponent(sandboxId)}${remove ? '?remove=1' : ''}`, {
      method: 'DELETE',
    }),
};
export const sessionInteractionReads = createInteractionReads((key, signal) => api.sessionInteractions(key, signal), 4, Date.now,
  (key, signal) => api.sessionInteractionCapability(key, signal));
