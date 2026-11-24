// Strip only embedded image payloads from the UI projection. Native rollouts
// remain untouched; textual output, errors and ordinary file paths survive.
export const OMITTED_TOOL_IMAGE = '[Image payload omitted from tool history]';
export function compactToolHistoryContent(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(value);
        const compact = compactToolHistoryContent(parsed);
        if (JSON.stringify(parsed) !== JSON.stringify(compact)) return JSON.stringify(compact);
      } catch { /* ordinary non-JSON output */ }
    }
    return value.replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\r\n]+/gi, OMITTED_TOOL_IMAGE);
  }
  if (Array.isArray(value)) return value.map(compactToolHistoryContent);
  if (!value || typeof value !== 'object') return value;
  const item = value as Record<string, unknown>;
  if (['image', 'input_image', 'output_image', 'image_url'].includes(String(item.type))) {
    const source = item.source as Record<string, unknown> | undefined;
    if (typeof item.data === 'string' || typeof item.image_url === 'string' && item.image_url.startsWith('data:')
      || typeof item.url === 'string' && item.url.startsWith('data:') || source?.type === 'base64'
      || item.image_url && typeof item.image_url === 'object' && String((item.image_url as Record<string, unknown>).url).startsWith('data:')) {
      return { type: 'text', text: OMITTED_TOOL_IMAGE };
    }
  }
  return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, compactToolHistoryContent(child)]));
}
