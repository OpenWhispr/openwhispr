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

const mainSource = () => fs.readFileSync(path.join(__dirname, "../../main.js"), "utf8");

// Runs main.js's startup Hold check, the code between createMainWindow() and the
// backend's delayed registration, against the given window manager.
function startupHoldCheck(windowManager, { writes = [], notifications = [] } = {}) {
  const main = mainSource();
  const start = main.indexOf("async function dropUnsupportedStartupHold() {");
  assert.notEqual(start, -1);
  const fn = main.slice(start, main.indexOf("\n}\n", start) + 3);
  return vm.runInNewContext(`(async () => {${fn}\nawait dropUnsupportedStartupHold();})()`, {
    windowManager,
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
}

// Mirrors startApp: restore the saved Hold, start the backend (registration is
// still pending behind its timer), run the check, then let registration run.
async function startWithSavedHold(f) {
  const writes = [];
  const notifications = [];
  await f.cache.setActivationModeCache("push");
  await f.manager.initializeHotkey(f.window, () => {});
  assert.equal(f.timers.length, 1, "the saved hotkey has not registered yet");
  await startupHoldCheck(
    {
      getActivationMode: () => f.cache._cachedActivationMode,
      hotkeyManager: f.manager,
      setActivationModeCache: (mode) => f.cache.setActivationModeCache(mode),
    },
    { writes, notifications }
  );
  f.registrations.length = 0;
  f.timers.shift().callback();
  for (let i = 0; i < 5; i++) await tick();
  return { writes, notifications };
}

for (const backend of ["Hyprland", "GNOME", "KDE"]) {
  for (const hotkey of ["Scrolllock", "Control+Shift+Space"]) {
    test(`${backend} startup keeps a saved Hold for saved ${hotkey}`, async () => {
      const f = fixture(backend, hotkey);
      const { writes, notifications } = await startWithSavedHold(f);
      assert.equal(f.cache._cachedActivationMode, "push");
      assert.equal(f.manager.activationMode, "push");
      assert.deepEqual(notifications, []);
      assert.deepEqual(writes, []);
      assert.deepEqual(f.registrations, [{ hotkey, push: true }]);
      assert.equal(f.manager.currentHotkey, hotkey);
    });
  }

  const modifierOnly = `${backend} startup drops Hold before registering a modifier-only hotkey`;
  test(modifierOnly, async () => {
    const f = fixture(backend, "Control+Alt");
    const { writes, notifications } = await startWithSavedHold(f);
    assert.equal(f.cache._cachedActivationMode, "tap");
    assert.equal(notifications.length, 1);
    assert.deepEqual(writes, [], "the saved Hold is retried next launch");
    assert.deepEqual(f.registrations, [{ hotkey: "Control+Alt", push: false }]);
  });
}

const noPortal = "GNOME without the shortcuts portal drops Hold before its key registers";
test(noPortal, async () => {
  const f = fixture("GNOME");
  f.manager.initializeGnomeShortcuts = async () => {
    f.manager.useGnome = true;
    f.manager.gnomeManager = { supportsPushToTalk: () => false };
    return true;
  };
  const { writes, notifications } = await startWithSavedHold(f);
  assert.equal(f.cache._cachedActivationMode, "tap");
  assert.equal(notifications.length, 1);
  assert.deepEqual(writes, []);
  assert.deepEqual(f.registrations, [{ hotkey: "Scrolllock", push: false }]);
  assert.equal(f.manager.useGnome, true, "the GNOME binding was kept");
});

for (const changed of [false, true]) {
  test(`startup Tap fallback preserves the saved preference when registration ${changed ? "succeeds" : "fails"}`, async () => {
    const notifications = [];
    const writes = [];
    await startupHoldCheck(
      {
        getActivationMode: () => "push",
        hotkeyManager: {
          isUsingNativeShortcut: () => true,
          getSavedDictationHotkey: async () => "Scrolllock",
          supportsPushToTalk: () => false,
        },
        setActivationModeCache: async () => changed,
      },
      { writes, notifications }
    );
    assert.equal(writes.length, 0);
    assert.equal(notifications.length, changed ? 1 : 0);
  });
}

// Without a desktop backend the hotkey registers during startup, and a fallback
// can replace the first saved hotkey, so the registered one decides.
test("startup checks the registered hotkey when no desktop backend delays it", async () => {
  const checked = [];
  const notifications = [];
  await startupHoldCheck(
    {
      getActivationMode: () => "push",
      hotkeyManager: {
        isUsingNativeShortcut: () => false,
        getSavedDictationHotkey: async () => "Control+Shift+Space",
        getCurrentHotkey: () => "F8",
        supportsPushToTalk: (hotkey) => {
          checked.push(hotkey);
          return hotkey !== "F8";
        },
      },
      setActivationModeCache: async () => true,
    },
    { notifications }
  );
  assert.deepEqual(checked, ["F8"]);
  assert.equal(notifications.length, 1);
});

test("startup checks Hold before the control panel opens and the hotkey registers", () => {
  const main = mainSource();
  const created = main.indexOf("  await windowManager.createMainWindow();\n");
  assert.notEqual(created, -1);
  const next = created + "  await windowManager.createMainWindow();\n".length;
  assert.ok(main.startsWith("  await dropUnsupportedStartupHold();\n", next));
});
