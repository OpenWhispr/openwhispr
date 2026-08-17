const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/mainWindowResizeCoordinator.ts");

const deferred = () => {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

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
