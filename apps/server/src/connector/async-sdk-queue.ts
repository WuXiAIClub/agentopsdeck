import type { ConnectorOwnerCommands, ConnectorOwnerKind } from './connector-owner-domain.js';
import type { ConnectorSdkQueueCommands } from './connector-sdk-queue-domain.js';
import type { ConnectorSdkQueueReadCommands } from './connector-sdk-queue-read-domain.js';

type Owner = { command<K extends ConnectorOwnerKind>(kind: K, input: ConnectorOwnerCommands[K]['input']): Promise<ConnectorOwnerCommands[K]['output']> };
/** Candidate caller only; do not activate alongside the legacy writer. A lost
 * response is resolved by readReceipt, never by retrying cancellation. The
 * original owner logs bounded numeric protocol steps 79/80 without token/text.
 * Caller abort before submission means no write; abort after submission cannot
 * turn a possibly committed cancellation into a definitive rejection. */
export class AsyncSdkQueue {
  constructor(private readonly owner: Owner) {}
  page(input: ConnectorSdkQueueReadCommands['sdkQueuePage']['input'], signal?: AbortSignal) {
    signal?.throwIfAborted();
    return this.owner.command('sdkQueuePage', input);
  }
  commandPage(input: ConnectorSdkQueueReadCommands['sdkQueueCommandPage']['input'], signal?: AbortSignal) {
    signal?.throwIfAborted();
    return this.owner.command('sdkQueueCommandPage', input);
  }
  cancel(input: ConnectorSdkQueueCommands['sdkQueuedCancel']['input'], signal?: AbortSignal) {
    signal?.throwIfAborted();
    return this.owner.command('sdkQueuedCancel', input);
  }
  readReceipt(input: ConnectorSdkQueueCommands['sdkQueueReceiptRead']['input'], signal?: AbortSignal) {
    signal?.throwIfAborted();
    return this.owner.command('sdkQueueReceiptRead', input);
  }
  edit(input: ConnectorSdkQueueCommands['sdkQueuedEdit']['input'], signal?: AbortSignal) {
    signal?.throwIfAborted();
    return this.owner.command('sdkQueuedEdit', input);
  }
}
