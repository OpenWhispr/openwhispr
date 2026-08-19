const test = require("node:test");
const assert = require("node:assert/strict");

const deferred = () => {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

test("the resting pill stays suppressed until bounds and compositor frames settle", async () => {
  const { createDictationErrorPillHandoff } =
    await import("../../src/utils/dictationErrorPillHandoff.ts");
  const bounds = deferred();
  const frames = deferred();
  const visibility = [];
  const handoff = createDictationErrorPillHandoff({
    onSuppressedChange: (suppressed) => visibility.push(suppressed),
    waitForFrames: () => frames.promise,
  });

  handoff.suppress();
  const release = handoff.releaseAfter(() => bounds.promise);
  assert.deepEqual(visibility, [true]);
  bounds.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(visibility, [true]);
  frames.resolve();

  assert.deepEqual(await release, { released: true, superseded: false });
  assert.deepEqual(visibility, [true, false]);
});

test("a new error invalidates an older in-flight pill reveal", async () => {
  const { createDictationErrorPillHandoff } =
    await import("../../src/utils/dictationErrorPillHandoff.ts");
  const bounds = deferred();
  const visibility = [];
  const handoff = createDictationErrorPillHandoff({
    onSuppressedChange: (suppressed) => visibility.push(suppressed),
    waitForFrames: async () => {},
  });

  handoff.suppress();
  const release = handoff.releaseAfter(() => bounds.promise);
  handoff.suppress();
  bounds.resolve();

  assert.deepEqual(await release, { released: false, superseded: true });
  assert.deepEqual(visibility, [true]);
});

test("auto-hide closes the native window before releasing DOM suppression", async () => {
  const { createDictationErrorPillHandoff } =
    await import("../../src/utils/dictationErrorPillHandoff.ts");
  const order = [];
  const handoff = createDictationErrorPillHandoff({
    onSuppressedChange: (suppressed) => order.push(suppressed ? "suppress" : "release"),
    shouldAutoHide: () => true,
    hideWindow: async () => order.push("hide"),
    waitForFrames: async () => assert.fail("visible-frame wait should not run"),
  });

  handoff.suppress();
  await handoff.releaseAfter(async () => order.push("bounds"));

  assert.deepEqual(order, ["suppress", "bounds", "hide", "release"]);
});
