export type MessageItem<T> =
  | { kind: 'message'; message: T; index: number; attachedTools?: T[] }
  | { kind: 'toolGroup'; messages: T[]; startIndex: number; endIndex: number };

/** One projector per pane. Keeps only the current input/output, not snapshots.
 * Identity comparison is still linear; decoding/classification and new groups
 * start at the first changed group. Arbitrary edits/prepends/removals are valid.
 * When older messages are prepended or a tail-first window expands backwards,
 * unchanged suffix chunks reuse their attachedTools/messages array references
 * and avoid re-scanning the unchanged tail.
 */
export function createMessageItemProjector<T extends object>(classify: (message: T) => 'hidden' | 'tool' | 'chat') {
  let previous: T[] = [];
  let chunks: Array<{ start: number; end: number; item: MessageItem<T> }> = [];
  let result: MessageItem<T>[] = [];
  const kinds = new WeakMap<T, ReturnType<typeof classify>>();
  const same = (a: T[] | undefined, b: T[] | undefined) => a === b || (!!a && !!b && a.length === b.length && a.every((value, i) => value === b[i]));
  const classifyMessage = (message: T) => {
    let kind = kinds.get(message);
    if (kind === undefined) {
      kind = classify(message);
      kinds.set(message, kind);
    }
    return kind;
  };
  const shiftChunk = (chunk: { start: number; end: number; item: MessageItem<T> }, delta: number): { start: number; end: number; item: MessageItem<T> } => {
    if (delta === 0) return chunk;
    const start = chunk.start + delta;
    const end = chunk.end + delta;
    if (chunk.item.kind === 'message') {
      return { start, end, item: { ...chunk.item, index: chunk.item.index + delta } };
    }
    return { start, end, item: { ...chunk.item, startIndex: chunk.item.startIndex + delta, endIndex: chunk.item.endIndex + delta } };
  };
  return (messages: T[]) => {
    let common = 0;
    while (common < messages.length && common < previous.length && messages[common] === previous[common]) common++;
    if (common === messages.length && common === previous.length) return result;
    // A trailing tool group may acquire more tools or attach to a new chat.
    let keep = 0;
    while (keep < chunks.length && chunks[keep]!.end < common && chunks[keep]!.item.kind === 'message') keep++;
    const next = chunks.slice(0, keep);
    let start = keep ? chunks[keep - 1]!.end + 1 : 0;

    // Detect common suffix so prepends / reverse-tail window expansions reuse
    // suffix chunks instead of re-grouping the entire tail.
    let suffixCount = 0;
    const maxSuffix = Math.min(messages.length - start, previous.length - start);
    while (
      suffixCount < maxSuffix &&
      messages[messages.length - 1 - suffixCount] === previous[previous.length - 1 - suffixCount]
    ) {
      suffixCount++;
    }
    const delta = messages.length - previous.length;
    let suffixKeepFrom = chunks.length;
    if (suffixCount > 0 && chunks.length > keep) {
      const prevSuffixStart = previous.length - suffixCount;
      // Find the first chunk in `chunks` (after `keep`) that starts at or after
      // `prevSuffixStart` AND is separated from preceding tool items by a clean
      // boundary (i.e. immediately preceded in `previous` by a 'chat' message).
      let candidate = chunks.length;
      for (let c = keep; c < chunks.length; c++) {
        const chunk = chunks[c]!;
        if (chunk.start < prevSuffixStart) continue;
        // Safe boundary if the previous chunk ended with a 'message' at chunk.start - 1
        // (or if all items between the previous message chunk and chunk.start are 'hidden').
        const prevChunk = c > 0 ? chunks[c - 1] : undefined;
        if (prevChunk && prevChunk.item.kind === 'message' && prevChunk.end >= prevSuffixStart) {
          candidate = c;
          break;
        }
      }
      suffixKeepFrom = candidate;
    }
    const scanEnd = suffixKeepFrom < chunks.length
      ? chunks[suffixKeepFrom - 1]!.end + 1 + delta
      : messages.length;

    let tools: T[] = [];
    let toolStart = -1;
    const append = (item: MessageItem<T>, end: number) => {
      const old = chunks[next.length];
      if (old?.start === start && old.end === end && old.item.kind === item.kind) {
        if (item.kind === 'message' && old.item.kind === 'message' && old.item.message === item.message && same(old.item.attachedTools, item.attachedTools)) item = old.item;
        else if (item.kind === 'toolGroup' && old.item.kind === 'toolGroup' && same(old.item.messages, item.messages)) item = old.item;
      }
      next.push({ start, end, item }); start = end + 1;
    };
    for (let index = start; index < scanEnd; index++) {
      const message = messages[index]!;
      const kind = classifyMessage(message);
      if (kind === 'hidden') continue;
      if (kind === 'tool') { if (!tools.length) toolStart = index; tools.push(message); continue; }
      append({ kind: 'message', message, index, ...(tools.length ? { attachedTools: tools } : {}) }, index);
      tools = []; toolStart = -1;
    }
    if (tools.length) append({ kind: 'toolGroup', messages: tools, startIndex: toolStart, endIndex: scanEnd - 1 }, scanEnd - 1);
    for (let c = suffixKeepFrom; c < chunks.length; c++) {
      next.push(shiftChunk(chunks[c]!, delta));
    }
    previous = messages;
    chunks = next;
    result = next.map(chunk => chunk.item);
    return result;
  };
}
