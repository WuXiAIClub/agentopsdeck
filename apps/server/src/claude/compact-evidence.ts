/** Stream correlation is separate from disk persistence. Nothing from the
 * native compact summary is projected as an assistant message. */
export class ClaudeCompactEvidence {
  private boundary?: string;
  private result = false;
  constructor(private readonly sessionId: string, private readonly requestId: string) {}
  observe(value: unknown) {
    const event = value as Record<string, any>;
    if (!event || typeof event !== 'object') throw new Error('Invalid compact event');
    if (event.type === 'system' && event.subtype === 'compact_boundary') {
      if (this.boundary || event.session_id !== this.sessionId || event.compact_metadata?.trigger !== 'manual'
        || typeof event.uuid !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(event.uuid)) throw new Error('Invalid compact boundary');
      this.boundary = event.uuid;
    }
    if (event.type === 'result') {
      if (this.result || !this.boundary || event.session_id !== this.sessionId || event.is_error !== false
        || event.user_message_uuid !== this.requestId) throw new Error('Unconfirmed compact result');
      this.result = true;
    }
  }
  persisted(rows: unknown[]): string {
    if (!this.result || !this.boundary || !Array.isArray(rows) || rows.length > 10_000
      || !rows.some(value => { const row = value as Record<string, any>;
        return row?.uuid === this.boundary && row.session_id === this.sessionId
          // getSessionMessages projects system rows without subtype/metadata.
          // Manual trigger and request correlation were checked on the stream;
          // the exact same root system UUID must now exist on disk.
          && row.type === 'system' && row.parent_tool_use_id === null && row.parent_agent_id === null;
      })) throw new Error('Compact history unconfirmed');
    return this.boundary;
  }
}
