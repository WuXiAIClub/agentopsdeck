import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { getEventListeners } from "node:events";
import { createConnector } from "./connector.js";
import { createHub } from "./hub.js";
import { ConnectorClient, boundedDispatch, HttpError } from "./transport.js";
import {
  Feed,
  cursorId,
  encoder,
  type Change,
  type Dispatch,
} from "./protocol.js";
import { fixture, listen, until } from "./fixture.js";

for (const mode of ["local", "http"] as const) {
  test(
    `${mode}: browser HTTP → Hub → Connector, ordered final, one upstream for 12 browsers`,
    { timeout: 10000 },
    async (t) => {
      const node = await fixture(mode);
      t.after(() => node.close());
      const hub = createHub(node.client, "fixture-browser-key");
      hub.start();
      t.after(() => hub.stop());
      await until(() => hub.connection === "live");
      const server = await listen((request) => hub.app.fetch(request));
      t.after(() => server.close());
      const browser = new ConnectorClient(
        (request) => fetch(request),
        server.origin,
        "fixture-browser-key",
      );
      const snapshot = await browser.snapshot();
      const watchers = Array.from({ length: 12 }, () => {
        const abort = new AbortController();
        const events: Change[] = [];
        const task = (async () => {
          try {
            for await (const event of browser.events(
              snapshot.cursor,
              abort.signal,
            ))
              events.push(event);
          } catch (error) {
            if (!abort.signal.aborted) throw error;
          }
        })();
        return { abort, events, task };
      });
      t.after(async () => {
        for (const w of watchers) w.abort.abort();
        await Promise.all(watchers.map((w) => w.task));
      });
      await until(() => hub.feed.consumers.size === 12);
      assert.equal((await node.control("stats")).streams, 1);
      await browser.send({ id: "first", text: "相同内容 🐟" });
      await browser.send({ id: "second", text: "相同内容 🐟" });
      await until(() => watchers.every((w) => w.events.length === 6));
      for (const w of watchers) {
        assert.deepEqual(
          w.events.map((e) => e.kind),
          [
            "running",
            "message",
            "completed",
            "running",
            "message",
            "completed",
          ],
        );
        assert.deepEqual(
          w.events.map((e) => e.cursor.seq),
          [1, 2, 3, 4, 5, 6],
        );
      }
      assert.equal((await browser.receipt("second")).status, "completed");
      assert.deepEqual(
        (await browser.snapshot()).state.messages.map((m) => m.id),
        ["first", "second"],
      );
      for (const w of watchers) w.abort.abort();
      await Promise.all(watchers.map((w) => w.task));
      await until(() => hub.feed.consumers.size === 0);
      assert.equal(hub.feed.activeTimers, 0);
      assert.equal(hub.metrics.snapshots, 1);
      assert.equal(hub.metrics.connections, 1);
    },
  );

  test(
    `${mode}: authorization on every route; no anonymous handler access`,
    { timeout: 6000 },
    async (t) => {
      const node = await fixture(mode);
      t.after(() => node.close());
      const hub = createHub(node.client, "fixture-browser-key");
      for (const [dispatch, origin] of [
        [node.dispatch, node.client.origin],
        [hub.app.fetch.bind(hub.app), "http://hub.invalid"],
      ] as const) {
        for (const [path, method] of [
          ["/snapshot", "GET"],
          ["/events", "GET"],
          ["/receipts/a", "GET"],
          ["/commands", "POST"],
        ]) {
          const response = await dispatch(
            new Request(`${origin}${path}`, { method }),
          );
          assert.equal(response.status, 401);
          await response.body?.cancel();
        }
      }
      assert.equal((await node.control("stats")).executions, 0);
    },
  );

  test(
    `${mode}: accepted response lost → retry same identity once; changed payload rejected`,
    { timeout: 6000 },
    async (t) => {
      const node = await fixture(mode);
      t.after(() => node.close());
      let lose = true;
      const client = new ConnectorClient(
        async (request) => {
          const response = await node.dispatch(request);
          if (new URL(request.url).pathname === "/commands" && lose) {
            lose = false;
            await response.arrayBuffer();
            throw new Error("Injected lost ACK");
          }
          return response;
        },
        node.client.origin,
        "fixture-node-key",
      );
      const receipt = await client.send({ id: "retry", text: "one execution" });
      assert.equal(receipt.id, "retry");
      assert.equal(client.metrics.retries, 1);
      await assert.rejects(
        client.send({ id: "retry", text: "changed" }),
        (error) => error instanceof HttpError && error.status === 409,
      );
      assert.equal((await node.control("stats")).executions, 1);
    },
  );

  test(
    `${mode}: snapshot/subscribe gap replays; expired cursor resnapshots`,
    { timeout: 6000 },
    async (t) => {
      const node = await fixture(mode);
      t.after(() => node.close());
      const snapshot = await node.client.snapshot();
      await node.control("burst", 3);
      const abort = new AbortController();
      const events = node.client.events(snapshot.cursor, abort.signal);
      for (let n = 1; n <= 3; n++)
        assert.equal((await events.next()).value?.cursor.seq, n);
      await events.return(undefined);
      const hub = createHub(node.client, "fixture-browser-key");
      hub.start();
      t.after(() => hub.stop());
      await until(() => hub.connection === "live");
      await hub.stop();
      await node.control("burst", 40);
      hub.start();
      await until(
        () => hub.connection === "live" && hub.feed.cursor.seq === 43,
      );
      assert.equal(hub.metrics.snapshots, 2);
      assert.equal((await node.control("stats")).log, 32);
    },
  );

  test(
    `${mode}: 40 abort/cancel cycles release upstream streams and timers`,
    { timeout: 10000 },
    async (t) => {
      const node = await fixture(mode);
      t.after(() => node.close());
      const snapshot = await node.client.snapshot();
      const dispatch = boundedDispatch(node.dispatch, 1000);
      for (let n = 0; n < 40; n++) {
        const abort = new AbortController();
        const response = await dispatch(
          new Request(`${node.client.origin}/events`, {
            signal: abort.signal,
            headers: {
              authorization: "Bearer fixture-node-key",
              "last-event-id": cursorId(snapshot.cursor),
            },
          }),
        );
        const reader = response.body!.getReader();
        assert.equal((await reader.read()).done, false);
        if (n % 2) await reader.cancel();
        else {
          abort.abort();
          await assert.rejects(reader.read());
        }
        reader.releaseLock();
      }
      await until(async () => (await node.control("stats")).streams === 0);
      const stats = await node.control("stats");
      assert.equal(stats.opened, stats.closed);
      assert.equal(stats.timers, 0);
    },
  );
}

