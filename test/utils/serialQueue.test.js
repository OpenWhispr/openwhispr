const test = require("node:test");
const assert = require("node:assert/strict");

const { createSerialQueue } = require("../../src/utils/serialQueue.ts");

test("runs tasks one at a time in enqueue order", async () => {
  const run = createSerialQueue();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  run(async () => {
    events.push("start1");
    await firstGate;
    events.push("end1");
  });
  const second = run(async () => {
    events.push("start2");
  });

  await Promise.resolve();
  assert.deepEqual(events, ["start1"], "second task must not start while the first is pending");

  releaseFirst();
  await second;
  assert.deepEqual(events, ["start1", "end1", "start2"]);
});

test("resolves each task with its own result", async () => {
  const run = createSerialQueue();
  assert.equal(await run(async () => "a"), "a");
  assert.equal(await run(async () => "b"), "b");
});

test("a rejected task does not stall the queue", async () => {
  const run = createSerialQueue();
  const events = [];

  const failing = run(async () => {
    throw new Error("boom");
  });
  const following = run(async () => {
    events.push("ran");
  });

  await assert.rejects(failing, /boom/);
  await following;
  assert.deepEqual(events, ["ran"]);
});
