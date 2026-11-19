const test = require("node:test");
const assert = require("node:assert/strict");
const { createLocalCleanupPrewarm } = require("../../src/helpers/localCleanupPrewarm");

function setup() {
  const starts = [];
  const prewarm = createLocalCleanupPrewarm({
    prewarmServer: async (modelId, signal) => starts.push({ modelId, signal }),
  });
  return { prewarm, starts };
}

test("a cancelled preparation does not warm cleanup", () => {
  const { prewarm, starts } = setup();
  prewarm.setModel("cleanup");
  prewarm.setLifecycleState("preparing");
  prewarm.setLifecycleState("idle");
  assert.deepEqual(starts, []);
});

test("a confirmed recording holds the same warm-up through processing and releases on idle", () => {
  const { prewarm, starts } = setup();
  prewarm.setModel("cleanup");
  prewarm.setLifecycleState("recording");
  prewarm.setModel("cleanup");
  prewarm.setLifecycleState("recording");
  prewarm.setLifecycleState("processing");
  assert.deepEqual(
    starts.map(({ modelId }) => modelId),
    ["cleanup"]
  );
  assert.equal(starts[0].signal.aborted, false);
  prewarm.setLifecycleState("idle");
  assert.equal(starts[0].signal.aborted, true);
});

test("late settings warm an active take and changing route invalidates its previous warm-up", () => {
  const { prewarm, starts } = setup();
  prewarm.setLifecycleState("recording");
  assert.equal(starts.length, 0);
  prewarm.setModel("first");
  prewarm.setModel("second");
  prewarm.setModel("");
  prewarm.setLifecycleState("idle");
  prewarm.setLifecycleState("recording");
  assert.deepEqual(
    starts.map(({ modelId }) => modelId),
    ["first", "second"]
  );
  assert.ok(starts.every(({ signal }) => signal.aborted));
});
