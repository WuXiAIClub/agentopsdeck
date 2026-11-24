import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncRuntimeReads, type AsyncRuntimeReadsOptions } from './async-runtime-reads.js';

export type AsyncCodexReadsOptions = AsyncRuntimeReadsOptions;
/** Uses original Codex history and causal projection; no execution mutations. */
export class AsyncCodexReads extends AsyncRuntimeReads {
  constructor(owner: Pick<AsyncConnectorOwner, 'command'>, options: AsyncCodexReadsOptions) {
    super(owner, options, 'codex');
  }
}
