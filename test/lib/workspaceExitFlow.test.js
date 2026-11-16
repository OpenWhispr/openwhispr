const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/lib/workspaceExitFlow.ts");

const run = (reducer, events, start = { kind: "closed" }) => events.reduce(reducer, start);

test("leave happy path", async () => {
  const { exitReducer } = await load();

  const state = run(exitReducer, [
    { type: "startLeave", name: "Acme" },
    { type: "confirm" },
    { type: "succeeded" },
  ]);

  assert.deepEqual(state, { kind: "left", name: "Acme" });
});

test("delete failure then retry", async () => {
  const { exitReducer } = await load();

  const failed = run(exitReducer, [
    { type: "startDelete", name: "Acme" },
    { type: "confirm" },
    { type: "failed", reason: null },
  ]);
  assert.deepEqual(failed, { kind: "deleteFailed", name: "Acme", reason: null });

  const state = run(exitReducer, [{ type: "confirm" }, { type: "succeeded" }], failed);
  assert.deepEqual(state, { kind: "deleted", name: "Acme" });
});

test("leave failure then retry", async () => {
  const { exitReducer } = await load();

  const failed = run(exitReducer, [
    { type: "startLeave", name: "Acme" },
    { type: "confirm" },
    { type: "failed", reason: "Workspace owners cannot leave" },
  ]);
  assert.deepEqual(failed, {
    kind: "leaveFailed",
    name: "Acme",
    reason: "Workspace owners cannot leave",
  });
  assert.deepEqual(exitReducer(failed, { type: "confirm" }), { kind: "leaving", name: "Acme" });
});

test("dismiss is ignored while deleting", async () => {
  const { exitReducer } = await load();

  const deleting = run(exitReducer, [{ type: "startDelete", name: "Acme" }, { type: "confirm" }]);
  assert.equal(exitReducer(deleting, { type: "dismiss" }), deleting);

  const leaving = run(exitReducer, [{ type: "startLeave", name: "Acme" }, { type: "confirm" }]);
  assert.equal(exitReducer(leaving, { type: "dismiss" }), leaving);
});

test("dismiss closes confirm, failed and outcome states", async () => {
  const { exitReducer } = await load();

  for (const kind of [
    "confirmLeave",
    "leaveFailed",
    "left",
    "confirmDelete",
    "deleteFailed",
    "deleted",
  ]) {
    assert.deepEqual(exitReducer({ kind, name: "Acme" }, { type: "dismiss" }), { kind: "closed" });
  }
});

test("left state keeps the left workspace's name", async () => {
  const { exitReducer } = await load();

  const left = run(exitReducer, [
    { type: "startLeave", name: "Acme" },
    { type: "confirm" },
    { type: "succeeded" },
  ]);

  // Later input (a stale confirm, a repeated success) never renames or moves it.
  assert.deepEqual(exitReducer(left, { type: "confirm" }), left);
  assert.deepEqual(exitReducer(left, { type: "succeeded" }), left);
  assert.deepEqual(exitReducer(left, { type: "failed", reason: null }), left);
  assert.equal(left.name, "Acme");
});

test("events that do not apply leave the state untouched", async () => {
  const { exitReducer } = await load();
  const closed = { kind: "closed" };

  assert.equal(exitReducer(closed, { type: "confirm" }), closed);
  assert.equal(exitReducer(closed, { type: "succeeded" }), closed);
  assert.equal(exitReducer(closed, { type: "failed", reason: null }), closed);
  assert.equal(exitReducer(closed, { type: "dismiss" }), closed);
});
