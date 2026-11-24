import { translate, type Locale } from './i18n.js';

// Translate known protocol labels, never operator-provided error text.
const label = (text: string, locale: Locale) => translate(text, locale);

/**
 * Pure maintenance-control helpers extracted from HubConnectionsPanel.
 *
 * These operate on structural shapes compatible with the shared
 * `ConnectorUpdateStatus` / `GatewayModelSetStatus` types. They are kept
 * dependency-free (no `@agentopsdeck/shared` import) so they can be unit-tested
 * under the web test tsconfig's `rootDir` without pulling package sources in.
 */

export type UpdateStatusLike = {
  state: string;
  targetVersion?: string | undefined;
  targetRevision?: string | undefined;
  manifestSha256?: string | undefined;
  rollbackAvailable: boolean;
  restartRequired?: boolean | undefined;
  lastError?: string | undefined;
};

export type ModelSetStatusLike = {
  converged: boolean;
  missing: string[];
  restartRequired?: boolean | undefined;
};

export function compactResponseNotice(result: { status: string; message?: string }, fallback: string): string {
  if (result.status === 'compacting') return 'Compaction admitted · waiting for native confirmation';
  if (result.status === 'outcome_unknown') return 'Compact outcome unknown. It may already be running; check the session before submitting again. This request was not automatically resent.';
  return result.message || fallback;
}

export type ConnectorUpdateApplyPayload = {
  version: string;
  revision?: string | undefined;
  manifestSha256: string;
};

export function canApplyConnectorUpdate(busy: boolean, update?: UpdateStatusLike): boolean {
  return !busy && !!update?.targetVersion && !!update.manifestSha256?.trim();
}

export function canRollbackConnectorUpdate(busy: boolean, update?: UpdateStatusLike): boolean {
  return !busy && !!update?.rollbackAvailable;
}

export function buildConnectorUpdateApplyPayload(update: UpdateStatusLike): ConnectorUpdateApplyPayload | undefined {
  const manifestSha256 = update.manifestSha256?.trim();
  if (!update.targetVersion || !manifestSha256) return undefined;
  return {
    version: update.targetVersion,
    revision: update.targetRevision,
    manifestSha256,
  };
}

export function formatModelSetStatus(model?: ModelSetStatusLike, locale: Locale = 'en'): string {
  if (!model) return label('not loaded', locale);
  return `${model.converged ? label('Converged', locale) : translate('Missing {count}', locale, { count: model.missing.length })}${model.restartRequired ? ` · ${label('restart required', locale)}` : ''}`;
}

export function formatConnectorUpdateStatus(update?: UpdateStatusLike, locale: Locale = 'en'): string {
  if (!update) return label('not loaded', locale);
  return `${label(update.state, locale)}${update.restartRequired ? ` · ${label('restart required', locale)}` : ''}${update.lastError ? ` · ${update.lastError}` : ''}`;
}
import type { ConnectorUpdateStatus } from '@agentopsdeck/shared';

export type ConnectorAdmissionStatus = {
  state: 'paused' | 'resuming' | 'released';
  boundary: 'admission_only';
  nativeQuiescent: false;
  fenceId?: string;
  resumeInterrupted?: true;
};
export type ConnectorMaintenanceResult = ConnectorUpdateStatus | ConnectorAdmissionStatus;

export function readConnectorAdmissionStatus(value: unknown): ConnectorAdmissionStatus | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  const state = body.state;
  if ((state !== 'paused' && state !== 'resuming' && state !== 'released') || body.boundary !== 'admission_only' || body.nativeQuiescent !== false
    || (body.fenceId !== undefined && (typeof body.fenceId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.fenceId)))
    || (state !== 'released' && body.fenceId === undefined)
    || (body.resumeInterrupted !== undefined && (body.resumeInterrupted !== true || state !== 'paused'))) return undefined;
  return { state, boundary: 'admission_only', nativeQuiescent: false,
    ...(typeof body.fenceId === 'string' ? { fenceId: body.fenceId } : {}), ...(body.resumeInterrupted === true ? { resumeInterrupted: true } : {}) };
}

export function formatMaintenanceResult(status: ConnectorMaintenanceResult, locale: Locale = 'en'): string {
  return 'boundary' in status ? `${label(status.state, locale)} · ${label('admission only', locale)} · ${label('native idle not verified', locale)}${status.resumeInterrupted ? ` · ${label('resume interrupted; still paused', locale)}` : ''}`
    : formatConnectorUpdateStatus(status, locale);
}
