import type { ChatMessage, SessionSummary } from '@agentopsdeck/shared';

// Bounded text-only cache shared by chat, hover and completion previews. No
// persistence: auth changes must discard both cached text and pending reads.
export const PREVIEW_REFRESH_MS = 60_000;
export const PREVIEW_IDLE_REVALIDATE_MS = 5 * PREVIEW_REFRESH_MS;
// Activity is an invalidation hint, not authorization or proof of freshness.
export const previewActivityVersion = (session: SessionSummary) => JSON.stringify([
  session.status, session.hasActiveRun, session.lastActiveAt, session.messageCount, session.runCompletedAt, session.recent,
]);
export const previewKey = (scope: string, session: string) => JSON.stringify([scope, session]);
type Entry = { messages: ChatMessage[]; at: number; started: number; activityVersion?: string | undefined; loading?: boolean; error?: boolean; denied?: boolean; retryAt?: number; failures?: number };
type Loader = (signal: AbortSignal) => Promise<ChatMessage[]>;
type Job = { key: string; loader: Loader; controller: AbortController; resolve: () => void; promise: Promise<void>; activityVersion?: string | undefined };

export function createSessionPreviewCache(now = Date.now, capacity = 64, concurrency = 2) {
  const entries = new Map<string, Entry>(), listeners = new Map<string, Set<() => void>>();
  const jobs = new Map<string, Job>(), queue: Job[] = [];
  let running = 0, generation = 0;
  const emit = (key: string) => listeners.get(key)?.forEach(listener => listener());
  function put(key: string, entry: Entry) {
    entries.delete(key); entries.set(key, entry);
    while (entries.size > capacity) { const oldest = entries.keys().next().value!; entries.delete(oldest); emit(oldest); }
    emit(key);
  }
  function seed(key: string, messages: ChatMessage[], started = now(), activityVersion?: string) {
    const previous = entries.get(key);
    if (previous && previous.started > started) return;
    // Construct rather than spread: never retain images/tool arguments/metadata.
    const text = messages.filter(message => (message.role === 'user' || message.role === 'assistant') && !message.toolName && !message.toolPhase)
      .slice(-4).map(({ id, role, text, sessionKey, createdAt }) => ({ id, role, text: String(text ?? '').slice(0, 3000), sessionKey, createdAt }));
    put(key, { messages: text, at: now(), started, activityVersion });
  }
  function pump() {
    while (running < concurrency && queue.length) {
      const job = queue.shift()!;
      if (jobs.get(job.key) !== job) continue;
      running++;
      const started = now();
      const timer = setTimeout(() => job.controller.abort(), 15_000);
      void Promise.resolve().then(() => job.loader(job.controller.signal)).then(messages => {
        if (jobs.get(job.key) === job && !job.controller.signal.aborted) seed(job.key, messages, started, job.activityVersion);
      }).catch(error => {
        if (jobs.get(job.key) !== job) return;
        const previous = entries.get(job.key);
        if (previous && previous.started > started) return;
        const denied = [401, 403, 404].includes(Number(error?.status));
        const failures = (previous?.failures ?? 0) + 1;
        put(job.key, { messages: denied ? [] : previous?.messages ?? [], at: previous?.at ?? 0, started,
          error: true, denied, failures, retryAt: now() + Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4)) });
      }).finally(() => {
        clearTimeout(timer); running--;
        if (jobs.get(job.key) === job) {
          jobs.delete(job.key);
          const entry = entries.get(job.key);
          if (entry?.loading) put(job.key, { ...entry, loading: false });
        }
        job.resolve(); pump();
      });
    }
  }
  return {
    epoch: () => generation,
    peek: (key: string) => entries.get(key), seed,
    subscribe(key: string, listener: () => void) {
      const set = listeners.get(key) ?? new Set(); set.add(listener); listeners.set(key, set);
      return () => { set.delete(listener); if (!set.size) listeners.delete(key); };
    },
    load(key: string, loader: Loader, force = false, priority = false, activityVersion?: string) {
      const pending = jobs.get(key);
      if (pending) {
        const index = queue.indexOf(pending);
        if (priority && index > 0) { queue.splice(index, 1); queue.unshift(pending); }
        return pending.promise;
      }
      const entry = entries.get(key);
      if (!force && activityVersion !== undefined && entry && !entry.error && entry.activityVersion === activityVersion
        && now() - entry.at < PREVIEW_IDLE_REVALIDATE_MS) return Promise.resolve();
      if (!force && entry && (entry.retryAt ? now() < entry.retryAt : now() - entry.at < PREVIEW_REFRESH_MS)) return Promise.resolve();
      if (queue.length >= capacity) return Promise.resolve();
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      const job: Job = { key, loader, resolve, promise, controller: new AbortController(), activityVersion };
      jobs.set(key, job); if (priority) queue.unshift(job); else queue.push(job);
      put(key, { messages: entry?.messages ?? [], at: entry?.at ?? 0, started: entry?.started ?? 0, ...entry, loading: true });
      pump(); return promise;
    },
    cancelQueued(key: string) {
      const job = jobs.get(key), index = job ? queue.indexOf(job) : -1;
      if (!job || index < 0) return;
      queue.splice(index, 1); jobs.delete(key); job.resolve();
      const entry = entries.get(key);
      if (entry) put(key, { ...entry, loading: false });
    },
    clear(matches: (key: string) => boolean = () => true) {
      generation++;
      for (const [key, job] of jobs) if (matches(key)) { jobs.delete(key); job.controller.abort(); job.resolve(); }
      for (let index = queue.length - 1; index >= 0; index--) if (matches(queue[index]!.key)) queue.splice(index, 1);
      for (const key of entries.keys()) if (matches(key)) entries.delete(key);
      for (const key of listeners.keys()) if (matches(key)) emit(key);
    },
  };
}
export const sessionPreviewCache = createSessionPreviewCache();
