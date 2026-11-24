import type { ChatMessage, SessionSummary } from '@agentopsdeck/shared';

export function finalReplyMatchesTurn(session: SessionSummary, message: ChatMessage | undefined) {
  if (!message || !session.runtime?.turnId) return false;
  return message.turnId ? message.turnId === session.runtime.turnId
    : typeof session.runStartedAt === 'number' && message.createdAt >= session.runStartedAt;
}

export function completionViewReadable(view: {
  foreground: boolean; focused: boolean; online: boolean; ready: boolean;
  active: boolean; collapsed: boolean; dimmed: boolean; synchronized: boolean; completed: boolean;
}) {
  return view.foreground && view.focused && view.online && view.ready && view.active
    && !view.collapsed && !view.dimmed && view.synchronized && view.completed;
}

/** Reading means the tail of the final reply was exposed in the active,
 * foreground chat, not merely that a list row was selected or data fetched. */
export type ReadRect = { top: number; bottom: number; left: number; right: number };
export function finalReplyExposed(reply: ReadRect, viewport: ReadRect) {
  return reply.bottom > reply.top && reply.right > reply.left
    && viewport.bottom > viewport.top && viewport.right > viewport.left
    && reply.bottom > viewport.top + 8 && reply.bottom <= viewport.bottom + 2
    && Math.min(reply.right, viewport.right) - Math.max(reply.left, viewport.left) > 8;
}

export type ReadIdentity = { scope: string; epoch: number; sessionKey: string; turnId: string; replyId: string };
type Proof = { token: string; throughSequence: number; turnId?: string };
/** Both async boundaries recheck the view. The server proof must refer to the
 * displayed turn, so an unseen successor cannot be cleared by an older view. */
export function createCompletionAutoRead(deps: {
  current(): ReadIdentity | undefined;
  observe(key: string): Promise<Proof>;
  read(key: string, proof: Proof): Promise<unknown>;
  seen(identity: ReadIdentity): void;
}) {
  let busy = false, acknowledged: string | undefined;
  const signature = (value: ReadIdentity) => JSON.stringify(value);
  return {
    async attempt() {
      const identity = deps.current();
      if (!identity || busy || acknowledged === signature(identity)) return;
      const stillCurrent = () => {
        const current = deps.current();
        return current && signature(current) === signature(identity);
      };
      busy = true;
      try {
        const proof = await deps.observe(identity.sessionKey);
        if (!stillCurrent() || proof.turnId !== identity.turnId || !Number.isSafeInteger(proof.throughSequence) || proof.throughSequence <= 0) return;
        await deps.read(identity.sessionKey, proof);
        // An old ceiling is safe after a successor starts; do not publish its
        // local seen state into a different account/view in the meantime.
        if (stillCurrent()) { acknowledged = signature(identity); deps.seen(identity); }
      } finally { busy = false; }
    },
  };
}
