/** Tab-local, identity/card-scoped configuration. Never store PTY IDs or input. */
export type TerminalPreference = { connection: string; target: string; reconnect: boolean; resume: boolean };
type Store = Pick<Storage, 'getItem' | 'setItem'>;
const key = (scope: string, card: string) => `agentopsdeck.terminal.v1:${JSON.stringify([scope, card])}`;
const lifetime = 12 * 60 * 60 * 1000;
export function readTerminalPreference(storage: Store | undefined, scope: string, card: string, now = Date.now()): TerminalPreference | undefined {
  if (!scope || !card) return;
  try {
    const value = JSON.parse(storage?.getItem(key(scope, card)) ?? 'null');
    if (!value || !Number.isFinite(value.at) || value.at > now || now - value.at > lifetime
      || typeof value.connection !== 'string' || !value.connection || value.connection.length > 512
      || typeof value.target !== 'string' || value.target.length > 512
      || typeof value.reconnect !== 'boolean' || typeof value.resume !== 'boolean') return;
    return { connection: value.connection, target: value.target, reconnect: value.reconnect, resume: value.resume };
  } catch { return; }
}
export function saveTerminalPreference(storage: Store | undefined, scope: string, card: string, value: TerminalPreference, now = Date.now()): boolean {
  if (!storage || !scope || !card) return false;
  try {
    storage.setItem(key(scope, card), JSON.stringify({ connection: value.connection, target: value.target,
      reconnect: value.reconnect, resume: value.resume, at: now }));
    return true;
  } catch { return false; }
}
/** Consume before doing any network work. A failed start must not be replayed. */
export function takeTerminalResume(storage: Store | undefined, scope: string, card: string, reload: boolean): TerminalPreference | undefined {
  const value = readTerminalPreference(storage, scope, card);
  if (!value || !saveTerminalPreference(storage, scope, card, { ...value, resume: false })) return;
  return reload && value.reconnect && value.resume && value.target ? value : undefined;
}
