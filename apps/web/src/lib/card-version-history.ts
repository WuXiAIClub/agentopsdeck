export type CardVersionKind = "notebook" | "taskboard" | "drawing";
export type CardVersionSource = "auto" | "manual" | "pre-restore" | "initial";

export type CardVersionSnapshot = {
  id: string;
  kind: CardVersionKind;
  resourceId: string;
  revision?: number | undefined;
  timestamp: number;
  label: string;
  summary: string;
  payload: string;
  hash: string;
  source?: CardVersionSource | undefined;
};

export type CardVersionDiffLine = {
  type: "same" | "add" | "remove";
  text: string;
  oldLineNumber?: number | undefined;
  newLineNumber?: number | undefined;
};

export type CardVersionDiffSummary = {
  lines: CardVersionDiffLine[];
  addedCount: number;
  removedCount: number;
  unchangedCount: number;
};

export const MAX_CARD_VERSION_SNAPSHOTS = 20;
const STORAGE_PREFIX = "agentopsdeck:card-versions:v1:";

function storageKey(scope: string | undefined, kind: CardVersionKind, resourceId: string): string {
  const safeScope = (scope ?? "default").trim() || "default";
  return `${STORAGE_PREFIX}${safeScope}:${kind}:${resourceId.trim() || "default"}`;
}

const snapshotMemoryCache = new Map<string, CardVersionSnapshot[]>();

/** Fast deterministic FNV-1a 32-bit string hash for snapshot deduplication (stride-sampled above 8KB). */
export function hashCardPayload(payload: string): string {
  let hash = 0x811c9dc5 ^ payload.length;
  const len = payload.length;
  const step = len > 8192 ? Math.max(1, Math.floor(len / 4096)) : 1;
  for (let i = 0; i < len; i += step) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  if (step > 1 && len > 0) {
    hash ^= payload.charCodeAt(len - 1);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function listCardVersionSnapshots(
  scope: string | undefined,
  kind: CardVersionKind,
  resourceId: string,
): CardVersionSnapshot[] {
  const key = storageKey(scope, kind, resourceId);
  if (typeof localStorage === "undefined") {
    return snapshotMemoryCache.get(key) ?? [];
  }
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      snapshotMemoryCache.delete(key);
      return [];
    }
    const cached = snapshotMemoryCache.get(key);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return cached ?? [];
    const list = parsed
      .filter(
        (item): item is CardVersionSnapshot =>
          Boolean(item) &&
          typeof item.id === "string" &&
          typeof item.timestamp === "number" &&
          typeof item.payload === "string" &&
          typeof item.hash === "string",
      )
      .slice(0, MAX_CARD_VERSION_SNAPSHOTS);
    snapshotMemoryCache.set(key, list);
    return list;
  } catch {
    return snapshotMemoryCache.get(key) ?? [];
  }
}

export function recordCardVersionSnapshot(input: {
  scope: string | undefined;
  kind: CardVersionKind;
  resourceId: string;
  payload: string;
  summary: string;
  label?: string | undefined;
  revision?: number | undefined;
  timestamp?: number | undefined;
  source?: CardVersionSource | undefined;
  force?: boolean | undefined;
}): CardVersionSnapshot[] {
  const trimmedPayload = input.payload;
  if (!trimmedPayload || !trimmedPayload.trim()) {
    return listCardVersionSnapshots(input.scope, input.kind, input.resourceId);
  }
  const key = storageKey(input.scope, input.kind, input.resourceId);
  const hash = hashCardPayload(trimmedPayload);
  const memExisting = snapshotMemoryCache.get(key);
  if (!input.force && memExisting && memExisting[0]?.hash === hash) {
    return memExisting;
  }
  const existing = listCardVersionSnapshots(input.scope, input.kind, input.resourceId);
  if (!input.force && existing[0]?.hash === hash) {
    return existing;
  }
  const now = input.timestamp ?? Date.now();
  const nextNumber = existing.length + 1;
  const snapshot: CardVersionSnapshot = {
    id: `ver_${now}_${hash.slice(0, 6)}`,
    kind: input.kind,
    resourceId: input.resourceId,
    revision: input.revision,
    timestamp: now,
    label: input.label ?? (input.revision !== undefined ? `r${input.revision}` : `v${nextNumber}`),
    summary: input.summary.slice(0, 140),
    payload: trimmedPayload,
    hash,
    source: input.source ?? "auto",
  };
  const deduped = existing.filter((item) => item.hash !== hash || input.force);
  const updated = [snapshot, ...deduped].slice(0, MAX_CARD_VERSION_SNAPSHOTS);
  snapshotMemoryCache.set(key, updated);
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(key, JSON.stringify(updated));
    } catch {
      // Ignore storage quota errors
    }
  }
  return updated;
}

