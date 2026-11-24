import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createConnector } from "./connector.js";
import { ConnectorClient } from "./transport.js";
import type { Dispatch } from "./protocol.js";

export async function until(
  check: () => boolean | Promise<boolean>,
  ms = 3000,
) {
  const deadline = performance.now() + ms;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error("Condition timed out");
    await delay(5);
  }
}
export async function listen(fetch: Dispatch) {
  const sockets = new Set<Socket>();
  const server = serve({ fetch, hostname: "127.0.0.1", port: 0 });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
export async function fixture(mode: "local" | "http") {
  if (mode === "local") {
    const connector = createConnector({
      token: "fixture-node-key",
      capacity: 32,
      maxCommands: 2000,
      runMs: 4,
      heartbeatMs: 100,
    });
    const dispatch: Dispatch = (request) => connector.app.fetch(request);
    return {
      dispatch,
      client: new ConnectorClient(
        dispatch,
        "http://connector.invalid",
        "fixture-node-key",
      ),
      control: async (action: string, count = 1): Promise<any> => {
        if (action === "burst")
          for (let n = 0; n < count; n++)
            connector.feed.append("completed", `burst-${n}`);
        return {
          ...connector.stats(),
          log: connector.feed.log.length,
          memory: process.memoryUsage(),
          cpu: process.cpuUsage(),
        };
      },
      close: async () => {
        connector.close();
      },
      connector,
    };
  }
  const worker = fork(
    fileURLToPath(new URL("./connector-worker.ts", import.meta.url)),
    [],
    {
      execArgv: ["--import", import.meta.resolve("tsx")],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      // Do not pass real app configuration to the isolated worker.
      env: { PATH: process.env.PATH },
    },
  );
  let errors = "";
  worker.stderr?.on("data", (chunk) => {
    errors = (errors + String(chunk)).slice(-4096);
  });
  let sequence = 0;
  const pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const ready = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.kill();
      reject(new Error(`Worker timeout: ${errors}`));
    }, 5000);
    worker.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.on("message", (message: any) => {
      if (message.ready) {
        clearTimeout(timer);
        resolve(message.origin);
        return;
      }
      const row = pending.get(message.id);
      if (row) {
        clearTimeout(row.timer);
        pending.delete(message.id);
        row.resolve(message.value);
      }
    });
    worker.on("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Worker exited: ${errors}`));
      for (const row of pending.values()) {
        clearTimeout(row.timer);
        row.reject(new Error("Worker exited"));
      }
      pending.clear();
    });
  });
  const origin = await ready;
  const dispatch: Dispatch = (request) => fetch(request);
  return {
    dispatch,
    client: new ConnectorClient(dispatch, origin, "fixture-node-key"),
    control: (action: string, count?: number): Promise<any> =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("IPC timeout"));
        }, 2000);
        pending.set(id, { resolve, reject, timer });
        worker.send({ id, action, count });
      }),
    close: async () => {
      if (worker.exitCode !== null || worker.signalCode) return;
      const exit = once(worker, "exit");
      worker.kill();
      await exit;
    },
    connector: undefined,
  };
}
