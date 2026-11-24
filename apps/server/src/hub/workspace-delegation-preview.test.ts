import assert from "node:assert/strict";
import test from "node:test";
import { createDelegationPreview as preview, delegationPreviewCurrent as current, type DelegationPreviewInput } from "./workspace-delegation-preview.js";

const id = "083ba0a5-4a98-4c93-b45e-ce8e62024228";
function fixture(): DelegationPreviewInput {
  return { owner: "alice", catalog: { owner: "alice", generation: 2, preferencesRevision: 3, complete: true,
    members: [{ owner: "alice", nodeId: "node", connectionId: "connector", runtime: "codex", sessionId: "one",
      authorityEpoch: 4, groupId: "project", tags: ["dev", "UI"], taskBinding: "supported" }] },
    selection: { groupId: "project", tags: ["dev"], tagMode: "all" },
    board: { resourceId: id, revision: 5, title: "Board", tasks: [{ id, title: "Selected", detail: "Keep", status: "todo", tags: ["x"], priority: "high", dueDate: "2026-10-07" }] },
    taskIds: [id], fields: ["status"] };
}
test("group and tag intersection yields frozen task-only snapshot, no automatic capabilities", () => {
  const input = fixture(), p = preview(input, 1000);
  assert.equal(p.confirmable, true); assert.equal(p.members.length, 1);
  assert.deepEqual(p.resource.fields, ["status"]); assert.deepEqual(p.resource.tasks, input.board.tasks);
  assert.equal(p.expiresAt, 301000); assert.ok(current(p, input, 1001));
  input.board.tasks[0]!.detail = "Changed"; input.catalog.members[0]!.tags.push("later");
  assert.equal(p.resource.tasks[0]!.detail, "Keep"); assert.deepEqual(p.members[0]!.tags, ["UI", "dev"]);
  assert.throws(() => p.members.push(p.members[0]!), TypeError);
  assert.throws(() => { p.resource.tasks[0]!.detail = "Cannot mutate"; }, TypeError);
});
test("tag all/any and exact case match; group-only allowed and empty selector rejected", () => {
  const i = fixture(); i.selection.tags = ["dev", "missing"];
  assert.equal(preview(i, 0).members.length, 0); i.selection.tagMode = "any";
  assert.equal(preview(i, 0).members.length, 1); i.selection.tags = ["ui"];
  assert.equal(preview(i, 0).members.length, 0); i.selection.tags = [];
  assert.equal(preview(i, 0).members.length, 1); delete i.selection.groupId;
  assert.throws(() => preview(i, 0), /Explicit/);
});
test("zero matches do not fall back to all and cannot be confirmed", () => {
  const i = fixture(); i.selection.groupId = "not-present";
  const p = preview(i, 0); assert.deepEqual(p.members, []); assert.equal(p.confirmable, false); assert.equal(current(p, i, 1), false);
});
test("unsupported or unknown members remain visible and prevent whole-preview confirmation", () => {
  for (const capability of ["unsupported", "unknown"] as const) {
    const i = fixture(); i.catalog.members[0]!.taskBinding = capability;
    const p = preview(i, 0); assert.equal(p.members[0]!.taskBinding, capability); assert.equal(p.confirmable, false);
    assert.equal(current(p, i, 1), false);
  }
});
test("incomplete catalogs and foreign owner entries fail closed even outside matching group", () => {
  const i = fixture(); i.catalog.complete = false; assert.throws(() => preview(i, 0), /Catalog/);
  i.catalog.complete = true; i.catalog.owner = "bob"; assert.throws(() => preview(i, 0), /owner/);
  i.catalog.owner = "alice"; i.catalog.members[0]!.owner = "bob"; i.catalog.members[0]!.groupId = "elsewhere";
  assert.throws(() => preview(i, 0), /member/);
});
test("identical duplicate sessions deduplicate; contradictory authority never silently wins", () => {
  const i = fixture(); i.catalog.members.push(structuredClone(i.catalog.members[0]!));
  assert.equal(preview(i, 0).members.length, 1);
  i.catalog.members[1]!.authorityEpoch++; assert.throws(() => preview(i, 0), /Conflicting/);
});
test("same native session on another node or runtime stays distinct", () => {
  const i = fixture(), m = i.catalog.members[0]!;
  i.catalog.members.push({ ...m, nodeId: "other" }, { ...m, runtime: "claude" });
  assert.equal(preview(i, 0).members.length, 3);
});
test("32 members accepted; 33 rejected rather than silently truncated", () => {
  const i = fixture(), m = i.catalog.members[0]!;
  i.catalog.members = Array.from({ length: 32 }, (_, n) => ({ ...m, sessionId: String(n) }));
  assert.equal(preview(i, 0).members.length, 32);
  i.catalog.members.push({ ...m, sessionId: "overflow" }); assert.throws(() => preview(i, 0), /Too many/);
});
test("ordering of catalog, tags, tasks and fields does not change fingerprint", () => {
  const i = fixture(); i.catalog.members.push({ ...i.catalog.members[0]!, sessionId: "two" });
  i.board.tasks.push({ ...i.board.tasks[0]!, id: "69957e08-7c01-45ca-aadd-3f9bc8443427" });
  i.taskIds.push(i.board.tasks[1]!.id); i.fields.push("detail"); i.selection.tags.push("UI");
  const p = preview(i, 0); i.catalog.members.reverse(); i.catalog.members[0]!.tags.reverse();
  i.board.tasks.reverse(); i.taskIds.reverse(); i.fields.reverse(); i.selection.tags.reverse();
  assert.equal(preview(i, 0).fingerprint, p.fingerprint);
});
test("resource, preferences, directory, identity, permissions and task edits invalidate confirmation", () => {
  const changes: ((i: DelegationPreviewInput) => void)[] = [
    i => i.board.revision++, i => i.catalog.generation++, i => i.catalog.preferencesRevision++,
    i => i.catalog.members[0]!.authorityEpoch++, i => { i.catalog.members[0]!.nodeId = "replacement"; },
    i => { i.catalog.members[0]!.groupId = "moved"; }, i => { i.board.tasks[0]!.detail = "new"; },
    i => { i.fields.push("detail"); }, i => { i.board.tasks = []; },
    i => { i.catalog.members.push({ ...i.catalog.members[0]!, sessionId: "new member" }); },
    i => { i.catalog.complete = false; },
  ];
  for (const change of changes) { const i = fixture(), p = preview(i, 0); change(i); assert.equal(current(p, i, 1), false); }
});
test("time expiry, clock reversal and unsafe numbers cannot confirm a preview", () => {
  const i = fixture(), p = preview(i, 10);
  assert.equal(current(p, i, 9), false); assert.equal(current(p, i, 300009), true); assert.equal(current(p, i, 300010), false);
  for (const invalid of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER]) assert.throws(() => preview(i, invalid));
  assert.equal(current(p, i, NaN), false);
});
test("unselected task content and catalog extras are not disclosed", () => {
  const i = fixture(); Object.assign(i.catalog.members[0]!, { credential: "PRIVATE", endpoint: "PRIVATE", history: "PRIVATE" });
  i.board.tasks.push({ id: "69957e08-7c01-45ca-aadd-3f9bc8443427", title: "PRIVATE", detail: "PRIVATE", status: "todo" });
  const p = preview(i, 0); assert.equal(p.resource.tasks.length, 1); assert.ok(!JSON.stringify(p).includes("PRIVATE"));
});
test("missing/duplicate tasks, expanded write fields and malformed selections reject", () => {
  const changes: ((i: DelegationPreviewInput) => void)[] = [
    i => { i.taskIds = []; }, i => { i.taskIds.push(id); }, i => { i.taskIds = ["missing"]; },
    i => { i.fields = []; }, i => { i.fields.push("status"); }, i => { i.fields = ["title" as "status"]; },
    i => { i.selection.tags = ["dev", "dev"]; }, i => { i.selection.tags = [" dev"]; },
    i => { i.selection.tagMode = "invalid" as "all"; }, i => { i.catalog.members[0]!.authorityEpoch = -1; },
    i => { i.catalog.members[0]!.tags = ["\u0000"]; },
  ];
  for (const change of changes) { const i = fixture(); change(i); assert.throws(() => preview(i, 0)); }
});
