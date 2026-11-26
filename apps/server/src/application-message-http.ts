import { createHash, randomUUID } from 'node:crypto';
import { createCommandKey, sessionRuntimeId } from '@agentopsdeck/shared';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { createApplicationCommandScopes } from './auth/application-command-scope.js';
import type { createApplicationStatusIngress } from './application-status-ingress.js';
import type { createApplicationCompactIngress } from './application-compact-ingress.js';
import { SessionReadAuthority, type SessionReadActor } from './auth/session-read-authority.js';
import { reply } from './commands/http.js';
import type { AsyncCodexMessages } from './connector/async-codex-messages.js';
import type { AsyncOpenClawMessages } from './connector/async-openclaw-messages.js';
import type { AsyncSdkMessages } from './connector/async-sdk-messages.js';
import type { AsyncHermesMessages } from './connector/async-hermes-messages.js';
import { CODEX_MESSAGE_PAYLOAD_BYTES } from './connector/connector-codex-message-domain.js';
import { OPENCLAW_MESSAGE_PAYLOAD_BYTES } from './connector/connector-openclaw-message-domain.js';
import { SDK_MESSAGE_PAYLOAD_BYTES } from './connector/connector-sdk-message-domain.js';
import { HERMES_MESSAGE_PAYLOAD_BYTES } from './connector/connector-hermes-message-domain.js';
import { ConnectorOwnerUnavailable } from './connector/connector-owner-domain.js';
import { isSdkCompactCommand } from './connector/sdk-text-command.js';
import type { AsyncLocalCredentials } from './connector/async-local-credentials.js';
import type { createApplicationMessageIngress } from './application-message-ingress.js';
import type { createApplicationStopIngress } from './application-stop-ingress.js';
import { guardedTrace } from './diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from './diagnostics/performance.js';
import { readJsonBody } from './utils/http-body.js';

type PhysicalReads<T> = Pick<T, Extract<keyof T, 'readReceiptPhysical' | 'readSendReceiptPhysical'>>;
type Runtime = ReturnType<typeof sessionRuntimeId>;
type Scope = { key: string; commandKey: string; authorization: string };
const validKey = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
const readDigest = createHash('sha256').update('original-message-receipt-read').digest('hex');
const unknown = (c: Context, commandKey: string) => {
  c.header('X-AgentOpsDeck-Command-Key', commandKey);
  return c.json({ error: 'Command outcome unavailable; read the original command key, do not resend',
    status: 'outcome_unknown', commandKey }, 503);
};

/** Original local administrator route, not Connector v1 or a Hub address
 * rewrite. The startup credential is transport-only; original application
 * evidence remains on the paired SQL transaction and on every delivery check.
 * No caller-supplied actor, bearer, node or delegated grant is forwarded. */
