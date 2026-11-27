const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const React = require("react");
const { createRoot } = require("react-dom/client");
const GnomeShortcutManager = require("../../src/helpers/gnomeShortcut");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const source = fs.readFileSync(path.join(__dirname, "../../src/helpers/hotkeyManager.js"), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(
  backend,
  savedHotkey = "Scrolllock",
  registrationResult = true,
  platform = "linux"
) {
  const timers = [];
  const registrations = [];
  const globalShortcuts = new Map();
  const notifications = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      executeJavaScript: async () => savedHotkey,
      send: (...args) => notifications.push(args),
    },
  };
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
    electron: {
      globalShortcut: {
        register(accelerator, callback) {
          if (globalShortcuts.has(accelerator)) return false;
          globalShortcuts.set(accelerator, callback);
          return true;
        },
        isRegistered: (accelerator) => globalShortcuts.has(accelerator),
        unregister: (accelerator) => globalShortcuts.delete(accelerator),
        unregisterAll: () => globalShortcuts.clear(),
      },
      BrowserWindow: { getAllWindows: () => [window] },
    },
    "./debugLogger": { debug() {}, log() {}, warn() {}, error() {} },
    "./gnomeShortcut": class extends GnomeShortcutManager {
      static isGnome() {
        return backend === "GNOME";
      }
    },
    "./hyprlandShortcut": Hyprland,
    "./kdeShortcut": { isKDE: () => backend === "KDE" },
    "./i18nMain": { i18nMain: { t: (key) => key } },
    "./hotkeyList": require("../../src/helpers/hotkeyList"),
    "./hotkeyRepeatGate": require("../../src/helpers/hotkeyRepeatGate"),
  };
  const context = {
    module: { exports: {} },
    process: { platform, env: {} },
    setTimeout: (callback, delay) => timers.push({ callback, delay }),
    require(name) {
      assert.ok(name in mocks, name);
      return mocks[name];
    },
  };
  vm.runInNewContext(source, context);
  const manager = new context.module.exports();
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
  return {
    manager,
    cache,
    timers,
    registrations,
    gnome,
    env: context.process.env,
    window,
    globalShortcuts,
    notifications,
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
  test(`${backend} registration readiness waits for the actual binding`, async () => {
    let finishRegistration;
    const binding = new Promise((resolve) => {
      finishRegistration = resolve;
    });
    const f = fixture(backend, "Scrolllock", binding);
    await f.cache.setActivationModeCache("push");
    await f.manager.initializeHotkey(f.window, () => {});
    assert.equal(typeof f.manager.registrationReady?.then, "function");
    let ready = false;
    f.manager.registrationReady.then(() => {
      ready = true;
    });
    await tick();
    assert.equal(ready, false, "the registration timer has not fired");
    f.timers.shift().callback();
    await tick();
    assert.equal(ready, false, "the backend has not answered");
    finishRegistration(true);
    await f.manager.registrationReady;
    assert.equal(f.manager.currentHotkey, "Scrolllock");
  });

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

for (const backend of ["GNOME", "Hyprland", "KDE"]) {
  test(`${backend} readiness includes a slow globalShortcut fallback`, async () => {
    const f = fixture(backend, "Scrolllock", false);
    let finishFallback;
    const fallback = new Promise((resolve) => {
      finishFallback = resolve;
    });
    f.manager.loadSavedHotkeyOrDefault = async () => {
      await fallback;
      f.manager.currentHotkey = "F8";
    };
    await f.manager.initializeHotkey(f.window, () => {});
    let ready = false;
    f.manager.registrationReady.then(() => {
      ready = true;
    });
    f.timers.shift().callback();
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(f.manager.isUsingNativeShortcut(), false);
    assert.equal(ready, false, "do not start listeners with the abandoned backend's key");
    finishFallback();
    await f.manager.registrationReady;
    assert.equal(f.manager.currentHotkey, "F8");
  });
}

for (const platform of ["darwin", "win32", "linux"]) {
  test(`${platform} globalShortcut readiness waits for the saved renderer hotkey`, async () => {
    const f = fixture(null, "Control+Space", true, platform);
    let finishRead;
    f.window.webContents.isLoading = () => false;
    f.window.webContents.executeJavaScript = () =>
      new Promise((resolve) => {
        finishRead = resolve;
      });
    f.manager.setupShortcuts = (hotkey) => {
      f.manager.currentHotkey = hotkey;
      return { success: true };
    };
    await f.manager.initializeHotkey(f.window, () => {});
    let ready = false;
    f.manager.registrationReady.then(() => {
      ready = true;
    });
    await tick();
    assert.equal(ready, false);
    finishRead("Control+Space");
    await f.manager.registrationReady;
    assert.equal(f.manager.currentHotkey, "Control+Space");
  });

  test(`${platform} readiness includes an env registration failure's fallback`, async () => {
    const f = fixture(null, "", true, platform);
    f.env.DICTATION_KEY = "F13";
    f.manager.setupShortcuts = () => ({ success: false });
    let finishFallback;
    f.manager.loadSavedHotkeyOrDefault = () =>
      new Promise((resolve) => {
        finishFallback = resolve;
      });
    await f.manager.initializeHotkey(f.window, () => {});
    let ready = false;
    f.manager.registrationReady.then(() => {
      ready = true;
    });
    await tick();
    assert.equal(ready, false);
    finishFallback();
    await f.manager.registrationReady;
    assert.equal(ready, true);
  });

  test(`${platform} env registration is ready without waiting for a document`, async () => {
    const f = fixture(null, "", true, platform);
    f.env.DICTATION_KEY = "Control+Space";
    f.window.webContents.executeJavaScript = () => {
      throw new Error("unexpected renderer read");
    };
    f.manager.setupShortcuts = (hotkey) => {
      f.manager.currentHotkey = hotkey;
      return { success: true };
    };
    await f.manager.initializeHotkey(f.window, () => {});
    await f.manager.registrationReady;
    assert.equal(f.manager.currentHotkey, "Control+Space");
  });
}

test("globalShortcut readiness includes document load before a renderer lookup", async () => {
  const f = fixture(null);
  let documentLoaded;
  f.window.webContents.isLoading = () => true;
  f.window.webContents.once = (event, callback) => {
    assert.equal(event, "did-finish-load");
    documentLoaded = callback;
  };
  f.manager.setupShortcuts = (hotkey) => {
    f.manager.currentHotkey = hotkey;
    return { success: true };
  };
  await f.manager.initializeHotkey(f.window, () => {});
  let ready = false;
  f.manager.registrationReady.then(() => {
    ready = true;
  });
  await tick();
  assert.equal(ready, false);
  documentLoaded();
  await f.manager.registrationReady;
  assert.equal(f.manager.currentHotkey, "Scrolllock");
});

// gnomeShortcut.js answers with a reason when the keymap leaves GNOME nothing to grab.
test("GNOME startup falls back to F8 when GNOME can't grab the saved key", async () => {
  const f = fixture("GNOME", "F19");
  const register = f.gnome.registerKeybinding;
  f.gnome.registerKeybinding = async (shortcut) =>
    shortcut === "F19" ? "keysym_missing" : register(shortcut);
  await f.manager.initializeHotkey(f.window, () => {});
  f.timers.shift().callback();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.manager.currentHotkey, "F8");
  assert.deepEqual(f.registrations, [{ hotkey: "F8", push: false }]);
});

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

