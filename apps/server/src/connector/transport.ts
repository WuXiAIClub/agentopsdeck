export type Dispatch = (request: Request) => Response | Promise<Response>;

// Transport deadlines are not original-work acknowledgements. Lifecycle owners
// opt into this tracker without changing HTTP timeout/abort response semantics.
export class OriginalTransportDrain {
  private readonly flights = new Set<Promise<unknown>>();

  track(original: Promise<unknown>) {
    this.flights.add(original);
    void original.then(() => this.flights.delete(original), () => this.flights.delete(original));
  }

  async wait(): Promise<void> {
    // A late dispatch response can start cancellation while dispatch settles.
    while (this.flights.size) await Promise.allSettled([...this.flights]);
  }
}

// Same owner of reader/abort/deadline for local and network dispatch.
// Callers must consume or cancel bodies; an accepted command is NOT cancelled with its transport.
export function boundedDispatch(
  dispatch: Dispatch,
  deadlineMs: number,
  idle = false,
  drain?: OriginalTransportDrain,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let output: ReadableStreamDefaultController<Uint8Array> | undefined;
    let disposed = false;
    let cancellation: Promise<void> | undefined;
    const cancelReader = (reason?: unknown) => {
      if (!cancellation) {
        let settle!: () => void;
        cancellation = new Promise<void>(resolve => { settle = resolve; });
        drain?.track(cancellation);
        try { void reader!.cancel(reason).then(settle, settle); } catch { settle(); }
        if (drain) void cancellation.then(() => reader!.releaseLock());
        else reader!.releaseLock();
      }
      return cancellation;
    };
    const cancelResponse = (response: Response) => {
      let settle!: () => void;
      const original = new Promise<void>(resolve => { settle = resolve; });
      drain?.track(original);
      try { void Promise.resolve(response.body?.cancel()).then(settle, settle); } catch { settle(); }
      return original;
    };
    const abort = () => controller.abort(request.signal.reason);
    const timer = setTimeout(
      () => controller.abort(new Error("Deadline exceeded")),
      deadlineMs,
    );
    const cleanup = () => {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      if (disposed) return;
      disposed = true;
      // Cancellation closes pending reads synchronously; source cleanup may never settle.
      if (reader) void cancelReader(controller.signal.reason);
      output?.error(controller.signal.reason);
      cleanup();
    };
    request.signal.addEventListener("abort", abort, { once: true });
    controller.signal.addEventListener("abort", cancel, { once: true });
    if (request.signal.aborted) abort();
    try {
      controller.signal.throwIfAborted();
      const result = await new Promise<Response>((resolve, reject) => {
        const fail = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", fail, { once: true });
        const original = Promise.resolve()
          .then(() =>
            dispatch(new Request(request, { signal: controller.signal })),
          )
          .then(
            (response) => {
              controller.signal.removeEventListener("abort", fail);
              if (controller.signal.aborted) {
                return cancelResponse(response);
              }
              resolve(response);
            },
            (error) => {
              controller.signal.removeEventListener("abort", fail);
              reject(error);
            },
          );
        drain?.track(original);
      });
      // Abort can arrive after dispatch resolves but before this continuation owns the body.
      if (controller.signal.aborted) {
        void cancelResponse(result);
        controller.signal.throwIfAborted();
      }
      if (!result.body) {
        cleanup();
        return result;
      }
      reader = result.body.getReader();
      const body = new ReadableStream<Uint8Array>(
        {
          start(c) {
            output = c;
            if (controller.signal.aborted) c.error(controller.signal.reason);
          },
          async pull(c) {
            try {
              const next = await reader!.read();
              if (disposed) return;
              if (next.done) {
                disposed = true;
                cleanup();
                reader!.releaseLock();
                c.close();
              } else {
                if (idle) timer.refresh();
                c.enqueue(next.value);
              }
            } catch (error) {
              if (!disposed) {
                disposed = true;
                cleanup();
                reader!.releaseLock();
                c.error(error);
              }
            }
          },
          cancel(reason) {
            disposed = true;
            cleanup();
            const original = cancelReader(reason);
            if (drain) return original;
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, {
        status: result.status,
        headers: result.headers,
      });
    } catch (error) {
      cleanup();
      throw error;
    }
  };
}
