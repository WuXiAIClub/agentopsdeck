import { isRecord } from '../commands/turn-queue.js';

export type BackgroundTerminal = { processId: string; itemId: string };

/** Observation only: run ownership proves neither a temporary lifetime nor
 * permission to clean up. Unattributed includes unknown and other-run work.
 * Keep identities and native command text out of diagnostic payloads. */
export class BackgroundTerminalDrainError extends Error {
  readonly ownership: Readonly<{ total: number; owned: number; unattributed: number }>;
  readonly lifecycle: Readonly<{ declaredTemporary: 0; declaredService: 0; undeclaredOwned: number; unattributed: number }>;

  constructor(terminals: readonly BackgroundTerminal[], trustedItemIds: ReadonlySet<string>) {
    super('Codex background terminals are still running');
    this.name = 'BackgroundTerminalDrainError';
    const owned = terminals.filter(terminal => trustedItemIds.has(terminal.itemId)).length;
    this.ownership = Object.freeze({ total: terminals.length, owned, unattributed: terminals.length - owned });
    // The native protocol currently supplies process/item identity only. Do
    // not turn same-run ownership into a temporary-lifetime declaration: an
    // owned terminal can still be an intentionally long-running service.
    this.lifecycle = Object.freeze({ declaredTemporary: 0, declaredService: 0,
      undeclaredOwned: owned, unattributed: terminals.length - owned });
  }
}

type Request = (method: string, params: unknown, timeoutMs?: number) => Promise<any>;
const validId = (value: unknown): value is string => typeof value === 'string' && value.trim() === value
  && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);

export async function backgroundTerminals(request: Request, threadId: string, check: () => void | Promise<void>,
  deadline = Date.now() + 30_000): Promise<BackgroundTerminal[]> {
  const terminals: BackgroundTerminal[] = [], cursors = new Set<string>(), processes = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 32; page++) {
    let checked = check(); if (checked) await checked;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Codex background terminal query timed out');
    const result = await request('thread/backgroundTerminals/list', { threadId, limit: 100, ...(cursor ? { cursor } : {}) }, remaining);
    checked = check(); if (checked) await checked;
    if (Date.now() >= deadline) throw new Error('Codex background terminal query timed out');
    if (!isRecord(result) || !Array.isArray(result.data) || result.data.length > 100
      || (result.nextCursor != null && !validId(result.nextCursor))) throw new Error('Invalid Codex background terminal page');
    for (const row of result.data) {
      if (!isRecord(row) || !validId(row.processId) || !validId(row.itemId) || processes.has(row.processId)) {
        throw new Error('Invalid Codex background terminal identity');
      }
      processes.add(row.processId);
      terminals.push({ processId: row.processId, itemId: row.itemId });
    }
    if (result.nextCursor == null) return terminals;
    if (cursors.has(result.nextCursor)) throw new Error('Repeated Codex background terminal cursor');
    cursor = result.nextCursor;
    cursors.add(cursor);
  }
  throw new Error('Codex background terminal page budget exceeded');
}

export async function terminateBackgroundTerminals(request: Request, threadId: string, itemIds: Set<string> | (() => Set<string>), check: () => void | Promise<void>) {
  const deadline = Date.now() + 30_000;
  const terminals = await backgroundTerminals(request, threadId, check, deadline);
  // Listing may yield to same-run item/started notifications. Resolve trusted
  // identities after that await, never from the terminal list itself.
  const allowed = typeof itemIds === 'function' ? itemIds() : itemIds;
  if (terminals.some(terminal => !allowed.has(terminal.itemId))) throw new Error('Codex background terminal belongs to another run');
  for (const terminal of terminals) {
    let checked = check(); if (checked) await checked;
    // A previous terminate RPC can yield to ownership updates. Keep the initial
    // all-or-nothing preflight, but never carry its authority across awaits.
    const currentAllowed = typeof itemIds === 'function' ? itemIds() : itemIds;
    if (!currentAllowed.has(terminal.itemId)) throw new Error('Codex background terminal belongs to another run');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Codex background terminal termination timed out');
    const result = await request('thread/backgroundTerminals/terminate', { threadId, processId: terminal.processId }, remaining);
    checked = check(); if (checked) await checked;
    if (Date.now() >= deadline) throw new Error('Codex background terminal termination timed out');
    if (!isRecord(result) || typeof result.terminated !== 'boolean') throw new Error('Invalid Codex background terminal termination response');
  }
  if (terminals.length && (await backgroundTerminals(request, threadId, check, deadline)).length) {
    throw new Error('Codex background terminals are still running');
  }
}
