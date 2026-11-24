import { randomUUID } from 'node:crypto';
import type { WeixinStatus } from '@agentopsdeck/shared';
import type { HubStore } from './hub-store.js';
import type { WeixinBinding } from './weixin-store.js';
import { WEIXIN_ORIGIN, WeixinError, weixinOrigin, type WeixinQrStatus } from './weixin-transport.js';

export const HUB_WEIXIN_BYTES = 128 * 1024;
type Code = WeixinError['code'];
export type WeixinAuthority = { user: string; keyId?: string; personalKey: boolean; administratorKey: boolean };
export type HubWeixinCommand = { action: 'status' } | { action: 'start'; id: string }
  | { action: 'poll'; id: string; verify?: string } | { action: 'remove'; id: string };
export type HubWeixinResult = null | { error: Code } | { action: 'status'; status: WeixinStatus }
  | { action: 'start' | 'poll'; status: WeixinStatus; work: string | null; state?: WeixinQrStatus['state'] }
  | { action: 'remove'; removed: true };
export type WeixinBindingEffectCommand = { action: 'access'; reference: string } | { action: 'release'; reference: string }
  | { action: 'observe'; reference: string; observation: { kind: 'qr'; code: string; url: string }
    | { kind: 'poll'; result: WeixinQrStatus } };
export type WeixinBindingEffectResult = { error: Code } | { action: 'release'; reference: string }
  | { action: 'observe'; reference: string; state: WeixinQrStatus['state'] | 'qr' }
  | { action: 'access'; reference: string; effect: { kind: 'qr' } | { kind: 'poll'; code: string; baseUrl: string; verify?: string } };
export type WeixinBindingEffectOwner = { command(command: WeixinBindingEffectCommand): Promise<WeixinBindingEffectResult> };
type Reference = { row: WeixinBinding; keyId: string; fresh: () => WeixinAuthority | undefined;
  kind: 'qr' | 'poll'; verify?: string; observed: boolean };
