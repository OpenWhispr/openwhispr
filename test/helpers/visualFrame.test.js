const test = require("node:test");
const assert = require("node:assert/strict");

test("visual work waits for the requested number of compositor frames", async () => {
  const { waitForVisualFrames } = await import("../../src/utils/visualFrame.ts");
  const queued = [];
  let resolved = false;
  const waiting = waitForVisualFrames(2, (callback) => {
    queued.push(callback);
    return queued.length;
  }).then(() => {
    resolved = true;
  });

  assert.equal(queued.length, 1);
  queued.shift()(0);
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.equal(queued.length, 1);

  queued.shift()(16);
  await waiting;
  assert.equal(resolved, true);
});

test("zero visual frames resolves without scheduling work", async () => {
  const { waitForVisualFrames } = await import("../../src/utils/visualFrame.ts");
  let scheduled = false;
  await waitForVisualFrames(0, () => {
    scheduled = true;
    return 0;
  });
  assert.equal(scheduled, false);
});
