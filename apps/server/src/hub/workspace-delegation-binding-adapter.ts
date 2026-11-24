import type { HubBoardBindings } from "./workspace-board-bindings.js";
import type { DelegationBoard, DelegationMember } from "./workspace-delegation-preview.js";
import type { DelegationAdapter } from "./workspace-delegation-runner.js";
import type { DelegationIntent, DelegationOutcome } from "./workspace-delegation-store.js";

/** Obtained synchronously from the authenticated server catalog and boards.
 * canGrant must include resource-level authorization, not just discoverability.
 * Never accept this evidence or an endpoint from the browser. */
export type DelegationAuthority = {
  member: DelegationMember; board: DelegationBoard; canGrant: boolean; fields: ("status" | "detail")[];
};
export type DelegationBindingTransport = {
  /** Transport must recheck beforeWrite AFTER all discovery/awaits and before
   * installation; Connector request cancellation/authority fences still apply. */
  install: (intent: DelegationIntent, credential: { endpoint: string; token: string; expiresAt: number },
    beforeWrite: () => boolean) => Promise<"installed" | "unknown">;
  query: (intent: DelegationIntent) => Promise<"installed" | "unknown">;
  /** Must persist a remote request tombstone even when installation is absent.
   * A missing file alone is not evidence that a delayed install cannot arrive. */
  cancel: (intent: DelegationIntent) => Promise<"revoked" | "cleanup_pending">;
};

/** Connects the durable runner to EXISTING task-scoped Hub capabilities. Private
 * credentials exist only at the transport boundary, not in batch/receipt JSON.
 * Not enabled by default; HTTP routes, owner catalog adapters and concrete
 * runtime transports must still be supplied and reviewed before exposure. */
export function delegationBindingAdapter(bindings: HubBoardBindings, endpoint: string,
  observe: (intent: DelegationIntent) => DelegationAuthority | undefined,
  transport: DelegationBindingTransport): DelegationAdapter {
  const authorize = (intent: DelegationIntent) => {
    const current = observe(intent); if (!current || current.canGrant !== true) return false;
    const actual = current.member, expected = intent.member;
    return actual.owner === intent.owner && actual.owner === expected.owner && actual.nodeId === expected.nodeId
      && actual.connectionId === expected.connectionId && actual.runtime === expected.runtime && actual.sessionId === expected.sessionId
      && actual.authorityEpoch === expected.authorityEpoch && actual.taskBinding === "supported"
      && current.board.resourceId === intent.boardId && current.board.revision === intent.boardRevision
      && intent.grant.taskIds.every(id => current.board.tasks.some(task => task.id === id))
      && intent.grant.fields.every(field => current.fields.includes(field));
  };
  const unknown = (intent: DelegationIntent): DelegationOutcome => ({ requestId: intent.requestId, state: "unknown" });
  const installed = (intent: DelegationIntent): DelegationOutcome => {
    const binding = bindings.get(intent.owner, intent.boardId, intent.requestId);
    return binding?.state === "installed" ? { requestId: intent.requestId, state: "installed", bindingId: binding.capabilityId } : unknown(intent);
  };
  return {
    authorize,
    async install(intent, beforeWrite) {
      const fence = () => beforeWrite() && authorize(intent);
      if (!fence()) return { requestId: intent.requestId, state: "rejected" };
      // No await between the last authority check and local capability issuance.
      const binding = bindings.prepare(intent.owner, intent.boardId,
        { requestId: intent.requestId, sessionId: intent.member.sessionId, grant: intent.grant },
        intent.member.connectionId, intent.member.authorityEpoch, endpoint);
      if (!binding) return unknown(intent);
      const credential = bindings.credential(intent.owner, intent.boardId, intent.requestId);
      if (!credential) return unknown(intent);
      try {
        const state = await transport.install(intent, credential, () => fence()
          && bindings.credential(intent.owner, intent.boardId, intent.requestId) !== undefined);
        bindings.outcome(intent.owner, intent.boardId, intent.requestId, state === "installed" ? "installed" : "uncertain", true);
        return state === "installed" ? installed(intent) : unknown(intent);
      } catch {
        bindings.outcome(intent.owner, intent.boardId, intent.requestId, "uncertain", true);
        return unknown(intent);
      }
    },
    async query(intent) {
      const binding = bindings.get(intent.owner, intent.boardId, intent.requestId);
      if (binding?.state === "installed") return installed(intent);
      // Absent local intent is NOT proof of remote non-acceptance. No minting.
      if (!binding || binding.state === "revoked" || binding.state === "expired" || binding.state === "unavailable") return unknown(intent);
      if (await transport.query(intent) === "installed") {
        bindings.outcome(intent.owner, intent.boardId, intent.requestId, "installed"); return installed(intent);
      }
      return unknown(intent);
    },
    async cancel(intent) {
      // Durable local revoke/tombstone precedes remote cleanup. Only this batch
      // member request is touched; group membership is not re-expanded.
      if (!bindings.cancelIntent(intent.owner, intent.boardId, intent.requestId)) return "cleanup_pending";
      return transport.cancel(intent);
    },
  };
}
