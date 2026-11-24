export type NewSessionOption = { id: string };

/** Older Connectors omit readiness; the server remains the admission authority. */
export function agentCreationNotice(readiness: unknown) {
  if (readiness === undefined || readiness === 'ready') return null;
  if (readiness === 'starting') return 'Agent is starting. Creation will be available when it is ready.' as const;
  if (readiness === 'maintenance') return 'Agent is paused for maintenance. Your draft is preserved.' as const;
  if (readiness === 'failed') return 'Agent startup or ownership check failed. Check the Connector before retrying.' as const;
  if (readiness === 'disabled' || readiness === 'closed') return 'Agent is unavailable on this Connector.' as const;
  return 'Agent readiness could not be verified. Refresh before creating a session.' as const;
}

export function shouldRefreshAgentReadiness(readiness: unknown) {
  return readiness === 'starting' || readiness === 'maintenance';
}

export type NewSessionSelection<T extends NewSessionOption> = {
  groupId: string;
  selectedOption: T | undefined;
  missingSelectedOption: boolean;
};

export type NewSessionDraft = {
  open: boolean;
  groupId: string;
  title: string;
  groupDirty: boolean;
  titleDirty: boolean;
};

export const closedNewSessionDraft: NewSessionDraft = {
  open: false,
  groupId: '',
  title: '',
  groupDirty: false,
  titleDirty: false,
};

export function resolveNewSessionDefaultGroupId(initialGroupId: string, options: readonly NewSessionOption[]) {
  return options.find(option => option.id === initialGroupId)?.id || options[0]?.id || initialGroupId || 'main';
}

export function openNewSessionDraft(initialGroupId: string, options: readonly NewSessionOption[]): NewSessionDraft {
  return {
    open: true,
    groupId: resolveNewSessionDefaultGroupId(initialGroupId, options),
    title: '',
    groupDirty: false,
    titleDirty: false,
  };
}

export function closeNewSessionDraft(draft: NewSessionDraft): NewSessionDraft {
  return { ...draft, open: false };
}

export function editNewSessionGroup(draft: NewSessionDraft, groupId: string): NewSessionDraft {
  return { ...draft, groupId, groupDirty: true };
}

export function editNewSessionTitle(draft: NewSessionDraft, title: string): NewSessionDraft {
  return { ...draft, title, titleDirty: true };
}

export function refreshNewSessionDefaults(draft: NewSessionDraft, initialGroupId: string, options: readonly NewSessionOption[]): NewSessionDraft {
  if (!draft.open) return draft;

  if (draft.groupDirty || options.some(option => option.id === draft.groupId)) return draft;
  return { ...draft, groupId: resolveNewSessionDefaultGroupId(initialGroupId, options) };
}

export function resolveNewSessionSelection<T extends NewSessionOption>(draft: NewSessionDraft, initialGroupId: string, options: readonly T[]): NewSessionSelection<T> {
  const selectedOption = options.find((option) => option.id === draft.groupId);
  if (selectedOption) return { groupId: draft.groupId, selectedOption, missingSelectedOption: false };

  const fallbackGroupId = resolveNewSessionDefaultGroupId(initialGroupId, options);
  const fallbackOption = options.find((option) => option.id === fallbackGroupId) ?? options[0];

  // Keep a dirty/user-selected group as the select value even if a background
  // refresh temporarily removes it from the option list. Rendering can include a
  // synthetic option for this id while still using fallback metadata for labels.
  if (draft.groupId && draft.groupDirty) return { groupId: draft.groupId, selectedOption: fallbackOption, missingSelectedOption: true };

  return { groupId: fallbackGroupId, selectedOption: fallbackOption, missingSelectedOption: false };
}