async function triggerWindowsListenerStartupFailure(fixtureState, writes) {
  const { cache, manager, window } = fixtureState;
  const main = fs.readFileSync(path.join(__dirname, "../../main.js"), "utf8");
  const helpers = main.slice(
    main.indexOf("async function dropUnsupportedStartupHold() {"),
    main.indexOf("// Main application startup")
  );
  const start = main.indexOf(
    "  // Windows and Linux share the same native low-level key listener model"
  );
  const listenerSetup = main.slice(start, main.indexOf("\n}\n", start));
  const windowsKeyManager = new EventEmitter();
  vm.runInNewContext(`${helpers}\n${listenerSetup}`, {
    process: { platform: "win32" },
    hotkeyManager: manager,
    windowsKeyManager,
    windowManager: {
      hotkeyManager: manager,
      mainWindow: window,
      getActivationMode: () => cache._cachedActivationMode,
      setActivationModeCache: (mode) => cache.setActivationModeCache(mode),
      resetWindowsPushState() {},
      initializeNativeKeyListeners: async () => {},
    },
    isLiveWindow: (candidate) => candidate && !candidate.isDestroyed(),
    environmentManager: { saveActivationMode: (mode) => writes.push(mode) },
    debugLogger: { debug() {}, warn() {} },
    i18nMain: { t: (key) => key },
    BrowserWindow: { getAllWindows: () => [window] },
    ipcMain: { on() {} },
  });
  manager.nativeListenerProbe = () => ({ available: false, reason: "startup_failed" });
  windowsKeyManager.emit("startup-failed");
  await tick();
}