const references = new WeakMap<HubStore, Map<string, Reference>>();
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const string = (v: unknown, max: number): v is string => typeof v === 'string' && !!v && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const code = (v: unknown): v is Code => typeof v === 'string' && ['unavailable','invalid_response','expired','denied','busy','not_configured','unknown'].includes(v);
const state = (v: unknown): v is WeixinQrStatus['state'] => typeof v === 'string' && ['wait','scanned','verify','expired','redirect','confirmed'].includes(v);
const origin = (v: unknown) => { try { return weixinOrigin(v) === v; } catch { return false; } };
function qrUrl(v: unknown): v is string {
  if (!string(v, 8192)) return false;
  try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
}
function poll(v: unknown): v is WeixinQrStatus {
  if (!object(v) || !fields(v, ['state'], ['baseUrl','account']) || !state(v.state)) return false;
  if (v.baseUrl !== undefined && !origin(v.baseUrl)) return false;
  if (v.state === 'redirect') return typeof v.baseUrl === 'string' && v.account === undefined;
  if (v.state !== 'confirmed') return v.account === undefined && v.baseUrl === undefined;
  const a = v.account;
  return object(a) && fields(a, ['botId','peerId','token','baseUrl']) && string(a.botId, 4096)
    && string(a.peerId, 4096) && string(a.token, 4096) && origin(a.baseUrl) && v.baseUrl === undefined;
}
export function validHubWeixinCommand(v: unknown): v is HubWeixinCommand {
  if (!object(v)) return false;
  if (v.action === 'status') return fields(v, ['action']);
  if (!uuid(v.id)) return false;
  if (v.action === 'start' || v.action === 'remove') return fields(v, ['action','id']);
  return v.action === 'poll' && fields(v, ['action','id'], ['verify'])
    && (v.verify === undefined || typeof v.verify === 'string' && /^\d{4,8}$/.test(v.verify));
}
export function validWeixinStatus(v: unknown): v is WeixinStatus {
  if (!object(v) || !fields(v, ['available','personalKey','administratorKey','binding']) || typeof v.available !== 'boolean'
    || typeof v.personalKey !== 'boolean' || typeof v.administratorKey !== 'boolean') return false;
  const b = v.binding;
  return b === null || object(b) && fields(b, ['id','state','expiresAt','contextReady','subscriptions'], ['qrUrl','receipt'])
    && uuid(b.id) && ['creating','qr','bound'].includes(String(b.state)) && Number.isSafeInteger(b.expiresAt)
    && typeof b.contextReady === 'boolean' && Number.isSafeInteger(b.subscriptions) && Number(b.subscriptions) >= 0 && Number(b.subscriptions) <= 50
    && (b.qrUrl === undefined || b.state === 'qr' && qrUrl(b.qrUrl))
    && (b.receipt === undefined || object(b.receipt) && fields(b.receipt, ['state','at'])
      && ['accepted','unknown'].includes(String(b.receipt.state)) && Number.isSafeInteger(b.receipt.at));
}
export function validHubWeixinResult(v: unknown): v is HubWeixinResult {
  if (v === null) return true;
  if (!object(v)) return false;
  if ('error' in v) return fields(v, ['error']) && code(v.error);
  if (v.action === 'remove') return fields(v, ['action','removed']) && v.removed === true;
  if (v.action === 'status') return fields(v, ['action','status']) && validWeixinStatus(v.status);
  return (v.action === 'start' || v.action === 'poll') && fields(v, ['action','status','work'], ['state'])
    && validWeixinStatus(v.status) && (v.work === null || uuid(v.work)) && (v.state === undefined || state(v.state));
}
export function validWeixinBindingEffectCommand(v: unknown): v is WeixinBindingEffectCommand {
  if (!object(v) || !uuid(v.reference)) return false;
  if (v.action === 'access' || v.action === 'release') return fields(v, ['action','reference']);
  if (v.action !== 'observe' || !fields(v, ['action','reference','observation']) || !object(v.observation)) return false;
  const o = v.observation;
  return o.kind === 'qr' ? fields(o, ['kind','code','url']) && string(o.code, 8192) && qrUrl(o.url)
    : o.kind === 'poll' && fields(o, ['kind','result']) && poll(o.result);
}
export function validWeixinBindingEffectResult(v: unknown): v is WeixinBindingEffectResult {
  if (!object(v)) return false;
  if ('error' in v) return fields(v, ['error']) && code(v.error);
  if (!uuid(v.reference)) return false;
  if (v.action === 'release') return fields(v, ['action','reference']);
  if (v.action === 'observe') return fields(v, ['action','reference','state']) && (v.state === 'qr' || state(v.state));
  if (v.action !== 'access' || !fields(v, ['action','reference','effect']) || !object(v.effect)) return false;
  const e = v.effect;
  return e.kind === 'qr' ? fields(e, ['kind']) : e.kind === 'poll' && fields(e, ['kind','code','baseUrl'], ['verify'])
    && string(e.code, 8192) && origin(e.baseUrl) && (e.verify === undefined || typeof e.verify === 'string' && /^\d{4,8}$/.test(e.verify));
}
export function matchesWeixinBindingEffectReply(command: WeixinBindingEffectCommand, result: WeixinBindingEffectResult) {
  if ('error' in result) return true;
  if (command.action !== result.action || command.reference !== result.reference) return false;
  return command.action !== 'observe' || result.action === 'observe'
    && result.state === (command.observation.kind === 'qr' ? 'qr' : command.observation.result.state);
}
function entries(owner: HubStore) {
  let active = references.get(owner); if (!active) { active = new Map(); references.set(owner, active); } return active;
}
export function weixinBindingCheckpoint(owner: HubStore) {
  const before = new Map(entries(owner)); return () => { references.set(owner, before); };
}
export function readWeixinStatus(owner: HubStore, identity: WeixinAuthority): WeixinStatus {
  const store = owner.weixin, row = store.get(identity.user);
  const common = { available: store.enabled, personalKey: identity.personalKey, administratorKey: identity.administratorKey };
  if (!row) return { ...common, binding: null };
  const secret = store.secrets(row), receipt = store.receipt(row);
  return { ...common, binding: { id: row.id, state: row.phase, expiresAt: row.expiresAt,
    ...(row.phase === 'qr' && secret.qrUrl ? { qrUrl: secret.qrUrl } : {}),
    contextReady: !!secret.context && (secret.contextAt ?? 0) + 24 * 3600_000 > Date.now(),
    subscriptions: store.targets(row).filter(t => t.watching).length, ...(receipt ? { receipt } : {}) } };
}
/** Entire member admission runs inside the original identity savepoint. The
 * private reference contains ORIGINAL evidence, never a captured permission. */
