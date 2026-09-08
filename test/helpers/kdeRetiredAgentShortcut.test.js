const test = require("node:test");
const assert = require("node:assert/strict");

const debugLogger = require("../../src/helpers/debugLogger.js");
const KDEShortcutManager = require("../../src/helpers/kdeShortcut.js");

// Names below come from the selected distribution manifest, the same way
// kdeShortcut.js derives them. Hardcoding the default distribution's values
// made these fail under any other manifest, including the release build's.
const { resolveReleaseDistribution } = require("../../src/helpers/releaseIdentity");
const DISTRIBUTION = resolveReleaseDistribution(require("../../package.json").distribution);
const NAMESPACE = DISTRIBUTION.runtimeNamespace;
const PRODUCT = DISTRIBUTION.productName;

test("KDE removes the retired Agent shortcut with its exact persisted action ID", async () => {
  const actionIds = [];
  const manager = new KDEShortcutManager();
  manager.kglobalaccel = {
    unRegister(actionId, callback) {
      actionIds.push(actionId);
      callback(null);
    },
  };

  await manager.removeRetiredAgentKeybinding();

  assert.deepEqual(actionIds, [[NAMESPACE, "agent", PRODUCT, `${PRODUCT} agent`]]);
});

test("a KDE retired-shortcut cleanup error is logged and absorbed", async (t) => {
  const messages = [];
  const originalLog = debugLogger.log;
  debugLogger.log = (...args) => messages.push(args.map(String).join(" "));
  t.after(() => {
    debugLogger.log = originalLog;
  });

  const manager = new KDEShortcutManager();
  manager.kglobalaccel = {
    unRegister(_actionId, callback) {
      callback(new Error("cleanup unavailable"));
    },
  };

  await assert.doesNotReject(manager.removeRetiredAgentKeybinding());
  assert.ok(messages.some((message) => message.includes("cleanup unavailable")));
});
