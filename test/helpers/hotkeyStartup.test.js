const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const GnomeShortcutManager = require("../../src/helpers/gnomeShortcut");

const source = fs.readFileSync(path.join(__dirname, "../../src/helpers/hotkeyManager.js"), "utf8");
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
    "./gnomeShortcut": class extends GnomeShortcutManager {
      static isGnome() {
        return backend === "GNOME";
      }
    },
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
  // Only the portal and gsettings are faked: gsettings refuses what GNOME refuses.
  const gnome = {
    supportsPushToTalk: () => true,
    registerPushToTalk: (hotkey) => register(hotkey, true),
    unregisterPushToTalk: async () => {},
    registerKeybinding: async (shortcut) =>
      GnomeShortcutManager.isValidShortcut(shortcut) && register(shortcut, false),
  };
  manager.initializeGnomeShortcuts = async () => {
    manager.useGnome = true;
    manager.gnomeManager = gnome;
    return true;
  };
  manager.initializeKDEShortcuts = async () => {
    manager.useKDE = true;
    manager.kdeManager = {
      registerKeybinding: (hotkey, _slot, _callback, push) => register(hotkey, push),
      close() {},
    };
    return true;
  };
  const cache = {
    _cachedActivationMode: "tap",
    async setActivationModeCache(mode) {
      if (!(await manager.setActivationMode(mode))) return false;
      this._cachedActivationMode = mode;
      return true;
    },
  };
  const webContents = { executeJavaScript: async () => savedHotkey };
  return {
    manager,
    cache,
    timers,
    registrations,
    gnome,
    window: { isDestroyed: () => false, webContents },
  };
}