export function executeHubWeixin(owner: HubStore, fresh: () => WeixinAuthority | undefined, command: HubWeixinCommand): HubWeixinResult {
  const identity = fresh(); if (!identity) return null;
  const store = owner.weixin;
  if (command.action === 'status') return { action: 'status', status: readWeixinStatus(owner, identity) };
  if (command.action === 'remove') {
    store.remove(identity.user, command.id);
    owner.identities.audit.append({ event: 'api_authz', outcome: 'success', userId: identity.user, reason: 'weixin_unlinked' });
    return { action: 'remove', removed: true };
  }
  if (!identity.keyId) return { error: 'denied' };
  const active = entries(owner);
  if (command.action === 'poll') {
    const row = store.get(identity.user); if (!row || row.id !== command.id) return { error: 'expired' };
    if (row.phase === 'bound') return { action: 'poll', status: readWeixinStatus(owner, identity), work: null, state: 'confirmed' };
  } else {
    const current = store.get(identity.user);
    if (current?.id === command.id && current.keyId === identity.keyId) return { action: 'start', status: readWeixinStatus(owner, identity), work: null };
  }
  if (active.size >= 4 || [...active.values()].some(r => r.row.user === identity.user)) return { error: 'busy' };
  const row = command.action === 'start' ? store.create(identity.user, identity.keyId, command.id).row : store.get(identity.user)!;
  if (row.keyId !== identity.keyId) return { error: 'denied' };
  if (command.action === 'poll') {
    const secret = store.secrets(row); if (!secret.qrCode || !secret.baseUrl) return { error: 'unknown' };
  }
  const reference = randomUUID();
  active.set(reference, { row, keyId: identity.keyId, fresh, kind: command.action === 'start' ? 'qr' : 'poll', observed: false,
    ...(command.action === 'poll' && command.verify !== undefined ? { verify: command.verify } : {}) });
  return { action: command.action, status: readWeixinStatus(owner, identity), work: reference };
}
/** A private effect lane can only use one admitted original binding. It has
 * neither raw store access nor permission to manufacture a member credential. */
export function executeWeixinBindingEffect(owner: HubStore, command: WeixinBindingEffectCommand): WeixinBindingEffectResult {
  const active = entries(owner), ref = active.get(command.reference);
  if (command.action === 'release') { active.delete(command.reference); return { ...command }; }
  if (!ref || ref.observed) return { error: 'denied' };
  const identity = ref.fresh(), row = ref.row, store = owner.weixin;
  if (!identity || identity.user !== row.user || identity.keyId !== ref.keyId || !store.current(row)) return { error: 'denied' };
  if (command.action === 'access') {
    if (ref.kind === 'qr') return { ...command, effect: { kind: 'qr' } };
    const secret = store.secrets(row);
    if (!secret.qrCode || !secret.baseUrl) return { error: 'unknown' };
    return { ...command, effect: { kind: 'poll', code: secret.qrCode, baseUrl: secret.baseUrl,
      ...(ref.verify === undefined ? {} : { verify: ref.verify }) } };
  }
  const observation = command.observation;
  if (observation.kind !== ref.kind) return { error: 'denied' };
  if (observation.kind === 'qr') {
    store.qr(row, observation.code, observation.url, WEIXIN_ORIGIN);
    owner.identities.audit.append({ event: 'api_authz', outcome: 'success', userId: row.user, reason: 'weixin_qr_created' });
  } else {
    const result = observation.result;
    if (result.state === 'confirmed') {
      store.bind(row, result.account!);
      owner.identities.audit.append({ event: 'api_authz', outcome: 'success', userId: row.user, reason: 'weixin_bound' });
    } else if (result.state === 'redirect') store.save(row, { ...store.secrets(row), baseUrl: result.baseUrl! });
    else if (result.state === 'expired') store.remove(row.user, row.id);
  }
  active.set(command.reference, { ...ref, observed: true });
  return { action: 'observe', reference: command.reference, state: observation.kind === 'qr' ? 'qr' : observation.result.state };
}
