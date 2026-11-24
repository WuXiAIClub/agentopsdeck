/** Additive, fail-closed contract. Native request IDs stay inside the worker. */
export const AGENT_INTERACTION_VERSION = 1;
export const INTERACTION_MAX_TTL_MS = 30 * 60_000;
export const INTERACTION_MAX_TEXT = 8_000;
export type InteractionKind = 'approval' | 'text' | 'single-select' | 'multi-select';
export type InteractionMode = 'automatic' | 'interactive';
export type InteractionScope = {
  ownerId: string; nodeId: string; sessionKey: string; runId: string;
};
export type InteractionRequest = InteractionScope & {
  version: 1;
  requestId: string;
  kind: InteractionKind;
  prompt: string;
  createdAt: number;
  expiresAt: number;
  options?: { id: string; label: string; description?: string }[];
  allowFreeform?: boolean;
};
export type InteractionAnswer =
  | { kind: 'approval'; decision: 'allow-once' | 'deny' }
  | { kind: 'text'; text: string }
  | { kind: 'single-select' | 'multi-select'; optionIds: string[]; text?: string };
export type InteractionCapabilities = {
  version: 1;
  kinds: InteractionKind[];
  modes: ('automatic' | 'interactive')[];
};

export type InteractionView = {
  request: InteractionRequest; revision: number;
  status: 'pending' | 'answered' | 'closed';
  delivery: 'none' | 'queued' | 'claimed' | 'confirmed' | 'unknown' | 'cancelled';
  reason?: 'expired' | 'stopped' | 'disconnected' | 'revoked' | 'restarted';
};
export type InteractionSnapshot = { version: 1; mode: InteractionMode; capabilities: InteractionCapabilities; requests: InteractionView[] };
export type InteractionSubmission = { runId: string; responseId: string; expectedRevision: number; answer: unknown };
export function readInteractionSubmission(value: unknown): InteractionSubmission | undefined {
  if (!record(value) || !exact(value, ['runId', 'responseId', 'expectedRevision', 'answer']) || !id(value.runId)
    || !id(value.responseId) || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1 || !record(value.answer)) return;
  return structuredClone(value) as InteractionSubmission;
}
export function readInteractionView(value: unknown): InteractionView | undefined {
  if (!record(value) || !exact(value, ['request', 'revision', 'status', 'delivery', 'reason']) || !readInteractionRequest(value.request)
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || !['pending', 'answered', 'closed'].includes(String(value.status))
    || !['none', 'queued', 'claimed', 'confirmed', 'unknown', 'cancelled'].includes(String(value.delivery))) return;
  if (value.status === 'pending' && value.delivery !== 'none' || value.status === 'closed' && value.delivery !== 'cancelled'
    || value.status === 'answered' && value.delivery === 'none') return;
  if (value.status === 'closed' ? !['expired', 'stopped', 'disconnected', 'revoked', 'restarted'].includes(String(value.reason)) : value.reason !== undefined) return;
  return structuredClone(value) as InteractionView;
}
export function readInteractionSnapshot(value: unknown): InteractionSnapshot | undefined {
  if (!record(value) || !exact(value, ['version', 'mode', 'capabilities', 'requests']) || value.version !== 1
    || !['automatic', 'interactive'].includes(String(value.mode)) || !Array.isArray(value.requests) || value.requests.length > 64) return;
  const requests = value.requests.map(readInteractionView);
  if (requests.some(v => !v) || new Set(requests.map(v => v!.request.requestId)).size !== requests.length) return;
  return { version: 1, mode: value.mode as InteractionMode, capabilities: readInteractionCapabilities(value.capabilities), requests: requests as InteractionView[] };
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).every(key => keys.includes(key));
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}
function id(value: unknown): value is string {
  return text(value, 256) && !/[\x00-\x1f\x7f]/.test(value);
}
const kinds: InteractionKind[] = ['approval', 'text', 'single-select', 'multi-select'];

