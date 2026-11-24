import type { AdmissionPause } from './request-drain.js';

export function createTaskDrain() {
  let active = 0;
  let pause: AdmissionPause | undefined;
  let finishPause: (() => void) | undefined;
  let closed: Promise<void> | undefined;
  let finishClose: (() => void) | undefined;
  return {
    async run<Result>(task: () => Result | PromiseLike<Result>): Promise<Result> {
      if (closed) throw new Error('Connector runtime is closing');
      if (pause) throw new Error('Connector runtime is paused for maintenance');
      active++;
      try { return await task(); }
      finally {
        if (--active === 0) { finishPause?.(); finishClose?.(); }
      }
    },
    pause(): AdmissionPause {
      if (pause) return pause;
      let settled = false;
      const drained = new Promise<void>(resolve => {
        finishPause = () => { settled = true; resolve(); };
        if (active === 0) finishPause();
      });
      const lease: AdmissionPause = {
        drained,
        resume: () => {
          if (pause !== lease || !settled || closed) return false;
          pause = undefined;
          finishPause = undefined;
          return true;
        },
      };
      pause = lease;
      return lease;
    },
    close(): Promise<void> {
      return closed ??= new Promise<void>(resolve => {
        finishClose = resolve;
        if (active === 0) resolve();
      });
    },
  };
}
