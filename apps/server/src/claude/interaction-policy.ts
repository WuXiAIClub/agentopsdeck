import type { claudeToolPolicy } from './tool-policy.js';
import type { InteractionWorker } from '../commands/interaction-worker.js';
import { claudeQuestions } from '../commands/native-questions.js';
import { interactionToolPrompt } from '../commands/interaction-tool-prompt.js';

const deny = () => ({ behavior: 'deny' as const, message: 'Connector interaction was denied or is unavailable' });
/** Human approval narrows static policy; it can never expand it. */
export function claudeInteractionPolicy(policy: ReturnType<typeof claudeToolPolicy>, worker: InteractionWorker, active: () => boolean) {
  return { ...policy, tools: [...policy.tools, 'AskUserQuestion'],
    permissions: { ...policy.permissions, ask: [...policy.permissions.ask, 'AskUserQuestion'] },
    async canUseTool(name: string, original: Record<string, unknown>, invocation?: { signal?: AbortSignal }) {
      try {
        const input = structuredClone(original), alive = () => active() && !invocation?.signal?.aborted;
        if (!alive()) return deny();
        if (name === 'AskUserQuestion') {
          const questions = claudeQuestions(input), answers: Record<string, string> = {};
          for (const question of questions) {
            const answer = await worker.ask(question.question, invocation?.signal, async () => alive());
            if (!alive()) return deny();
            answers[question.question.prompt] = question.decode(answer).join(', ');
          }
          return { behavior: 'allow' as const, updatedInput: { ...input, answers } };
        }
        let checked = await policy.canUseTool(name, input, invocation);
        if (checked.behavior !== 'allow' || !alive()) return deny();
        const answer = await worker.ask({ kind: 'approval', prompt: interactionToolPrompt(name, input) }, invocation?.signal, async answer => {
          if (!alive()) return false;
          if (answer.kind === 'approval' && answer.decision === 'deny') return true;
          checked = await policy.canUseTool(name, input, invocation);
          return checked.behavior === 'allow' && alive();
        });
        return alive() && answer.kind === 'approval' && answer.decision === 'allow-once' ? checked : deny();
      } catch { return deny(); }
    },
  };
}
