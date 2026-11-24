const successorItemMethods = new Set([
  'item/started', 'item/completed', 'item/agentMessage/delta',
  'item/commandExecution/outputDelta', 'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded',
]);

/** Native aliases are redundant evidence, not fallback precedence. Missing
 * aliases are allowed; every supplied alias must be bounded and agree. false
 * distinguishes contradictory/malformed evidence from an absent identity. */
function consistentIdentity(...aliases: unknown[]): string | false | undefined {
  let identity: string | undefined;
  for (const alias of aliases) {
    if (alias === undefined) continue;
    if (typeof alias !== 'string' || alias.trim().length === 0 || alias.length > 512
      || identity !== undefined && identity !== alias) return false;
    identity = alias;
  }
  return identity;
}

function notificationThread(params: any) {
  return consistentIdentity(params?.threadId, params?.thread?.id, params?.turn?.threadId, params?.item?.threadId);
}

/** Reject conflicting supplied evidence, not legitimately unscoped events. */
export function conflictingNativeNotificationIdentity(params: any): boolean {
  return notificationThread(params) === false || consistentIdentity(params?.turn?.id, params?.turnId) === false;
}

/** Ambiguous thread scope must invalidate the global unscoped read epoch, not
 * be attributed only to whichever alias happened to appear first. */
export function nativeNotificationThread(params: any): string | undefined {
  const thread = notificationThread(params);
  return typeof thread === 'string' ? thread : undefined;
}

export function nativeNotificationTurn(params: any): string | undefined {
  const turn = consistentIdentity(params?.turn?.id, params?.turnId);
  return typeof turn === 'string' ? turn : undefined;
}

/** Only explicitly identified item notifications can be separated from a
 * terminal predecessor. Lifecycle/Goal/unknown/unscoped events remain barriers.
 * This classifier never supplies execution or dispatch authority. */
export function successorItemTurn(method: string, params: any): string | undefined {
  if (!successorItemMethods.has(method) || notificationThread(params) === false) return undefined;
  return nativeNotificationTurn(params);
}

/** One bounded observation window per final-history reader. Retain one ID, no
 * payload/deltas and no per-notification queue. The native snapshot must still
 * prove that this exact ID is its ONLY in-progress successor head. */
export function terminalHistoryActivity(threadId: string) {
  let window: { unsafe: boolean; turn?: string } | undefined;
  return {
    observe(method: string, params: any) {
      if (!window) return;
      const id = notificationThread(params);
      if (typeof id !== 'string') { window.unsafe = true; return; }
      if (id !== threadId) return;
      const turn = successorItemTurn(method, params);
      if (!turn || window.turn !== undefined && window.turn !== turn) window.unsafe = true;
      else window.turn = turn;
    },
    checkpoint() {
      const current: { unsafe: boolean; turn?: string } = { unsafe: false };
      window = current;
      return (headTurnId: string) => !current.unsafe && current.turn === headTurnId;
    },
  };
}
