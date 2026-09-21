const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Pinned on purpose: a new GUID resets every user's tray placement.
const PRODUCTION_TRAY_GUID = "9afd9bd5-53da-42ef-8334-6e2b494c66fe";
const trayModulePath = require.resolve("../../src/helpers/tray");
const icon = { isEmpty: () => false };

async function trayConstructorArgs({
  platform = "win32",
  channel = "production",
  metadata = { windowsTrayIdentity: true },
} = {}) {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalChannel = process.env.OPENWHISPR_CHANNEL;
  const originalLoad = Module._load;
  const calls = [];
  const errors = [];

  class FakeTray {
    constructor(...args) {
      calls.push(args);
    }
    on() {}
    setToolTip() {}
    setContextMenu() {}
    setIgnoreDoubleClickEvents() {}
  }

  try {
    Object.defineProperty(process, "platform", { value: platform });
    process.env.OPENWHISPR_CHANNEL = channel;
    delete require.cache[trayModulePath];
    Module._load = function loadTrayWithStubs(request, parent, isMain) {
      if (parent?.filename === trayModulePath) {
        if (request === "electron") {
          return {
            Tray: FakeTray,
            Menu: { buildFromTemplate: () => ({}) },
            nativeImage: {},
            app: {},
          };
        }
        if (request === "../../package.json") return metadata;
        if (request === "./debugLogger") {
          return { debug: () => undefined, error: (...args) => errors.push(args) };
        }
        if (request === "./dockManager") return {};
        if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    const TrayManager = require(trayModulePath);
    const manager = new TrayManager();
    manager.loadTrayIcon = async () => icon;
    await manager.createTray();
    // createTray logs failures instead of throwing them.
    assert.deepEqual(errors, []);
    return calls;
  } finally {
    Module._load = originalLoad;
    Object.defineProperty(process, "platform", originalPlatform);
    if (originalChannel === undefined) delete process.env.OPENWHISPR_CHANNEL;
    else process.env.OPENWHISPR_CHANNEL = originalChannel;
    delete require.cache[trayModulePath];
  }
}

test("signed production Windows builds pass the permanent tray GUID", async () => {
  assert.deepEqual(await trayConstructorArgs(), [[icon, PRODUCTION_TRAY_GUID]]);
});

test("unsigned builds, other channels, and other platforms keep the one-argument tray", async () => {
  for (const scenario of [
    { metadata: {} },
    { metadata: { windowsTrayIdentity: false } },
    { channel: "development" },
    { channel: "staging" },
    { platform: "darwin" },
    { platform: "linux" },
  ]) {
    assert.deepEqual(await trayConstructorArgs(scenario), [[icon]], JSON.stringify(scenario));
  }
});
