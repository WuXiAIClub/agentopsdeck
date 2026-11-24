import { serve } from "@hono/node-server";
import type { Socket } from "node:net";
import { createConnector } from "./connector.js";

// Spawned by fixtures only; loopback ephemeral port, synthetic credentials, no files/runtime.
let connector = createConnector({
  token: "fixture-node-key",
  capacity: 32,
  maxCommands: 2000,
  runMs: 4,
  heartbeatMs: 100,
});
const sockets = new Set<Socket>();
const server = serve(
  {
    fetch: (request) => connector.app.fetch(request),
    hostname: "127.0.0.1",
    port: 0,
  },
  (info) => {
    process.send?.({ ready: true, origin: `http://127.0.0.1:${info.port}` });
  },
);
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
process.on(
  "message",
  (message: { id: number; action: string; count?: number }) => {
    if (message.action === "cut" || message.action === "restart")
      for (const socket of sockets) socket.destroy();
    if (message.action === "restart") {
      connector.close();
      connector = createConnector({
        token: "fixture-node-key",
        capacity: 32,
        maxCommands: 2000,
        runMs: 4,
        heartbeatMs: 100,
      });
    }
    if (message.action === "burst")
      for (let n = 0; n < (message.count ?? 1); n++)
        connector.feed.append("completed", `burst-${n}`);
    if (message.action === "running")
      connector.feed.append("running", "synthetic-running");
    process.send?.({
      id: message.id,
      value: {
        ...connector.stats(),
        log: connector.feed.log.length,
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
      },
    });
  },
);
