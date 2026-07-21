const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const managerModulePath = require.resolve("../../src/helpers/appleCalendarManager.js");
const originalLoad = Module._load;

function loadManager() {
  delete require.cache[managerModulePath];
  Module._load = function loadWithElectronMock(request, parent, isMain) {
    if (request === "electron") {
      return { BrowserWindow: { getAllWindows: () => [] } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(managerModulePath);
  } finally {
    Module._load = originalLoad;
  }
}

test("an unexpected helper exit schedules a restart while Apple Calendar is connected", () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    const AppleCalendarManager = loadManager();
    const databaseManager = {
      getAppleCalendars: () => [{ id: "calendar-1" }],
    };
    const manager = new AppleCalendarManager(databaseManager, {});
    const child = {};
    let restartCount = 0;
    manager._helperProcess = child;
    manager._scheduleHelperRestart = () => {
      restartCount += 1;
    };

    manager._onHelperGone(child);

    assert.equal(manager._helperProcess, null);
    assert.equal(restartCount, 1);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
});

test("a deliberate stop prevents the exited child from scheduling a restart", () => {
  const AppleCalendarManager = loadManager();
  const databaseManager = {
    getAppleCalendars: () => [{ id: "calendar-1" }],
  };
  const manager = new AppleCalendarManager(databaseManager, {});
  const child = { kill: () => {} };
  let restartCount = 0;
  manager._helperProcess = child;
  manager._scheduleHelperRestart = () => {
    restartCount += 1;
  };

  manager.stop();
  manager._onHelperGone(child);

  assert.equal(restartCount, 0);
});
