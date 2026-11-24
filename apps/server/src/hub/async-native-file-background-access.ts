import {encodeHubMemberJson} from './async-member-owner.js';
import {HUB_NATIVE_FILE_BYTES} from './member-native-file-domain.js';
import {HubMemberOwnerUnavailable} from './member-owner-domain.js';
import {matchesNativeFileBackgroundReply, validNativeFileBackgroundCommand, validNativeFileBackgroundResult,
  type NativeFileBackgroundCommand, type NativeFileBackgroundOwner, type NativeFileBackgroundResult} from './native-file-background-domain.js';

/** Private serialized ACK lane. A browser/read deadline cannot release an
 * admitted projection update; close freezes admission and waits for its ACK. */
export class AsyncNativeFileBackgroundAccess implements NativeFileBackgroundOwner {
  private closed = false;
  private pending = 0;
  private bytes = 0;
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly owner: NativeFileBackgroundOwner) {}
  command(command: NativeFileBackgroundCommand): Promise<NativeFileBackgroundResult> {
    let copied: NativeFileBackgroundCommand, size: number;
    try {
      if (this.closed || this.pending >= 256) throw new HubMemberOwnerUnavailable();
      const encoded = encodeHubMemberJson(command, HUB_NATIVE_FILE_BYTES, 16_384);
      size = Buffer.byteLength(encoded);
      if (this.bytes + size > 4 * HUB_NATIVE_FILE_BYTES) throw new HubMemberOwnerUnavailable();
      copied = JSON.parse(encoded);
      if (!validNativeFileBackgroundCommand(copied)) throw new HubMemberOwnerUnavailable();
    } catch {return Promise.reject(new HubMemberOwnerUnavailable());}
    this.pending++; this.bytes += size;
    const result = this.tail.then(async () => {
      const value = await this.owner.command(copied);
      if (!validNativeFileBackgroundResult(value) || !matchesNativeFileBackgroundReply(copied, value)) throw new HubMemberOwnerUnavailable();
      return value;
    });
    this.tail = result.then(() => {}, () => {}).finally(() => {this.pending--; this.bytes -= size;});
    return result;
  }
  close(): Promise<void> {this.closed = true; return this.tail;}
}
