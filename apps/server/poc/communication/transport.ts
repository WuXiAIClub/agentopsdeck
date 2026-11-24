import { setTimeout as delay } from "node:timers/promises";
import {
  type Command,
  type Cursor,
  type Change,
  type Dispatch,
  type Receipt,
  type Snapshot,
  cursorId,
  parseCursor,
  readJson,
  maxMessages,
} from "./protocol.js";

export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

import { boundedDispatch } from "../../src/connector/transport.js";
export { boundedDispatch } from "../../src/connector/transport.js";

export class ConnectorClient {
  readonly metrics = { requests: 0, retries: 0, eventBytes: 0 };
  private epoch?: string;
  constructor(
    readonly dispatch: Dispatch,
    readonly origin: string,
    private token: string,
    readonly rpcMs = 2000,
    readonly streamMs = 60_000,
  ) {}
  private request(path: string, init: RequestInit = {}, stream = false) {
    this.metrics.requests++;
    return boundedDispatch(
      this.dispatch,
      stream ? this.streamMs : this.rpcMs,
      stream,
    )(
      new Request(`${this.origin}${path}`, {
        ...init,
        redirect: "error",
        headers: { ...init.headers, authorization: `Bearer ${this.token}` },
      }),
    );
  }
  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.request(path, init);
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(response.status);
    }
    return readJson(
      response.body,
      init?.signal ?? new AbortController().signal,
      2 * 1024 * 1024,
    ) as Promise<T>;
  }
  async snapshot(signal?: AbortSignal) {
    const snapshot = await this.json<Snapshot>("/snapshot", { signal });
    parseCursor(cursorId(snapshot.cursor));
    if (
      !["idle", "running"].includes(snapshot.state.status) ||
      !Array.isArray(snapshot.state.messages) ||
      snapshot.state.messages.length > maxMessages ||
      snapshot.state.messages.some(
        (row) => typeof row.id !== "string" || typeof row.text !== "string",
      )
    )
      throw new Error("Invalid snapshot");
    this.epoch = snapshot.cursor.epoch;
    return snapshot;
  }
  receipt(id: string, signal?: AbortSignal) {
    return this.json<Receipt>(`/receipts/${encodeURIComponent(id)}`, {
      signal,
    });
  }
  async send(command: Command, signal?: AbortSignal): Promise<Receipt> {
    // Serialize once; reconstruct every Request. No retry of consumed streaming bodies.
    const body = JSON.stringify(command);
    const epoch = this.epoch ?? (await this.snapshot(signal)).cursor.epoch;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.json<Receipt>("/commands", {
          method: "POST",
          body,
          signal,
          headers: { "content-type": "application/json", "if-match": epoch },
        });
      } catch (error) {
        if (
          signal?.aborted ||
          attempt >= 2 ||
          (error instanceof HttpError && error.status < 500)
        )
          throw error;
        this.metrics.retries++;
        await delay(20 * 2 ** attempt + Math.random() * 10, undefined, {
          signal,
        });
      }
    }
  }
  async *events(
    cursor: Cursor,
    signal: AbortSignal,
    onActivity?: () => void,
  ): AsyncGenerator<Change> {
    const response = await this.request(
      "/events",
      { signal, headers: { "last-event-id": cursorId(cursor) } },
      true,
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(response.status);
    }
    if (
      !response.headers.get("content-type")?.startsWith("text/event-stream")
    ) {
      await response.body?.cancel();
      throw new Error("Not SSE");
    }
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Stream ended");
        onActivity?.();
        this.metrics.eventBytes += chunk.value.byteLength;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (frame.length > 16384) throw new Error("Frame too large");
          const data = frame
            .split("\n")
            .find((line) => line.startsWith("data: "));
          if (data) {
            const event = JSON.parse(data.slice(6)) as Change;
            parseCursor(cursorId(event.cursor));
            if (
              !["running", "message", "completed"].includes(event.kind) ||
              typeof event.id !== "string" ||
              event.id.length > 80 ||
              (event.kind === "message" &&
                (typeof event.text !== "string" || event.text.length > 4096))
            )
              throw new Error("Invalid event");
            yield event;
          }
        }
        if (buffer.length > 16384) throw new Error("Frame too large");
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