test(
  "HTTP outage keeps last running fact; one reconnect recovers missed terminal events",
  { timeout: 8000 },
  async (t) => {
    const node = await fixture("http");
    t.after(() => node.close());
    let offline = false;
    const client = new ConnectorClient(
      (request) => {
        if (offline) throw new Error("Offline");
        return node.dispatch(request);
      },
      node.client.origin,
      "fixture-node-key",
    );
    const hub = createHub(client, "fixture-browser-key");
    hub.start();
    t.after(() => hub.stop());
    await until(() => hub.connection === "live");
    await node.control("running");
    await until(() => hub.feed.state.status === "running");
    offline = true;
    await node.control("cut");
    await until(() => hub.connection === "recovering");
    assert.equal(hub.feed.state.status, "running");
    await node.control("burst", 2);
    offline = false;
    await until(
      () => hub.connection === "live" && hub.feed.state.status === "idle",
    );
    assert.equal(hub.metrics.snapshots, 1); // resumed from cursor, not full-history polling
    assert.equal((await node.control("stats")).streams, 1);
  },
);

test(
  "process epoch change fences an uncertain command retry, then feed resnapshots",
  { timeout: 8000 },
  async (t) => {
    const node = await fixture("http");
    t.after(() => node.close());
    let lose = true;
    const client = new ConnectorClient(
      async (request) => {
        const response = await node.dispatch(request);
        if (new URL(request.url).pathname === "/commands" && lose) {
          lose = false;
          await response.arrayBuffer();
          await node.control("restart");
          throw new Error("Lost ACK + restart");
        }
        return response;
      },
      node.client.origin,
      "fixture-node-key",
    );
    await assert.rejects(
      client.send({ id: "uncertain", text: "do not replay after restart" }),
      (e) => e instanceof HttpError && e.status === 409,
    );
    assert.equal((await node.control("stats")).executions, 0);
    const hub = createHub(node.client, "fixture-browser-key");
    hub.start();
    t.after(() => hub.stop());
    await until(() => hub.connection === "live");
    const epoch = hub.feed.cursor.epoch;
    await node.control("restart");
    await until(
      () => hub.connection === "live" && hub.feed.cursor.epoch !== epoch,
    );
    assert.equal(hub.metrics.snapshots, 2);
  },
);

test("bounded shared log evicts slow stream without affecting an active reader", async () => {
  const feed = new Feed(4, 100);
  const slow = feed
    .open({ ...feed.cursor }, new AbortController().signal)
    .getReader();
  const fast = feed
    .open({ ...feed.cursor }, new AbortController().signal)
    .getReader();
  await fast.read();
  for (let n = 0; n < 10; n++) {
    feed.append("completed", `e${n}`);
    await fast.read();
  }
  await assert.rejects(slow.read(), /Resync/);
  assert.equal(feed.log.length, 4);
  assert.equal(feed.consumers.size, 1);
  assert.equal(feed.metrics.slow, 1);
  await fast.cancel();
  slow.releaseLock();
  fast.releaseLock();
  assert.equal(feed.activeTimers, 0);
});

