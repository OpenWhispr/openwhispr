const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/mainWindowResizeCoordinator.ts");
const { deferred } = require("./harness/deferred");

test("voice window resizes are serialized and obsolete pending heights are dropped", async () => {
  const { createMainWindowResizeCoordinator } = await load();
  const first = deferred();
  const calls = [];
  const coordinator = createMainWindowResizeCoordinator({
    resizeMainWindow: async (key) => ({
      success: true,
      bounds: { x: 0, y: 0, width: key === "ASSISTANT" ? 466 : 96, height: 96 },
    }),
    resizeAssistantWindowToContent: async (height) => {
      calls.push(height);
      if (calls.length === 1) await first.promise;
      return { success: true, bounds: { x: 0, y: 0, width: 466, height } };
    },
    waitForBounds: async () => {},
  });

  const initial = coordinator.resizeAssistantWindowToContent(176);
  const obsolete = coordinator.resizeAssistantWindowToContent(220);
  const latest = coordinator.resizeAssistantWindowToContent(264);

  assert.deepEqual(calls, [176]);
  assert.equal((await obsolete).superseded, true);
  first.resolve();
  await Promise.all([initial, latest]);
  assert.deepEqual(calls, [176, 264]);
});

test("anchor compensation masks split native move and resize frames", async () => {
  const { calculateWindowAnchorCompensation } = await load();
  const target = { x: 2282, y: 913, width: 466, height: 176 };

  assert.deepEqual(
    calculateWindowAnchorCompensation(
      target,
      { x: 2652, y: 993, width: 466, height: 176 },
      "bottom-right"
    ),
    { x: -370, y: -80 }
  );
  assert.deepEqual(calculateWindowAnchorCompensation(target, target, "bottom-right"), {
    x: 0,
    y: 0,
  });
});

test("anchor compensation pins the configured edge for bottom-left and center anchors", async () => {
  const { calculateWindowAnchorCompensation } = await load();
  const target = { x: 100, y: 900, width: 466, height: 176 };
  const current = { x: 130, y: 880, width: 400, height: 240 };

  // bottom-left keeps the left edge and the bottom edge fixed in screen space.
  assert.deepEqual(calculateWindowAnchorCompensation(target, current, "bottom-left"), {
    x: -30,
    y: -44,
  });
  // center keeps the horizontal midpoint fixed while the bottom edge anchors:
  // target center 333 vs current center 330.
  assert.deepEqual(calculateWindowAnchorCompensation(target, current, "center"), {
    x: 3,
    y: -44,
  });
  for (const anchor of ["bottom-left", "center"]) {
    assert.deepEqual(calculateWindowAnchorCompensation(target, target, anchor), { x: 0, y: 0 });
  }
});

test("dispose flushes the queued resize and refuses later requests without invoking", async () => {
  const { createMainWindowResizeCoordinator } = await load();
  const first = deferred();
  const invoked = [];
  const coordinator = createMainWindowResizeCoordinator({
    resizeMainWindow: async (key) => {
      invoked.push(key);
      if (key === "BASE") await first.promise;
      return { success: true, bounds: { x: 0, y: 0, width: 96, height: 96 } };
    },
    resizeAssistantWindowToContent: async () => ({ success: true }),
    waitForBounds: async () => {},
  });

  const active = coordinator.resizeMainWindow("BASE");
  const queued = coordinator.resizeMainWindow("RECORDING");
  coordinator.dispose();

  const queuedResult = await queued;
  assert.equal(queuedResult.success, false);
  assert.equal(queuedResult.superseded, true);

  first.resolve();
  assert.equal((await active).success, true, "the in-flight resize still completes");

  const late = await coordinator.resizeMainWindow("ASSISTANT");
  assert.equal(late.success, false);
  assert.equal(late.superseded, true);
  assert.deepEqual(invoked, ["BASE"], "no new native resize may run after dispose");
});

test("a duplicate settled footprint does not ask Electron to resize again", async () => {
  const { createMainWindowResizeCoordinator } = await load();
  let calls = 0;
  const coordinator = createMainWindowResizeCoordinator({
    resizeMainWindow: async () => {
      calls += 1;
      return { success: true, bounds: { x: 10, y: 20, width: 466, height: 562 } };
    },
    resizeAssistantWindowToContent: async () => ({ success: true }),
    waitForBounds: async () => {},
  });

  await coordinator.resizeMainWindow("ASSISTANT");
  await coordinator.resizeMainWindow("ASSISTANT");
  assert.equal(calls, 1);
});

test("a deduplicated same-footprint request reports changed:false", async () => {
  const { createMainWindowResizeCoordinator } = await load();
  const coordinator = createMainWindowResizeCoordinator({
    resizeMainWindow: async () => ({
      success: true,
      changed: true,
      bounds: { x: 0, y: 0, width: 466, height: 300 },
    }),
    resizeAssistantWindowToContent: async () => ({
      success: true,
      changed: true,
      bounds: { x: 0, y: 0, width: 466, height: 300 },
    }),
    waitForBounds: async () => {},
  });

  const first = await coordinator.resizeAssistantWindowToContent(300);
  const second = await coordinator.resizeAssistantWindowToContent(300);

  assert.equal(first.changed, true);
  assert.equal(second.changed, false, "nothing moved, so callers must not wait for a grow");
});

test("the next resize waits for renderer geometry settlement", async () => {
  const { createMainWindowResizeCoordinator } = await load();
  const settle = deferred();
  const order = [];
  const coordinator = createMainWindowResizeCoordinator({
    resizeMainWindow: async (key) => {
      order.push(`invoke:${key}`);
      return { success: true, bounds: { x: 0, y: 0, width: 96, height: 96 } };
    },
    resizeAssistantWindowToContent: async () => ({ success: true }),
    waitForBounds: async () => {
      order.push("settle:start");
      await settle.promise;
      order.push("settle:end");
    },
  });

  const first = coordinator.resizeMainWindow("BASE");
  const second = coordinator.resizeMainWindow("RECORDING");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["invoke:BASE", "settle:start"]);
  settle.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, [
    "invoke:BASE",
    "settle:start",
    "settle:end",
    "invoke:RECORDING",
    "settle:start",
    "settle:end",
  ]);
});
