import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { CommandQueueObservation } from '@agentopsdeck/shared';
import { createCommandKey } from '@agentopsdeck/shared';
import { CommandCapacity, CommandConflict, type CommandReceipt, type CommandReceipts, type CommandResult } from './receipts.js';
import { readJsonBody } from '../utils/http-body.js';
import { StorageAdmissionDeferred } from '../storage/work-admission.js';

declare module 'hono' { interface ContextVariableMap {
  commandKey: string; commandDeliveryKey: string;
  acknowledgeDeletion: (result: CommandResult) => void;
  acknowledgeCreation: (result: CommandResult) => void;
  acknowledgeControl: (result: CommandResult) => void;
  commitCreation: (result: CommandResult) => (db: DatabaseSync) => void;
  acknowledgeSettings: (result: CommandResult) => void;
  beginSettingsWrite: () => void;
  settingsPayload: Record<string, unknown>;
} }

// Both boundaries use the same receipt protocol; each authorizes its own actor.
// No tokens, uploads or request bodies are persisted in the receipt table.
type ReceiptOptions = {
  receipts: CommandReceipts;
  isolatedDelivery?: boolean;
  scope: (c: Context, write: boolean) => string;
  recover?: (c: Context, key: string) => Promise<CommandReceipt | undefined>;
  queue?: (c: Context, runtimeId: string) => CommandQueueObservation;
  deletionAdmission?: (c: Context) => boolean;
  settingsAdmission?: (c: Context) => boolean;
  sessionKey?: (c: Context) => string;
  present?: (c: Context, receipt: CommandReceipt) => CommandReceipt;
};
export function registerMessageReceipts(app: Hono, path: string, deps: ReceiptOptions) {
  registerReceipts(app, path, deps);
}
export function registerCompactReceipts(app: Hono, path: string, deps: Omit<ReceiptOptions, 'queue'>) {
  registerReceipts(app, path, deps, 'compact');
}
export function registerDeletionReceipts(app: Hono, path: string, deps: Omit<ReceiptOptions, 'queue'>) {
  registerReceipts(app, path, deps, 'delete');
}
export function registerCreationReceipts(app: Hono, path: string, deps: Omit<ReceiptOptions, 'queue' | 'deletionAdmission'>) {
  registerReceipts(app, path, deps, 'create');
}
export function registerSettingsReceipts(app: Hono, path: string,
  deps: Omit<ReceiptOptions, 'queue' | 'deletionAdmission'> & { sessionKey: (c: Context) => string }) {
  registerReceipts(app, path, deps, 'settings');
}
function registerReceipts(app: Hono, path: string, deps: ReceiptOptions, operation?: 'delete' | 'create' | 'settings' | 'compact') {
  const present = (c: Context, receipt: CommandReceipt) => deps.present?.(c, receipt) ?? receipt;
  const scopeFor = (c: Context, write: boolean) => {
    const scope = deps.scope(c, write);
    return operation ? JSON.stringify([operation, scope]) : scope;
  };
  const commandPath = operation === 'delete' ? 'deletion-commands' : operation === 'create' ? 'creation-commands'
    : operation === 'settings' ? 'settings-commands' : operation === 'compact' ? 'compact-commands' : 'commands';
  async function recover(c: Context, scope: string, receipt: CommandReceipt) {
    if (receipt.state !== 'outcome_unknown' || !deps.recover) return receipt;
    let upstream: CommandReceipt | undefined;
    try {
      const deliveryKey = deps.receipts.deliveryKey(scope, receipt.key);
      upstream = await deps.recover(c, deliveryKey);
    } catch { /* unknown is not permission to redispatch */ }
    // Transport recovery must not swallow a revoked or replaced reader.
    if (scopeFor(c, false) !== scope) throw new HTTPException(403, { message: 'Command authority changed' });
    return deps.receipts.settleFromReceipt(scope, receipt.key, upstream);
  }
  app.get(`${path}/${commandPath}/:commandKey`, async (c) => {
    // A transient missing receipt must not become a cached negative lookup.
    c.header('Cache-Control', 'no-store');
    const scope = scopeFor(c, false);
    const receipt = deps.receipts.get(scope, c.req.param('commandKey'));
    if (!receipt) return c.json({ error: 'Command not found' }, 404);
    const recovered = await recover(c, scope, receipt);
    const released = operation === 'settings' && deps.receipts.settingsStartReleased(scope, receipt.key);
    return c.json({ command: present(c, released ? { ...recovered, settingsStartReleased: true } : recovered) });
  });
  if (deps.queue) app.get(`${path}/commands/:commandKey/queue`, (c) => {
    c.header('Cache-Control', 'no-store');
    const scope = scopeFor(c, false), key = c.req.param('commandKey');
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return c.json({ error: 'Invalid command key' }, 400);
    const receipt = deps.receipts.get(scope, key);
    if (!receipt) return c.json({ error: 'Command not found' }, 404);
    // Runtime adapters assign their own node-wide IDs. The original atomic
    // admission result binds that ID; a command delivery key is not a queue ID.
    const id = commandQueueId(receipt);
    const queue: CommandQueueObservation = id ? deps.queue!(c, id) : { presence: 'unknown' };
    return c.json({ commandKey: key, queue });
  });
  app.on(operation === 'delete' ? 'DELETE' : operation === 'settings' ? 'PATCH' : 'POST', operation === 'compact' ? `${path}/compact` : operation ? path : `${path}/messages`, async (c, next) => {
    const initialScope = scopeFor(c, true);
    const raw = operation === 'delete' ? {} : operation === 'compact' ? await readJsonBody(c.req.raw, 4096) : operation === 'settings'
      ? await readJsonBody(c.req.raw, 128 * 1024) : await c.req.json().catch(() => undefined);
    const scope = scopeFor(c, true); // recheck after waiting for request body
    if (scope !== initialScope) return c.json({ error: 'Command authority changed' }, 403);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ error: 'JSON object required' }, 400);
    const { idempotencyKey, ...payload } = raw as Record<string, unknown>;
    if (operation === 'compact' && Object.keys(payload).length) return c.json({ error: 'Compact takes no message or native options' }, 400);
    const header = c.req.header('idempotency-key');
    if (header && idempotencyKey !== undefined && idempotencyKey !== header) return c.json({ error: 'Conflicting command keys' }, 400);
    const key = header ?? idempotencyKey ?? createCommandKey(randomUUID());
    if (typeof key !== 'string') return c.json({ error: 'Invalid command key' }, 400);
    const check = () => {
      c.req.raw.signal.throwIfAborted();
      if (scopeFor(c, true) !== scope) throw new HTTPException(403, { message: 'Command authority changed' });
    };
    let claimed;
    try { claimed = await deps.receipts.claimAsync(scope, key, payload, deps.isolatedDelivery, undefined,
      operation === 'delete' ? () => !!c.req.param('sessionKey') && !deps.receipts.sessionDeletion(c.req.param('sessionKey')!)
        && (deps.deletionAdmission?.(c) ?? true) : operation === 'settings' ? () => {
          const sessionKey = deps.sessionKey!(c);
          return !!sessionKey && !deps.receipts.sessionDeletion(sessionKey) && !deps.receipts.sessionSettingsPending(sessionKey)
            && (deps.settingsAdmission?.(c) ?? true);
        } : undefined, undefined, operation === 'settings', check);
      check(); // Promise delivery is itself an event boundary before dispatch.
    }
    catch (error) {
      if (error instanceof CommandConflict) return c.json({ error: error.message }, 409);
      if (error instanceof CommandCapacity) return c.json({ error: 'Command receipt capacity reached' }, 503);
      if (error instanceof StorageAdmissionDeferred) return c.json({ error: 'Command storage admission unavailable' }, 503);
      throw error;
    }
    c.set('commandKey', key);
    c.set('commandDeliveryKey', deps.receipts.deliveryKey(scope, key));
    c.header('Cache-Control', 'no-store');
    c.header('X-AgentOpsDeck-Command-Key', key);
    if (!claimed.fresh) return reply(c, present(c, await recover(c, scope, claimed.receipt)));
    if (!operation) c.set('acknowledgeControl', result => {
      // Record the original native control ACK before optional history/cleanup.
      // This is acceptance only, never evidence that execution has stopped.
      // Do not reauthorize an already observed effect or redispatch it on retry.
      if (deps.receipts.settle(scope, key, result).state !== 'accepted') {
        throw new CommandCapacity('Control acceptance could not be persisted');
      }
    });
    let settingsDispatched = false;
    if (operation === 'settings') {
      c.set('settingsPayload', payload);
      c.set('beginSettingsWrite', () => {
        deps.receipts.beginSettingsWrite(scope, key);
        settingsDispatched = true;
      });
    }
    if (operation && operation !== 'compact') c.set(operation === 'delete' ? 'acknowledgeDeletion' : operation === 'settings' ? 'acknowledgeSettings' : 'acknowledgeCreation', result => {
      // Native ACK must survive a later projection failure or client revoke.
      // This records acceptance, not successful projection/queue cleanup.
      if (deps.receipts.settle(scope, key, result).state !== 'accepted') {
        throw new CommandCapacity('Control acceptance could not be persisted');
      }
    });
    // Local SDK allocation can roll back, unlike a native create RPC. Bind
    // its atomic writer here so routes never duplicate operation/actor scope.
    if (operation === 'create') c.set('commitCreation', result => deps.receipts.creationCommit(scope, key, result));
    await next();
    // The handler may already have admitted runtime work. Recording its ACK
    // must not depend on the browser remaining connected or logged in.
    try {
      const body = await c.res.clone().json() as Record<string, unknown>;
      // Settings adapters may partially write then return a legacy 4xx. Only
      // explicit ACK settles success; after dispatch no HTTP envelope proves
      // absence of effect. Prewrite validation may still reject durably.
      const receipt = (operation === 'settings' && (settingsDispatched || c.res.status < 400))
        || (body.command && typeof body.command === 'object' && (body.command as CommandReceipt).state === 'outcome_unknown')
        ? deps.receipts.get(scope, key)! : deps.receipts.settle(scope, key, { status: c.res.status, body: stripCommand(body) });
      c.res = reply(c, present(c, receipt));
    } catch {
      c.res = reply(c, present(c, deps.receipts.get(scope, key)!));
    }
  });
}

function stripCommand(body: Record<string, unknown>) { const { command: _, ...rest } = body; return rest; }
export function commandQueueId(receipt: CommandReceipt) {
  const id = receipt.state === 'accepted' ? receipt.result?.body.idempotencyKey : undefined;
  return typeof id === 'string' && id.length > 0 && id.length <= 512 ? id : undefined;
}
export function reply(c: Context, command: CommandReceipt) {
  const { result, ...metadata } = command;
  return result
    ? c.json({ ...result.body, command: metadata }, result.status as 200)
    : c.json({ ok: false, status: 'outcome_unknown', command }, 202);
}
