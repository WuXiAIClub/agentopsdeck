import assert from "node:assert/strict";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { createHub } from "./hub.js";
import { ConnectorClient, boundedDispatch } from "./transport.js";
import { cursorId } from "./protocol.js";
import { fixture, listen, until } from "./fixture.js";

// Small local baseline, not an internet/TLS throughput benchmark or capacity SLA.
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(
      3,
    ),
  );
};
const cpuMs = (before: NodeJS.CpuUsage, after: NodeJS.CpuUsage) =>
  (after.user + after.system - before.user - before.system) / 1000;
const results = [];
for (const mode of ["local", "http"] as const) {
  for (const browsers of [1, 16]) {
    const node = await fixture(mode);
    const hub = createHub(node.client, "fixture-browser-key");
    const server = await listen((request) => hub.app.fetch(request));
    const browser = new ConnectorClient(
      (request) => fetch(request),
      server.origin,
      "fixture-browser-key",
    );
    const abort = new AbortController();
    const tasks: Promise<void>[] = [];
    const pending = new Map<string, () => void>();
    let received = 0;
    const lag = monitorEventLoopDelay({ resolution: 10 });
    try {
      // Cold startup excluded. Identical authenticated/encoded snapshot path in both modes.
      for (let n = 0; n < 30; n++) await node.client.snapshot();
      const rpc = [];
      for (let n = 0; n < 200; n++) {
        const start = performance.now();
        await node.client.snapshot();
        rpc.push(performance.now() - start);
      }
      hub.start();
      await until(() => hub.connection === "live");
      const snapshot = await browser.snapshot();
      for (let n = 0; n < browsers; n++)
        tasks.push(
          (async () => {
            try {
              for await (const event of browser.events(
                snapshot.cursor,
                abort.signal,
              )) {
                received++;
                if (n === 0 && event.kind === "completed") {
                  pending.get(event.id)?.();
                  pending.delete(event.id);
                }
              }
            } catch (error) {
              if (!abort.signal.aborted) throw error;
            }
          })(),
        );
      await until(() => hub.feed.consumers.size === browsers);
      const initialNode = await node.control("stats");
      const initialCpu = process.cpuUsage();
      const initialMemory = process.memoryUsage();
      const initialBytes = node.client.metrics.eventBytes;
      lag.enable();
      const ack = [],
        final = [];
      const begin = performance.now();
      for (let n = 0; n < 100; n++) {
        const id = `bench-${n}`;
        const finished = new Promise<void>((resolve) =>
          pending.set(id, resolve),
        );
        const start = performance.now();
        await browser.send({ id, text: "x".repeat(256) });
        ack.push(performance.now() - start);
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            finished,
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error("Final timeout")),
                2000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
        final.push(performance.now() - start);
      }
      await until(() => received === 300 * browsers);
      const elapsedMs = performance.now() - begin;
      const endCpu = process.cpuUsage();
      const endMemory = process.memoryUsage();
      lag.disable();
      const endNode = await node.control("stats");
      assert.equal(endNode.streams, 1);
      assert.equal(hub.metrics.snapshots, 1);
      const eventBytes = node.client.metrics.eventBytes - initialBytes;
      const idleRequests = node.client.metrics.requests;
      const idleCpu = process.cpuUsage();
      const idleNode = await node.control("stats");
      await delay(500);
      const idleParentCpuMs = cpuMs(idleCpu, process.cpuUsage());
      const idleEnd = await node.control("stats");
      assert.equal(node.client.metrics.requests, idleRequests);
      const idleExtraRequests = node.client.metrics.requests - idleRequests;
      abort.abort();
      await Promise.all(tasks);
      await hub.stop();
      await until(async () => (await node.control("stats")).streams === 0);
      await until(() => hub.feed.consumers.size === 0);

      // Fixed state, explicit GC if available: short cancellation churn, not a long-run leak proof.
      global.gc?.();
      const churnBefore = process.memoryUsage().heapUsed;
      const cursor = (await node.client.snapshot()).cursor;
      const dispatch = boundedDispatch(node.dispatch, 1000);
      for (let n = 0; n < 300; n++) {
        const response = await dispatch(
          new Request(`${node.client.origin}/events`, {
            headers: {
              authorization: "Bearer fixture-node-key",
              "last-event-id": cursorId(cursor),
            },
          }),
        );
        const reader = response.body!.getReader();
        await reader.read();
        await reader.cancel();
        reader.releaseLock();
      }
      await until(async () => (await node.control("stats")).streams === 0);
      global.gc?.();
      const churnHeapDelta = process.memoryUsage().heapUsed - churnBefore;
      const cleanup = await node.control("stats");
      assert.equal(cleanup.opened, cleanup.closed);
      assert.equal(cleanup.timers, 0);
      results.push({
        mode,
        browsers,
        samples: 100,
        snapshotRpcMs: {
          p50: percentile(rpc, 0.5),
          p95: percentile(rpc, 0.95),
        },
        browserAckMs: { p50: percentile(ack, 0.5), p95: percentile(ack, 0.95) },
        browserFinalMsIncluding4msFakeWork: {
          p50: percentile(final, 0.5),
          p95: percentile(final, 0.95),
        },
        elapsedMs: Number(elapsedMs.toFixed(1)),
        parentCpuMs: cpuMs(initialCpu, endCpu),
        workerCpuMs:
          mode === "http" ? cpuMs(initialNode.cpu, endNode.cpu) : null,
        parentRssDeltaBytes: endMemory.rss - initialMemory.rss,
        workerRssDeltaBytes:
          mode === "http" ? endNode.memory.rss - initialNode.memory.rss : null,
        upstreamStreams: endNode.streams,
        upstreamEventBytes: eventBytes,
        deliveredEvents: received,
        eventLoopP99Ms: Number((lag.percentile(99) / 1e6).toFixed(3)),
        idle500ms: {
          extraRequests: idleExtraRequests,
          parentCpuMs: idleParentCpuMs,
          workerCpuMs:
            mode === "http" ? cpuMs(idleNode.cpu, idleEnd.cpu) : null,
        },
        churn300: {
          parentHeapDeltaBytes: churnHeapDelta,
          streams: cleanup.streams,
          timers: cleanup.timers,
          opened: cleanup.opened,
          closed: cleanup.closed,
        },
      });
    } finally {
      abort.abort();
      await Promise.allSettled(tasks);
      lag.disable();
      await hub.stop();
      await server.close();
      await node.close();
    }
  }
}
console.log(
  JSON.stringify(
    {
      date: new Date().toISOString(),
      node: process.version,
      gcExposed: !!global.gc,
      notes:
        "Loopback, one node/session, 256-byte ASCII messages, 100ms fixture heartbeat; no production runtime/files/config.",
      results,
    },
    null,
    2,
  ),
);