export function registerApplicationMessagesHttp(app: Hono, deps: {
  commands: Pick<ReturnType<typeof createApplicationCommandScopes>, 'run'>;
  ingress: ReturnType<typeof createApplicationMessageIngress>;
  stopIngress?: ReturnType<typeof createApplicationStopIngress>;
  statusIngress?: ReturnType<typeof createApplicationStatusIngress>;
  compactIngress?: ReturnType<typeof createApplicationCompactIngress>;
  credentials: Pick<AsyncLocalCredentials, 'token'>;
  observeActor: SessionReadActor;
  available(): boolean;
  ports: {
    codex?: PhysicalReads<AsyncCodexMessages>;
    openclaw?: PhysicalReads<AsyncOpenClawMessages>;
    sdk?: PhysicalReads<AsyncSdkMessages>;
    hermes?: PhysicalReads<AsyncHermesMessages>;
  };
  timeoutMs?: number;
  diagnostics?: PerformanceDiagnostics;
}) {
  const timeoutMs = deps.timeoutMs ?? 10_000, diagnostics = deps.diagnostics ?? performanceDiagnostics;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new RangeError('Finite application message deadline required');
  let closed = false, readers = 0;
  const authority = new SessionReadAuthority(request => {
    if (closed || !deps.available()) throw new ConnectorOwnerUnavailable();
    return deps.observeActor(request);
  }, diagnostics, timeoutMs);
  const available = () => !closed && deps.available();
  const originalRequest = (request: Request) => {
    const headers = new Headers();
    for (const name of ['authorization', 'x-agentopsdeck-key', 'cookie']) {
      const value = request.headers.get(name); if (value !== null) headers.set(name, value);
    }
    return new Request('http://application-messages.invalid/', { headers, signal: request.signal });
  };
  const local = (key: string, commandKey: string): Scope => {
    if (!available()) throw new ConnectorOwnerUnavailable();
    const token = deps.credentials.token('daily');
    if (!token) throw new ConnectorOwnerUnavailable();
    return { key, commandKey, authorization: `Bearer ${token}` };
  };
  const readPhysical = (runtime: Runtime, scope: Scope, forSend: boolean) => {
    const method = forSend ? 'readSendReceiptPhysical' : 'readReceiptPhysical';
    if (runtime === 'claude-code' || runtime === 'ghcp' || runtime === 'antigravity') {
      if (!deps.ports.sdk) throw new ConnectorOwnerUnavailable();
      return deps.ports.sdk[method]({ ...scope, runtime });
    }
    const port = deps.ports[runtime];
    if (!port) throw new ConnectorOwnerUnavailable();
    return port[method](scope);
  };
  const read = (request: Request, runtime: Runtime, scope: Scope, forSend: boolean) => deps.commands.run(request,
    { action: 'message', runtime, resource: scope.key, commandKey: scope.commandKey, payloadDigest: readDigest },
    async command => {
      await deps.statusIngress?.recoverPhysical(runtime, scope, command);
      if (runtime === 'openclaw' && deps.compactIngress) {
        const compact = await deps.compactIngress.readPhysical(runtime, scope, command, 'message');
        if ('error' in compact) throw new ConnectorOwnerUnavailable();
      }
      const result = await readPhysical(runtime, scope, forSend);
      // A buffered receipt is not authority after Cookie/Key revocation.
      await command.authorize('prepare'); command.local(); return result;
    });
  const send = (request: Request, runtime: Runtime, scope: Scope, payloadJson: string, control: 'stop' | 'status' | 'compact' | undefined) => {
    const wait = { timeoutMs, signal: request.signal }, input = { ...scope, payloadJson };
    if (control === 'compact') {
      if (!deps.compactIngress || runtime !== 'openclaw') throw new ConnectorOwnerUnavailable();
      return deps.compactIngress.openclaw(request, { ...input, operation: 'message' }, wait);
    }
    if (control === 'status') {
      if (!deps.statusIngress || runtime === 'codex') throw new ConnectorOwnerUnavailable();
      if (runtime === 'claude-code' || runtime === 'ghcp' || runtime === 'antigravity') return deps.statusIngress.sdk(request, { ...input, runtime }, wait);
      return deps.statusIngress[runtime](request, input, wait);
    }
    if (control === 'stop') {
      if (!deps.stopIngress) throw new ConnectorOwnerUnavailable();
      if (runtime === 'claude-code' || runtime === 'ghcp' || runtime === 'antigravity') return deps.stopIngress.sdk(request, { ...input, runtime }, wait);
      return deps.stopIngress[runtime](request, input, wait);
    }
    if (runtime === 'claude-code' || runtime === 'ghcp' || runtime === 'antigravity') return deps.ingress.sdk(request, { ...input, runtime }, wait);
    return deps.ingress[runtime](request, input, wait);
  };
  const path = '/api/sessions/:sessionKey';
  app.post(`${path}/messages`, async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!available()) return c.json({ error: 'server_draining' }, 503);
    if (readers >= 2) return c.json({ error: 'Message input capacity reached' }, 503);
    // A raw local endpoint cannot turn a browser-provided grant into a local
    // issuer binding, including when the browser happens to know a token.
    if (c.req.header('x-agentopsdeck-execution-grant') !== undefined) return c.json({ error: 'Delegated execution is not supported' }, 403);
    const trace = guardedTrace(diagnostics, 'application-message-http');
    readers++;
    let physicalStarted = false;
    let failed = true, commandKey = createCommandKey(randomUUID());
    try {
      const request = originalRequest(c.req.raw), key = c.req.param('sessionKey')!, runtime = sessionRuntimeId(key);
      const original = { url: c.req.raw.url, method: c.req.raw.method, headers: [...c.req.raw.headers] };
      const header = c.req.header('idempotency-key');
      return await authority.run(request, async check => {
        physicalStarted = true;
        try {
        trace.add('step', 1);
        const bytes = runtime === 'hermes' ? HERMES_MESSAGE_PAYLOAD_BYTES
          : runtime === 'claude-code' || runtime === 'ghcp' || runtime === 'antigravity' ? SDK_MESSAGE_PAYLOAD_BYTES
          : runtime === 'codex' ? CODEX_MESSAGE_PAYLOAD_BYTES : OPENCLAW_MESSAGE_PAYLOAD_BYTES;
        const raw = await readJsonBody(c.req.raw, bytes, timeoutMs);
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ error: 'JSON object required' }, 400);
        const { idempotencyKey, ...payload } = raw as Record<string, unknown>;
        // Controls have their own native lifetime/receipt domains. Never send
        // an unmigrated local slash command as an ordinary model message.
        const text = typeof payload.message === 'string' ? payload.message.trim() : '';
        const media = Array.isArray(payload.media) && payload.media.length > 0;
        const control = runtime === 'codex' ? text === '/stop'
          : runtime === 'openclaw' ? text === '/stop'
            || (text === '/status' || text === '/compact') && (!media || payload.deliveryMode === 'mirror')
          : runtime === 'claude-code' || runtime === 'ghcp' || runtime === 'antigravity' ? text === '/stop' || text === '/status' || isSdkCompactCommand(text)
          : text === '/stop' || text === '/status' || text === '/compact';
        const localControl = text === '/stop' && deps.stopIngress ? 'stop'
          : control && text === '/status' && runtime !== 'codex' && deps.statusIngress ? 'status'
          : control && text === '/compact' && runtime === 'openclaw' && deps.compactIngress ? 'compact' : undefined;
        if (control && !localControl) {
          // The next owner may be a separate Hono application using raw.fetch
          // or readJsonBody, not c.req.json(). A JSON cache alone leaves that
          // owner's Request consumed. Restore only this bounded original body;
          // never insert the private Connector transport credential.
          const body = JSON.stringify(raw), headers = new Headers(original.headers);
          headers.set('content-length', String(Buffer.byteLength(body)));
          c.req.raw = new Request(original.url, { method: original.method, headers, body, signal: request.signal });
          c.req.bodyCache.json = Promise.resolve(raw); await check(); await next(); failed = false; return c.res;
        }
        if (header !== undefined && idempotencyKey !== undefined && header !== idempotencyKey) return c.json({ error: 'Conflicting command keys' }, 400);
        const selected = header ?? idempotencyKey ?? commandKey;
        if (!validKey(selected)) return c.json({ error: 'Invalid command key' }, 400);
        commandKey = selected; c.header('X-AgentOpsDeck-Command-Key', commandKey);
        await check();
        const scope = local(key, commandKey);
        trace.add('step', 2);
        const result = await send(request, runtime, scope, JSON.stringify(payload), localControl);
        if ('error' in result) return c.json({ error: 'Message admission unavailable' }, result.error);
        trace.add('step', 3);
        const current = await read(request, runtime, scope, true);
        if ('error' in current) return c.json({ error: 'Message authority unavailable' }, current.error);
        if (!current.receipt) return unknown(c, commandKey);
        if (current.receipt.id !== result.receipt?.id) return c.json({ error: 'Message authority changed' }, 403);
        await check(); failed = false; return reply(c, current.receipt);
        } finally { readers--; }
      });
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      return unknown(c, commandKey);
    } finally { if (!physicalStarted) readers--; trace.finish(failed); }
  });
  for (const queue of [false, true]) app.get(`${path}/commands/:commandKey${queue ? '/queue' : ''}`, async c => {
    c.header('Cache-Control', 'no-store');
    if (!available()) return c.json({ error: 'server_draining' }, 503);
    const key = c.req.param('sessionKey')!, commandKey = c.req.param('commandKey')!;
    if (!validKey(commandKey)) return c.json({ error: 'Invalid command key' }, 400);
    const request = originalRequest(c.req.raw), trace = guardedTrace(diagnostics, 'application-message-http');
    let failed = true;
    try {
      return await authority.run(request, async check => {
        trace.add('step', queue ? 5 : 4);
        const result = await read(request, sessionRuntimeId(key), local(key, commandKey), false);
        if ('error' in result) return c.json({ error: 'Message authority unavailable' }, result.error);
        if (!result.receipt) return c.json({ error: 'Command not found' }, 404);
        await check(); failed = false;
        return queue ? c.json({ commandKey, queue: result.queue }) : c.json({ command: result.receipt });
      });
    } catch { return unknown(c, commandKey); }
    finally { trace.finish(failed); }
  });
  // Dedicated local compact routes share the same input slots, request
  // authority and close/drain as messages. No detached route lifetime.
  const compactRuntime = (key: string) => {
    const runtime = sessionRuntimeId(key);
    return runtime === 'openclaw' || runtime === 'claude-code' || runtime === 'ghcp' || runtime === 'antigravity' ? runtime : undefined;
  };
  const compactRead = (request: Request, runtime: NonNullable<ReturnType<typeof compactRuntime>>, scope: Scope) =>
    deps.commands.run(request, { action: 'compact', runtime, resource: scope.key, commandKey: scope.commandKey, payloadDigest: readDigest },
      command => deps.compactIngress!.readPhysical(runtime, scope, command));
  app.get(`${path}/compact-commands/:commandKey`, async (c, next) => {
    const key = c.req.param('sessionKey')!, runtime = compactRuntime(key);
    if (!deps.compactIngress || !runtime) return next();
    c.header('Cache-Control', 'no-store');
    const commandKey = c.req.param('commandKey')!;
    if (!validKey(commandKey)) return c.json({ error: 'Invalid command key' }, 400);
    if (c.req.header('x-agentopsdeck-execution-grant') !== undefined) return c.json({ error: 'Delegated execution is not supported' }, 403);
    const trace = guardedTrace(diagnostics, 'application-compact-http'); let failed = true;
    try {
      const request = originalRequest(c.req.raw);
      return await authority.run(request, async check => {
        trace.add('step', 1);
        const result = await compactRead(request, runtime, local(key, commandKey));
        if ('error' in result) return c.json({ error: 'Compaction authority unavailable' }, result.error);
        if (!result.receipt) return c.json({ error: 'Command not found' }, 404);
        await check(); failed = false; return c.json({ command: result.receipt });
      });
    } catch (error) { if (error instanceof HTTPException) throw error; return unknown(c, commandKey); }
    finally { trace.finish(failed); }
  });
  app.post(`${path}/compact`, async (c, next) => {
    const key = c.req.param('sessionKey')!, runtime = compactRuntime(key);
    if (!deps.compactIngress || !runtime) return next();
    c.header('Cache-Control', 'no-store');
    if (!available()) return c.json({ error: 'server_draining' }, 503);
    if (readers >= 2) return c.json({ error: 'Compact input capacity reached' }, 503);
    if (c.req.header('x-agentopsdeck-execution-grant') !== undefined) return c.json({ error: 'Delegated execution is not supported' }, 403);
    const trace = guardedTrace(diagnostics, 'application-compact-http');
    let failed = true, physicalStarted = false, commandKey = createCommandKey(randomUUID()); readers++;
    try {
      const request = originalRequest(c.req.raw);
      return await authority.run(request, async check => {
        physicalStarted = true;
        try {
          trace.add('step', 2);
          const raw = await readJsonBody(c.req.raw, 4096, timeoutMs);
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ error: 'JSON object required' }, 400);
          const { idempotencyKey, ...payload } = raw as Record<string, unknown>;
          if (Object.keys(payload).length) return c.json({ error: 'Compact takes no message or native options' }, 400);
          const header = c.req.header('idempotency-key');
          if (header !== undefined && idempotencyKey !== undefined && header !== idempotencyKey) return c.json({ error: 'Conflicting command keys' }, 400);
          const selected = header ?? idempotencyKey ?? commandKey;
          if (!validKey(selected)) return c.json({ error: 'Invalid command key' }, 400);
          commandKey = selected; c.header('X-AgentOpsDeck-Command-Key', commandKey); await check();
          const scope = local(key, commandKey), wait = { timeoutMs, signal: request.signal };
          const result = runtime === 'openclaw'
            ? await deps.compactIngress!.openclaw(request, { ...scope, payloadJson: '{}', operation: 'compact' }, wait)
            : await deps.compactIngress!.sdk(request, { ...scope, runtime, payloadJson: '{}' }, wait);
          if ('error' in result) return c.json({ error: 'Compaction authority unavailable' }, result.error);
          trace.add('step', 3);
          const current = await compactRead(request, runtime, scope);
          if ('error' in current) return c.json({ error: 'Compaction authority unavailable' }, current.error);
          await check();
          if (current.receipt) { failed = false; return reply(c, current.receipt); }
          if ('dispatch' in result && result.dispatch === 'blocked') return c.json({ error: 'Compaction authority unavailable' }, 403);
          if ('dispatch' in result && result.dispatch === 'not_started') return c.json({ error: 'Compaction was not admitted; session must be ready and queue empty' }, 409);
          return unknown(c, commandKey);
        } finally { readers--; }
      });
    } catch (error) { if (error instanceof HTTPException) throw error; return unknown(c, commandKey); }
    finally { if (!physicalStarted) readers--; trace.finish(failed); }
  });
  return { close() { closed = true; return authority.close(); }, get pending() { return authority.pending; } };
}
