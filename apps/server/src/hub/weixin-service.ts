import { randomBytes } from 'node:crypto';
import { readInteractionSnapshot, readInteractionView, type InteractionAnswer, type SessionSummary, type WeixinStatus } from '@agentopsdeck/shared';
import { WEIXIN_ORIGIN, WeixinError, type WeixinTransport } from './weixin-transport.js';
import type { WeixinStore, WeixinBinding } from './weixin-store.js';
import { decodeHubSessionId } from './session-id.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncWeixinBackgroundAccess } from './async-weixin-background-access.js';
import type { WeixinBackgroundObservation } from './weixin-background-domain.js';
import { weixinOriginalEffect } from './weixin-original-effect.js';

type Bridge = (row: WeixinBinding, path: string, signal: AbortSignal, body?: unknown) => Promise<unknown>;
type AsyncWeixinService = { mode: 'async'; background: AsyncWeixinBackgroundAccess; transport: WeixinTransport; bridge: Bridge; now?: () => number };
const handle = () => randomBytes(6).toString('hex');
const instructions = 'AgentOpsDeck 微信：sessions 列出会话；status 编号 查看状态；watch 编号 订阅；unwatch 编号 取消；questions 编号 主动查看问题（会外发问题正文）；answer 问题码 内容；allow 问题码 / deny 问题码；stop 编号 获取停止确认码，confirm 确认码 停止该Codex回合。不会执行任意命令或发送新消息。';
const sessionPath = (id: string) => `/api/hub/v1/sessions/${encodeURIComponent(id)}`;

/** One bounded worker per binding; no accounts => no provider requests.
 * Side effects are claimed durably BEFORE delivery, including ambiguous outcomes. */
