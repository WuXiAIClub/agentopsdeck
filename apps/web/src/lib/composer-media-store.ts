import type { SendMessageUpload } from '@agentopsdeck/shared';

const empty: SendMessageUpload[] = [];
// Conservative UTF-16 data URL budget across all unsent drafts. Never evict a
// user's attachments silently, and never persist file bodies in browser storage.
export function createComposerMediaStore(maxBytes = 128 * 1024 * 1024) {
  let scope = '', bytes = 0;
  const drafts = new Map<string, { media: SendMessageUpload[]; bytes: number }>();
  return {
    activate(next: string) { if (scope !== next) { drafts.clear(); bytes = 0; scope = next; } },
    clear() { drafts.clear(); bytes = 0; scope = ''; },
    read(owner: string, key: string) { return owner === scope ? drafts.get(key)?.media ?? empty : empty; },
    update(owner: string, key: string, value: SendMessageUpload[] | ((media: SendMessageUpload[]) => SendMessageUpload[]), restore = false) {
      if (!owner || owner !== scope) return;
      const previous = drafts.get(key);
      const media = typeof value === 'function' ? value(previous?.media ?? empty) : value;
      const size = media.reduce((sum, item) => sum + item.dataUrl.length * 2, 0);
      const total = bytes - (previous?.bytes ?? 0) + size;
      // A send rejected before submission must be able to return its existing
      // files to the composer, even if another pane filled the budget meanwhile.
      // Those files already live in the outgoing bubble; no new upload is admitted.
      if (total > maxBytes && size > (previous?.bytes ?? 0) && !restore) throw new Error('Attachment drafts are using too much memory. Send or remove attachments in another session first.');
      if (media.length) drafts.set(key, { media, bytes: size }); else drafts.delete(key);
      bytes = total;
    },
  };
}
