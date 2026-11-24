import { useSessionTone } from './WorkspacePreferences';

export function SessionColorMark({ sessionKey }: { sessionKey: string }) {
  const tone = useSessionTone(sessionKey);
  return <span aria-hidden="true" data-session-color={sessionKey} className="inline-block h-3 w-3 shrink-0 rounded-[0.25rem]" style={{ backgroundColor: tone.accent }} />;
}
