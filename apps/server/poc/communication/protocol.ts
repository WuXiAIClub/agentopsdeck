// Isolated single-node/single-session communication experiment. Not production storage.
import { randomUUID } from "node:crypto";

export type Cursor = { epoch: string; seq: number };
export type State = {
  status: "idle" | "running";
  messages: { id: string; text: string }[];
};
export type Change = {
  cursor: Cursor;
  kind: "running" | "message" | "completed";
  id: string;
  text?: string;
};
export type Snapshot = { cursor: Cursor; state: State };
export type Command = { id: string; text: string };
export type Receipt = { id: string; status: "accepted" | "completed" };
export type Dispatch = (request: Request) => Promise<Response> | Response;
export const encoder = new TextEncoder();
export const maxMessages = 64; // Bounded recent projection, NOT the complete transcript.
export const cursorId = (cursor: Cursor) => `${cursor.epoch}:${cursor.seq}`;
export class BodyError extends Error {
  constructor(readonly status: number) {
    super(`Invalid body (${status})`);
  }
}
export async function readJson(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  limit: number,
  deadlineMs = 0,
): Promise<unknown> {
  const reader = body?.getReader();
  if (!reader) throw new BodyError(400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let interrupted: unknown;
  const interrupt = (reason: unknown) => {
    interrupted = reason;
    void reader.cancel(reason).catch(() => {});
  };
  const abort = () => interrupt(signal.reason ?? new Error("Aborted"));
  const timer = deadlineMs
    ? setTimeout(() => interrupt(new BodyError(408)), deadlineMs)
    : undefined;
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) abort();
    signal.throwIfAborted();
    while (true) {
      const chunk = await reader.read();
      if (interrupted) throw interrupted;
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new BodyError(413);
      }
      chunks.push(chunk.value);
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BodyError(400);
  }
}
export async function readCommand(request: Request): Promise<Command> {
  const command = (await readJson(
    request.body,
    request.signal,
    8192,
    2000,
  )) as Command;
  if (
    !command ||
    typeof command.id !== "string" ||
    !/^[\w-]{1,80}$/.test(command.id) ||
    typeof command.text !== "string" ||
    command.text.length > 4096
  )
    throw new BodyError(400);
  return { id: command.id, text: command.text };
}
export function parseCursor(value: string): Cursor {
  const match = /^([a-zA-Z0-9-]{1,80}):(\d+)$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[2])))
    throw new Error("Invalid cursor");
  return { epoch: match[1], seq: Number(match[2]) };
}
export function reduce(state: State, event: Change): State {
  if (event.kind === "message")
    return {
      ...state,
      messages: [...state.messages, { id: event.id, text: event.text! }].slice(
        -maxMessages,
      ),
    };
  return { ...state, status: event.kind === "running" ? "running" : "idle" };
}

// One retained log, one cursor per consumer, no per-consumer unbounded event queue.
export class Feed {
  cursor: Cursor = { epoch: randomUUID(), seq: 0 };
  state: State = { status: "idle", messages: [] };
  readonly log: Change[] = [];
  readonly consumers = new Set<(mode?: "heartbeat" | "close") => void>();
  readonly metrics = { opened: 0, closed: 0, slow: 0, heartbeats: 0 };
  private heartbeat?: ReturnType<typeof setInterval>;
  private readonly frames = new WeakMap<Change, Uint8Array>();
  constructor(
    readonly capacity = 128,
    readonly heartbeatMs = 15_000,
  ) {}
  snapshot(): Snapshot {
    return structuredClone({ cursor: this.cursor, state: this.state });
  }
  valid(cursor: Cursor) {
    return (
      cursor.epoch === this.cursor.epoch &&
      cursor.seq <= this.cursor.seq &&
      cursor.seq >= (this.log[0]?.cursor.seq ?? this.cursor.seq + 1) - 1
    );
  }
  reset(snapshot: Snapshot) {
    this.cursor = snapshot.cursor;
    this.state = snapshot.state;
    this.log.length = 0;
    for (const wake of [...this.consumers]) wake();
  }
  append(kind: Change["kind"], id: string, text?: string) {
    this.accept({
      cursor: { ...this.cursor, seq: this.cursor.seq + 1 },
      kind,
      id,
      ...(text === undefined ? {} : { text }),
    });
  }
  accept(event: Change) {
    if (
      event.cursor.epoch !== this.cursor.epoch ||
      event.cursor.seq !== this.cursor.seq + 1
    )
      throw new Error("Event gap");
    this.cursor = event.cursor;
    this.state = reduce(this.state, event);
    this.log.push(event);
    if (this.log.length > this.capacity) this.log.shift();
    for (const wake of [...this.consumers]) wake();
  }
  open(cursor: Cursor, signal: AbortSignal): ReadableStream<Uint8Array> {
    if (this.consumers.size >= 64) throw new BodyError(503);
    let position = cursor;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let pending: (() => void) | undefined;
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      this.consumers.delete(wake);
      signal.removeEventListener("abort", abort);
      this.metrics.closed++;
      pending?.();
      pending = undefined;
      if (!this.consumers.size) {
        clearInterval(this.heartbeat);
        this.heartbeat = undefined;
      }
    };
    const abort = () => {
      cleanup();
      controller.close();
    };
    const wake = (mode?: "heartbeat" | "close") => {
      if (closed) return;
      if (mode === "close") {
        cleanup();
        controller.close();
        return;
      }
      if (!this.valid(position)) {
        this.metrics.slow++;
        cleanup();
        controller.error(new Error("Resync required"));
        return;
      }
      if (!pending) return;
      const event = this.log.find((row) => row.cursor.seq > position.seq);
      if (!event) {
        if (mode === "heartbeat") {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
          pending();
          pending = undefined;
        }
        return;
      }
      position = event.cursor;
      let bytes = this.frames.get(event);
      if (!bytes) {
        bytes = encoder.encode(
          `id: ${cursorId(position)}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`,
        );
        this.frames.set(event, bytes);
      }
      // Serialize once per feed event; copy bytes to isolate consumers from buffer mutation.
      controller.enqueue(bytes.slice());
      pending();
      pending = undefined;
    };
    return new ReadableStream<Uint8Array>(
      {
        start: (c) => {
          controller = c;
          this.metrics.opened++;
          this.consumers.add(wake);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) {
            abort();
            return;
          }
          c.enqueue(encoder.encode(": connected\n\n"));
          if (!this.heartbeat)
            this.heartbeat = setInterval(() => {
              this.metrics.heartbeats++;
              for (const wake of this.consumers) wake("heartbeat");
            }, this.heartbeatMs);
        },
        pull: () =>
          new Promise<void>((resolve) => {
            pending = resolve;
            wake();
          }),
        cancel: cleanup,
      },
      { highWaterMark: 0 },
    );
  }
  close() {
    for (const wake of [...this.consumers]) wake("close");
  }
  get activeTimers() {
    return this.heartbeat ? 1 : 0;
  }
}
