const test = require("node:test");
const assert = require("node:assert/strict");
const { deferred } = require("./harness/deferred");

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

test("a rejecting settleBounds still releases suppression instead of stranding the pill", async () => {
  const { createDictationErrorPillHandoff } =
    await import("../../src/utils/dictationErrorPillHandoff.ts");
  const visibility = [];
  const handoff = createDictationErrorPillHandoff({
    onSuppressedChange: (suppressed) => visibility.push(suppressed),
    waitForFrames: async () => assert.fail("frames must not be awaited after a settle failure"),
  });

  handoff.suppress();
  const result = await handoff.releaseAfter(async () => {
    throw new Error("native window destroyed");
  });

  assert.deepEqual(result, { released: true, superseded: false });
  assert.deepEqual(visibility, [true, false]);
});

test("a rejecting hideWindow still releases suppression instead of stranding the pill", async () => {
  const { createDictationErrorPillHandoff } =
    await import("../../src/utils/dictationErrorPillHandoff.ts");
  const visibility = [];
  const handoff = createDictationErrorPillHandoff({
    onSuppressedChange: (suppressed) => visibility.push(suppressed),
    shouldAutoHide: () => true,
    hideWindow: async () => {
      throw new Error("window already gone");
    },
  });

  handoff.suppress();
  const result = await handoff.releaseAfter(async () => {});

  assert.deepEqual(result, { released: true, superseded: false });
  assert.deepEqual(visibility, [true, false]);
});

test("cancel supersedes an in-flight release but keeps the pill suppressed", async () => {
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
  handoff.cancel();
  bounds.resolve();

  assert.deepEqual(await release, { released: false, superseded: true });
  assert.deepEqual(visibility, [true]);

  // Unlike dispose, cancel leaves the handoff usable: a later release still
  // publishes — so after unmount it could still call the dead component's
  // onSuppressedChange.
  assert.deepEqual(await handoff.releaseAfter(async () => {}), {
    released: true,
    superseded: false,
  });
  assert.deepEqual(visibility, [true, false]);
});

test("dispose permanently silences the handoff, including releases started later", async () => {
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
  handoff.dispose();
  bounds.resolve();

  assert.deepEqual(await release, { released: false, superseded: true });
  assert.deepEqual(await handoff.releaseAfter(async () => {}), {
    released: false,
    superseded: true,
  });
  assert.deepEqual(visibility, [true], "no callback may fire after dispose");
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
