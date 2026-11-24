import type { copilotToolPolicy } from './tool-policy.js';
import type { InteractionWorker } from '../commands/interaction-worker.js';
import { copilotQuestion } from '../commands/native-questions.js';
import { interactionToolPrompt } from '../commands/interaction-tool-prompt.js';

export function copilotInteractionPolicy(policy: Pick<ReturnType<typeof copilotToolPolicy>, 'onPermissionRequest'>,
  worker: InteractionWorker, sessionId: string, active: () => boolean) {
  return {
    async onPermissionRequest(original: unknown, invocation: { managedSettingsEnabled?: boolean; sessionId?: string } = {}) {
      try {
        const request = structuredClone(original), alive = () => active() && invocation.sessionId === sessionId;
        if (!alive() || (await policy.onPermissionRequest(request, invocation)).kind !== 'approve-once') return { kind: 'reject' as const };
        const answer = await worker.ask({ kind: 'approval', prompt: interactionToolPrompt('Copilot', request) }, undefined, async answer =>
          alive() && (answer.kind === 'approval' && answer.decision === 'deny'
            || (await policy.onPermissionRequest(request, invocation)).kind === 'approve-once' && alive()));
        return alive() && answer.kind === 'approval' && answer.decision === 'allow-once' ? { kind: 'approve-once' as const } : { kind: 'reject' as const };
      } catch { return { kind: 'reject' as const }; }
    },
    async onUserInputRequest(value: unknown, invocation: { sessionId: string }) {
      if (!active() || invocation.sessionId !== sessionId) throw new Error('Copilot interaction unavailable');
      const question = copilotQuestion(value);
      const answer = await worker.ask(question.question, undefined, async () => active());
      if (!active()) throw new Error('Copilot interaction unavailable');
      return { answer: question.decode(answer)[0]!, wasFreeform: answer.kind === 'text' || 'text' in answer && answer.text !== undefined };
    },
  };
}
