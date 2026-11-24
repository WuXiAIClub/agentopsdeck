/** Four rolling slots for ONE bounded reconciliation page. Follow-up tasks
 * belong to that same page, not replacement requests. Pending tasks retain a
 * slot; fencing stops unstarted tasks and still waits for every original ACK.
 * No timeout, cancellation, command replay or additional owner is introduced. */
export function reconcilePage<T>(initial: readonly T[], work: (item: T) => Promise<readonly T[] | void>,
  canStart: () => boolean, maximumItems = initial.length): Promise<void> {
  if (!Number.isSafeInteger(maximumItems) || maximumItems < initial.length || maximumItems > 1024) {
    return Promise.reject(Error('Invalid reconciliation page capacity'));
  }
  const queue = [...initial];
  let next = 0, active = 0, fenced = false, failed = false, firstIndex = Infinity, firstError: unknown;
  const failure = (index: number, error: unknown) => {
    failed = true;
    if (index < firstIndex) { firstIndex = index; firstError = error; }
  };
  return new Promise<void>((resolve, reject) => {
    const pump = () => {
      while (!fenced && active < 4 && next < queue.length) {
        try { if (!canStart()) { fenced = true; break; } }
        catch (error) { failure(next, error); fenced = true; break; }
        const index = next++, item = queue[index]!; active++;
        void Promise.resolve().then(() => {
          // Admission and invocation are different microtasks. A close between
          // them fences even already reserved, but not yet invoked, work.
          try { if (fenced || !canStart()) { fenced = true; return; } }
          catch (error) { fenced = true; throw error; }
          return work(item);
        }).then(follow => {
          if (!follow) return;
          if (queue.length + follow.length > maximumItems) throw Error('Reconciliation page capacity exceeded');
          queue.push(...follow);
        }).catch(error => failure(index, error)).then(() => { active--; pump(); });
      }
      if (!active && (fenced || next === queue.length)) {
        if (failed) reject(firstError); else resolve();
      }
    };
    pump();
  });
}
