export function normalizeOpenClawSessionRow(row: any) {
  const sessionKey = row?.key ?? row?.sessionKey;
  if (typeof sessionKey !== 'string' || !sessionKey.length) return undefined;
  return {
    key: sessionKey,
    sessionKey,
    agentId: row.agentId,
    ...(row.title ?? row.label ?? row.subject ? { label: row.title ?? row.label ?? row.subject, subject: row.title ?? row.label ?? row.subject } : {}),
    derivedTitle: row.derivedTitle,
    displayName: row.displayName,
    sessionId: row.sessionId,
    sessionFile: row.sessionFile,
    origin: row.origin,
    deliveryContext: row.deliveryContext,
    kind: row.kind,
    // systemSent means the session received its system prompt at some point; it
    // is not evidence of a currently active run. Only explicit runtime status
    // may mark a row running here. Transcript inspection can refine it later.
    status: row.status ?? (row.abortedLastRun ? 'failed' : 'idle'),
    updatedAt: row.updatedAt,
    lastActiveAt: row.updatedAt,
    model: row.model,
    contextTokens: row.contextTokens,
    estimatedTokens: row.totalTokens,
    percentUsed: row.percentUsed,
  };
}
