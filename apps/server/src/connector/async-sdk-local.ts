import type { ConnectorOwnerCommands, ConnectorOwnerKind } from './connector-owner-domain.js';
import type { ConnectorSdkLocalCommands } from './connector-sdk-local-domain.js';
import type { ConnectorSdkLocalRecoveryCommands } from './connector-sdk-local-recovery-domain.js';
import { runNativeOperation } from './native-operation.js';

type Owner = { command<K extends ConnectorOwnerKind>(kind: K, input: ConnectorOwnerCommands[K]['input']): Promise<ConnectorOwnerCommands[K]['output']> };
type Wait = { timeoutMs: number; signal?: AbortSignal };
/** Candidate whole-owner caller. A deadline bounds the caller's wait, NOT the
 * original transaction: late work remains observed and is never resubmitted.
 * Resolve uncertainty by reading the original actor-scoped receipt. Neither a
 * missing receipt nor a settings-start release marker authorizes replay. */
export class AsyncSdkLocal {
  constructor(private readonly owner: Owner, private readonly committed?: (runtime: 'claude-code' | 'ghcp', key: string) => void | Promise<void>) {}
  private async writePhysical<K extends 'sdkSessionCreate' | 'sdkModelUpdate'>(kind: K, input: ConnectorSdkLocalCommands[K]['input']) {
    const request = structuredClone(input);
    const result = await this.owner.command(kind, request);
    if ('receipt' in result && result.receipt.state === 'accepted' && result.key) {
      try { await this.committed?.(request.runtime, result.key); } catch { /* Original receipt is the recovery authority. */ }
    }
    return result;
  }
  createPhysical(input: ConnectorSdkLocalCommands['sdkSessionCreate']['input']) {
    return this.writePhysical('sdkSessionCreate', input);
  }
  updateModelPhysical(input: ConnectorSdkLocalCommands['sdkModelUpdate']['input']) {
    return this.writePhysical('sdkModelUpdate', input);
  }
  readReceiptPhysical(input: ConnectorSdkLocalRecoveryCommands['sdkLocalReceiptRead']['input']) {
    return this.owner.command('sdkLocalReceiptRead', structuredClone(input));
  }
  create(input: ConnectorSdkLocalCommands['sdkSessionCreate']['input'], wait: Wait) {
    return runNativeOperation(() => this.createPhysical(input), wait);
  }
  updateModel(input: ConnectorSdkLocalCommands['sdkModelUpdate']['input'], wait: Wait) {
    return runNativeOperation(() => this.updateModelPhysical(input), wait);
  }
  readReceipt(input: ConnectorSdkLocalRecoveryCommands['sdkLocalReceiptRead']['input'], wait: Wait) {
    return runNativeOperation(() => this.readReceiptPhysical(input), wait);
  }
}