// Runs main.js's startup Hold check, the code between createMainWindow() and the
// backend's delayed registration, against the given window manager.
function startupHoldCheck(windowManager, { writes = [], notifications = [] } = {}) {
  const main = fs.readFileSync(path.join(__dirname, "../../main.js"), "utf8");
  const start = main.indexOf("async function dropUnsupportedStartupHold() {");
  assert.notEqual(start, -1);
  const recheck = main.indexOf("async function checkStartupHold() {", start);
  assert.notEqual(recheck, -1);
  const fn = main.slice(start, main.indexOf("\n}\n", recheck) + 3);
  return vm.runInNewContext(`(async () => {${fn}\nawait checkStartupHold();})()`, {
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
async function startWithSavedHold(f, mode) {
  const writes = [];
  const notifications = [];
  await f.cache.setActivationModeCache("push");
  await f.manager.initializeHotkey(f.window, () => {});
  assert.equal(f.timers.length, 1, "the saved hotkey has not registered yet");
  await startupHoldCheck(
    {
      getActivationMode: () => f.cache._cachedActivationMode,
      hotkeyManager: f.manager,
      setActivationModeCache: (next) => f.cache.setActivationModeCache(next),
    },
    { writes, notifications }
  );
  assert.equal(f.cache._cachedActivationMode, mode, "checked before registration");
  assert.deepEqual(f.registrations, [], "nothing registers before the backend does");
  f.timers.shift().callback();
  for (let i = 0; i < 5; i++) await tick();
  return { writes, notifications };
}

for (const backend of ["Hyprland", "GNOME", "KDE"]) {
  for (const hotkey of ["Scrolllock", "Control+Shift+Space"]) {
    test(`${backend} startup keeps a saved Hold for saved ${hotkey}`, async () => {
      const f = fixture(backend, hotkey);
      const { writes, notifications } = await startWithSavedHold(f, "push");
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
    const { writes, notifications } = await startWithSavedHold(f, "tap");
    assert.equal(f.cache._cachedActivationMode, "tap");
    assert.equal(notifications.length, 1);
    assert.deepEqual(writes, [], "the saved Hold is retried next launch");
    // GNOME cannot bind a modifier-only key, so it falls back to F8 in Tap.
    const registered = backend === "GNOME" ? "F8" : "Control+Alt";
    assert.deepEqual(f.registrations, [{ hotkey: registered, push: false }]);
  });
}

const noPortal = "GNOME without the shortcuts portal drops Hold before its key registers";
test(noPortal, async () => {
  const f = fixture("GNOME");
  f.gnome.supportsPushToTalk = () => false;
  const { writes, notifications } = await startWithSavedHold(f, "tap");
  assert.equal(f.cache._cachedActivationMode, "tap");
  assert.equal(notifications.length, 1);
  assert.deepEqual(writes, []);
  assert.deepEqual(f.registrations, [{ hotkey: "Scroll_Lock", push: false }]);
  assert.equal(f.manager.useGnome, true, "the GNOME binding was kept");
});

// The registration delay can elapse while main.js still reads the saved hotkey.
for (const backend of ["GNOME", "Hyprland"]) {
  test(`${backend} drops Hold when its registration starts during the check`, async () => {
    const f = fixture(backend, "Control+Alt");
    const reads = [];
    f.window.webContents.executeJavaScript = () => new Promise((resolve) => reads.push(resolve));
    await f.cache.setActivationModeCache("push");
    await f.manager.initializeHotkey(f.window, () => {});
    const check = startupHoldCheck({
      getActivationMode: () => f.cache._cachedActivationMode,
      hotkeyManager: f.manager,
      setActivationModeCache: (next) => f.cache.setActivationModeCache(next),
    });
    f.timers.shift().callback();
    reads[0]("Control+Alt");
    await check;
    reads[1]("Control+Alt");
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(f.cache._cachedActivationMode, "tap");
    const registered = backend === "GNOME" ? "F8" : "Control+Alt";
    assert.deepEqual(f.registrations, [{ hotkey: registered, push: false }]);
  });
}

// Without its evdev listener a Linux session cannot hold through globalShortcut.
test("KDE that cannot register falls back to globalShortcut and checks Hold again", async () => {
  const f = fixture("KDE", "Scrolllock", false);
  f.manager.nativeListenerProbe = () => ({ available: false, reason: "input_access_denied" });
  f.manager.loadSavedHotkeyOrDefault = async () => {
    f.manager.currentHotkey = "Scrolllock";
    f.manager.emit("hotkey-loaded", "Scrolllock");
  };
  const { writes, notifications } = await startWithSavedHold(f, "push");
  assert.equal(f.manager.isUsingNativeShortcut(), false, "KDE was abandoned");
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.cache._cachedActivationMode, "tap");
  assert.equal(notifications.length, 1);
  assert.deepEqual(writes, []);
});

test("startup Tap fallback preserves the saved preference when registration fails", async () => {
  const notifications = [];
  const writes = [];
  await startupHoldCheck(
    {
      getActivationMode: () => "push",
      hotkeyManager: {
        once() {},
        isUsingNativeShortcut: () => true,
        getSavedDictationHotkey: async () => "Scrolllock",
        supportsPushToTalk: () => false,
      },
      setActivationModeCache: async () => false,
    },
    { writes, notifications }
  );
  assert.equal(writes.length, 0);
  assert.equal(notifications.length, 0);
});

// Without a desktop backend the hotkey registers during startup, and a fallback
// can replace the first saved hotkey, so the registered one decides.
test("startup checks the registered hotkey when no desktop backend delays it", async () => {
  const checked = [];
  const notifications = [];
  await startupHoldCheck(
    {
      getActivationMode: () => "push",
      hotkeyManager: {
        once() {},
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
  const main = fs.readFileSync(path.join(__dirname, "../../main.js"), "utf8");
  const created = main.indexOf("  await windowManager.createMainWindow();\n");
  assert.notEqual(created, -1);
  const next = created + "  await windowManager.createMainWindow();\n".length;
  assert.ok(main.startsWith("  await checkStartupHold();\n", next));
});
