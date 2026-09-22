const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { i18nMain, changeLanguage } = require("../../src/helpers/i18nMain");

// The get-hotkey-mode-info handler is what the Settings ActivationModeSelector
// rows actually read: hotkeyManager.supportsPushToTalk being honest is not
// enough if the IPC never routes its answer to the renderer.

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;

const handlers = new Map();

const electronStub = {
  app: {
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: () => {},
    removeHandler: () => {},
  },
  net: { fetch: async () => ({ ok: true, json: async () => ({}) }) },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }
    static fromWebContents() {
      return null;
    }
  },
  globalShortcut: {
    register: () => true,
    unregister: () => undefined,
    isRegistered: () => false,
    unregisterAll: () => undefined,
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  return originalLoad.call(this, request, parent, isMain);
};

// Registration only stores closures, so every manager the mode-info handler
// does not touch can be an inert stub (same pattern as
// retryTranscriptionHandler.test.js).
function anything() {
  return new Proxy(function () {}, {
    get: (t, prop) => {
      if (prop === Symbol.toPrimitive || prop === "toString") return () => "";
      if (prop === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

let updateHotkeyResult = { success: true, message: "ok" };
const savedActivationModes = [];

function buildFakeThis(hotkeyManager) {
  const windowManager = new Proxy(
    {
      hotkeyManager,
      isUsingNativeShortcutHotkeys: () => hotkeyManager.isUsingNativeShortcut(),
      isUsingGnomeHotkeys: () => false,
      isUsingHyprlandHotkeys: () => false,
      isUsingKDEHotkeys: () => false,
      updateHotkey: async () => updateHotkeyResult,
    },
    { get: (t, prop) => (prop in t ? t[prop] : anything()) }
  );
  const environmentManager = new Proxy(
    { saveActivationMode: (mode) => savedActivationModes.push(mode) },
    { get: (t, prop) => (prop in t ? t[prop] : anything()) }
  );
  const target = { windowManager, environmentManager, linuxKeyManager: null };
  return new Proxy(target, {
    get: (t, prop) => (prop in t ? t[prop] : anything()),
  });
}

let modeInfoHandler;
let updateHotkeyHandler;
let HotkeyManager;
let sharedHotkeyManager;
test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  HotkeyManager = require("../../src/helpers/hotkeyManager");
  sharedHotkeyManager = new HotkeyManager();
  Ctor.prototype.setupHandlers.call(buildFakeThis(sharedHotkeyManager));
  modeInfoHandler = handlers.get("get-hotkey-mode-info");
  updateHotkeyHandler = handlers.get("update-hotkey");
  assert.ok(modeInfoHandler, "get-hotkey-mode-info must be registered");
  assert.ok(updateHotkeyHandler, "update-hotkey must be registered");
});

test.after(() => {
  Module._load = originalLoad;
});

const withPlatform = async (platform, fn) => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
};

test("macOS mode info reports a plain single key as Hold-capable (listener key watch)", async () => {
  await withPlatform("darwin", async () => {
    const info = await modeInfoHandler({ sender: {} }, "F13", "dictation");
    assert.equal(info.supportsPushToTalk, true);
    assert.equal(info.pushToTalkUnavailableReason, null);

    const slotInfo = await modeInfoHandler({ sender: {} }, "F13", "voiceAgent");
    assert.equal(slotInfo.supportsPushToTalk, true);
  });
});

test("macOS mode info keeps Hold available for hotkeys with release detection", async () => {
  await withPlatform("darwin", async () => {
    for (const hotkey of ["Command+Period", "GLOBE", "RightOption", "MouseButton4", "F9"]) {
      const info = await modeInfoHandler({ sender: {} }, hotkey, "dictation");
      assert.equal(info.supportsPushToTalk, true, `${hotkey} should support Hold`);
      assert.equal(info.pushToTalkUnavailableReason, null);
    }
  });
});

test("Windows mode info keeps every regular hotkey Hold-capable", async () => {
  await withPlatform("win32", async () => {
    for (const [hotkey, slot] of [
      ["F13", "dictation"],
      ["F9", "voiceAgent"],
      ["Control+Shift+T", "translation"],
    ]) {
      const info = await modeInfoHandler({ sender: {} }, hotkey, slot);
      assert.equal(info.supportsPushToTalk, true, `${hotkey}/${slot} should support Hold`);
    }
  });
});

test("Linux DE-native mode info offers Hold to the assistant and translation slots", async () => {
  await withPlatform("linux", async () => {
    sharedHotkeyManager.useKDE = true;
    try {
      for (const [hotkey, slot] of [
        ["F9", "voiceAgent"],
        ["Control+Shift+T", "translation"],
      ]) {
        const info = await modeInfoHandler({ sender: {} }, hotkey, slot);
        assert.equal(info.supportsPushToTalk, true, `${hotkey}/${slot} should support Hold`);
      }
      const modifierOnly = await modeInfoHandler({ sender: {} }, "Control+Super", "voiceAgent");
      assert.equal(modifierOnly.supportsPushToTalk, false);
    } finally {
      sharedHotkeyManager.useKDE = false;
    }

    sharedHotkeyManager.useHyprland = true;
    try {
      const info = await modeInfoHandler({ sender: {} }, "F9", "voiceAgent");
      assert.equal(info.supportsPushToTalk, false);
      assert.equal(typeof info.pushToTalkUnavailableReason, "string");
    } finally {
      sharedHotkeyManager.useHyprland = false;
    }
  });
});

test("update-hotkey persists a Hold-to-Tap convergence reported by the manager", async () => {
  updateHotkeyResult = { success: true, message: "ok", activationMode: "tap" };
  savedActivationModes.length = 0;
  const result = await updateHotkeyHandler({ sender: {} }, "F13");
  assert.equal(result.activationMode, "tap");
  assert.deepEqual(savedActivationModes, ["tap"]);

  // An ordinary update touches no mode.
  updateHotkeyResult = { success: true, message: "ok" };
  await updateHotkeyHandler({ sender: {} }, "Command+Period");
  assert.deepEqual(savedActivationModes, ["tap"]);
});

test("an empty optional shortcut checks its backend without borrowing the dictation key", async () => {
  await withPlatform("linux", async () => {
    const originalHotkey = sharedHotkeyManager.getCurrentHotkey;
    sharedHotkeyManager.getCurrentHotkey = () => "Control+Super";
    sharedHotkeyManager.useKDE = true;
    try {
      assert.equal((await modeInfoHandler({ sender: {} })).supportsPushToTalk, false);
      for (const slot of ["voiceAgent", "translation"]) {
        assert.equal((await modeInfoHandler({ sender: {} }, "", slot)).supportsPushToTalk, true);
      }
      sharedHotkeyManager.useKDE = false;
      sharedHotkeyManager.useHyprland = true;
      assert.equal(
        (await modeInfoHandler({ sender: {} }, "", "translation")).supportsPushToTalk,
        false
      );
    } finally {
      sharedHotkeyManager.getCurrentHotkey = originalHotkey;
      sharedHotkeyManager.useKDE = false;
      sharedHotkeyManager.useHyprland = false;
    }
  });
});

test("mode info uses a normalized requested language without changing the main language", async () => {
  changeLanguage("de");
  sharedHotkeyManager.useKDE = true;
  try {
    await withPlatform("linux", async () => {
      const english = await modeInfoHandler({ sender: {} }, "Control+Super", "dictation", "en");
      assert.match(english.pushToTalkUnavailableReason, /has no regular key/);
      assert.equal(i18nMain.language, "de");

      for (const language of [undefined, null, 42, "de-DE"]) {
        const german = await modeInfoHandler(
          { sender: {} },
          "Control+Super",
          "dictation",
          language
        );
        assert.match(german.pushToTalkUnavailableReason, /enthält keine normale Taste/);
        assert.equal(german.supportsPushToTalk, false);
        assert.equal(german.isUsingNativeShortcut, true);
        assert.equal(i18nMain.language, "de");
      }

      const supported = await modeInfoHandler({ sender: {} }, "F9", "translation", "en");
      assert.equal(supported.supportsPushToTalk, true);
      assert.equal(supported.pushToTalkUnavailableReason, null);
      assert.equal(supported.isUsingNativeShortcut, true);
      assert.equal(i18nMain.language, "de");
    });
  } finally {
    sharedHotkeyManager.useKDE = false;
    changeLanguage("en");
  }
});

test("every unavailable Hold explanation honors its request language", async () => {
  changeLanguage("en");
  const german = require("../../src/locales/de/translation.json");
  try {
    await withPlatform("linux", async () => {
      sharedHotkeyManager.useHyprland = true;
      const hyprland = await modeInfoHandler({ sender: {} }, "F9", "voiceAgent", "de");
      assert.equal(hyprland.supportsPushToTalk, false);
      assert.equal(
        hyprland.pushToTalkUnavailableReason,
        german.hotkey.errors.holdUnsupportedOnHyprland
      );

      sharedHotkeyManager.useHyprland = false;
      sharedHotkeyManager.useGnome = true;
      sharedHotkeyManager.gnomeManager = { supportsPushToTalk: () => false };
      const gnome = await modeInfoHandler({ sender: {} }, "F9", "translation", "de");
      assert.equal(gnome.supportsPushToTalk, false);
      assert.equal(
        gnome.pushToTalkUnavailableReason,
        german.hotkey.errors.holdUnsupportedOnDesktop
      );

      sharedHotkeyManager.useGnome = false;
      sharedHotkeyManager.gnomeManager = null;
      const evdev = await modeInfoHandler({ sender: {} }, "F9", "dictation", "de");
      assert.equal(evdev.supportsPushToTalk, false);
      assert.equal(evdev.pushToTalkUnavailableReason, german.windows.pttUnavailable);
      assert.equal(i18nMain.language, "en");
    });
  } finally {
    sharedHotkeyManager.useHyprland = false;
    sharedHotkeyManager.useGnome = false;
    sharedHotkeyManager.gnomeManager = null;
    changeLanguage("en");
  }
});

test("mounted Settings guidance changes language before preference synchronization completes", async (t) => {
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  const {
    createRendererServer,
    installBrowserGlobals,
    installHookDom,
  } = require("../lib/rendererTestHarness");
  let root;
  let rendererI18n;
  const pendingLanguageSyncs = [];
  const requests = [];
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    if (rendererI18n) await rendererI18n.changeLanguage("en");
    sharedHotkeyManager.useKDE = false;
    changeLanguage("en");
  });
  sharedHotkeyManager.useKDE = true;
  changeLanguage("en");
  installBrowserGlobals(t, {
    initialStorage: { uiLanguage: "en" },
    window: {
      electronAPI: {
        getHotkeyModeInfo: async (hotkey, slot, language) => {
          requests.push({ hotkey, slot, language });
          return withPlatform("linux", () =>
            modeInfoHandler({ sender: {} }, hotkey, slot, language)
          );
        },
        setUiLanguage: (language) =>
          new Promise((resolve) => pendingLanguageSyncs.push({ language, resolve })),
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t);
  ({ default: rendererI18n } = await vite.ssrLoadModule("/i18n.ts"));
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { useHotkeyModeInfo } = await vite.ssrLoadModule("/hooks/useHotkeyModeInfo.ts");
  let result;
  function SettingsLifetimeHarness() {
    result = useHotkeyModeInfo("settings", "Control+Super", "dictation");
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(SettingsLifetimeHarness)));
  assert.match(result.pushToTalkUnavailableReason, /has no regular key/);

  await React.act(async () => useSettingsStore.getState().setUiLanguage("de"));
  assert.equal(rendererI18n.resolvedLanguage, "de");
  assert.equal(i18nMain.language, "en", "the main preference has not caught up");
  assert.equal(pendingLanguageSyncs.length, 1);
  assert.equal(pendingLanguageSyncs[0].language, "de");
  assert.equal(result.loaded, true);
  assert.match(result.pushToTalkUnavailableReason, /enthält keine normale Taste/);
  assert.deepEqual(requests.at(-1), { hotkey: "Control+Super", slot: "dictation", language: "de" });

  changeLanguage("de");
  await React.act(async () => pendingLanguageSyncs[0].resolve({ success: true, language: "de" }));
  await React.act(async () => useSettingsStore.getState().setUiLanguage("en"));
  assert.equal(i18nMain.language, "de");
  assert.match(result.pushToTalkUnavailableReason, /has no regular key/);
  assert.equal(result.loaded, true);
  assert.equal(pendingLanguageSyncs.length, 2);
  await React.act(async () => pendingLanguageSyncs[1].resolve({ success: true, language: "en" }));
});

async function linuxDiagnosticHarness(t) {
  const fs = require("node:fs");
  const statSync = fs.statSync;
  const helper = { present: true };
  t.mock.method(fs, "statSync", (candidate, ...args) => {
    if (String(candidate).includes("linux-key-listener")) {
      if (!helper.present) {
        throw Object.assign(new Error("helper not installed"), { code: "ENOENT" });
      }
      return { isFile: () => true };
    }
    return statSync(candidate, ...args);
  });
  const LinuxKeyManager = require("../../src/helpers/linuxKeyManager");
  const manager = await withPlatform("linux", async () => new LinuxKeyManager());
  const context = buildFakeThis(sharedHotkeyManager);
  context.linuxKeyManager = manager;
  const IPCHandlers = require(handlersModulePath);
  (IPCHandlers.default || IPCHandlers).prototype.setupHandlers.call(context);
  const handler = handlers.get("get-hotkey-mode-info");
  return {
    manager,
    helper,
    query: (platform = "linux", hotkey = "Control+Shift+Space", slot = "dictation") =>
      withPlatform(platform, () => handler({ sender: {} }, hotkey, slot)),
  };
}

test("mode info distinguishes real binary absence from observed permission denial", async (t) => {
  const { manager, helper, query } = await linuxDiagnosticHarness(t);
  helper.present = false;
  let info = await query();
  assert.equal(info.supportsPushToTalk, false);
  assert.equal(info.linuxPttPermissionDenied, false);
  assert.equal(typeof info.pushToTalkUnavailableReason, "string");

  helper.present = true;
  info = await query();
  assert.equal(info.supportsPushToTalk, true);
  assert.equal(info.linuxPttPermissionDenied, false);
  manager.handleOutputLine("NO_PERMISSION", "Control+Shift+Space");
  manager.handleOutputLine("READY", "Control+Shift+Space");
  for (let reopen = 0; reopen < 2; reopen += 1) {
    info = await query();
    assert.equal(
      info.supportsPushToTalk,
      true,
      "the diagnostic preserves the existing capability API"
    );
    assert.equal(info.linuxPttPermissionDenied, true);
  }
  helper.present = false;
  info = await query();
  assert.equal(info.supportsPushToTalk, false);
  assert.equal(
    info.linuxPttPermissionDenied,
    false,
    "a missing helper cannot be repaired with permissions"
  );
});

test("a Linux helper denial does not change native desktop or other platform capability answers", async (t) => {
  const { manager, query } = await linuxDiagnosticHarness(t);
  manager.handleOutputLine("NO_PERMISSION", "F9");
  for (const platform of ["darwin", "win32"]) {
    const info = await query(platform, "F9");
    assert.equal(info.supportsPushToTalk, true);
    assert.equal(info.linuxPttPermissionDenied, false);
  }
  for (const backend of ["useKDE", "useGnome", "useHyprland"]) {
    sharedHotkeyManager[backend] = true;
    try {
      for (const slot of ["dictation", "voiceAgent", "translation"]) {
        const info = await query("linux", "F9", slot);
        assert.equal(info.linuxPttPermissionDenied, false, `${backend}/${slot}`);
        assert.equal(info.supportsPushToTalk, backend !== "useHyprland" || slot === "dictation");
      }
    } finally {
      sharedHotkeyManager[backend] = false;
    }
  }
});

test("binary lookup through IPC renders only proven Linux permission repairs in Settings and onboarding", async (t) => {
  const { manager, helper, query } = await linuxDiagnosticHarness(t);
  const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
  const React = require("react");
  const { createInstance } = require("i18next");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { I18nextProvider } = await import("react-i18next");
  installBrowserGlobals(t);
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: require("../../src/locales/en/translation.json") } },
    interpolation: { escapeValue: false },
  });
  const vite = await createRendererServer(t);
  const { SettingsHotkeyException, SettingsHotkeyGestureGuide } = await vite.ssrLoadModule(
    "/components/settings/SettingsHotkeyGuidance.tsx"
  );
  const { default: OnboardingHotkeyGestureCard } = await vite.ssrLoadModule(
    "/components/onboarding/OnboardingHotkeyGestureCard.tsx"
  );
  const render = (info) => {
    const slot = {
      name: "dictation",
      hotkey: "Control+Shift+Space",
      mode: "push",
      info: { ...info, loaded: true, hyprlandConfigStatus: null },
      pending: false,
    };
    return {
      settings: renderToStaticMarkup(
        React.createElement(
          I18nextProvider,
          { i18n },
          React.createElement(SettingsHotkeyGestureGuide, { slots: [slot], platform: "linux" }),
          React.createElement(SettingsHotkeyException, { slot, platform: "linux" })
        )
      ),
      onboarding: renderToStaticMarkup(
        React.createElement(
          I18nextProvider,
          { i18n },
          React.createElement(OnboardingHotkeyGestureCard, {
            confirmed: true,
            slot: "dictation",
            hotkey: slot.hotkey,
            mode: "push",
            platform: "linux",
            ...info,
          })
        )
      ),
    };
  };

  helper.present = false;
  assert.equal(manager.isAvailable(), false);
  for (const markup of Object.values(render(await query()))) {
    assert.match(markup, /Press to start, press again to stop/);
    assert.match(markup, /Push-to-Talk native listener not available/);
    assert.doesNotMatch(
      markup,
      /sudo usermod|Your user needs access|Hold to speak|Start hands-free/
    );
  }
  helper.present = true;
  for (const markup of Object.values(render(await query()))) {
    assert.match(markup, /Hold to speak/);
    assert.doesNotMatch(markup, /sudo usermod/);
  }
  manager.handleOutputLine("NO_PERMISSION", "Control+Shift+Space");
  manager.handleOutputLine("READY", "Control+Shift+Space");
  manager.stop();
  for (let reopen = 0; reopen < 2; reopen += 1) {
    for (const markup of Object.values(render(await query()))) {
      assert.match(markup, /Press to start, press again to stop/);
      assert.match(markup, /Your user needs access to keyboard input devices/);
      assert.equal((markup.match(/sudo usermod/g) || []).length, 1);
      assert.doesNotMatch(markup, /Hold to speak|Start hands-free/);
    }
  }
});
