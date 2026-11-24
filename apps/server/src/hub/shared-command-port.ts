import type { CommandReceipt } from '../commands/receipts.js';
import type { CommandQueueObservation, SessionRef, SharedQueuedCommandPage } from '@agentopsdeck/shared';
import type { QueueCommandChange } from './execution-commands.js';

/** Complete request chain, not a collection of synchronous store getters. */
export interface SharedCommandPort {
  readonly ref: SessionRef;
  read(): void | Promise<void>;
  authorizeSend?(mirror: boolean): void | Promise<void>;
  send(key: string, payload: Record<string, unknown>, mirror: boolean): Promise<CommandReceipt>;
  recover(key: string): Promise<CommandReceipt | undefined>;
  queue(key: string): Promise<CommandQueueObservation | undefined>;
  queuePage(cursor?: string): Promise<SharedQueuedCommandPage>;
  mutateQueue(commandKey: string, key: string, change: QueueCommandChange): Promise<CommandReceipt>;
  recoverQueueMutation(commandKey: string, key: string): Promise<CommandReceipt | undefined>;
}
export interface AsyncSharedCommandPort {
  open(request: Request, target: { ownerUserId: string; sessionId: string }): Promise<SharedCommandPort>;
  close(): Promise<void>;
}
