import { randomBytes } from 'node:crypto';
import { AGENTOPSDECK_VERSION } from '@agentopsdeck/shared';
import { weixinOriginalEffect } from './weixin-original-effect.js';

// Wire contract checked against @tencent-weixin/openclaw-weixin 2.4.9.
// No plugin installation, account import, telemetry or third-party scripts.
export const WEIXIN_ORIGIN = 'https://ilinkai.weixin.qq.com';
export class WeixinError extends Error {
  constructor(readonly code: 'unavailable' | 'invalid_response' | 'expired' | 'denied' | 'busy' | 'not_configured' | 'unknown') { super(`weixin_${code}`); }
}
export type WeixinAccount = { botId: string; peerId: string; token: string; baseUrl: string };
export type WeixinMessage = { id: string; peerId: string; at: number; text: string; context: string };
export type WeixinQrStatus = { state: 'wait' | 'scanned' | 'verify' | 'expired' | 'redirect' | 'confirmed'; baseUrl?: string; account?: WeixinAccount };
export interface WeixinTransport {
  qr(signal: AbortSignal): Promise<{ code: string; url: string }>;
  pollQr(code: string, baseUrl: string, verify: string | undefined, signal: AbortSignal): Promise<WeixinQrStatus>;
  receive(account: WeixinAccount, cursor: string, signal: AbortSignal): Promise<{ cursor: string; messages: WeixinMessage[] }>;
  send(account: WeixinAccount, context: string, text: string, id: string, signal: AbortSignal): Promise<'accepted' | 'unknown'>;
}
export function weixinOrigin(value: unknown): string {
  if (typeof value !== 'string') throw new WeixinError('invalid_response');
  let u: URL; try { u = new URL(value); } catch { throw new WeixinError('invalid_response'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash || u.pathname !== '/'
    || !/^ilink[a-z0-9-]*\.weixin\.qq\.com$/.test(u.hostname)) throw new WeixinError('invalid_response');
  return u.origin;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WeixinError('invalid_response');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || !value || value.length > max) throw new WeixinError('invalid_response');
  return value;
}
export class HttpWeixinTransport implements WeixinTransport {
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly deadlineMs?: number) {}
  private async call(origin: string, endpoint: string, signal: AbortSignal, body?: unknown, token?: string, poll = false) {
    try { return await weixinOriginalEffect(signal, this.deadlineMs ?? (poll ? 35_000 : 15_000), 'unavailable', async (originalSignal, retain) => {
      originalSignal.throwIfAborted();
      const response = await this.fetcher(new URL(endpoint, weixinOrigin(origin)), {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: originalSignal,
        headers: { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
          'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '132105',
          'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),
          ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const reader = response.body ? retain(response.body) : undefined;
      originalSignal.throwIfAborted();
      if (!response.ok || !reader) throw new WeixinError('unavailable');
      const parts: Uint8Array[] = []; let bytes = 0;
      while (true) {
        const part = await reader.read(); originalSignal.throwIfAborted(); if (part.done) break;
        bytes += part.value.length; if (bytes > 512 * 1024) throw new WeixinError('invalid_response'); parts.push(part.value);
      }
      // Node22 JSON source context preserves uint64 IDs, including values above 2^53.
      const value = record(JSON.parse(Buffer.concat(parts).toString('utf8'), (key: string, value: unknown, context?: { source?: string }) => {
        if (key === 'message_id' && typeof value === 'number') return context?.source ?? (Number.isSafeInteger(value) ? String(value) : null);
        return value;
      }));
      if (value.ret !== undefined && value.ret !== 0) throw new WeixinError(value.ret === -14 ? 'expired' : 'unavailable');
      if (value.errcode !== undefined && value.errcode !== 0) throw new WeixinError('unavailable');
      return value;
    }); }
    catch (error) { throw error instanceof WeixinError ? error : new WeixinError('unavailable'); }
  }
  async qr(signal: AbortSignal) {
    const data = await this.call(WEIXIN_ORIGIN, '/ilink/bot/get_bot_qrcode?bot_type=3', signal, { local_token_list: [] });
    const url = text(data.qrcode_img_content, 8192);
    // This is QR payload, rendered locally, never fetched by the Hub/browser as an image.
    let parsed: URL; try { parsed = new URL(url); } catch { throw new WeixinError('invalid_response'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new WeixinError('invalid_response');
    return { code: text(data.qrcode), url };
  }
  async pollQr(code: string, baseUrl: string, verify: string | undefined, signal: AbortSignal): Promise<WeixinQrStatus> {
    const data = await this.call(baseUrl, `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(code)}${verify ? `&verify_code=${encodeURIComponent(verify)}` : ''}`, signal, undefined, undefined, true);
    switch (data.status) {
      case 'wait': return { state: 'wait' };
      case 'scaned': return { state: 'scanned' };
      case 'need_verifycode': return { state: 'verify' };
      case 'expired': return { state: 'expired' };
      case 'scaned_but_redirect': return { state: 'redirect', baseUrl: weixinOrigin(`https://${text(data.redirect_host, 255)}`) };
      case 'confirmed': return { state: 'confirmed', account: { botId: text(data.ilink_bot_id), peerId: text(data.ilink_user_id),
        token: text(data.bot_token), baseUrl: weixinOrigin(data.baseurl ?? WEIXIN_ORIGIN) } };
      default: throw new WeixinError('invalid_response');
    }
  }
  async receive(account: WeixinAccount, cursor: string, signal: AbortSignal) {
    const data = await this.call(account.baseUrl, '/ilink/bot/getupdates', signal,
      { get_updates_buf: cursor, base_info: { channel_version: '2.4.9', bot_agent: `AgentOpsDeck/${AGENTOPSDECK_VERSION}` } }, account.token, true);
    const incoming = data.msgs ?? [];
    if (!Array.isArray(incoming) || incoming.length > 100) throw new WeixinError('invalid_response');
    const messages: WeixinMessage[] = [];
    for (const raw of incoming) {
      const m = record(raw);
      // Never promote arbitrary inbound users/groups into the QR owner's authority.
      if (m.message_type !== 1 || m.message_state !== 2 || m.from_user_id !== account.peerId) continue;
      if (!Number.isSafeInteger(m.create_time_ms) || !Array.isArray(m.item_list) || m.item_list.length !== 1) continue;
      const item = record(m.item_list[0]); if (item.type !== 1) continue;
      messages.push({ id: text(m.message_id, 128), peerId: account.peerId, at: m.create_time_ms as number,
        text: text(record(item.text_item).text, 4000), context: text(m.context_token, 8192) });
    }
    const next = data.get_updates_buf ?? cursor;
    if (typeof next !== 'string' || next.length > 64 * 1024) throw new WeixinError('invalid_response');
    return { cursor: next, messages };
  }
  async send(account: WeixinAccount, context: string, message: string, id: string, signal: AbortSignal): Promise<'accepted' | 'unknown'> {
    if (!context || !message || message.length > 4000 || !id || id.length > 128) throw new WeixinError('denied');
    try {
      const data = await this.call(account.baseUrl, '/ilink/bot/sendmessage', signal, {
        msg: { from_user_id: '', to_user_id: account.peerId, client_id: id, message_type: 2, message_state: 2,
          context_token: context, item_list: [{ type: 1, text_item: { text: message } }] },
        base_info: { channel_version: '2.4.9', bot_agent: `AgentOpsDeck/${AGENTOPSDECK_VERSION}` },
      }, account.token);
      return data.ret === 0 ? 'accepted' : 'unknown';
    } catch { return 'unknown'; } // A timeout/HTTP error is not evidence of non-delivery. Never retry.
  }
}
