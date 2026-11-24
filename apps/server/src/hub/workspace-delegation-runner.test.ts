import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DelegationStore } from "./workspace-delegation-store.js";
import { DelegationRunner, type DelegationAdapter } from "./workspace-delegation-runner.js";
import { delegationBindingAdapter, type DelegationAuthority } from "./workspace-delegation-binding-adapter.js";
import type { DelegationPreviewInput } from "./workspace-delegation-preview.js";
import { WorkspaceBoards } from "./workspace-boards.js";
import { WorkspaceBoardCapabilities } from "./workspace-board-capabilities.js";
import { HubBoardBindings } from "./workspace-board-bindings.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(count = 2) {
  const db = new DatabaseSync(":memory:"), store = new DelegationStore(db), batchId = randomUUID(), taskId = randomUUID();
  const source: DelegationPreviewInput = { owner: "alice", catalog: { owner: "alice", generation: 1, preferencesRevision: 1, complete: true,
    members: Array.from({ length: count }, (_, n) => ({ owner: "alice", nodeId: "node", connectionId: "connection", runtime: "codex",
      sessionId: `s${n}`, authorityEpoch: 1, groupId: "project", tags: ["dev"], taskBinding: "supported" })) },
    selection: { tags: ["dev"], tagMode: "all" },
    board: { resourceId: "default", revision: 1, title: "Tasks", tasks: [{ id: taskId, title: "Selected", detail: "", status: "todo" }] },
    taskIds: [taskId], fields: ["status"] };
  const batch = store.prepare("alice", batchId, source, Date.now() + 60_000); store.confirm("alice", batchId, source);
  let installs = 0, queries = 0, cancels = 0;
  const adapter: DelegationAdapter = {
    authorize: intent => intent.owner === "alice" && intent.member.authorityEpoch === source.catalog.members[0]!.authorityEpoch,
    install: async (intent, fence) => {
      assert.equal(fence(), true); installs++; return { requestId: intent.requestId, state: "installed", bindingId: randomUUID() };
    },
    query: async intent => { queries++; return { requestId: intent.requestId, state: "unknown" }; },
    cancel: async () => { cancels++; return "revoked"; },
  };
  return { db, store, source, batch, batchId, adapter, runner: new DelegationRunner(store, adapter),
    get installs() { return installs; }, get queries() { return queries; }, get cancels() { return cancels; },
    close: () => db.close() };
}