for (const { savedHotkey, activeHotkeys } of [
  { savedHotkey: "Control+Super", activeHotkeys: ["F9"] },
  { savedHotkey: "Control+Super,F7,F10", activeHotkeys: ["F7", "F10"] },
  { savedHotkey: "Control+Shift+Space", activeHotkeys: ["Control+Shift+Space"] },
]) {
  test(`Windows startup failure keeps ${savedHotkey} saved and enables ${activeHotkeys.join(",")} in Tap`, async () => {
    const f = fixture(null, savedHotkey, true, "win32");
    const triggered = [];
    const writes = [];
    f.env.DICTATION_KEY = savedHotkey;
    f.env.ACTIVATION_MODE = "push";
    f.manager._persistHotkeyToEnvFile = (hotkey) => writes.push(hotkey);
    const meetingCallback = () => {};
    await f.manager.registerSlot("meeting", "F8", meetingCallback);
    const meetingBinding = f.globalShortcuts.get("F8");
    await f.cache.setActivationModeCache("push");
    await f.manager.initializeHotkey(f.window, (hotkey) => {
      if (f.cache._cachedActivationMode === "tap") triggered.push(hotkey);
    });
    f.notifications.length = 0;
    await triggerWindowsListenerStartupFailure(f, writes);

    assert.equal(f.cache._cachedActivationMode, "tap");
    assert.ok(f.notifications.some(([event]) => event === "windows-ptt-unavailable"));
    assert.ok(
      f.notifications.some(
        ([event, data]) =>
          event === "setting-updated" &&
          data.key === "activationMode" &&
          data.value === "tap" &&
          data.persist === false
      )
    );
    assert.deepEqual(Array.from(f.manager.getSlotHotkeys("dictation")), activeHotkeys);
    for (const hotkey of activeHotkeys) f.globalShortcuts.get(hotkey)();
    assert.deepEqual(triggered, activeHotkeys);
    assert.equal(f.globalShortcuts.get("F8"), meetingBinding, "leave the other slot bound");
    if (savedHotkey.startsWith("Control+Super")) {
      assert.ok(
        f.notifications.some(
          ([event, data]) =>
            event === "hotkey-fallback-used" && data.fallback === activeHotkeys.join(",")
        )
      );
    }
    assert.equal(f.env.DICTATION_KEY, savedHotkey);
    assert.equal(f.env.ACTIVATION_MODE, "push");
    assert.deepEqual(writes, []);
  });
}

test("recreating the Windows dictation window after startup failure keeps the saved shortcut", async () => {
  const f = fixture(null, "Control+Super", true, "win32");
  const writes = [];
  f.env.DICTATION_KEY = "Control+Super";
  f.manager._persistHotkeyToEnvFile = async (hotkey) => writes.push(hotkey);
  const callback = () => {};
  await f.manager.registerSlot("meeting", "F8", callback);
  await f.manager.initializeHotkey(f.window, callback);
  await triggerWindowsListenerStartupFailure(f, writes);

  await f.manager.initializeHotkey(f.window, callback);
  await f.manager.registrationReady;

  assert.equal(f.manager.getCurrentHotkey(), "F9");
  assert.equal(f.env.DICTATION_KEY, "Control+Super");
  assert.deepEqual(writes, []);
});

