import { randomBytes, randomUUID } from 'node:crypto';
import { readInteractionSnapshot, readInteractionView, type InteractionAnswer, type SessionSummary, type InteractionView } from '@agentopsdeck/shared';
import type { HubStore } from './hub-store.js';
import { decodeHubSessionId } from './session-id.js';
import type { WeixinBinding, WeixinOriginalReceipt } from './weixin-store.js';
import type { WeixinRequestBinding } from './weixin-bridge.js';
import { validOwnerStopPayload, ownerControlScope, type HubOwnerControlCommand } from './member-owner-control-domain.js';
import { WeixinError, weixinOrigin, type WeixinAccount, type WeixinMessage } from './weixin-transport.js';

/** Private service protocol, NOT a member command or a general store proxy.
 * Every effect originates from an admitted receive or a stored subscription.
 * Its UUID is consumed once; ACK loss never licenses a second dispatch. */
export const WEIXIN_BACKGROUND_BYTES = 5 * 1024 * 1024;
export type WeixinBackgroundEffect =
  | { kind: 'receive'; account: WeixinAccount; cursor: string }
  | { kind: 'bridge'; binding: WeixinBinding; path: string; body?: unknown }
  | { kind: 'send'; account: WeixinAccount; context: string; clientId: string; message: string };
export type WeixinBackgroundObservation = { kind: 'failed' }
  | { kind: 'receive'; batch: { cursor: string; messages: WeixinMessage[] } }
  | { kind: 'bridge'; value: unknown } | { kind: 'send'; state: 'accepted' | 'unknown' };
export type WeixinBackgroundCommand = { action: 'scan' }
  | { action: 'begin'; binding: WeixinBinding }
  | { action: 'observe'; reference: string; effectId: string; observation: WeixinBackgroundObservation; halt?: true }
  | { action: 'release'; reference: string };
export type WeixinBackgroundResult = { error: WeixinError['code'] }
  | { action: 'scan'; bindings: WeixinBinding[] }
  | { action: 'release'; reference: string }
  | { action: 'step'; reference: string; work: null | { effectId: string; effect: WeixinBackgroundEffect } };
export type WeixinBackgroundOwner = { command(command: WeixinBackgroundCommand): Promise<WeixinBackgroundResult> };
type Stage = 'receive' | 'sessions' | 'target' | 'confirm' | 'answerCheck' | 'questions' | 'answer' | 'stop' | 'send' | 'notify' | 'notifySend';
type Flight = { row: WeixinBinding; stage: Stage; effectId: string; cursor: string; messages: WeixinMessage[];
  original?: WeixinOriginalReceipt; question?: {session: string; view: InteractionView}; stop?: {session: string; run: string; expires: number; key?: string} };
const flights = new WeakMap<HubStore, Map<string, Flight>>();
const map = (owner: HubStore) => { let m = flights.get(owner); if (!m) {m = new Map(); flights.set(owner, m);} return m; };
/** Values are replaced, never mutated. Restore private continuation and SQL as
 * ONE failure boundary, including when the audit insert fails after settlement. */
