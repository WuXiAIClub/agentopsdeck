import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncRuntimeReads, type AsyncRuntimeReadsOptions } from './async-runtime-reads.js';

export type AsyncOpenClawReadsOptions = AsyncRuntimeReadsOptions;
/** Backwards-compatible OpenClaw port; shares ownership, never a second loader. */
export class AsyncOpenClawReads extends AsyncRuntimeReads {
  constructor(owner: Pick<AsyncConnectorOwner, 'command'>, options: AsyncOpenClawReadsOptions) {
    super(owner, options, 'openclaw');
  }
}
