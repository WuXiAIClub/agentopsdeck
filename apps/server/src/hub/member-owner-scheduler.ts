/** One worker, independent original Auth awaits, serialized original Hub work.
 * This is not an SQL scheduler: transaction bodies remain synchronous inside
 * their original store. Closing freezes admission before collecting all work. */
export class HubMemberOwnerScheduler {
  private hub = Promise.resolve();
  private barrier = Promise.resolve();
  private readonly running = new Set<Promise<void>>();
  private closing = false;
  schedule(kind: 'hub' | 'auth' | 'barrier' | 'close', execute: () => Promise<void>): Promise<void> {
    if (this.closing) throw Error('hub_member_storage_unavailable');
    if (kind === 'close') this.closing = true;
    const predecessors = kind === 'close' || kind === 'barrier' ? [...this.running] : [];
    const work = kind === 'close' || kind === 'barrier'
      ? Promise.allSettled(predecessors).then(execute)
      : Promise.all(kind === 'hub' ? [this.hub, this.barrier] : [this.barrier]).then(execute);
    if (kind === 'hub') this.hub = work;
    if (kind === 'barrier') this.barrier = work;
    this.running.add(work);
    void work.then(() => this.running.delete(work), () => this.running.delete(work));
    return work;
  }
}
