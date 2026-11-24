import { encodeHubMemberJson } from './async-member-owner.js';
import { HUB_CONTENT_DOCUMENT_BYTES } from './member-content-document-domain.js';
import { HubMemberOwnerUnavailable } from './member-owner-domain.js';
import { matchesContentBackgroundReply, validContentBackgroundCommand, validContentBackgroundResult,
  type ContentBackgroundCommand, type ContentBackgroundOwner, type ContentBackgroundResult } from './content-background-domain.js';

/** One bounded SQL lane for the four background effects. Retains original
 * commands through settlement; no read timeout can release their ownership. */
export class AsyncContentBackgroundAccess implements ContentBackgroundOwner {
  private closed = false;
  private pending = 0;
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly owner: ContentBackgroundOwner) {}
  command(command: ContentBackgroundCommand): Promise<ContentBackgroundResult> {
    let copied: ContentBackgroundCommand;
    try {
      if (this.closed || this.pending >= 16) throw new HubMemberOwnerUnavailable();
      copied = JSON.parse(encodeHubMemberJson(command,HUB_CONTENT_DOCUMENT_BYTES,16_384));
      if (!validContentBackgroundCommand(copied)) throw new HubMemberOwnerUnavailable();
    } catch { return Promise.reject(new HubMemberOwnerUnavailable()); }
    this.pending++;
    const result = this.tail.then(async () => {
      const value = await this.owner.command(copied);
      if (!validContentBackgroundResult(value) || !matchesContentBackgroundReply(copied,value)) throw new HubMemberOwnerUnavailable();
      return value;
    });
    this.tail = result.then(() => {},() => {}).finally(() => { this.pending--; });
    return result;
  }
  close(): Promise<void> { this.closed = true; return this.tail; }
}
