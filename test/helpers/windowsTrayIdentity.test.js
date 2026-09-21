const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const EXPECTED_GUID = "9afd9bd5-53da-42ef-8334-6e2b494c66fe";
const trayModulePath = require.resolve("../../src/helpers/tray");

async function createTray({
  platform = "win32",
  isPackaged = true,
  channel = "production",
  metadata = { windowsTrayIdentity: "signed-production-v1" },
  icon = { isEmpty: () => false },
} = {}) {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalChannel = process.env.OPENWHISPR_CHANNEL;
  const originalLoad = Module._load;
  const originalCache = require.cache[trayModulePath];
  const constructorCalls = [];
  const errors = [];

  class FakeTray {
    constructor(...args) {
      constructorCalls.push(args);
      this.events = new Map();
    }
    on(name, callback) {
      this.events.set(name, callback);
    }
    setToolTip(value) {
      this.tooltip = value;
    }
    setContextMenu(value) {
      this.menu = value;
    }
    setIgnoreDoubleClickEvents(value) {
      this.ignoreDoubleClick = value;
    }
  }

  try {
    Object.defineProperty(process, "platform", { value: platform });
    if (channel === null) delete process.env.OPENWHISPR_CHANNEL;
    else process.env.OPENWHISPR_CHANNEL = channel;
    delete require.cache[trayModulePath];
    Module._load = function loadWithStubs(request, parent, isMain) {
      if (parent?.filename === trayModulePath) {
        if (request === "electron") {
          return {
            Tray: FakeTray,
            Menu: { buildFromTemplate: (items) => items },
            nativeImage: {},
            app: { isPackaged },
          };
        }
        if (request === "../../package.json") return metadata;
        if (request === "./debugLogger") {
          return {
            debug: () => {},
            info: () => {},
            error: (...args) => errors.push(args),
          };
        }
        if (request === "./dockManager") return {};
        if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    const TrayManager = require(trayModulePath);
    Module._load = originalLoad;
    const manager = new TrayManager();
    manager.loadTrayIcon = async () => icon;
    await manager.createTray();
    return { manager, constructorCalls, errors, icon };
  } finally {
    Module._load = originalLoad;
    Object.defineProperty(process, "platform", originalPlatform);
    if (originalChannel === undefined) delete process.env.OPENWHISPR_CHANNEL;
    else process.env.OPENWHISPR_CHANNEL = originalChannel;
    if (originalCache) require.cache[trayModulePath] = originalCache;
    else delete require.cache[trayModulePath];
  }
}

test("marked packaged production Windows uses the permanent GUID", async () => {
  const first = await createTray();
  const second = await createTray();
  assert.deepEqual(first.constructorCalls, [[first.icon, EXPECTED_GUID]]);
  assert.deepEqual(second.constructorCalls, [[second.icon, EXPECTED_GUID]]);
  assert.deepEqual(first.errors, []);
});

test("every unsigned, development, other-channel, and non-Windows case keeps one argument", async () => {
  const scenarios = [
    { metadata: {} },
    { metadata: { windowsTrayIdentity: null } },
    { metadata: { windowsTrayIdentity: true } },
    { metadata: { windowsTrayIdentity: "signed-production-v2" } },
    { isPackaged: false },
    { channel: "development" },
    { channel: "staging" },
    { channel: "canary" },
    { channel: null },
    { platform: "darwin" },
    { platform: "linux" },
  ];
  for (const scenario of scenarios) {
    const result = await createTray(scenario);
    assert.deepEqual(result.constructorCalls, [[result.icon]], JSON.stringify(scenario));
    assert.deepEqual(result.errors, []);
  }
});

test("Windows keeps its tooltip, menu, click toggle, and destruction handler", async () => {
  const { manager } = await createTray();
  const tray = manager.tray;
  assert.equal(tray.tooltip, "tray.tooltip");
  assert.equal(tray.menu[0].label, "app.commandMenu.startListening");
  assert.equal(tray.menu.at(-1).label, "tray.quit");
  assert.deepEqual([...tray.events.keys()], ["click", "destroyed"]);
  let toggles = 0;
  manager.toggleControlPanelFromTray = async () => {
    toggles += 1;
  };
  tray.events.get("click")();
  assert.equal(toggles, 1);
  tray.events.get("destroyed")();
  assert.equal(manager.tray, null);
});

test("macOS and Linux retain their existing click and double-click behavior", async () => {
  const mac = (await createTray({ platform: "darwin" })).manager.tray;
  assert.equal(mac.ignoreDoubleClick, true);
  assert.equal(mac.events.has("click"), false);
  const linux = (await createTray({ platform: "linux" })).manager.tray;
  assert.equal(linux.ignoreDoubleClick, undefined);
  assert.equal(linux.events.has("click"), true);
});

test("missing and empty icons still skip tray construction", async () => {
  for (const icon of [null, { isEmpty: () => true }]) {
    const result = await createTray({ icon });
    assert.deepEqual(result.constructorCalls, []);
    assert.equal(result.manager.tray, null);
    assert.equal(result.errors.length, 1);
  }
});
