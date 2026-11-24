import { visitRollout, type RolloutSource } from './rollout-projection.js';

const modelName = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** Per-read state only: a failed/pending turn does not replace a successful model. */
export function createRolloutModelAccumulator() {
  let activeModel: string | undefined;
  let lastSuccessfulModel: string | undefined;
  return {
    accept(entry: any) {
      const payload = entry?.payload;
      if (payload?.type === 'thread_settings_applied') activeModel = modelName(payload?.thread_settings?.model) ?? activeModel;
      if (entry?.type === 'turn_context' || payload?.type === 'turn_context') activeModel = modelName(payload?.model) ?? activeModel;
      if (payload?.type === 'task_complete' && !payload?.error && activeModel) lastSuccessfulModel = activeModel;
    },
    result: () => lastSuccessfulModel ?? activeModel,
  };
}

export function threadModelFromRollout(rollout: string): string | undefined;
export function threadModelFromRollout(rollout: RolloutSource): string | undefined | Promise<string | undefined>;
export function threadModelFromRollout(rollout: RolloutSource) {
  const model = createRolloutModelAccumulator();
  return visitRollout(rollout, line => {
    let entry: any;
    try { entry = JSON.parse(line); } catch { return; }
    model.accept(entry);
  }, model.result);
}
