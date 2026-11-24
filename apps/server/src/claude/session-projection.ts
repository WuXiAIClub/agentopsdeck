import type { ConnectorUserStore } from '../connector/connector-user-store.js';
import type { DeckStore } from '../projection/deck-store.js';
import { claudeSessionView } from './session-view.js';
import { claudeHistoryPage } from './history.js';

/** Internal durable projection bridge, not an authorized history endpoint.
 * Never reads native files or wakes execution. Public historical paging must
 * use claudeHistoryPage after authorization, not this latest cache. */
export class ClaudeSessionProjection {
  private readonly projected = new Map<string, string>();
  constructor(private readonly source: Pick<ConnectorUserStore, 'claudeJournal' | 'claudeTranscript'>,
    private readonly target: Pick<DeckStore, 'upsertSession' | 'replaceMessages' | 'removeSession'>,
    private readonly configuredModel?: string) {}

  publishSummary(key: string, ready: boolean) {
    const deletion = this.source.claudeJournal.deletion(key);
    if (deletion?.phase === 'deleted') { this.projected.delete(key); this.target.removeSession(key); return; }
    const session = this.source.claudeJournal.session(key);
    if (!session) throw new Error('Claude session does not exist');
    if (deletion) session.nativeState = 'unknown';
    const summary = claudeSessionView(session, this.source.claudeJournal.current(key), ready);
    const model = session.model ?? this.configuredModel;
    if (model) summary.model = model;
    const fingerprint = JSON.stringify(summary);
    if (this.projected.get(key) !== fingerprint) this.target.upsertSession(summary);
    this.projected.set(key, fingerprint);
  }

  publish(key: string, ready: boolean) {
    try {
      this.publishSummary(key, ready);
      const page = claudeHistoryPage(this.source, key);
      if (!page) return;
      // Final rows are immutable. DeckStore emits only actual message deltas;
      // using bounded latest summaries never fetches whole native tool history.
      this.target.replaceMessages(key, page.messages, { authoritative: true });
      return page;
    } catch (error) {
      this.projected.delete(key);
      throw error;
    }
  }
}
