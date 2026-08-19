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

test("a background-throttled rAF cannot stall the wait past the per-frame timeout", async () => {
  const { waitForVisualFrames } = await import("../../src/utils/visualFrame.ts");
  let scheduled = 0;
  // Hidden/occluded window: rAF callbacks are queued but never invoked.
  await waitForVisualFrames(
    2,
    () => {
      scheduled += 1;
      return scheduled;
    },
    5
  );
  assert.equal(scheduled, 2);
});

test("a frame that does render advances immediately and cancels its fallback timer", async () => {
  const { waitForVisualFrames } = await import("../../src/utils/visualFrame.ts");
  let scheduled = 0;
  await waitForVisualFrames(
    1,
    (callback) => {
      scheduled += 1;
      callback(0);
      return scheduled;
    },
    1
  );
  assert.equal(scheduled, 1);
  // Let the (cleared) fallback timer's deadline pass: no second advance.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(scheduled, 1);
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