export function weixinBackgroundCheckpoint(owner: HubStore) {
  const before = new Map(map(owner)); return () => { flights.set(owner, before); };
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(k => Object.hasOwn(v,k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
function binding(v: unknown): v is WeixinBinding {
  return object(v) && keys(v,['id','user','keyId','phase','createdAt','expiresAt']) && uuid(v.id) && text(v.user,4096) && text(v.keyId,4096)
    && ['bound','qr','creating'].includes(String(v.phase)) && Number.isSafeInteger(v.createdAt) && Number.isSafeInteger(v.expiresAt);
}
function account(v: unknown): v is WeixinAccount {
  if (!object(v) || !keys(v,['botId','peerId','token','baseUrl']) || !text(v.botId,4096) || !text(v.peerId,4096) || !text(v.token,4096)) return false;
  try { return weixinOrigin(v.baseUrl) === v.baseUrl; } catch { return false; }
}
function observation(v: unknown): v is WeixinBackgroundObservation {
  if (!object(v)) return false;
  if (v.kind === 'failed') return keys(v,['kind']);
  if (v.kind === 'send') return keys(v,['kind','state']) && ['accepted','unknown'].includes(String(v.state));
  // The fixed stage validates the original bridge response before consuming it.
  if (v.kind === 'bridge') return keys(v,['kind','value']);
  if (v.kind !== 'receive' || !keys(v,['kind','batch']) || !object(v.batch) || !keys(v.batch,['cursor','messages'])
    || typeof v.batch.cursor !== 'string' || v.batch.cursor.length > 65536 || !Array.isArray(v.batch.messages) || v.batch.messages.length > 100) return false;
  return v.batch.messages.every(m => object(m) && keys(m,['id','peerId','at','text','context']) && text(m.id,128) && text(m.peerId,4096)
    && Number.isSafeInteger(m.at) && typeof m.text === 'string' && m.text.length <= 4000 && text(m.context,8192));
}
export function validWeixinBackgroundCommand(v: unknown): v is WeixinBackgroundCommand {
  if (!object(v)) return false;
  if (v.action === 'scan') return keys(v,['action']);
  if (v.action === 'begin') return keys(v,['action','binding']) && binding(v.binding);
  if (!uuid(v.reference)) return false;
  return v.action === 'release' ? keys(v,['action','reference']) : v.action === 'observe'
    && keys(v,['action','reference','effectId','observation'],['halt']) && (v.halt === undefined || v.halt === true)
    && uuid(v.effectId) && observation(v.observation);
}
function effect(v: unknown): v is WeixinBackgroundEffect {
  if (!object(v)) return false;
  if (v.kind === 'receive') return keys(v,['kind','account','cursor']) && account(v.account) && typeof v.cursor === 'string' && v.cursor.length <= 65536;
  if (v.kind === 'send') return keys(v,['kind','account','context','clientId','message']) && account(v.account)
    && text(v.context,8192) && text(v.clientId,128) && typeof v.message === 'string' && v.message.length <= 4000;
  return v.kind === 'bridge' && keys(v,['kind','binding','path'],['body']) && binding(v.binding)
    && typeof v.path === 'string' && !/[?#]/.test(v.path) && (v.body === undefined
      ? v.path === '/api/hub/v1/sessions/state' || /^\/api\/hub\/v1\/sessions\/[^/]+\/interactions$/.test(v.path)
      : /^\/api\/hub\/v1\/sessions\/[^/]+\/(?:messages|interactions\/[^/]+\/answer)$/.test(v.path));
}
export function validWeixinBackgroundResult(v: unknown): v is WeixinBackgroundResult {
  if (!object(v)) return false;
  if ('error' in v) return keys(v,['error']) && ['unavailable','invalid_response','expired','denied','busy','not_configured','unknown'].includes(String(v.error));
  if (v.action === 'scan') return keys(v,['action','bindings']) && Array.isArray(v.bindings) && v.bindings.length <= 64 && v.bindings.every(binding);
  if (v.action === 'release') return keys(v,['action','reference']) && uuid(v.reference);
  return v.action === 'step' && keys(v,['action','reference','work']) && uuid(v.reference) && (v.work === null
    || object(v.work) && keys(v.work,['effectId','effect']) && uuid(v.work.effectId) && effect(v.work.effect));
}
export function matchesWeixinBackgroundReply(command: WeixinBackgroundCommand, result: WeixinBackgroundResult) {
  if ('error' in result) return true;
  if (command.action === 'scan' || command.action === 'release') return result.action === command.action
    && (command.action !== 'release' || result.action === 'release' && result.reference === command.reference);
  return result.action === 'step' && (command.action === 'begin' || result.reference === command.reference
    && (result.work === null || result.work.effectId !== command.effectId))
    && (command.action !== 'begin' || result.work === null || result.work.effect.kind === 'receive');
}
const handle = () => randomBytes(6).toString('hex');
const instructions = 'AgentOpsDeck 微信：sessions 列出会话；status 编号 查看状态；watch 编号 订阅；unwatch 编号 取消；questions 编号 主动查看问题（会外发问题正文）；answer 问题码 内容；allow 问题码 / deny 问题码；stop 编号 获取停止确认码，confirm 确认码 停止该Codex回合。不会执行任意命令或发送新消息。';
const unconfirmed = '请求未确认完成。请在网页核对当前权限和状态；不会自动重复提交。';
const path = (id: string) => `/api/hub/v1/sessions/${encodeURIComponent(id)}`;
const words = (f: Flight) => f.messages[0]!.text.trim().split(/\s+/);
function audit(owner: HubStore, f: Flight, reason: string, ok: boolean) {
  owner.identities.audit.append({event: 'api_authz', outcome: ok ? 'success' : 'failure', userId: f.row.user, reason});
}
function sessions(value: unknown): SessionSummary[] {
  if (!object(value) || !Array.isArray(value.groups) || value.groups.length > 4096) throw new WeixinError('invalid_response');
  const result: SessionSummary[] = [];
  for (const group of value.groups) {
    if (!object(group) || !Array.isArray(group.sessions)) throw new WeixinError('invalid_response');
    for (const session of group.sessions) {
      if (!object(session) || !text(session.sessionKey,4095) || typeof session.status !== 'string'
        || (session.title !== undefined && typeof session.title !== 'string')) throw new WeixinError('invalid_response');
      if (session.runtime !== undefined && (!object(session.runtime) || typeof session.runtime.phase !== 'string'
        || typeof session.runtime.connection !== 'string' || typeof session.runtime.sync !== 'string'
        || (session.runtime.turnId !== undefined && typeof session.runtime.turnId !== 'string'))) throw new WeixinError('invalid_response');
      result.push(session as SessionSummary); if (result.length > 4096) throw new WeixinError('busy');
    }
  }
  return result;
}
function step(owner: HubStore, reference: string, f: Flight, stage: Stage, effect: WeixinBackgroundEffect,
  details: Partial<Pick<Flight,'original'|'question'|'stop'>> = {}): WeixinBackgroundResult {
  const effectId = randomUUID();
  // Clear previous original references. In particular a send must never settle
  // the preceding answer receipt by accident.
  const next: Flight = {row:f.row, cursor:f.cursor, messages:f.messages, stage, effectId, ...details};
  map(owner).set(reference,next); return {action:'step',reference,work:{effectId,effect}};
}
function bridge(owner: HubStore, ref: string, f: Flight, stage: Stage, suffix: string,
  details: Partial<Pick<Flight,'original'|'question'|'stop'>> = {}, body?: unknown) {
  return step(owner,ref,f,stage,{kind:'bridge',binding:f.row,path:suffix,...(body === undefined ? {} : {body})},details);
}
function done(owner: HubStore, reference: string): WeixinBackgroundResult {
  map(owner).delete(reference); return {action:'step',reference,work:null};
}
function send(owner: HubStore, ref: string, f: Flight, message: string, notify?: string) {
  const current = f.messages[0], event = notify ?? `in:${current!.id}`;
  const original = owner.weixin.deliveryAdmission(f.row,event,!notify,notify ? undefined : current!.context);
  if (!original) return next(owner,ref,{...f,messages:notify ? [] : f.messages.slice(1)},!!notify);
  return step(owner,ref,f,notify ? 'notifySend' : 'send',{kind:'send',account:original.account,context:original.context,
    clientId:original.clientId,message:message.slice(0,4000)},{original:original.reference});
}
function next(owner: HubStore, ref: string, f: Flight, notified = false): WeixinBackgroundResult {
  const store = owner.weixin, row = f.row;
  if (!store.current(row)) return done(owner,ref);
  if (!f.messages.length) {
    const secret = store.secrets(row);
    if (notified || !secret.context || (secret.contextAt ?? 0) + 24*3600_000 <= Date.now() || !store.targets(row).some(t => t.watching)) return done(owner,ref);
    return bridge(owner,ref,f,'notify','/api/hub/v1/sessions/state');
  }
  const [verb,code,...rest] = words(f);
  if (verb === 'help' || f.messages[0]!.text.trim() === '帮助') return send(owner,ref,f,instructions);
  if (verb === 'sessions') return bridge(owner,ref,f,'sessions','/api/hub/v1/sessions/state');
  if (verb === 'confirm') {
    const selected = code && store.secrets(row).stops?.[code];
    if (!selected || rest.length || selected.expires <= Date.now()) return send(owner,ref,f,unconfirmed);
    return bridge(owner,ref,f,'confirm','/api/hub/v1/sessions/state',{stop:selected});
  }
  if (['answer','allow','deny'].includes(verb ?? '')) {
    const selected = code && store.secrets(row).questions?.[code];
    if (!selected || selected.view.request.expiresAt <= Date.now()) return send(owner,ref,f,unconfirmed);
    return bridge(owner,ref,f,'answerCheck',`${path(selected.session)}/interactions`,{question:selected});
  }
  if (!['status','watch','unwatch','questions','stop'].includes(verb ?? '')) return send(owner,ref,f,instructions);
  const target = store.targets(row).find(t => t.handle === code && t.expiresAt > Date.now());
  return target ? bridge(owner,ref,f,'target','/api/hub/v1/sessions/state') : send(owner,ref,f,'会话编号已失效，请先发送 sessions。');
}
function observeBridge(owner: HubStore, ref: string, f: Flight, value: unknown): WeixinBackgroundResult {
  const store = owner.weixin, row = f.row, [verb,code,...rest] = f.messages.length ? words(f) : [];
  if (f.stage === 'sessions') {
    const rows = sessions(value).slice(0,20);
    return send(owner,ref,f,rows.length ? rows.map(s => `${store.target(row,s.sessionKey,handle())} · ${(s.title || 'Session').slice(0,80)}`).join('\n')
      + '\n使用 status 编号 或 watch 编号；编号30分钟内有效。' : '没有可访问的会话。');
  }
  if (f.stage === 'confirm') {
    const selected = f.stop!, session = sessions(value).find(s => s.sessionKey === selected.session);
    if (!session || session.runtime?.turnId !== selected.run || session.runtime.connection !== 'connected' || session.runtime.sync !== 'current'
      || !['starting','running','waiting','finalizing'].includes(session.runtime.phase) || selected.expires <= Date.now()) return send(owner,ref,f,unconfirmed);
    const original = store.claimAction(row,`stop:${code}`);
    const key = randomUUID();
    return original ? bridge(owner,ref,f,'stop',`${path(selected.session)}/messages`,{original,stop:{...selected,key}},
      {message:'/stop',expectedRunId:selected.run,deliveryMode:'web-only',media:[],idempotencyKey:key}) : send(owner,ref,f,'此确认码已使用；不会重复停止，请在网页核对。');
  }
  if (f.stage === 'answerCheck') {
    const selected = f.question!, old = selected.view, snapshot = readInteractionSnapshot(value);
    const current = snapshot?.requests.find(v => v.request.requestId === old.request.requestId);
    if (!current || current.status !== 'pending' || current.revision !== old.revision || current.request.runId !== old.request.runId
      || current.request.nodeId !== old.request.nodeId || current.request.sessionKey !== old.request.sessionKey
      || current.request.ownerId !== old.request.ownerId || current.request.kind !== old.request.kind
      || current.request.expiresAt <= Date.now()) return send(owner,ref,f,unconfirmed);
    let answer: InteractionAnswer;
    if (verb === 'answer' && old.request.kind === 'text' && rest.join(' ').trim()) answer = {kind:'text',text:rest.join(' ')};
    else if ((verb === 'allow' || verb === 'deny') && old.request.kind === 'approval' && !rest.length) answer = {kind:'approval',decision:verb === 'allow' ? 'allow-once' : 'deny'};
    else return send(owner,ref,f,'该问题不接受此答复格式。选择题请在网页处理。');
    const original = store.claimAction(row,`action:${code}`);
    return original ? bridge(owner,ref,f,'answer',`${path(selected.session)}/interactions/${encodeURIComponent(old.request.requestId)}/answer`,{original,question:selected},
      {runId:old.request.runId,expectedRevision:old.revision,responseId:`weixin-${code}`,answer}) : send(owner,ref,f,'该问题码已使用，不能重复提交。请在网页核对结果。');
  }
  if (f.stage === 'target') {
    const target = store.targets(row).find(t => t.handle === code && t.expiresAt > Date.now());
    const session = target && sessions(value).find(s => s.sessionKey === target.session);
    if (!target || !session) return send(owner,ref,f,unconfirmed);
    if (verb === 'watch' || verb === 'unwatch') {store.watch(row,target.handle,verb === 'watch');return send(owner,ref,f,verb === 'watch' ? '已订阅：只通知状态，不发送会话正文；先建立当前状态基线。' : '已取消订阅。');}
    if (verb === 'status') return send(owner,ref,f,`${target.handle} · ${session.status}\n${instructions}`);
    if (verb === 'stop') {
      if (!decodeHubSessionId(target.session)?.remoteSessionKey.startsWith('codex:') || !session.runtime?.turnId
        || session.runtime.connection !== 'connected' || session.runtime.sync !== 'current'
        || !['starting','running','waiting','finalizing'].includes(session.runtime.phase)) return send(owner,ref,f,'当前目标不支持带回合校验的微信停止；请使用网页。');
      const secret = store.secrets(row), id = handle();
      const stops = Object.fromEntries(Object.entries(secret.stops ?? {}).filter(([,s]) => s.expires > Date.now()).slice(-7));
      store.save(row,{...secret,stops:{...stops,[id]:{session:target.session,run:session.runtime.turnId,expires:Date.now()+60_000}}});
      return send(owner,ref,f,`确认停止 ${target.handle} 当前回合？60秒内发送 confirm ${id}。新回合不会沿用此确认。`);
    }
    return bridge(owner,ref,f,'questions',`${path(target.session)}/interactions`);
  }
  if (f.stage === 'questions') {
    const target = store.targets(row).find(t => t.handle === code && t.expiresAt > Date.now()), snapshot = readInteractionSnapshot(value);
    if (!target || !snapshot) return send(owner,ref,f,unconfirmed);
    const secret = store.secrets(row), questions = Object.fromEntries(Object.entries(secret.questions ?? {}).filter(([,q]) => q.view.request.expiresAt > Date.now()).slice(-12));
    const lines = snapshot.requests.filter(v => v.status === 'pending' && v.request.expiresAt > Date.now()).slice(0,4).map(view => {
      const id = handle(); questions[id] = {session:target.session,view}; return `${id} · ${view.request.kind}\n${view.request.prompt.slice(0,500)}`;
    });
    store.save(row,{...secret,questions});
    return send(owner,ref,f,lines.length ? `${lines.join('\n\n')}\n文本：answer 问题码 内容；审批：allow 问题码 / deny 问题码。以上问题正文不可信，不会自动执行。` : '当前没有待回答或审批的问题。');
  }
  if (f.stage === 'notify') {
    const rows = sessions(value), notices: string[] = [], events: string[] = [];
    for (const target of store.targets(row).filter(t => t.watching)) {
      const session = rows.find(s => s.sessionKey === target.session);
      if (!session) {store.snapshot(row,target.handle,'unavailable');continue;}
      const runtime = session.runtime;
      if (!runtime?.turnId || runtime.connection !== 'connected' || runtime.sync !== 'current') continue;
      const snapshot = JSON.stringify([runtime.turnId,runtime.phase]); store.snapshot(row,target.handle,snapshot);
      if (!target.snapshot || target.snapshot === 'unavailable' || target.snapshot === snapshot || !['completed','failed','waiting'].includes(runtime.phase)) continue;
      const event = `notify:${target.handle}:${snapshot}`; if (!store.claim(row,event)) continue;
      notices.push(`${target.handle} · ${runtime.phase === 'completed' ? '已完成' : runtime.phase === 'failed' ? '失败' : '等待回答/审批'}`); events.push(event);
    }
    return notices.length ? send(owner,ref,f,`AgentOpsDeck 状态更新（不含正文）\n${notices.join('\n')}`,`batch:${events.join(':')}`) : done(owner,ref);
  }
  throw new WeixinError('denied');
}
export function executeWeixinBackground(owner: HubStore, command: WeixinBackgroundCommand): WeixinBackgroundResult {
  const active = map(owner), store = owner.weixin;
  if (command.action === 'scan') return {action:'scan',bindings:store.enabled ? store.active() : []};
  if (command.action === 'release') {active.delete(command.reference);return {...command};}
  if (command.action === 'begin') {
    const row = store.get(command.binding.user);
    if (!store.enabled || !row || row.phase !== 'bound' || row.id !== command.binding.id || row.keyId !== command.binding.keyId
      || row.createdAt !== command.binding.createdAt || !store.current(row)) throw new WeixinError('denied');
    if (active.size >= 4 || [...active.values()].some(f => f.row.id === row.id)) throw new WeixinError('busy');
    const reference = randomUUID(), secret = store.secrets(row);
    if (!secret.account) return done(owner,reference);
    return step(owner,reference,{row,cursor:secret.cursor ?? '',messages:[],stage:'receive',effectId:''},'receive',
      {kind:'receive',account:secret.account,cursor:secret.cursor ?? ''});
  }
  const ref = command.reference, f = active.get(ref), observed = command.observation;
  if (!f || f.effectId !== command.effectId) throw new WeixinError('denied');
  // Settle ORIGINAL facts before checking current authorization. Revocation
  // prevents new dispatch/delivery, never erases an acknowledged past effect.
  if (f.original) {
    let confirmed = false;
    if ((f.stage === 'send' || f.stage === 'notifySend') && observed.kind === 'send') confirmed = observed.state === 'accepted';
    else if (f.stage === 'stop' && observed.kind === 'bridge') confirmed = object(observed.value) && observed.value.status === 'interrupt_requested';
    else if (f.stage === 'answer' && observed.kind === 'bridge') {
      const view = readInteractionView(observed.value), old = f.question!.view;
      confirmed = !!view && view.request.requestId === old.request.requestId && view.request.runId === old.request.runId
        && view.request.sessionKey === old.request.sessionKey && view.request.ownerId === old.request.ownerId
        && view.request.nodeId === old.request.nodeId && view.request.kind === old.request.kind
        && view.revision >= old.revision && view.status === 'answered' && view.delivery === 'confirmed';
    } else if (observed.kind !== 'failed') throw new WeixinError('invalid_response');
    if (confirmed && f.stage === 'stop' && f.stop?.key) {
      const decoded = decodeHubSessionId(f.stop.session);
      if (!decoded) throw new WeixinError('invalid_response');
      const scope = ownerControlScope(f.row.user, { operation: 'message', connectionId: decoded.connectionId, sessionId: f.stop.session });
      // Only settle the already admitted original Hub receipt and its saved
      // downstream key. Never claim, query a new key or redispatch on recovery.
      const saved = owner.commands.get(scope, f.stop.key);
      if (saved) owner.commands.settleFromReceipt(scope, f.stop.key, { ...saved,
        key: owner.commands.deliveryKey(scope, f.stop.key), state: 'accepted',
        result: { status: 200, body: { status: 'interrupt_requested' } } });
    }
    store.settleOriginal(f.original,confirmed ? 'accepted' : 'unknown');
    audit(owner,f,f.stage === 'stop' ? 'weixin_stop_requested' : f.stage === 'answer'
      ? confirmed ? 'weixin_answer_confirmed' : 'weixin_answer_unknown' : confirmed ? 'weixin_send_accepted' : 'weixin_send_unknown',confirmed);
    if (command.halt || !store.current(f.row)) return done(owner,ref);
    if (f.stage === 'send') return next(owner,ref,{...f,messages:f.messages.slice(1)});
    if (f.stage === 'notifySend') return done(owner,ref);
    return send(owner,ref,f,f.stage === 'stop' ? confirmed ? '停止请求已接收，不代表回合已结束；请查看当前状态。' : '停止结果未知，不会自动重试。'
      : confirmed ? '原生交互已确认收到答复。' : '已尝试提交，尚无原生确认；不会自动重试，请在网页核对。');
  }
  if (command.halt || !store.current(f.row)) return done(owner,ref);
  if (observed.kind === 'failed') {
    if (f.stage === 'receive' || f.stage === 'notify') return done(owner,ref);
    audit(owner,f,'weixin_command_unconfirmed',false); return send(owner,ref,f,unconfirmed);
  }
  if (f.stage === 'receive') {
    if (observed.kind !== 'receive') throw new WeixinError('invalid_response');
    return next(owner,ref,{...f,messages:store.receiveAdmission(f.row,f.cursor,observed.batch)});
  }
  if (observed.kind !== 'bridge') throw new WeixinError('invalid_response');
  return observeBridge(owner,ref,f,observed.value);
}

/** The private bridge may use owner controls ONLY while this worker holds the
 * original stop admission. A binding is not a general message credential. */
export function weixinBackgroundStop(owner: HubStore, binding: Readonly<WeixinRequestBinding>, connectionId: string,
  command?: HubOwnerControlCommand) {
  const original = [...map(owner).values()].find(f => f.stage === 'stop' && f.original && f.stop
    && f.row.id === binding.id && f.row.user === binding.user && f.row.keyId === binding.keyId
    && decodeHubSessionId(f.stop.session)?.connectionId === connectionId);
  if (!original?.stop) return false;
  if (!command) return true;
  if (command.target.operation !== 'message' || command.target.sessionId !== original.stop.session
    || !['check','get','delivery','claim','settle'].includes(command.action)) return false;
  if ('key' in command && command.key !== original.stop.key) return false;
  if (command.action !== 'claim') return true;
  const payload = command.payload;
  return validOwnerStopPayload(payload) && object(payload) && payload.expectedRunId === original.stop.run;
}
