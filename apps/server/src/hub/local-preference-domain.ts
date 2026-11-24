import type { HubStore } from './hub-store.js';
import { validHubMemberInput, type HubMemberEvidence } from './member-owner-domain.js';
import { OriginalLocalPreferences, validLocalPreferenceInput, validLocalPreferenceOutput,
  validLocalPreferenceSnapshot, type LocalPreferenceInput, type LocalPreferenceResult,
  type LocalPreferenceSnapshot } from '../auth/local-preference-domain.js';

export type HubLocalPreferenceInput = Omit<LocalPreferenceInput, 'evidence'> & { evidence: HubMemberEvidence };
export type HubLocalPreferenceCommand = { kind: 'localPreferenceSnapshot'; input: Record<string, never> }
  | { kind: 'localPreferenceChange'; input: HubLocalPreferenceInput };
export type HubLocalPreferenceResult = { kind: 'localPreferenceSnapshot'; value: LocalPreferenceSnapshot }
  | { kind: 'localPreferenceChange'; value: LocalPreferenceResult };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function validHubLocalPreferenceCommand(v: unknown): v is HubLocalPreferenceCommand {
  if (!object(v) || Object.keys(v).length !== 2 || !Object.hasOwn(v, 'kind') || !Object.hasOwn(v, 'input')) return false;
  if (v.kind === 'localPreferenceSnapshot') return object(v.input) && Object.keys(v.input).length === 0;
  if (v.kind !== 'localPreferenceChange' || !object(v.input) || !object(v.input.evidence)
    || Object.hasOwn(v.input.evidence, 'weixinBinding')) return false;
  return validLocalPreferenceInput({ ...v.input, evidence: {} }, false)
    && validHubMemberInput('memberSnapshot', v.input.evidence);
}
export function validHubLocalPreferenceResult(v: unknown): v is HubLocalPreferenceResult {
  return object(v) && Object.keys(v).length === 2 && Object.hasOwn(v, 'kind') && Object.hasOwn(v, 'value')
    && (v.kind === 'localPreferenceSnapshot' ? validLocalPreferenceSnapshot(v.value)
      : v.kind === 'localPreferenceChange' && validLocalPreferenceOutput(v.value));
}

/** Called inside the original Auth+Hub owner only. Request evidence is not a
 * preflight grant: current principal and fixed synchronous file effect share
 * the same worker turn. No Connector bearer or native permission is issued. */
export function executeHubLocalPreference(command: HubLocalPreferenceCommand, hub: HubStore,
  preferences: OriginalLocalPreferences, legacy: (request: Request) => boolean): HubLocalPreferenceResult {
  if (!validHubLocalPreferenceCommand(command)) throw Error('hub_member_storage_unavailable');
  if (command.kind === 'localPreferenceSnapshot') return { kind: command.kind, value: preferences.snapshot() };
  const { evidence, ...input } = command.input;
  const headers = new Headers();
  if (evidence.accessKey !== undefined) headers.set('x-agentopsdeck-key', evidence.accessKey);
  if (evidence.sessionToken !== undefined) headers.set('cookie', `agentopsdeck_session=${encodeURIComponent(evidence.sessionToken)}`);
  const request = new Request('http://local-preference.invalid/', { headers });
  return { kind: command.kind, value: preferences.change({ ...input, evidence: {} },
    () => hub.identities.requestPrincipal(request, legacy)?.admin === true) };
}
