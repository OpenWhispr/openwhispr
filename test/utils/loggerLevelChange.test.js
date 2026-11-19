const test = require("node:test");
const assert = require("node:assert/strict");

test("a log-level change from main reaches a window that already cached its level", async () => {
  let mainLevel = "info";
  let onLevelChanged = null;
  const sent = [];
  globalThis.window = {
    electronAPI: {
      getLogLevel: async () => mainLevel,
      onLogLevelChanged: (callback) => {
        onLevelChanged = callback;
        return () => {};
      },
      log: async (entry) => {
        sent.push(entry.message);
      },
    },
  };

  const mod = await import("../../src/utils/logger.ts");
  const logger = mod.default.default ?? mod.default;
  assert.equal(typeof onLevelChanged, "function", "logger subscribes when it loads");

  await logger.debug("before toggle");
  assert.deepEqual(sent, [], "info level drops debug lines");

  mainLevel = "debug";
  await logger.debug("cached level still info");
  assert.deepEqual(sent, [], "without the event the window keeps its cached level");

  onLevelChanged();
  await logger.debug("after toggle");
  assert.deepEqual(sent, ["after toggle"]);
});