test(
  "deadline covers stalled headers, idle stream body, and caller cancellation",
  { timeout: 2000 },
  async () => {
    await assert.rejects(
      boundedDispatch(
        () => new Promise(() => {}),
        20,
      )(new Request("http://test.invalid")),
      /Deadline/,
    );
    let cancelled = 0;
    const raw: Dispatch = () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
      );
    const response = await boundedDispatch(
      raw,
      20,
      true,
    )(new Request("http://test.invalid"));
    await assert.rejects(response.text(), /Deadline/);
    assert.equal(cancelled, 1);
    const abort = new AbortController();
    abort.abort();
    let calls = 0;
    await assert.rejects(
      boundedDispatch(() => {
        calls++;
        return new Response();
      }, 20)(new Request("http://test.invalid", { signal: abort.signal })),
    );
    assert.equal(calls, 0);
  },
);

test("fragmented UTF-8 SSE preserves data; oversized frame is cancelled", async () => {
  const event: Change = {
    cursor: { epoch: "test", seq: 1 },
    kind: "message",
    id: "m",
    text: "你好🐟",
  };
  const bytes = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
  let offset = 0;
  let cancelled = 0;
  const client = new ConnectorClient(
    () =>
      new Response(
        new ReadableStream(
          {
            pull(c) {
              if (offset < bytes.length)
                c.enqueue(bytes.slice(offset, ++offset));
              else c.close();
            },
            cancel() {
              cancelled++;
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "text/event-stream" } },
      ),
    "http://test.invalid",
    "fake",
  );
  for await (const row of client.events(
    { epoch: "test", seq: 0 },
    new AbortController().signal,
  )) {
    assert.deepEqual(row, event);
    break;
  }
  assert.equal(cancelled, 1);
  const bad = new ConnectorClient(
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode("x".repeat(17000)));
          },
          cancel() {
            cancelled++;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    "http://test.invalid",
    "fake",
  );
  await assert.rejects(
    bad.events({ epoch: "test", seq: 0 }, new AbortController().signal).next(),
    /Frame too large/,
  );
  assert.equal(cancelled, 2);
});

test(
  "bounded command admissions and accepted command survives client disconnect",
  { timeout: 3000 },
  async () => {
    const node = createConnector({ token: "fake", maxCommands: 1, runMs: 40 });
    const client = new ConnectorClient(
      (request) => node.app.fetch(request),
      "http://test.invalid",
      "fake",
    );
    try {
      const abort = new AbortController();
      await client.send(
        { id: "accepted", text: "finish without browser" },
        abort.signal,
      );
      abort.abort();
      await until(
        () =>
          node.stats().executions === 1 && node.feed.state.status === "idle",
      );
      assert.equal((await client.receipt("accepted")).status, "completed");
      await assert.rejects(
        client.send({ id: "over-budget", text: "" }),
        (e) => e instanceof HttpError && e.status === 503,
      );
      assert.equal(node.stats().receipts, 1);
      const oversized = await node.app.fetch(
        new Request("http://test.invalid/commands", {
          method: "POST",
          headers: { authorization: "Bearer fake" },
          body: "x".repeat(9000),
        }),
      );
      assert.equal(oversized.status, 413);
    } finally {
      node.close();
    }
  },
);

test(
  "idle heartbeats maintain health without snapshot polling; auth rejection does not retry",
  { timeout: 2000 },
  async (t) => {
    const node = await fixture("local");
    t.after(() => node.close());
    const hub = createHub(node.client, "fixture-browser-key");
    hub.start();
    t.after(() => hub.stop());
    await until(() => hub.connection === "live");
    await delay(250);
    assert.equal(hub.metrics.connections, 1);
    assert.equal(hub.metrics.snapshots, 1);
    assert.equal(node.client.metrics.requests, 2);
    const deniedClient = new ConnectorClient(
      (request) => node.dispatch(request),
      node.client.origin,
      "wrong",
    );
    const denied = createHub(deniedClient, "fixture-browser-key");
    denied.start();
    t.after(() => denied.stop());
    await until(() => denied.connection === "denied");
    await delay(80);
    assert.equal(deniedClient.metrics.requests, 1);
  },
);

