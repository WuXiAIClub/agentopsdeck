// Frozen pre-optimization grouping/entry algorithm (2026-09-30). Helpers are
// injected from the test-only module export; no oracle code enters production.
export function toolTimelineOracle(messages, liveNow, h) {
  const entries = [], grouped = new Map();
  messages.forEach((message, index) => {
    if (!message.toolCallId) {
      const preview = h.displayMessageText(h.readableText(message.toolPreview ?? message.text));
      if (h.isToolOutputPlaceholder(preview)) return;
      const resultText = h.toolResultTextForTokenEstimate(preview);
      if (!resultText) return;
      const label = h.toolEntryLabel(message, preview), hint = h.agentCallHint(preview);
      const next = messages[index + 1];
      entries.push({ id: message.id, stableKey: JSON.stringify([message.sessionKey, 'tool-message', message.toolCallId ?? message.id]),
        sessionKey: message.sessionKey, label, hint, variant: h.toolOutputVariant(preview, label, hint),
        lineCount: h.lineCount(preview), tokenLabel: h.formatTokenDelta(h.estimateTextTokens(resultText)), text: preview, preview,
        detailAvailable: Boolean(message.toolDetailAvailable),
        elapsedLabel: next ? h.formatElapsedMs(Math.max(0, next.createdAt - message.createdAt)) : undefined,
        phaseLabel: message.toolPhase === 'result' ? 'history result' : 'result', sortIndex: index });
      return;
    }
    const key = JSON.stringify([message.sessionKey, message.toolCallId]);
    const group = grouped.get(key) ?? { key, index };
    group.index = Math.min(group.index, index);
    if (message.toolPhase === 'call') group.call = message;
    else group.result = message;
    grouped.set(key, group);
  });
  for (const group of grouped.values()) {
    const message = group.result ?? group.call;
    if (!message) continue;
    const callText = group.call ? h.displayMessageText(h.readableText(group.call.toolPreview ?? group.call.text)) : '';
    const resultText = group.result ? h.displayMessageText(h.readableText(group.result.toolPreview ?? group.result.text)) : '';
    const preview = [callText, resultText].filter(Boolean).join('\n\n');
    if (h.isToolOutputPlaceholder(preview)) continue;
    const resultDeltaText = group.result ? h.toolResultTextForTokenEstimate(resultText) : '';
    const label = h.toolEntryLabel(message, preview), executing = h.isToolExecuting(group.call, group.result);
    const executingMs = executing && liveNow !== undefined ? Math.max(0, liveNow - group.call.createdAt) : undefined;
    const hint = group.result?.status === 'failed' ? 'failed' : executing ? `executing${executingMs === undefined ? '' : ` · ${h.formatElapsedMs(executingMs)}`}` : undefined;
    const variant = h.toolOutputVariant(preview, label, h.agentCallHint(preview));
    const elapsedMs = h.groupedToolElapsedMs(group.call, group.result, messages[group.index + 1]);
    entries.push({ id: message.id, stableKey: `tool-call:${group.key}`, sessionKey: message.sessionKey, label, hint, variant,
      lineCount: h.lineCount(preview), tokenLabel: resultDeltaText ? h.formatTokenDelta(h.estimateTextTokens(resultDeltaText)) : undefined,
      text: preview, preview, detailAvailable: Boolean(group.result?.toolDetailAvailable ?? group.call?.toolDetailAvailable),
      elapsedLabel: elapsedMs !== undefined ? h.formatElapsedMs(elapsedMs) : undefined,
      phaseLabel: group.call && group.result ? 'call + result' : group.result ? 'history result' : 'call', sortIndex: group.index });
  }
  return [...entries].sort((a, b) => a.sortIndex - b.sortIndex);
}