export class WeixinService {
  private readonly operations = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly failures = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  private rotation = 0;
  private scanning: Promise<void> | undefined;
  private readonly legacy: { store: WeixinStore; audit: (user: string, reason: string, ok: boolean) => void } | undefined;
  private readonly transport: WeixinTransport;
  private readonly bridge: Bridge;
  private readonly now: () => number;
  private readonly background: AsyncWeixinBackgroundAccess | undefined;
  get store() { if (!this.legacy) throw new WeixinError('not_configured'); return this.legacy.store; }
  private get audit() { if (!this.legacy) throw new WeixinError('not_configured'); return this.legacy.audit; }
  constructor(source: AsyncWeixinService);
  constructor(source: WeixinStore, transport: WeixinTransport, bridge: Bridge,
    audit: (user: string, reason: string, ok: boolean) => void, now?: () => number, background?: AsyncWeixinBackgroundAccess);
  constructor(source: WeixinStore | AsyncWeixinService, transport?: WeixinTransport, bridge?: Bridge,
    audit?: (user: string, reason: string, ok: boolean) => void, now = Date.now, background?: AsyncWeixinBackgroundAccess) {
    if ('mode' in source && source.mode === 'async') {
      if (!source.background || typeof source.background.command !== 'function' || typeof source.background.close !== 'function'
        || !source.transport || !['qr', 'pollQr', 'receive', 'send'].every(key => typeof source.transport[key as keyof WeixinTransport] === 'function')
        || typeof source.bridge !== 'function' || source.now !== undefined && typeof source.now !== 'function') throw new WeixinError('not_configured');
      this.background = source.background; this.transport = source.transport; this.bridge = source.bridge; this.now = source.now ?? Date.now;
    } else {
      if (!transport || !bridge || !audit) throw new WeixinError('not_configured');
      this.transport = transport; this.bridge = bridge; this.now = now; this.background = background;
      // A legacy call with an async lane must not retain synchronous fallbacks.
      if (!background) this.legacy = { store: source as WeixinStore, audit };
    }
  }
  status(user: string, personalKey: boolean): WeixinStatus {
    const row = this.store.get(user);
    if (!row) return { available: this.store.enabled, personalKey, binding: null };
    const secret = this.store.secrets(row), receipt = this.store.receipt(row);
    return { available: this.store.enabled, personalKey, binding: { id: row.id, state: row.phase, expiresAt: row.expiresAt,
      ...(row.phase === 'qr' && secret.qrUrl ? { qrUrl: secret.qrUrl } : {}),
      contextReady: !!secret.context && (secret.contextAt ?? 0) + 24 * 3600_000 > this.now(),
      subscriptions: this.store.targets(row).filter(t => t.watching).length, ...(receipt ? { receipt } : {}) } };
  }
  /** The asynchronous management lane and legacy background share ONE original
   * effect budget. No SQL or captured authorization is exposed by this gate. */
  async runBindingEffect<T>(id: string, signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>) {
    if (this.closed || this.operations.has(id) || this.operations.size >= 4) throw new WeixinError('busy');
    const controller = new AbortController(), abort = () => controller.abort();
    let complete!: () => void;
    const done = new Promise<void>(resolve => { complete = resolve; });
    // Publish original ownership before authorization, transport or diagnostics
    // may reenter close. Abort is only a signal, never a drain acknowledgement.
    const operation = { controller, done }; this.operations.set(id, operation);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    try { controller.signal.throwIfAborted(); return await run(controller.signal); }
    finally { signal.removeEventListener('abort', abort); if (this.operations.get(id) === operation) this.operations.delete(id); complete(); }
  }
  cancelBinding(id: string) { this.operations.get(id)?.controller.abort(); }
  private exclusive<T>(row: WeixinBinding, signal: AbortSignal, authorize: () => void, run: (signal: AbortSignal, check: () => void) => Promise<T>) {
    return this.runBindingEffect(row.id, signal, async originalSignal => {
      const check = () => { originalSignal.throwIfAborted(); authorize(); if (!this.store.current(row)) throw new WeixinError('denied'); };
      check(); return run(originalSignal, check);
    });
  }
  async start(user: string, keyId: string, id: string, signal: AbortSignal, authorize: () => void) {
    signal.throwIfAborted();
    if (this.closed || this.operations.size >= 4) throw new WeixinError('busy');
    authorize(); const { row, fresh } = this.store.create(user, keyId, id);
    if (fresh) await this.exclusive(row, signal, authorize, async (signal, check) => {
      const qr = await this.transport.qr(signal); check(); this.store.qr(row, qr.code, qr.url, WEIXIN_ORIGIN);
      this.audit(user, 'weixin_qr_created', true);
    });
    return this.status(user, true);
  }
  async poll(user: string, id: string, verify: string | undefined, signal: AbortSignal, authorize: () => void) {
    // Completed/idempotent requests still cross an authorization boundary.
    signal.throwIfAborted(); authorize();
    if (this.closed) throw new WeixinError('busy');
    const row = this.store.get(user); if (!row || row.id !== id) throw new WeixinError('expired');
    if (row.phase === 'bound') return { state: 'confirmed' as const, status: this.status(user, true) };
    return this.exclusive(row, signal, authorize, async (signal, check) => {
      const secret = this.store.secrets(row); if (!secret.qrCode || !secret.baseUrl) throw new WeixinError('unknown');
      const result = await this.transport.pollQr(secret.qrCode, secret.baseUrl, verify, signal); check();
      if (result.state === 'confirmed' && result.account) { this.store.bind(row, result.account); this.audit(user, 'weixin_bound', true); }
      else if (result.state === 'redirect' && result.baseUrl) this.store.save(row, { ...secret, baseUrl: result.baseUrl });
      else if (result.state === 'expired') this.remove(user, id);
      return { state: result.state, status: this.status(user, true) };
    });
  }
  remove(user: string, id: string) {
    const row = this.store.get(user);
    if (row?.id === id) this.operations.get(id)?.controller.abort();
    this.store.remove(user, id); this.failures.delete(id); this.audit(user, 'weixin_unlinked', true);
  }
  startWorker() {
    if (this.timer || this.closed || !this.background && !this.store.enabled) return;
    this.timer = setInterval(() => {
      if (this.closed) return;
      if (this.background) { void this.scan(); return; }
      // A maintenance SQL failure must not escape setInterval as an uncaught
      // exception. No failed scan authorizes a new effect or releases a claim.
      try {
      const rows = this.store.active();
      const offset = this.rotation++ % Math.max(1, rows.length);
      for (const row of [...rows.slice(offset), ...rows.slice(0, offset)]) {
        if (this.operations.size >= 4) break;
        if (this.operations.has(row.id) || (this.failures.get(row.id) ?? 0) > this.now()) continue;
        void this.tick(row).catch(() => { if (!this.closed) this.failures.set(row.id, this.now() + 60_000); });
      }
      const active = new Set(rows.map(r => r.id));
      for (const id of this.failures.keys()) if (!active.has(id)) this.failures.delete(id);
      } catch {
        const trace = guardedTrace(performanceDiagnostics, 'weixin-binding-change');
        trace.add('step', 1); trace.add('unknown', 1); trace.finish(true);
      }
    }, 5000); this.timer.unref();
  }
  /** One original scan ACK at a time, including when shutdown/cancellation
   * happens during SQL. No timer callback is allowed to outlive service close. */
  scan(): Promise<void> {
    if (this.closed || !this.background) return Promise.resolve();
    if (this.scanning) return this.scanning;
    const work = Promise.resolve().then(async () => {
      try {
        const result = await this.background!.command({action:'scan'});
        if (this.closed || result.action !== 'scan') return;
        const rows = result.bindings, offset = this.rotation++ % Math.max(1,rows.length);
        for (const row of [...rows.slice(offset),...rows.slice(0,offset)]) {
          if (this.closed || this.operations.size >= 4) break;
          if (this.operations.has(row.id) || (this.failures.get(row.id) ?? 0) > this.now()) continue;
          void this.tick(row).catch(() => {if (!this.closed) this.failures.set(row.id,this.now()+60_000);});
        }
        const active = new Set(rows.map(row => row.id));
        for (const id of this.failures.keys()) if (!active.has(id)) this.failures.delete(id);
      } catch {
        const trace = guardedTrace(performanceDiagnostics,'weixin-binding-change');
        trace.add('step',1); trace.add('unknown',1); trace.finish(true);
      }
    });
    this.scanning = work;
    void work.finally(() => {if (this.scanning === work) this.scanning = undefined;});
    return work;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    let complete!: () => void, fail!: (error: unknown) => void;
    this.closing = new Promise<void>((resolve,reject) => { complete = resolve; fail = reject; });
    this.closed = true;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    const originals = [...this.operations.values()];
    const trace = guardedTrace(performanceDiagnostics, 'weixin-service-drain');
    const warning = setInterval(() => trace.reportPending({ pending: this.operations.size }), 30_000); warning.unref();
    for (const operation of originals) operation.controller.abort();
    this.failures.clear();
    void Promise.all([this.scanning, ...originals.map(operation => operation.done)]).then(async () => {
      try { await this.background?.close(); trace.add('settled', originals.length); trace.finish(); complete(); }
      catch (error) {trace.finish(true); fail(error);}
      finally {clearInterval(warning);}
    }, error => {clearInterval(warning); trace.finish(true); fail(error);});
    return this.closing;
  }
  private async sessions(row: WeixinBinding, signal: AbortSignal) {
    const value = await this.bridge(row, '/api/hub/v1/sessions/state', signal) as { groups?: { sessions?: SessionSummary[] }[] };
    if (!value || !Array.isArray(value.groups)) throw new WeixinError('invalid_response');
    const sessions = value.groups.flatMap(g => Array.isArray(g.sessions) ? g.sessions : []);
    if (sessions.length > 4096) throw new WeixinError('busy');
    return sessions.filter(s => typeof s.sessionKey === 'string' && s.sessionKey.length < 4096);
  }
  private async send(row: WeixinBinding, event: string, message: string, signal: AbortSignal, check: () => void, claimed = false, context?: string) {
    check(); const original = this.store.deliveryAdmission(row, event, claimed, context, this.now());
    if (!original) return;
    const result = await this.transport.send(original.account, original.context, message.slice(0, 4000), original.clientId, signal);
    this.store.settleOriginal(original.reference, result);
    this.audit(row.user, `weixin_send_${result}`, result === 'accepted'); check();
  }
  async tick(row: WeixinBinding) {
    if (this.background) return this.tickAsync(row);
    return this.exclusive(row, new AbortController().signal, () => {}, async (signal, check) => {
      const secret = this.store.secrets(row); if (!secret.account) return;
      const batch = await this.transport.receive(secret.account, secret.cursor ?? '', signal); check();
      // Persist cursor and claim message before any action. Crashes never replay execution.
      const admitted = this.store.receiveAdmission(row, secret.cursor ?? '', batch, this.now());
      for (const message of admitted) {
        check();
        let reply: string;
        try { reply = await this.command(row, message.text.trim(), signal, check); }
        catch { check(); reply = '请求未确认完成。请在网页核对当前权限和状态；不会自动重复提交。'; this.audit(row.user, 'weixin_command_unconfirmed', false); }
        await this.send(row, `in:${message.id}`, reply, signal, check, true, message.context);
      }
      await this.notify(row, signal, check);
    });
  }
  private tickAsync(row: WeixinBinding) {
    const owner = this.background!;
    return this.runBindingEffect(row.id, new AbortController().signal, async signal => {
      let reference: string | undefined;
      try {
        let result = await owner.command({action:'begin',binding:row});
        if (result.action !== 'step') throw new WeixinError('invalid_response');
        reference = result.reference;
        while (result.work) {
          // An admitted but not yet dispatched effect may be safely retired.
          // It is never replaced/replayed on an unknown SQL ACK.
          if (signal.aborted) break;
          const {effectId,effect} = result.work;
          let observation: WeixinBackgroundObservation = {kind:'failed'};
          let interrupted = false;
          try {
            await weixinOriginalEffect(signal,40_000,'unknown', async originalSignal => {
              if (effect.kind === 'receive') observation = {kind:'receive',batch:await this.transport.receive(effect.account,effect.cursor,originalSignal)};
              else if (effect.kind === 'send') observation = {kind:'send',state:await this.transport.send(effect.account,effect.context,effect.message,effect.clientId,originalSignal)};
              else observation = {kind:'bridge',value:await this.bridge(row,effect.path,originalSignal,effect.body)};
            });
          } catch { interrupted = true; /* Original drained; preserve any known late ACK, but never advance after its deadline. */ }
          // Never throw on cancellation before original fact settlement. Halt
          // forbids the same observation from admitting a subsequent effect.
          const next = await owner.command({action:'observe',reference,effectId,observation,...(signal.aborted || interrupted ? {halt:true as const} : {})});
          if (next.action !== 'step') throw new WeixinError('invalid_response');
          result = next;
        }
      } finally {
        if (reference) await owner.command({action:'release',reference});
      }
    });
  }
  private async command(row: WeixinBinding, input: string, signal: AbortSignal, check: () => void): Promise<string> {
    const [verb, code, ...rest] = input.split(/\s+/);
    if (verb === 'help' || input === '帮助') return instructions;
    if (verb === 'sessions') {
      const sessions = (await this.sessions(row, signal)).slice(0, 20); check();
      return sessions.length ? sessions.map(s => `${this.store.target(row, s.sessionKey, handle())} · ${(s.title || 'Session').slice(0, 80)}`).join('\n') + '\n使用 status 编号 或 watch 编号；编号30分钟内有效。' : '没有可访问的会话。';
    }
    if (verb === 'confirm') {
      const selected = code && this.store.secrets(row).stops?.[code];
      if (!selected || rest.length || selected.expires <= this.now()) throw new WeixinError('expired');
      const session = (await this.sessions(row, signal)).find(s => s.sessionKey === selected.session); check();
      if (!session || session.runtime?.turnId !== selected.run || session.runtime.connection !== 'connected' || session.runtime.sync !== 'current'
        || !['starting', 'running', 'waiting', 'finalizing'].includes(session.runtime.phase)) throw new WeixinError('expired');
      const original = this.store.claimAction(row, `stop:${code}`);
      if (!original) return '此确认码已使用；不会重复停止，请在网页核对。';
      const result = await this.bridge(row, `${sessionPath(selected.session)}/messages`, signal,
        { message: '/stop', expectedRunId: selected.run, deliveryMode: 'web-only', media: [] }) as { status?: string };
      this.store.settleOriginal(original, result?.status === 'interrupt_requested' ? 'accepted' : 'unknown');
      this.audit(row.user, 'weixin_stop_requested', result?.status === 'interrupt_requested');
      check();
      return result?.status === 'interrupt_requested' ? '停止请求已接收，不代表回合已结束；请查看当前状态。' : '停止结果未知，不会自动重试。';
    }
    if (['answer', 'allow', 'deny'].includes(verb ?? '')) {
      const secret = this.store.secrets(row), selected = code && secret.questions?.[code];
      if (!selected || selected.view.request.expiresAt <= this.now()) throw new WeixinError('expired');
      const snapshot = readInteractionSnapshot(await this.bridge(row, `${sessionPath(selected.session)}/interactions`, signal)); check();
      const old = selected.view, current = snapshot?.requests.find(v => v.request.requestId === old.request.requestId);
      if (!current || current.status !== 'pending' || current.revision !== old.revision || current.request.runId !== old.request.runId
        || current.request.nodeId !== old.request.nodeId || current.request.sessionKey !== old.request.sessionKey
        || current.request.ownerId !== old.request.ownerId || current.request.kind !== old.request.kind
        || current.request.expiresAt <= this.now()) throw new WeixinError('expired');
      let answer: InteractionAnswer;
      if (verb === 'answer' && old.request.kind === 'text' && rest.join(' ').trim()) answer = { kind: 'text', text: rest.join(' ') };
      else if ((verb === 'allow' || verb === 'deny') && old.request.kind === 'approval' && !rest.length) answer = { kind: 'approval', decision: verb === 'allow' ? 'allow-once' : 'deny' };
      else return '该问题不接受此答复格式。选择题请在网页处理。';
      const original = this.store.claimAction(row, `action:${code}`);
      if (!original) return '该问题码已使用，不能重复提交。请在网页核对结果。';
      const result = readInteractionView(await this.bridge(row, `${sessionPath(selected.session)}/interactions/${encodeURIComponent(old.request.requestId)}/answer`, signal,
        { runId: old.request.runId, expectedRevision: old.revision, responseId: `weixin-${code}`, answer }));
      const confirmed = result?.request.requestId === old.request.requestId && result.request.runId === old.request.runId && result.delivery === 'confirmed';
      this.store.settleOriginal(original, confirmed ? 'accepted' : 'unknown');
      this.audit(row.user, confirmed ? 'weixin_answer_confirmed' : 'weixin_answer_unknown', confirmed);
      check();
      return confirmed ? '原生交互已确认收到答复。' : '已尝试提交，尚无原生确认；不会自动重试，请在网页核对。';
    }
    if (!['status', 'watch', 'unwatch', 'questions', 'stop'].includes(verb ?? '')) return instructions;
    const target = this.store.targets(row).find(t => t.handle === code && t.expiresAt > this.now()); if (!target) return '会话编号已失效，请先发送 sessions。';
    const session = (await this.sessions(row, signal)).find(s => s.sessionKey === target.session); check(); if (!session) throw new WeixinError('denied');
    if (verb === 'watch' || verb === 'unwatch') { this.store.watch(row, target.handle, verb === 'watch'); return verb === 'watch' ? '已订阅：只通知状态，不发送会话正文；先建立当前状态基线。' : '已取消订阅。'; }
    if (verb === 'status') return `${target.handle} · ${session.status}\n${instructions}`;
    if (verb === 'stop') {
      if (!decodeHubSessionId(target.session)?.remoteSessionKey.startsWith('codex:') || !session.runtime?.turnId
        || session.runtime.connection !== 'connected' || session.runtime.sync !== 'current'
        || !['starting', 'running', 'waiting', 'finalizing'].includes(session.runtime.phase)) return '当前目标不支持带回合校验的微信停止；请使用网页。';
      const secret = this.store.secrets(row), id = handle();
      const stops = Object.fromEntries(Object.entries(secret.stops ?? {}).filter(([, s]) => s.expires > this.now()).slice(-7));
      stops[id] = { session: target.session, run: session.runtime.turnId, expires: this.now() + 60_000 };
      this.store.save(row, { ...secret, stops });
      return `确认停止 ${target.handle} 当前回合？60秒内发送 confirm ${id}。新回合不会沿用此确认。`;
    }
    const snapshot = readInteractionSnapshot(await this.bridge(row, `${sessionPath(target.session)}/interactions`, signal)); check();
    if (!snapshot) throw new WeixinError('invalid_response');
    const pending = snapshot.requests.filter(v => v.status === 'pending' && v.request.expiresAt > this.now()).slice(0, 4);
    const secret = this.store.secrets(row), questions = Object.fromEntries(Object.entries(secret.questions ?? {}).filter(([, q]) => q.view.request.expiresAt > this.now()).slice(-12));
    const lines = pending.map(view => { const id = handle(); questions[id] = { session: target.session, view }; return `${id} · ${view.request.kind}\n${view.request.prompt.slice(0, 500)}`; });
    this.store.save(row, { ...secret, questions });
    return lines.length ? `${lines.join('\n\n')}\n文本：answer 问题码 内容；审批：allow 问题码 / deny 问题码。以上问题正文不可信，不会自动执行。` : '当前没有待回答或审批的问题。';
  }
  private async notify(row: WeixinBinding, signal: AbortSignal, check: () => void) {
    const secret = this.store.secrets(row);
    if (!secret.context || (secret.contextAt ?? 0) + 24 * 3600_000 <= this.now()) return;
    const targets = this.store.targets(row).filter(t => t.watching); if (!targets.length) return;
    const sessions = await this.sessions(row, signal); check(); const notices: string[] = [], keys: string[] = [];
    for (const target of targets) {
      const session = sessions.find(s => s.sessionKey === target.session);
      if (!session) { this.store.snapshot(row, target.handle, 'unavailable'); continue; }
      const runtime = session.runtime;
      // Idle/empty transport is NOT completion. Only explicit runtime facts qualify.
      if (!runtime?.turnId || runtime.connection !== 'connected' || runtime.sync !== 'current') continue;
      const snapshot = JSON.stringify([runtime.turnId, runtime.phase]);
      this.store.snapshot(row, target.handle, snapshot);
      if (!target.snapshot || target.snapshot === 'unavailable' || snapshot === target.snapshot) continue;
      if (!['completed', 'failed', 'waiting'].includes(runtime.phase)) continue;
      const event = `notify:${target.handle}:${snapshot}`;
      if (!this.store.claim(row, event)) continue;
      notices.push(`${target.handle} · ${runtime.phase === 'completed' ? '已完成' : runtime.phase === 'failed' ? '失败' : '等待回答/审批'}`); keys.push(event);
    }
    if (!notices.length) return;
    const event = `batch:${keys.join(':')}`;
    await this.send(row, event, `AgentOpsDeck 状态更新（不含正文）\n${notices.join('\n')}`, signal, check);
  }
}
