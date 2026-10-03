const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

const source = fs.readFileSync(path.join(__dirname, "../../src/helpers/hotkeyManager.js"), "utf8");
const windowSource = fs.readFileSync(
  path.join(__dirname, "../../src/helpers/windowManager.js"),
  "utf8"
);
const cacheMethod = windowSource.match(
  / {2}async setActivationModeCache\(mode\) \{[\s\S]*?\n {2}\}/
)[0];
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(backend, savedHotkey = "Scrolllock", registrationResult = true) {
  const timers = [];
  const registrations = [];
  const register = async (hotkey, push) => {
    registrations.push({ hotkey, push });
    return registrationResult;
  };
  class Hyprland {
    static isWayland() {
      return true;
    }
    static isHyprland() {
      return backend === "Hyprland";
    }
    static isHyprctlAvailable() {
      return true;
    }
    async initDBusService() {
      return true;
    }
    registerKeybinding(...args) {
      return register(...args);
    }
    updateKeybinding(...args) {
      return register(...args);
    }
  }
  const mocks = {
    events: require("node:events"),
    electron: { globalShortcut: { unregisterAll() {} }, BrowserWindow: {} },
    "./debugLogger": { log() {}, warn() {}, error() {} },
    "./gnomeShortcut": { isGnome: () => backend === "GNOME" },
    "./hyprlandShortcut": Hyprland,
    "./kdeShortcut": { isKDE: () => backend === "KDE" },
    "./i18nMain": { i18nMain: { t: (key) => key } },
    "./hotkeyList": require("../../src/helpers/hotkeyList"),
  };
  const context = {
    module: { exports: {} },
    process: { platform: "linux", env: {} },
    setTimeout: (callback, delay) => timers.push({ callback, delay }),
    require(name) {
      assert.ok(name in mocks, name);
      return mocks[name];
    },
  };
  vm.runInNewContext(source, context);
  const manager = new context.module.exports();
  manager.notifyActiveHotkey =
    manager.notifyHotkeyFailure =
    manager.notifyHotkeyFallback =
      () => {};
  manager._persistHotkeyToEnvFile = async () => {};
  manager.initializeGnomeShortcuts = async () => {
    manager.useGnome = true;
    return true;
  };
  manager.registerGnomeDictationHotkey = (hotkey) =>
    register(hotkey, manager.activationMode === "push");
  manager.initializeKDEShortcuts = async () => {
    manager.useKDE = true;
    manager.kdeManager = {
      registerKeybinding: (hotkey, _slot, _callback, push) => register(hotkey, push),
      close() {},
    };
    return true;
  };
  const cache = vm.runInNewContext(`({${cacheMethod}})`);
  cache.hotkeyManager = manager;
  cache._cachedActivationMode = "tap";
  const webContents = new EventEmitter();
  webContents.executeJavaScript = async () => savedHotkey;
  webContents.isLoading = () => false;
  return {
    manager,
    cache,
    timers,
    registrations,
    context,
    window: { isDestroyed: () => false, webContents },
  };
}

for (const backend of ["Hyprland", "GNOME", "KDE"]) {
  for (const hotkey of ["Scrolllock", "Control+Shift+Space"]) {
    test(`${backend} startup waits for saved ${hotkey} before validating Hold`, async () => {
      const f = fixture(backend, hotkey);
      await f.cache.setActivationModeCache("push");
      let complete = false;
      const init = f.manager
        .initializeHotkey(f.window, () => {})
        .then(() => {
          complete = true;
        });
      await tick();
      assert.equal(complete, false);
      assert.equal(f.manager.isInitialized, false);
      assert.equal(f.timers.length, 1);
      f.timers.shift().callback();
      await init;
      assert.equal(f.manager.isInitialized, true);
      assert.equal(f.manager.currentHotkey, hotkey);
      assert.equal(f.manager.supportsPushToTalk(), true);
      assert.equal(f.manager.activationMode, "push");
      assert.equal(f.cache._cachedActivationMode, "push");
      assert.deepEqual(f.registrations, [{ hotkey, push: true }]);
    });
  }
  test(`${backend} startup awaits globalShortcut fallback when native registration fails`, async () => {
    const f = fixture(backend, "Scrolllock", false);
    let release;
    let complete = false;
    f.manager.loadSavedHotkeyOrDefault = async () => {
      await new Promise((resolve) => {
        release = resolve;
      });
      f.manager.currentHotkey = "F8";
    };
    const init = f.manager
      .initializeHotkey(f.window, () => {})
      .then(() => {
        complete = true;
      });
    await tick();
    f.timers.shift().callback();
    await tick();
    assert.equal(complete, false);
    assert.equal(f.manager.isInitialized, false);
    assert.equal(typeof release, "function");
    release();
    await init;
    assert.equal(f.manager.currentHotkey, "F8");
    assert.equal(f.manager.isInitialized, true);
  });
}

test("globalShortcut startup waits for page load and saved shortcut registration", async () => {
  const f = fixture("globalShortcut");
  f.window.webContents.isLoading = () => true;
  let release;
  let complete = false;
  f.manager.loadSavedHotkeyOrDefault = async () => {
    await new Promise((resolve) => {
      release = resolve;
    });
    f.manager.currentHotkey = "F8";
  };
  const init = f.manager
    .initializeHotkey(f.window, () => {})
    .then(() => {
      complete = true;
    });
  await tick();
  assert.equal(complete, false);
  assert.equal(release, undefined);
  f.window.webContents.emit("did-finish-load");
  await tick();
  assert.equal(complete, false);
  release();
  await init;
  assert.equal(f.manager.currentHotkey, "F8");
});

test("failed environment shortcut registration awaits the saved shortcut fallback", async () => {
  const f = fixture("globalShortcut");
  f.context.process.env.DICTATION_KEY = "F8";
  f.manager.setupShortcuts = () => ({ success: false });
  let release;
  let complete = false;
  f.manager.loadSavedHotkeyOrDefault = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const init = f.manager
    .initializeHotkey(f.window, () => {})
    .then(() => {
      complete = true;
    });
  await tick();
  assert.equal(complete, false);
  release();
  await init;
  assert.equal(f.manager.isInitialized, true);
});

for (const changed of [false, true]) {
  test(`startup Tap fallback preserves the saved preference when registration ${changed ? "succeeds" : "fails"}`, async () => {
    const main = fs.readFileSync(path.join(__dirname, "../../main.js"), "utf8");
    const start = main.indexOf('  if (\n    windowManager.getActivationMode() === "push"');
    assert.notEqual(start, -1);
    const block = main.slice(start, main.indexOf("  if (!startMinimized)", start));
    const notifications = [];
    const writes = [];
    await vm.runInNewContext(`(async () => {${block}})()`, {
      windowManager: {
        getActivationMode: () => "push",
        hotkeyManager: { supportsPushToTalk: () => false },
        setActivationModeCache: async () => changed,
      },
      environmentManager: { saveActivationMode: (mode) => writes.push(mode) },
      debugLogger: { warn() {} },
      BrowserWindow: {
        getAllWindows: () => [
          {
            isDestroyed: () => false,
            webContents: { send: (...args) => notifications.push(args) },
          },
        ],
      },
    });
    assert.equal(writes.length, 0);
    assert.equal(notifications.length, changed ? 1 : 0);
  });
}
