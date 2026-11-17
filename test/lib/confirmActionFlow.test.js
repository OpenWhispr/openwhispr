const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/lib/confirmActionFlow.ts");

const run = (reducer, events, start = { kind: "closed" }) => events.reduce(reducer, start);

test("open then confirm then succeeded closes the dialog", async () => {
  const { confirmActionReducer } = await load();

  const confirming = run(confirmActionReducer, [{ type: "open", subject: "mia" }]);
  assert.deepEqual(confirming, { kind: "confirm", subject: "mia" });

  const running = confirmActionReducer(confirming, { type: "confirm" });
  assert.deepEqual(running, { kind: "running", subject: "mia" });

  assert.deepEqual(confirmActionReducer(running, { type: "succeeded" }), { kind: "closed" });
});

test("succeeded closes a running action", async () => {
  const { confirmActionReducer } = await load();

  const running = { kind: "running", subject: { id: "u1" } };

  assert.deepEqual(confirmActionReducer(running, { type: "succeeded" }), { kind: "closed" });
});

test("succeeded is ignored outside running", async () => {
  const { confirmActionReducer } = await load();
  const states = [
    { kind: "closed" },
    { kind: "confirm", subject: "mia" },
    { kind: "failed", subject: "mia", error: { kind: "failed" } },
  ];

  for (const state of states) {
    assert.equal(confirmActionReducer(state, { type: "succeeded" }), state);
  }
});

test("failed then confirm retries with the same subject", async () => {
  const { confirmActionReducer } = await load();
  const error = { kind: "failed" };

  const failed = run(confirmActionReducer, [
    { type: "open", subject: { id: "u1" } },
    { type: "confirm" },
    { type: "failed", error },
  ]);
  assert.deepEqual(failed, { kind: "failed", subject: { id: "u1" }, error });

  const retrying = confirmActionReducer(failed, { type: "confirm" });
  assert.deepEqual(retrying, { kind: "running", subject: { id: "u1" } });
});

test("dismiss is ignored while running", async () => {
  const { confirmActionReducer } = await load();

  const running = run(confirmActionReducer, [
    { type: "open", subject: "mia" },
    { type: "confirm" },
  ]);

  assert.equal(confirmActionReducer(running, { type: "dismiss" }), running);
});

test("dismiss closes a confirm and a failure", async () => {
  const { confirmActionReducer } = await load();

  const confirming = confirmActionReducer({ kind: "closed" }, { type: "open", subject: "mia" });
  assert.deepEqual(confirmActionReducer(confirming, { type: "dismiss" }), { kind: "closed" });

  const failed = { kind: "failed", subject: "mia", error: { kind: "failed" } };
  assert.deepEqual(confirmActionReducer(failed, { type: "dismiss" }), { kind: "closed" });
});

test("events that do not fit the state are ignored", async () => {
  const { confirmActionReducer } = await load();
  const closed = { kind: "closed" };
  const confirming = { kind: "confirm", subject: "mia" };

  assert.equal(confirmActionReducer(closed, { type: "confirm" }), closed);
  assert.equal(confirmActionReducer(closed, { type: "failed", error: { kind: "failed" } }), closed);
  assert.equal(
    confirmActionReducer(confirming, { type: "failed", error: { kind: "failed" } }),
    confirming
  );
});
