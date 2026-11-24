/** In-page drag identity: DataTransfer is deliberately unreadable during dragover.
 * Never trust arbitrary text, file paths, or cross-page payloads as session IDs. */
export const sessionCardDragType = 'application/x-agentopsdeck-session';
let active: { key: string; paneId: string } | undefined;
export function beginSessionCardDrag(key: string) {
  active = { key, paneId: crypto.randomUUID() };
  window.dispatchEvent(new CustomEvent('agentopsdeck:session-hover-preview'));
}
export function endSessionCardDrag() { active = undefined; }
export function currentSessionCardDrag() { return active; }