test("64-stream admission limit, recent projection budget, and graceful shutdown cleanup", async () => {
  const feed = new Feed(8);
  const readers = Array.from({ length: 64 }, () =>
    feed.open({ ...feed.cursor }, new AbortController().signal).getReader(),
  );
  assert.throws(
    () => feed.open({ ...feed.cursor }, new AbortController().signal),
    /503/,
  );
  feed.close();
  assert.equal(feed.consumers.size, 0);
  assert.equal(feed.activeTimers, 0);
  for (const reader of readers) {
    await reader.cancel();
    reader.releaseLock();
  }
  for (let n = 0; n < 100; n++) feed.append("message", `m${n}`, "same text");
  assert.equal(feed.state.messages.length, 64);
  assert.equal(feed.state.messages[0].id, "m36");
  assert.equal(feed.log.length, 8);
});

test(
  "slow upload cancellation, late response cleanup and abort listener ownership",
  { timeout: 3000 },
  async () => {
    const node = createConnector({ token: "fake" });
    try {
      let bodyCancelled = 0;
      const abort = new AbortController();
      const request = new Request("http://test.invalid/commands", {
        method: "POST",
        signal: abort.signal,
        headers: { authorization: "Bearer fake" },
        duplex: "half",
        body: new ReadableStream({
          cancel() {
            bodyCancelled++;
          },
        }),
      } as RequestInit);
      const result = node.app.fetch(request);
      abort.abort();
      await result;
      assert.equal(bodyCancelled, 1);
      assert.equal(node.stats().executions, 0);
      assert.equal(getEventListeners(request.signal, "abort").length, 0);
      let responseCancelled = 0;
      const late = boundedDispatch(async () => {
        await delay(40);
        return new Response(
          new ReadableStream({
            cancel() {
              responseCancelled++;
            },
          }),
        );
      }, 10);
      const lateRequest = new Request("http://test.invalid");
      await assert.rejects(late(lateRequest), /Deadline/);
      await until(() => responseCancelled === 1);
      assert.equal(getEventListeners(lateRequest.signal, "abort").length, 0);
      const okRequest = new Request("http://test.invalid");
      await (
        await boundedDispatch(() => new Response("ok"), 50)(okRequest)
      ).text();
      assert.equal(getEventListeners(okRequest.signal, "abort").length, 0);
    } finally {
      node.close();
    }
  },
);

test("malformed upstream event cannot silently turn running into idle", async () => {
  let cancelled = false;
  const client = new ConnectorClient(
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(
              encoder.encode(
                'data: {"cursor":{"epoch":"test","seq":1},"kind":"unknown","id":"x"}\n\n',
              ),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    "http://test.invalid",
    "fake",
  );
  await assert.rejects(
    client
      .events({ epoch: "test", seq: 0 }, new AbortController().signal)
      .next(),
    /Invalid event/,
  );
  assert.equal(cancelled, true);
});

test(
  "upstream authorization denial after reconnect closes cached subscriptions",
  { timeout: 3000 },
  async (t) => {
    const node = await fixture("local");
    t.after(() => node.close());
    let denied = false;
    const client = new ConnectorClient(
      (request) =>
        denied ? new Response(null, { status: 403 }) : node.dispatch(request),
      node.client.origin,
      "fixture-node-key",
    );
    const hub = createHub(client, "fixture-browser-key");
    hub.start();
    t.after(() => hub.stop());
    await until(() => hub.connection === "live");
    const stream = hub.feed
      .open({ ...hub.feed.cursor }, new AbortController().signal)
      .getReader();
    await stream.read();
    denied = true;
    node.connector!.feed.close();
    await until(() => hub.connection === "denied");
    assert.equal((await stream.read()).done, true);
    stream.releaseLock();
    assert.equal(hub.feed.consumers.size, 0);
    assert.equal(hub.feed.activeTimers, 0);
    const response = await hub.app.fetch(
      new Request("http://hub.invalid/snapshot", {
        headers: { authorization: "Bearer fixture-browser-key" },
      }),
    );
    assert.equal(response.status, 503);
    await response.body?.cancel();
  },
);

test(
  "heartbeats refresh idle deadline without periodic stream replacement",
  { timeout: 2000 },
  async () => {
    const node = createConnector({ token: "fake", heartbeatMs: 10 });
    const client = new ConnectorClient(
      (request) => node.app.fetch(request),
      "http://node.invalid",
      "fake",
      1000,
      100,
    );
    const hub = createHub(client, "fixture-browser-key");
    hub.start();
    try {
      await until(() => hub.connection === "live");
      await delay(250);
      assert.equal(hub.connection, "live");
      assert.equal(hub.metrics.connections, 1);
      assert.equal(client.metrics.requests, 2);
    } finally {
      await hub.stop();
      node.close();
    }
  },
);
