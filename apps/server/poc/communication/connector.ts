import { Hono } from "hono";
import {
  Feed,
  parseCursor,
  readCommand,
  BodyError,
  type Command,
  type Receipt,
} from "./protocol.js";

export function createConnector(options: {
  token: string;
  capacity?: number;
  maxCommands?: number;
  runMs?: number;
  heartbeatMs?: number;
}) {
  const feed = new Feed(options.capacity, options.heartbeatMs);
  const commands = new Map<string, { text: string; receipt: Receipt }>();
  const queue: Command[] = [];
  let executing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let executions = 0;
  const app = new Hono();
  app.onError(
    (error) =>
      new Response(null, {
        status: error instanceof BodyError ? error.status : 500,
      }),
  );
  app.use("*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${options.token}`)
      return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  app.get("/snapshot", (c) => c.json(feed.snapshot()));
  app.get("/receipts/:id", (c) => {
    const row = commands.get(c.req.param("id"));
    return row ? c.json(row.receipt) : c.json({ error: "not found" }, 404);
  });
  app.post("/commands", async (c) => {
    const command = await readCommand(c.req.raw);
    // A process epoch is not durability. It prevents automatic retry into a new empty inbox.
    if (c.req.header("if-match") !== feed.cursor.epoch)
      return c.json({ error: "epoch changed; outcome unknown" }, 409);
    const old = commands.get(command.id);
    if (old)
      return old.text === command.text
        ? c.json(old.receipt)
        : c.json({ error: "id conflict" }, 409);
    // No silent eviction of receipts: reject admissions at the POC memory budget.
    if (commands.size >= (options.maxCommands ?? 256))
      return c.json({ error: "capacity" }, 503);
    const receipt: Receipt = { id: command.id, status: "accepted" };
    commands.set(command.id, { text: command.text, receipt });
    queue.push(command);
    queueMicrotask(pump);
    return c.json(receipt, 202);
  });
  app.get("/events", (c) => {
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
  function pump() {
    if (executing || !queue.length) return;
    executing = true;
    const command = queue.shift()!;
    executions++;
    feed.append("running", command.id);
    timer = setTimeout(() => {
      feed.append("message", command.id, command.text);
      commands.get(command.id)!.receipt.status = "completed";
      feed.append("completed", command.id);
      executing = false;
      timer = undefined;
      pump();
    }, options.runMs ?? 5);
  }
  return {
    app,
    feed,
    stats: () => ({
      executions,
      queued: queue.length,
      receipts: commands.size,
      streams: feed.consumers.size,
      timers: feed.activeTimers,
      ...feed.metrics,
    }),
    close: () => {
      clearTimeout(timer);
      feed.close();
    },
  };
}
