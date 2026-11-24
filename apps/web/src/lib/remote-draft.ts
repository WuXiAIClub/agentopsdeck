import type { RemoteOutcome } from '@agentopsdeck/shared';
import type { NotebookTransferOutcome } from './session-notebook.js';
export type NotebookReadingTransfer = { text: string; result: NotebookTransferOutcome };
/** Separate from composer drafts: only an explicitly selected notebook may autosave. */
export function placeNotebookReading(pane: HTMLElement, text: string): NotebookTransferOutcome {
  const notebook = pane.querySelector<HTMLElement>('.session-notebook');
  if (!notebook) return 'unavailable';
  const detail: NotebookReadingTransfer = { text, result: 'unavailable' };
  notebook.dispatchEvent(new CustomEvent<NotebookReadingTransfer>('agentopsdeck:notebook-reading', { detail }));
  return detail.result;
}
/** Targeted DOM event remains inside one explicitly selected pane, never window-wide. */
export type RemoteDraft = { text: string; result: RemoteOutcome; reason?: 'too-large' };
export type SessionDraftOutcome = 'applied' | 'occupied' | 'unavailable' | 'too-large';
/** Bounded, inert labels; numbering also distinguishes identical titles on one node. */
export function sessionDraftTargetLabel(title: string, runtime: string, node: string | undefined, position: number): string {
  const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, 120);
  return [`#${position + 1}`, clean(title), clean(runtime), node ? clean(node) : ''].filter(Boolean).join(' · ');
}
export function draftAdmission(text: string, state: { disabled: boolean; occupied: boolean; maxChars: number }): SessionDraftOutcome {
  if (state.disabled || !text.trim()) return 'unavailable';
  if (state.occupied) return 'occupied';
  if (text.length > state.maxChars) return 'too-large';
  return 'applied';
}
/** Session-only transfer: must never fall through to an autosaving notebook editor. */
export function placeSessionDraft(pane: HTMLElement, text: string): SessionDraftOutcome {
  const editor = pane.querySelector<HTMLTextAreaElement>('.desktop-composer-textarea');
  if (!editor) return 'unavailable';
  const detail: RemoteDraft = { text, result: 'unavailable' };
  editor.dispatchEvent(new CustomEvent<RemoteDraft>('agentopsdeck:remote-draft', { detail }));
  return detail.reason === 'too-large' ? 'too-large' : detail.result === 'applied' || detail.result === 'occupied' ? detail.result : 'unavailable';
}
export type RemoteSend = { text: string; key: string; resolve: (result: RemoteOutcome) => void };
/** The desktop composer owns admission, permissions, queue mode and receipt recovery. */
export function sendRemoteMessage(pane: HTMLElement, text: string, key: string): Promise<RemoteOutcome> {
  const editor = pane.querySelector<HTMLElement>('.desktop-composer-textarea');
  if (!editor) return Promise.resolve('unavailable');
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve('unknown'), 6500);
    const detail: RemoteSend = { text, key, resolve: result => { clearTimeout(timer); resolve(result); } };
    editor.dispatchEvent(new CustomEvent<RemoteSend>('agentopsdeck:remote-send', { detail }));
  });
}
export function placeRemoteDraft(pane: HTMLElement, text: string): RemoteOutcome {
  const editor = pane.querySelector<HTMLElement>('.desktop-composer-textarea, .tiptap[contenteditable="true"]');
  if (!editor) return 'unavailable';
  const detail: RemoteDraft = { text, result: 'unavailable' };
  editor.dispatchEvent(new CustomEvent<RemoteDraft>('agentopsdeck:remote-draft', { detail }));
  return detail.result;
}
