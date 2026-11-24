import type { CommandReceipt, CommandReceipts, CommandResult } from '../commands/receipts.js';

type Awaitable<T> = T | Promise<T>;
/** Explicit compatibility shape. SQL callbacks stay synchronous; an async
 * implementation must perform its own transaction authority check in-worker. */
export type UpdateReceiptPort = {
  get(scope: string, key: string): Awaitable<CommandReceipt | undefined>;
  claim(scope: string, key: string, payload: unknown): Awaitable<{ fresh: boolean; receipt: CommandReceipt }>;
  claimAsync: (...args: Parameters<CommandReceipts['claimAsync']>) => Promise<{ fresh: boolean; receipt: CommandReceipt }>;
  settle(scope: string, key: string, result: CommandResult): Awaitable<CommandReceipt>;
};
export type UpdatePersistence = { nodeId: string; receipts: UpdateReceiptPort; asynchronous?: true };
