// One timer per scroll surface, not one per code card. Only presentation nodes
// are reclaimed: the card, its state and its searchable code text stay mounted.
export const PREVIEW_RETENTION_DELAY_MS = 1200;

export function createPreviewRetention<T>({ protectedTarget, now = Date.now, schedule = setTimeout, cancel = clearTimeout }: {
  protectedTarget: (target: T, compact: boolean) => boolean;
  now?: () => number;
  schedule?: typeof setTimeout;
  cancel?: typeof clearTimeout;
}) {
  const targets = new Map<T, { near: boolean; compact: boolean; due: number; notify: (compact: boolean) => void }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  function flush() {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    let next = Infinity;
    const time = now();
    for (const [target, state] of targets) {
      const desired = !state.near;
      if (desired === state.compact || protectedTarget(target, desired)) continue;
      if (desired && state.due > time) { next = Math.min(next, state.due); continue; }
      state.compact = desired;
      state.notify(desired);
    }
    if (Number.isFinite(next)) timer = schedule(flush, Math.max(0, next - now()));
  }
  return {
    register(target: T, notify: (compact: boolean) => void) {
      const state = { near: true, compact: false, due: Infinity, notify };
      targets.set(target, state);
      return () => {
        if (targets.get(target) !== state) return;
        targets.delete(target);
        if (!targets.size && timer !== undefined) { cancel(timer); timer = undefined; }
      };
    },
    update(changes: Iterable<readonly [T, boolean]>) {
      for (const [target, near] of changes) {
        const state = targets.get(target);
        if (!state || state.near === near) continue;
        state.near = near;
        state.due = near ? Infinity : now() + PREVIEW_RETENTION_DELAY_MS;
      }
      flush();
    },
    flush,
    dispose() { if (timer !== undefined) cancel(timer); timer = undefined; targets.clear(); },
  };
}
