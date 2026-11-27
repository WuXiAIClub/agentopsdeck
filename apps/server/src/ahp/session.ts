import { randomUUID } from 'node:crypto';
import {
  MessageKind, PROTOCOL_VERSION, chatReducer, sessionReducer,
  type ActionEnvelope, type ChatAction, type ChatState, type ChatTurnStartedAction, type SessionAction, type SessionState,
  type Snapshot, type Turn, type ActiveTurn,
} from '@microsoft/agent-host-protocol';
import { AhpClient, type AhpTransport, type Subscription } from '@microsoft/agent-host-protocol/client';

const historyTurns = 100;
const sessionUriPattern = /^ahp-session:\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const chatUriPattern = /^ahp-chat:\/[A-Za-z0-9_-]{1,512}$/;
const turnStarted = 'chat/turnStarted' as ChatTurnStartedAction['type'];
const unavailable = () => new Error('AHP session unavailable');
const unknownOutcome = () => new Error('AHP message outcome unknown; verify in VS Code before retrying');

export type AhpTextTurn = { id: string; prompt: string; response: string; active: boolean };
type Pending = {
  id: string; seq: number; timer: NodeJS.Timeout;
  resolve: (id: string) => void; reject: (error: Error) => void;
};

function snapshotFor(snapshot: Snapshot | undefined, uri: string): Snapshot {
  if (!snapshot || snapshot.resource !== uri || !Number.isSafeInteger(snapshot.fromSeq)
    || snapshot.fromSeq < 0 || !snapshot.state || typeof snapshot.state !== 'object') throw unavailable();
  return snapshot;
}

function textTurn(turn: Turn | ActiveTurn, active: boolean): AhpTextTurn {
  return { id: turn.id, prompt: turn.message.text,
    response: turn.responseParts.flatMap(part => part.kind === 'markdown' ? [part.content] : []).join('\n\n'), active };
}

/** A single externally managed chat. This client never changes tool policy or opens resources. */
export class AhpSession {
  private pending: Pending | undefined;
  private stopping?: Promise<void>;

  private constructor(private readonly client: AhpClient, private readonly clientId: string,
    private session: SessionState, private chat: ChatState, private readonly timeoutMs: number) {}

  static async attach(transport: AhpTransport, selection: { sessionUri: string; chatUri?: string },
    timeoutMs = 5_000): Promise<AhpSession> {
    const client = new AhpClient(transport, { requestTimeoutMs: timeoutMs });
    try {
      const { sessionUri, chatUri } = selection;
      if (!sessionUriPattern.test(sessionUri) || (chatUri !== undefined && !chatUriPattern.test(chatUri))) throw unavailable();
      const clientId = `aod-${randomUUID()}`;
      client.connect();
      const handshake = await client.initialize({ clientId, protocolVersions: [PROTOCOL_VERSION] });
      if (handshake.protocolVersion !== PROTOCOL_VERSION) throw unavailable();
      const session = await client.subscribe(sessionUri);
      const sessionSnapshot = snapshotFor(session.result.snapshot, sessionUri);
      const sessionState = sessionSnapshot.state as SessionState;
      const selected = chatUri ?? sessionState.defaultChat;
      if (sessionState.lifecycle !== 'ready' || !selected || !chatUriPattern.test(selected) || !Array.isArray(sessionState.chats)
        || !sessionState.chats.some(chat => chat.resource === selected && chat.interactivity !== 'hidden')) throw unavailable();
      const chat = await client.subscribe(selected, { view: { turns: historyTurns } });
      const chatSnapshot = snapshotFor(chat.result.snapshot, selected);
      const chatState = chatSnapshot.state as ChatState;
      if (chatState.resource !== selected || typeof chatState.title !== 'string'
        || !Array.isArray(chatState.turns) || chatState.interactivity === 'hidden') throw unavailable();
      const connection = new AhpSession(client, clientId, { ...sessionState },
        { ...chatState, turns: chatState.turns.slice(-historyTurns) }, timeoutMs);
      connection.watch(session.subscription, sessionSnapshot.fromSeq, envelope => connection.applySession(envelope));
      connection.watch(chat.subscription, chatSnapshot.fromSeq, envelope => connection.applyChat(envelope));
      return connection;
    } catch {
      await client.shutdown();
      throw unavailable();
    }
  }