export function clearCardVersionSnapshots(
  scope: string | undefined,
  kind: CardVersionKind,
  resourceId: string,
): void {
  const key = storageKey(scope, kind, resourceId);
  snapshotMemoryCache.delete(key);
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore storage removal errors
  }
}

/** Compute a human-readable line diff between two snapshots or against current state. */
export function computeCardVersionDiff(
  beforePayload: string,
  afterPayload: string,
  kind: CardVersionKind,
): CardVersionDiffLine[] {
  return computeCardVersionDiffSummary(beforePayload, afterPayload, kind).lines;
}

export function computeCardVersionDiffSummary(
  beforePayload: string,
  afterPayload: string,
  kind: CardVersionKind,
): CardVersionDiffSummary {
  const beforeLines = formatCardSnapshotPreview(beforePayload, kind).split(/\r?\n/).slice(0, 220);
  const afterLines = formatCardSnapshotPreview(afterPayload, kind).split(/\r?\n/).slice(0, 220);
  const result: CardVersionDiffLine[] = [];
  let addedCount = 0;
  let removedCount = 0;
  let unchangedCount = 0;

  let i = 0;
  let j = 0;
  while (i < beforeLines.length || j < afterLines.length) {
    const b = beforeLines[i];
    const a = afterLines[j];
    if (i < beforeLines.length && j < afterLines.length && b === a) {
      result.push({ type: "same", text: a ?? "", oldLineNumber: i + 1, newLineNumber: j + 1 });
      unchangedCount += 1;
      i += 1;
      j += 1;
    } else if (j + 1 < afterLines.length && b === afterLines[j + 1]) {
      result.push({ type: "add", text: a ?? "", newLineNumber: j + 1 });
      addedCount += 1;
      j += 1;
    } else if (i + 1 < beforeLines.length && beforeLines[i + 1] === a) {
      result.push({ type: "remove", text: b ?? "", oldLineNumber: i + 1 });
      removedCount += 1;
      i += 1;
    } else {
      if (i < beforeLines.length) {
        result.push({ type: "remove", text: b ?? "", oldLineNumber: i + 1 });
        removedCount += 1;
        i += 1;
      }
      if (j < afterLines.length) {
        result.push({ type: "add", text: a ?? "", newLineNumber: j + 1 });
        addedCount += 1;
        j += 1;
      }
    }
  }
  return {
    lines: result.slice(0, 320),
    addedCount,
    removedCount,
    unchangedCount,
  };
}

export function formatCardSnapshotPreview(payload: string, kind: CardVersionKind): string {
  if (!payload) return "";
  if (kind === "notebook") return payload;
  try {
    const parsed = JSON.parse(payload);
    const taskList = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).tasks) ? (parsed as Record<string, unknown>).tasks as Record<string, unknown>[] : null);
    if (kind === "taskboard" && taskList) {
      return taskList
        .map((task: Record<string, unknown>) => {
          const status = typeof task.status === "string" ? task.status.toUpperCase() : "TODO";
          const title = typeof task.title === "string" ? task.title : String(task.id ?? "");
          const detail = typeof task.detail === "string" && task.detail.trim() ? ` — ${task.detail.trim()}` : "";
          return `[${status}] ${title}${detail}`;
        })
        .join("\n");
    }
    if (kind === "drawing" && parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const nodes = Array.isArray(obj.nodes) ? obj.nodes : [];
      const edges = Array.isArray(obj.edges) ? obj.edges : [];
      const strokes = Array.isArray(obj.strokes) ? obj.strokes : [];
      const lines: string[] = [`Whiteboard (${nodes.length} cards, ${edges.length} links, ${strokes.length} strokes)`];
      for (const node of nodes) {
        if (node && typeof node === "object") {
          const rec = node as Record<string, unknown>;
          lines.push(`- Card (${String(rec.x ?? 0)}, ${String(rec.y ?? 0)}): ${String(rec.text ?? "").replace(/\s+/g, " ")}`);
        }
      }
      return lines.join("\n");
    }
  } catch {
    // Fallback to raw payload
  }
  return payload;
}
