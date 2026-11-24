import type { Dispatch } from '../connector/transport.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { encodeHubMemberJson } from './async-member-owner.js';
import { ConnectorClient, ConnectorClientError } from './connector-client.js';
import type { HubConnection, HubDeliveryEvent } from './hub-store.js';
import { encodeHubEventJson, hubEventWire } from './member-event-domain.js';
import { HUB_EVENT_FEED_COMMAND_BYTES, HUB_EVENT_FEED_RESULT_BYTES, validEventFeedOwner,
  validHubEventFeedCommand, validHubEventFeedReply, type HubEventFeedCommand,
  type HubEventFeedOwner, type HubEventFeedResult } from './event-feed-domain.js';

export type HubEventFeedTarget = { connection: HubConnection; epoch: number; client: ConnectorClient; domain: string };
export type HubEventFeedPort = {
  readonly pending: number;
  readonly failed: boolean;
  directory(): Promise<HubConnection[]>;
  open(id: string): Promise<HubEventFeedTarget | undefined>;
  check(target: HubEventFeedTarget): Promise<boolean>;
  cursor(target: HubEventFeedTarget): Promise<string | undefined>;
  append(target: HubEventFeedTarget, event: Omit<HubDeliveryEvent, 'id'>, cursor?: string, liveSince?: number): Promise<boolean>;
  gap(): Promise<void>;
  close(): Promise<void>;
};

/** Process-private background capability. HTTP/member command ports cannot
 * mint it. The owner is fixed before serialization; no browser session, cached
 * administrator principal or generic SQL crosses this boundary. */
export function createHubEventFeedPort(factory: { eventFeed(ownerUserId: string): HubEventFeedOwner }, ownerUserId: string,
  local?: { connectionId: string; token: string; dispatch: Dispatch },
  diagnostics: PerformanceDiagnostics = performanceDiagnostics): HubEventFeedPort {
  if (!validEventFeedOwner(ownerUserId)) throw Error('hub_event_feed_unavailable');
  const owner = factory.eventFeed(ownerUserId), persistence = new AuthRoutePersistence(diagnostics);
  let closed = false, failed = false;
  const available = () => { if (closed || failed) throw Error('hub_event_feed_unavailable'); };
  const command = async <A extends HubEventFeedCommand['action']>(input: Extract<HubEventFeedCommand, { action: A }>) => {
    available();
    // Own caller data before awaiting, and validate ACKs even for in-process
    // owners. An unknown outcome permanently fences this lane; never replay it.
    const copied = JSON.parse(encodeHubMemberJson(input, HUB_EVENT_FEED_COMMAND_BYTES)) as HubEventFeedCommand;
    if (!validHubEventFeedCommand(copied)) throw Error('hub_event_feed_unavailable');
    try {
      const { value } = await persistence.run(93, () => owner.command(copied));
      const reply: unknown = JSON.parse(encodeHubMemberJson(value, HUB_EVENT_FEED_RESULT_BYTES));
      if (!validHubEventFeedReply({ ownerUserId, command: copied }, reply)) throw Error('hub_event_feed_unavailable');
      available();
      return reply as Extract<HubEventFeedResult, { action: A }>;
    } catch { failed = true; throw Error('hub_event_feed_unavailable'); }
  };
  const targetCommand = (target: HubEventFeedTarget) => ({ id: target.connection.id, epoch: target.epoch });
  const port: HubEventFeedPort = {
    get pending() { return persistence.pending; }, get failed() { return failed; },
    async directory() { return JSON.parse((await command({ action: 'directory' })).body) as HubConnection[]; },
    async open(id) {
      const { target } = await command({ action: 'open', id });
      if (!target) return;
      const { connection, epoch, token } = target;
      const authorization = { ...(connection.nodeId ? { nodeId: connection.nodeId } : {}),
        domain: JSON.stringify([ownerUserId, epoch, connection.nodeId, undefined, undefined]),
        authorize: async () => {
          const result = await command({ action: 'check', id: connection.id, epoch });
          if (!result.ok) throw new ConnectorClientError(403, 'Connector authority changed');
        },
        request: (path: string, method: string) => {
          if (path !== '/events/stream' || method !== 'GET') throw new ConnectorClientError(403, 'Event feed only');
        } };
      let client: ConnectorClient;
      if (connection.kind === 'local') {
        if (!local || ownerUserId !== 'default' || local.connectionId !== connection.id)
          return; // Never substitute a remote/missing credential with local transport.
        client = new ConnectorClient('http://connector.example.invalid', local.token, local.dispatch, undefined, undefined, authorization);
      } else {
        if (!token) return;
        client = new ConnectorClient(connection.connectorUrl, token, undefined, undefined, undefined, authorization);
      }
      return { connection, epoch, client, domain: client.eventDomain };
    },
    async check(target) { return (await command({ action: 'check', ...targetCommand(target) })).ok; },
    async cursor(target) {
      const result = await command({ action: 'cursor', ...targetCommand(target), domain: target.domain });
      if (!result.ok) throw new ConnectorClientError(403, 'Connector authority changed');
      return result.cursor ?? undefined;
    },
    async append(target, event, cursor, liveSince) {
      const result = await command({ action: 'append', ...targetCommand(target), domain: target.domain,
        eventJson: encodeHubEventJson(hubEventWire(event)), ...(cursor === undefined ? {} : { cursor }),
        ...(liveSince === undefined ? {} : { liveSince }) });
      return result.ok && result.appended;
    },
    async gap() { await command({ action: 'gap' }); },
    close() { closed = true; return persistence.close(); },
  };
  return port;
}