  view() {
    if (this.stopping || this.client.connectionState.status !== 'connected') throw unavailable();
    const { title, turns, activeTurn } = this.chat;
    return { title, turns: [...turns.map(turn => textTurn(turn, false)), ...(activeTurn ? [textTurn(activeTurn, true)] : [])],
      canSend: this.canSend() };
  }

  sendText(text: string): Promise<string> {
    if (!text.trim() || Buffer.byteLength(text) > 16_384) return Promise.reject(new Error('Invalid AHP message text'));
    if (!this.canSend()) return Promise.reject(new Error('AHP chat is not accepting a new turn'));
    return new Promise<string>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { void this.close(); }, this.timeoutMs);
      this.pending = { id, seq: 0, timer, resolve, reject };
      try {
        const { clientSeq } = this.client.dispatch(this.chat.resource, {
          type: turnStarted, turnId: id, startedAt: new Date().toISOString(),
          message: { text, origin: { kind: MessageKind.User } },
        });
        this.pending.seq = clientSeq;
      } catch {
        void this.close();
      }
    });
  }

  close(): Promise<void> {
    if (this.stopping) return this.stopping;
    const pending = this.takePending();
    pending?.reject(unknownOutcome());
    return this.stopping = this.client.shutdown();
  }

  private canSend() {
    const summary = this.session.chats.find(chat => chat.resource === this.chat.resource);
    const full = (value: string | undefined) => value === undefined || value === 'full';
    return !this.stopping && this.client.connectionState.status === 'connected' && !!summary
      && this.session.lifecycle === 'ready' && full(summary.interactivity) && full(this.chat.interactivity)
      && !this.chat.activeTurn && !this.pending;
  }

  private takePending() {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) clearTimeout(pending.timer);
    return pending;
  }

  private watch(subscription: Subscription, fromSeq: number, apply: (envelope: ActionEnvelope) => void) {
    void (async () => {
      let seq = fromSeq;
      try {
        for await (const event of subscription) {
          if (event.type === 'authRequired') break;
          if (event.type !== 'action') continue;
          const envelope = event.params;
          if (envelope.channel !== subscription.uri || !Number.isSafeInteger(envelope.serverSeq)) throw unavailable();
          if (envelope.serverSeq <= seq) continue;
          seq = envelope.serverSeq;
          apply(envelope);
        }
      } finally {
        await this.close();
      }
    })().catch(() => { /* Readers observe the closed session; never log private host payloads. */ });
  }

  private applySession({ action, rejectionReason }: ActionEnvelope) {
    if (rejectionReason !== undefined || !action.type.startsWith('session/')) return;
    this.session = sessionReducer(this.session, action as SessionAction);
    if (this.session.lifecycle !== 'ready'
      || !this.session.chats.some(chat => chat.resource === this.chat.resource && chat.interactivity !== 'hidden')) throw unavailable();
  }

  private applyChat({ action, origin, rejectionReason }: ActionEnvelope) {
    if (rejectionReason === undefined && action.type === 'chat/moved') throw unavailable();
    if (rejectionReason === undefined && action.type.startsWith('chat/')) {
      this.chat = chatReducer(this.chat, action as ChatAction);
      if (this.chat.turns.length > historyTurns) this.chat = { ...this.chat, turns: this.chat.turns.slice(-historyTurns) };
    }
    const pending = this.pending;
    if (pending && origin?.clientId === this.clientId && origin.clientSeq === pending.seq
      && action.type === turnStarted && action.turnId === pending.id) {
      this.takePending();
      if (rejectionReason === undefined) pending.resolve(pending.id);
      else pending.reject(new Error('AHP host rejected the message'));
    }
  }
}
