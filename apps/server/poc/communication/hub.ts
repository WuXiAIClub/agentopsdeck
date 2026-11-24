import { Hono } from "hono";
import { setTimeout as delay } from "node:timers/promises";
import { Feed, parseCursor, readCommand, BodyError } from "./protocol.js";
import { ConnectorClient, HttpError } from "./transport.js";

// One upstream pump per node/security domain, independent of browser count.
export function createHub(
  client: ConnectorClient,
  token: string,
  capacity = 128,
  retryMs = 30,
) {
  const feed = new Feed(capacity);
  let connection: "connecting" | "live" | "recovering" | "denied" | "stopped" =
    "connecting";
  let initialized = false;
  let controller: AbortController | undefined;
  let task: Promise<void> | undefined;
  const metrics = {
    connections: 0,
    snapshots: 0,
    reconnects: 0,
    duplicates: 0,
  };
  const app = new Hono();
  app.onError(
    (error) =>
      new Response(null, {
        status:
          error instanceof HttpError || error instanceof BodyError
            ? error.status
            : 502,
      }),
  );
  app.use("*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${token}`)
      return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  app.get("/snapshot", (c) =>
    initialized
      ? c.json({ ...feed.snapshot(), connection })
      : c.json({ error: "not ready" }, 503),
  );
  app.get("/events", (c) => {
    if (!initialized) return c.json({ error: "not ready" }, 503);
    let cursor;
    try {
      cursor = parseCursor(c.req.header("last-event-id") ?? "");
    } catch {
      return c.json({ error: "invalid cursor" }, 400);
    }
    if (!feed.valid(cursor)) return c.json({ error: "resync required" }, 410);
    return new Response(feed.open(cursor, c.req.raw.signal), {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  });
  app.post("/commands", async (c) => {
    const command = await readCommand(c.req.raw);
    if (!initialized || c.req.header("if-match") !== feed.cursor.epoch)
      return c.json({ error: "epoch changed" }, 409);
    return c.json(await client.send(command, c.req.raw.signal), 202);
  });
  app.get("/receipts/:id", async (c) =>
    c.json(await client.receipt(c.req.param("id"), c.req.raw.signal)),
  );
  async function loop(signal: AbortSignal) {
    let attempt = 0;
    let needSnapshot = !initialized;
    while (!signal.aborted) {
      try {
        if (needSnapshot) {
          const snapshot = await client.snapshot(signal);
          feed.reset(snapshot);
          initialized = true;
          needSnapshot = false;
          metrics.snapshots++;
        }
        metrics.connections++;
        for await (const event of client.events(feed.cursor, signal, () => {
          connection = "live";
        })) {
          if (
            event.cursor.epoch === feed.cursor.epoch &&
            event.cursor.seq <= feed.cursor.seq
          ) {
            metrics.duplicates++;
            continue;
          }
          if (
            event.cursor.epoch !== feed.cursor.epoch ||
            event.cursor.seq !== feed.cursor.seq + 1
          ) {
            needSnapshot = true;
            throw new Error("Gap");
          }
          feed.accept(event);
          connection = "live";
          attempt = 0;
        }
      } catch (error) {
        if (signal.aborted) break;
        if (
          error instanceof HttpError &&
          (error.status === 401 || error.status === 403)
        ) {
          connection = "denied";
          initialized = false;
          feed.close();
          return;
        }
        if (error instanceof HttpError && error.status === 410)
          needSnapshot = true;
        connection = "recovering";
        metrics.reconnects++;
        try {
          await delay(
            Math.min(1000, retryMs * 2 ** Math.min(attempt++, 5)) +
              Math.random() * retryMs,
            undefined,
            { signal },
          );
        } catch {
          break;
        }
      }
    }
  }
  return {
    app,
    feed,
    metrics,
    get connection() {
      return connection;
    },
    start() {
      if (controller) return;
      controller = new AbortController();
      connection = "connecting";
      task = loop(controller.signal);
    },
    async stop() {
      controller?.abort();
      await task;
      feed.close();
      controller = undefined;
      task = undefined;
      connection = "stopped";
    },
  };
}