/** Missing/legacy or malformed capabilities never enable human control. */
export function readInteractionCapabilities(value: unknown): InteractionCapabilities {
  const disabled: InteractionCapabilities = { version: 1, kinds: [], modes: ['automatic'] };
  if (!record(value) || !exact(value, ['version', 'kinds', 'modes']) || value.version !== 1
    || !Array.isArray(value.kinds) || value.kinds.length > kinds.length
    || !value.kinds.every(k => kinds.includes(k)) || new Set(value.kinds).size !== value.kinds.length
    || !Array.isArray(value.modes) || value.modes.length > 2 || !value.modes.includes('automatic')
    || !value.modes.every(m => m === 'automatic' || m === 'interactive')
    || new Set(value.modes).size !== value.modes.length) return disabled;
  return { version: 1, kinds: [...value.kinds], modes: [...value.modes] };
}

export function readInteractionRequest(value: unknown): InteractionRequest | undefined {
  if (!record(value) || !exact(value, ['version', 'ownerId', 'nodeId', 'sessionKey', 'runId',
    'requestId', 'kind', 'prompt', 'createdAt', 'expiresAt', 'options', 'allowFreeform'])
    || value.version !== 1 || !['ownerId', 'nodeId', 'sessionKey', 'runId', 'requestId'].every(k => id(value[k]))
    || !kinds.includes(value.kind as InteractionKind) || !text(value.prompt, INTERACTION_MAX_TEXT)
    || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt)) return undefined;
  const createdAt = value.createdAt as number, expiresAt = value.expiresAt as number;
  if (createdAt < 0 || expiresAt <= createdAt || expiresAt - createdAt > INTERACTION_MAX_TTL_MS) return undefined;
  const select = value.kind === 'single-select' || value.kind === 'multi-select';
  if (select) {
    if (value.allowFreeform !== undefined && typeof value.allowFreeform !== 'boolean') return undefined;
    if (!Array.isArray(value.options) || !value.options.length || value.options.length > 32
      || !value.options.every(o => record(o) && exact(o, ['id', 'label', 'description']) && id(o.id) && text(o.label, 240)
        && (o.description === undefined || text(o.description, 2000)))
      || new Set(value.options.map(o => o.id)).size !== value.options.length) return undefined;
  } else if (Object.hasOwn(value, 'options') || Object.hasOwn(value, 'allowFreeform')) return undefined;
  return structuredClone(value) as InteractionRequest;
}

export function readInteractionAnswer(request: InteractionRequest, value: unknown): InteractionAnswer | undefined {
  if (!record(value) || value.kind !== request.kind) return undefined;
  if (value.kind === 'approval' && exact(value, ['kind', 'decision'])
    && (value.decision === 'allow-once' || value.decision === 'deny')) {
    return { kind: 'approval', decision: value.decision };
  }
  if (value.kind === 'text' && exact(value, ['kind', 'text']) && text(value.text, INTERACTION_MAX_TEXT)) {
    return { kind: 'text', text: value.text };
  }
  if ((value.kind === 'single-select' || value.kind === 'multi-select') && exact(value, ['kind', 'optionIds'])
    && Array.isArray(value.optionIds) && value.optionIds.length > 0 && value.optionIds.length <= 32
    && (value.kind !== 'single-select' || value.optionIds.length === 1)
    && new Set(value.optionIds).size === value.optionIds.length
    && value.optionIds.every(id => request.options?.some(option => option.id === id))) {
    return { kind: value.kind, optionIds: [...value.optionIds].sort() };
  }
  if ((value.kind === 'single-select' || value.kind === 'multi-select') && request.allowFreeform === true
    && exact(value, ['kind', 'optionIds', 'text']) && Array.isArray(value.optionIds) && value.optionIds.length === 0
    && text(value.text, INTERACTION_MAX_TEXT)) return { kind: value.kind, optionIds: [], text: value.text };
  return undefined;
}