for (const fallbackTiming of ["before hydration", "during hydration", "after hydration"]) {
  test(`the renderer shows the Tap fallback and keeps preferences when recovery happens ${fallbackTiming}`, async (t) => {
    let settingUpdated;
    let dictationKeyActive;
    let recovered = fallbackTiming === "before hydration";
    const recover = () => {
      recovered = true;
      settingUpdated?.({ key: "activationMode", value: "tap", persist: false });
      dictationKeyActive?.("F9");
    };
    const { storage } = installBrowserGlobals(t, {
      initialStorage: { activationMode: "push", dictationKey: "Control+Super" },
      window: {
        electronAPI: {
          getActivationMode: async () => (recovered ? "tap" : "push"),
          getActiveDictationKey: async () => (recovered ? "F9" : "Control+Super"),
          async getTranslationKey() {
            if (fallbackTiming === "during hydration") recover();
            return "";
          },
          setDictionary: async () => ({ success: true }),
          onSettingUpdated(callback) {
            settingUpdated = callback;
          },
          onDictationKeyActive(callback) {
            dictationKeyActive = callback;
          },
        },
      },
    });
    const vite = await createRendererServer(t, { cachePrefix: "openwhispr-hotkey-startup-" });
    const { initializeSettings, useSettingsStore } = await vite.ssrLoadModule(
      "/stores/settingsStore.ts"
    );
    await initializeSettings();
    if (fallbackTiming === "after hydration") recover();

    assert.equal(useSettingsStore.getState().activationMode, "tap");
    assert.equal(useSettingsStore.getState().activeDictationKey, "F9");
    assert.equal(storage.getItem("activationMode"), "push");
    assert.equal(storage.getItem("dictationKey"), "Control+Super");
  });
}

test("Windows Settings stops offering Hold when the listener fails to start", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  let available = true;
  let listenerUnavailable;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getHotkeyModeInfo: async () => ({
          isUsingNativeShortcut: false,
          isUsingHyprland: false,
          supportsPushToTalk: available,
          pushToTalkUnavailableReason: available ? null : "Windows key listener unavailable",
        }),
        onWindowsPushToTalkUnavailable(callback) {
          listenerUnavailable = callback;
          return () => {
            listenerUnavailable = undefined;
          };
        },
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-hotkey-settings-" });
  const { useHotkeyModeInfo } = await vite.ssrLoadModule("/hooks/useHotkeyModeInfo.ts");
  let modeInfo;
  function Settings() {
    modeInfo = useHotkeyModeInfo("settings", "F9");
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Settings)));
  assert.equal(modeInfo.supportsPushToTalk, true);

  available = false;
  await React.act(async () => listenerUnavailable?.({ reason: "startup_failed" }));
  assert.equal(modeInfo.supportsPushToTalk, false);
});

test("a rejected Windows Hold retry does not save the session's Tap mode", async () => {
  const main = fs.readFileSync(path.join(__dirname, "../../main.js"), "utf8");
  const handler = main.slice(
    main.indexOf("  let activationModeChangeQueue"),
    main.indexOf('  ipcMain.on("floating-icon-auto-hide-changed"')
  );
  let onModeChanged;
  const notifications = [];
  const window = {
    isDestroyed: () => false,
    webContents: { send: (...args) => notifications.push(args) },
  };
  vm.runInNewContext(handler, {
    process: { platform: "win32" },
    windowsKeyManager: {
      checkAvailability: () => ({ available: false, reason: "startup_failed" }),
    },
    windowManager: {
      setActivationModeCache: async () => false,
      getActivationMode: () => "tap",
      resetWindowsPushState() {},
      reconcileNativeKeyListeners() {},
    },
    BrowserWindow: { getAllWindows: () => [window] },
    ipcMain: {
      on: (_event, callback) => {
        onModeChanged = callback;
      },
    },
  });
  onModeChanged(null, "push");
  await tick();
  assert.equal(notifications[0]?.[1].persist, false);
});