test("coordinator performs bounded partial results and repeated run never duplicates completed members", async () => {
  const f = fixture(8);
  try {
    let active = 0, maximum = 0; const original = f.adapter.install;
    f.adapter.install = async (intent, fence) => {
      maximum = Math.max(maximum, ++active); await Promise.resolve();
      try { return intent.member.sessionId === "s1" ? { requestId: intent.requestId, state: "rejected" } : await original(intent, fence); }
      finally { active--; }
    };
    const result = await f.runner.run("alice", f.batchId);
    assert.equal(result!.members.filter(m => m.state === "installed").length, 7);
    assert.equal(result!.members.filter(m => m.state === "rejected").length, 1);
    assert.equal(maximum, 4); assert.equal(f.installs, 7);
    await f.runner.run("alice", f.batchId); assert.equal(f.installs, 7);
    assert.equal(await f.runner.run("bob", f.batchId), undefined);
  } finally { f.close(); }
});
test("overlapping runners cannot dispatch the same request twice", async () => {
  const f = fixture(6), gate = deferred();
  try {
    const original = f.adapter.install;
    f.adapter.install = async (intent, fence) => { await gate.promise; return original(intent, fence); };
    const first = f.runner.run("alice", f.batchId);
    const second = new DelegationRunner(f.store, f.adapter).run("alice", f.batchId);
    assert.equal(f.store.read("alice", f.batchId)!.members.filter(m => m.state === "dispatching").length, 4);
    gate.resolve(); await Promise.all([first, second]);
    await f.runner.run("alice", f.batchId); assert.equal(f.installs, 6);
  } finally { gate.resolve(); f.close(); }
});
test("lost response stays unknown; reconciliation uses original request and never installs", async () => {
  const f = fixture(1); let attempts = 0; const bindingId = randomUUID();
  try {
    f.adapter.install = async () => { attempts++; throw new Error("PRIVATE provider failure"); };
    await f.runner.run("alice", f.batchId); await f.runner.run("alice", f.batchId);
    assert.equal(attempts, 1); assert.equal(f.store.read("alice", f.batchId)!.members[0]!.state, "unknown");
    assert.ok(!JSON.stringify(f.store.read("alice", f.batchId)).includes("PRIVATE"));
    await f.runner.reconcile("alice", f.batchId); assert.equal(f.queries, 1);
    f.adapter.query = async intent => {
      assert.equal(intent.requestId, f.batch.members[0]!.requestId);
      return { requestId: intent.requestId, state: "installed", bindingId };
    };
    await f.runner.reconcile("alice", f.batchId);
    assert.equal(f.store.read("alice", f.batchId)!.members[0]!.bindingId, bindingId); assert.equal(attempts, 1);
  } finally { f.close(); }
});
test("a mismatched or invalid outcome never settles a different member", async () => {
  for (const malformed of ["wrong-request", "bad-binding"] as const) {
    const f = fixture(1);
    try {
      f.adapter.install = async intent => ({ requestId: malformed === "wrong-request" ? randomUUID() : intent.requestId,
        state: "installed", bindingId: malformed === "bad-binding" ? "credential-not-an-id" : randomUUID() });
      await f.runner.run("alice", f.batchId);
      assert.equal(f.store.read("alice", f.batchId)!.members[0]!.state, "unknown");
      assert.ok(!JSON.stringify(f.store.read("alice", f.batchId)).includes("credential-not-an-id"));
    } finally { f.close(); }
  }
});
test("current authority is checked both at claim and after an asynchronous preflight", async () => {
  const f = fixture(1), gate = deferred(); let nativeWrites = 0;
  try {
    f.adapter.install = async (intent, fence) => {
      await gate.promise;
      if (!fence()) return { requestId: intent.requestId, state: "rejected" };
      nativeWrites++; return { requestId: intent.requestId, state: "installed", bindingId: randomUUID() };
    };
    const running = f.runner.run("alice", f.batchId); f.source.catalog.members[0]!.authorityEpoch++;
    gate.resolve(); await running;
    assert.equal(nativeWrites, 0); assert.equal(f.store.read("alice", f.batchId)!.members[0]!.state, "rejected");
  } finally { gate.resolve(); f.close(); }
});
test("cancel during the await gap fences unsent install and cannot revive after late receipt", async () => {
  const f = fixture(1), gate = deferred(); let writes = 0;
  try {
    f.adapter.install = async (intent, fence) => {
      await gate.promise; if (fence()) writes++;
      return { requestId: intent.requestId, state: "unknown" };
    };
    const running = f.runner.run("alice", f.batchId); await f.runner.cancel("alice", f.batchId);
    gate.resolve(); await running;
    assert.equal(writes, 0); assert.equal(f.cancels, 1);
    assert.equal(f.store.read("alice", f.batchId)!.members[0]!.state, "revoked");
  } finally { gate.resolve(); f.close(); }
});
test("failed remote cleanup stays pending and retries only cancellation of the same request", async () => {
  const f = fixture(1); const ids: string[] = [];
  try {
    await f.runner.run("alice", f.batchId);
    f.adapter.cancel = async intent => { ids.push(intent.requestId); throw new Error("offline"); };
    assert.equal((await f.runner.cancel("alice", f.batchId))!.members[0]!.state, "cleanup_pending");
    await f.runner.run("alice", f.batchId); await f.runner.reconcile("alice", f.batchId);
    assert.equal(f.installs, 1); assert.equal(f.queries, 0);
    f.adapter.cancel = async intent => { ids.push(intent.requestId); return "revoked"; };
    assert.equal((await f.runner.cancel("alice", f.batchId))!.members[0]!.state, "revoked");
    assert.deepEqual(ids, [f.batch.members[0]!.requestId, f.batch.members[0]!.requestId]);
  } finally { f.close(); }
});
test("worker failure waits for already-started I/O before reporting incomplete execution", async () => {
  const f = fixture(6), gate = deferred(); let finished = false;
  try {
    const original = f.adapter.install;
    f.adapter.install = async (intent, fence) => { await gate.promise; return original(intent, fence); };
    f.adapter.authorize = intent => {
      if (intent.member.sessionId === "s1") throw new Error("catalog temporarily unavailable"); return true;
    };
    const running = f.runner.run("alice", f.batchId).then(() => { finished = true; }, error => {
      finished = true; assert.match(error.message, /incomplete/);
    });
    await Promise.resolve(); await Promise.resolve(); assert.equal(finished, false);
    gate.resolve(); await running; assert.equal(finished, true);
    // The first four workers started together before the rejected promise was
    // observed. Drain those three valid writes; do not start members five/six.
    assert.equal(f.installs, 3);
    assert.ok(f.store.read("alice", f.batchId)!.members.slice(4).every(m => m.state === "prepared"));
  } finally { gate.resolve(); f.close(); }
});
test("binding adapter rejects stale identities, removed tasks and expanded fields but does not use group as authority", () => {
  const f = fixture(1);
  try {
    const intent = f.store.intent(f.batch, f.batch.members[0]!);
    const base: DelegationAuthority = { member: structuredClone(f.source.catalog.members[0]!), board: structuredClone(f.source.board), canGrant: true, fields: ["status"] };
    let evidence = structuredClone(base);
    const unexpected = async (): Promise<never> => { throw new Error("transport must not be called"); };
    const adapter = delegationBindingAdapter({} as HubBoardBindings, "https://hub.example", () => evidence,
      { install: unexpected, query: unexpected, cancel: unexpected });
    assert.equal(adapter.authorize(intent), true);
    const changes: ((a: DelegationAuthority) => void)[] = [
      a => { a.member.owner = "other"; }, a => { a.member.nodeId = "replacement"; },
      a => { a.member.connectionId = "other"; }, a => { a.member.runtime = "other"; },
      a => { a.member.sessionId = "other"; }, a => { a.member.authorityEpoch++; },
      a => { a.member.taskBinding = "unknown"; }, a => { a.canGrant = false; },
      a => { a.board.resourceId = "other"; }, a => { a.board.revision++; },
      a => { a.board.tasks = []; }, a => { a.fields = []; },
    ];
    for (const change of changes) { evidence = structuredClone(base); change(evidence); assert.equal(adapter.authorize(intent), false); }
    evidence = structuredClone(base); evidence.member.groupId = "moved"; evidence.member.tags = ["other"];
    assert.equal(adapter.authorize(intent), true);
  } finally { f.close(); }
});
test("real Hub binding and capability stores preserve scope, lost-response lookup and batch-only revocation", async () => {
  const f = fixture(2), vault = new Map<string, string>();
  try {
    const boards = new WorkspaceBoards(f.db);
    assert.equal(boards.save("alice", "default", { title: f.source.board.title, tasks: f.source.board.tasks, revision: 0, mutationId: randomUUID() }).status, "saved");
    let bindings!: HubBoardBindings;
    const caps = new WorkspaceBoardCapabilities(f.db, boards, Date.now, id => bindings.authorized(id));
    bindings = new HubBoardBindings(f.db, caps, { read: id => vault.get(id), write: (id, value) => { vault.set(id, value); }, remove: id => { vault.delete(id); } },
      true, (connection, owner) => connection === "connection" && owner === "alice" ? 1 : undefined);
    const endpoint = "https://hub.example/api/workspace-agent/v1/board";
    let installations = 0;
    const remoteRequests = new Set<string>();
    Object.assign(f.adapter, delegationBindingAdapter(bindings, endpoint, intent => {
      const member = f.source.catalog.members.find(m => m.sessionId === intent.member.sessionId);
      return member && { member, board: boards.get(intent.owner, intent.boardId), canGrant: true, fields: ["status"] };
    }, {
      install: async (intent, credential, fence) => {
        assert.ok(fence()); assert.ok(caps.authorized(credential.token)); installations++;
        remoteRequests.add(intent.requestId);
        if (intent.member.sessionId === "s0") throw new Error("response lost after commit");
        return "installed";
      },
      query: async intent => remoteRequests.has(intent.requestId) ? "installed" : "unknown",
      cancel: async intent => {
        assert.equal(bindings.credential(intent.owner, intent.boardId, intent.requestId), undefined);
        // Synthetic transport confirms request fencing and remote cleanup.
        remoteRequests.delete(intent.requestId); return "revoked";
      },
    }));
    const otherBatch = randomUUID();
    const prepared = f.store.prepare("alice", otherBatch, f.source, f.batch.grantExpiresAt); f.store.confirm("alice", otherBatch, f.source);
    await f.runner.run("alice", f.batchId); await f.runner.run("alice", otherBatch);
    assert.equal(installations, 4); assert.equal(caps.list("alice", "default").length, 4);
    await f.runner.reconcile("alice", f.batchId);
    assert.ok(f.store.read("alice", f.batchId)!.members.every(m => m.state === "installed"));
    // A late timeout from the original install must not undo query evidence.
    bindings.outcome("alice", "default", f.batch.members[0]!.requestId, "uncertain", true);
    assert.equal(bindings.get("alice", "default", f.batch.members[0]!.requestId)!.state, "installed");
    await f.runner.run("alice", f.batchId); assert.equal(installations, 4);
    const otherCredential = bindings.credential("alice", "default", prepared.members[0]!.requestId)!;
    assert.ok(caps.authorized(otherCredential.token));
    assert.ok(!JSON.stringify(f.store.read("alice", otherBatch)).includes(otherCredential.token));
    await f.runner.cancel("alice", f.batchId);
    for (const member of f.batch.members) {
      assert.equal(bindings.get("alice", "default", member.requestId)!.state, "revoked");
      assert.equal(bindings.credential("alice", "default", member.requestId), undefined);
    }
    assert.ok(caps.authorized(otherCredential.token));
    assert.equal(caps.update(otherCredential.token, { revision: 1, mutationId: randomUUID(), tasks: [{ id: f.source.taskIds[0]!, detail: "not granted" }] }).status, "denied");
    assert.equal(caps.update(otherCredential.token, { revision: 1, mutationId: randomUUID(), tasks: [{ id: f.source.taskIds[0]!, status: "doing" }] }).status, "saved");
  } finally { f.close(); }
});
