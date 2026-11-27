const { withDevicePolicy } = require("./harness/devicePolicy");
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

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
    handle: (channel, handler) => handlers.set(channel, handler),
    on: () => {},
    removeHandler: () => {},
  },
  net: { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }

    static fromWebContents() {
      return null;
    }
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (
    parent?.filename === handlersModulePath &&
    (request.startsWith("./") || request.startsWith("../"))
  ) {
    return anything();
  }
  return originalLoad.call(this, request, parent, isMain);
};

function anything() {
  return new Proxy(function () {}, {
    get: (_target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

// A real HotkeyManager answers for Hold; only its backend and the listener
// probe are faked.
const HotkeyManager = require("../../src/helpers/hotkeyManager");

const inputDenied = () => ({ available: false, reason: "input_access_denied" });
let hotkeyManager;

test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const target = {
    windowManager: {
      get hotkeyManager() {
        return hotkeyManager;
      },
      isUsingGnomeHotkeys: () => hotkeyManager.isUsingGnome(),
      isUsingHyprlandHotkeys: () => hotkeyManager.isUsingHyprland(),
      isUsingKDEHotkeys: () => hotkeyManager.isUsingKDE(),
      isUsingNativeShortcutHotkeys: () => hotkeyManager.isUsingNativeShortcut(),
      getActivationMode: () => "tap",
    },
    environmentManager: { getActivationMode: () => "push" },
  };
  IPCHandlers.prototype.setupHandlers.call(
    withDevicePolicy(
      new Proxy(target, {
        get: (value, property) => (property in value ? value[property] : anything()),
      })
    )
  );
});

test.after(() => {
  Module._load = originalLoad;
});

// The handler decides everything before its first await, so the patched
// platform covers the whole answer.
function hotkeyModeInfo(backend, platform = "linux", hotkey = "F8") {
  hotkeyManager = Object.assign(new HotkeyManager(), {
    isInitialized: true,
    nativeListenerProbe: inputDenied,
    nativeListenerSupportsExactModifiers: () => true,
    ...backend,
  });
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return handlers.get("get-hotkey-mode-info")({}, hotkey);
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

// GNOME (portal), KDE and Hyprland deliver press and release themselves, so a
// user without /dev/input access can still hold, and the setup box would send
// them to run sudo for nothing.
const DESKTOP_BACKENDS = {
  GNOME: { useGnome: true, gnomeManager: { supportsPushToTalk: () => true } },
  KDE: { useKDE: true },
  Hyprland: { useHyprland: true },
};

for (const [desktop, backend] of Object.entries(DESKTOP_BACKENDS)) {
  test(`${desktop} holds without the evdev listener, so no input setup is shown`, async () => {
    const info = await hotkeyModeInfo(backend);

    assert.equal(info.supportsPushToTalk, true);
    assert.equal(info.linuxInputAccessDenied, false);
  });
}

// Desktop backends can't hold a modifier-only chord, so the reason must ask for
// a regular key rather than blame a conflict (#1977).
for (const [desktop, backend] of Object.entries(DESKTOP_BACKENDS)) {
  test(`${desktop} says Hold needs a regular key for a modifier-only hotkey`, async () => {
    const info = await hotkeyModeInfo(backend, "linux", "Control+Super");

    assert.equal(info.supportsPushToTalk, false);
    assert.match(info.pushToTalkUnavailableReason, /regular key/);
    assert.doesNotMatch(info.pushToTalkUnavailableReason, /reserved/);
  });
}

// GNOME holds only through its GlobalShortcuts portal, which has nothing to do
// with OpenWhispr's own key listener.
test("GNOME without the shortcuts portal names the portal, not the key listener", async () => {
  const info = await hotkeyModeInfo({
    useGnome: true,
    gnomeManager: { supportsPushToTalk: () => false },
  });

  assert.equal(info.supportsPushToTalk, false);
  assert.match(info.pushToTalkUnavailableReason, /GNOME 48/);
  assert.doesNotMatch(info.pushToTalkUnavailableReason, /listener/);
});

test("GNOME without the portal names the portal even for a modifier-only hotkey", async () => {
  const info = await hotkeyModeInfo(
    { useGnome: true, gnomeManager: { supportsPushToTalk: () => false } },
    "linux",
    "Control+Super"
  );

  assert.match(info.pushToTalkUnavailableReason, /GNOME 48/);
  assert.doesNotMatch(info.pushToTalkUnavailableReason, /regular key/);
});

test("without a desktop backend, denied input access reaches the renderer", async () => {
  const info = await hotkeyModeInfo({});

  assert.equal(info.supportsPushToTalk, false);
  assert.equal(info.linuxInputAccessDenied, true);
  assert.match(info.pushToTalkUnavailableReason, /usermod/);
});

// Windows holds only through windows-key-listener.exe, which a build can lack
// (#2005). The Linux input-access setup box never applies there.
test("Windows without its key listener reports Hold unavailable", async () => {
  const info = await hotkeyModeInfo(
    { nativeListenerProbe: () => ({ available: false, reason: "binary_missing" }) },
    "win32"
  );

  assert.equal(info.supportsPushToTalk, false);
  assert.equal(info.pushToTalkUnavailableReason, "OpenWhispr's key listener isn't available.");
  assert.equal(info.linuxInputAccessDenied, false);
});

test("Windows with its key listener still offers Hold", async () => {
  const info = await hotkeyModeInfo({ nativeListenerProbe: () => ({ available: true }) }, "win32");

  assert.equal(info.supportsPushToTalk, true);
  assert.equal(info.pushToTalkUnavailableReason, null);
});

// Startup may fall back to Tap for the session while keeping a saved Hold for
// the next launch. A window that syncs afterwards must show the mode in effect.
test("renderers read the activation mode in effect, not the saved preference", async () => {
  assert.equal(await handlers.get("get-activation-mode")({}), "tap");
});

test("an unsupported macOS secondary binding disables only double-tap", async () => {
  const info = await hotkeyModeInfo({}, "darwin", "GLOBE,F8");

  assert.equal(info.supportsPushToTalk, true);
  assert.equal(info.pushToTalkUnavailableReason, null);
  assert.match(info.doubleTapUnavailableReason, /F8.*key releases/);
});

test("double-tap stays available when all active macOS bindings can release", async () => {
  const info = await hotkeyModeInfo({}, "darwin", "GLOBE,RightOption");

  assert.equal(info.doubleTapUnavailableReason, null);
});

test("Linux native shortcuts check the single binding the backend registers", async () => {
  const info = await hotkeyModeInfo(DESKTOP_BACKENDS.KDE, "linux", "F8,Control+Super");

  assert.equal(info.doubleTapUnavailableReason, null);
});

test("Linux desktop-native double-tap does not depend on the evdev key parser", async () => {
  const info = await hotkeyModeInfo(DESKTOP_BACKENDS.KDE, "linux", "Control+Left");

  assert.equal(info.doubleTapUnavailableReason, null);
});

test("combined mode requires a terminal key macOS can see released", async () => {
  const compound = await hotkeyModeInfo({}, "darwin", "Control+Space");
  assert.equal(compound.doubleTapUnavailableReason, null);

  const modifierOnly = await hotkeyModeInfo({}, "darwin", "Control+Shift");
  assert.equal(modifierOnly.supportsPushToTalk, true);
  assert.match(modifierOnly.doubleTapUnavailableReason, /Control\+Shift.*key releases/);
});

test("unavailable macOS keyboard monitoring disables only double-tap", async () => {
  const info = await hotkeyModeInfo(
    { getMacKeyboardMonitorStatus: () => "unavailable" },
    "darwin",
    "GLOBE,RightOption"
  );

  assert.equal(info.supportsPushToTalk, true);
  assert.equal(info.pushToTalkUnavailableReason, null);
  assert.match(info.doubleTapUnavailableReason, /keyboard monitor/i);
});

test("pending and ready macOS keyboard monitoring do not disable double-tap", async () => {
  for (const status of ["pending", "ready"]) {
    const info = await hotkeyModeInfo(
      { getMacKeyboardMonitorStatus: () => status },
      "darwin",
      "GLOBE,RightOption"
    );

    assert.equal(info.doubleTapUnavailableReason, null);
  }
});

for (const platform of ["win32", "linux"]) {
  test(`${platform} modifier-only bindings disable double-tap while keeping Hold`, async () => {
    const backend = { nativeListenerProbe: () => ({ available: true }) };

    for (const binding of ["RightControl", "Control+Super", "Control+RightShift"]) {
      const info = await hotkeyModeInfo(backend, platform, binding);

      assert.equal(info.supportsPushToTalk, true);
      assert.equal(info.pushToTalkUnavailableReason, null);
      assert.match(info.doubleTapUnavailableReason, /non-modifier key/);
      assert.ok(info.doubleTapUnavailableReason.includes(binding));
    }
  });

  test(`${platform} an older listener still supports Hold but cannot offer double-tap`, async () => {
    const info = await hotkeyModeInfo(
      {
        nativeListenerProbe: () => ({ available: true }),
        nativeListenerSupportsExactModifiers: () => false,
      },
      platform,
      "Control+Space"
    );

    assert.equal(info.supportsPushToTalk, true);
    assert.match(info.doubleTapUnavailableReason, /updated key listener/);
  });

  test(`${platform} double-tap stays available for a chord with a regular key`, async () => {
    const backend = { nativeListenerProbe: () => ({ available: true }) };
    const info = await hotkeyModeInfo(backend, platform, "Control+Shift+Space");

    assert.equal(info.doubleTapUnavailableReason, null);
  });

  test(`${platform} double-tap requires a chord the raw key parser can match exactly`, async () => {
    const backend = { nativeListenerProbe: () => ({ available: true }) };

    const clipped = `${"Ctrl+".repeat(52)}Space`;
    for (const binding of ["Control+Left", "RightControl+A", "Control+\tSpace", clipped]) {
      const info = await hotkeyModeInfo(backend, platform, binding);

      assert.equal(info.supportsPushToTalk, true);
      assert.match(info.doubleTapUnavailableReason, /non-modifier key/);
      assert.ok(info.doubleTapUnavailableReason.includes(binding));
    }
  });

  test(`${platform} a modifier-only secondary binding disables double-tap`, async () => {
    const backend = { nativeListenerProbe: () => ({ available: true }) };
    const info = await hotkeyModeInfo(backend, platform, "Control+Shift+Space,RightControl");

    assert.equal(info.supportsPushToTalk, true);
    assert.match(info.doubleTapUnavailableReason, /RightControl/);
  });
}

test("mode info without a candidate uses the registered dictation list", async () => {
  const info = await hotkeyModeInfo(
    { currentHotkey: "GLOBE", getSlotHotkeys: () => ["GLOBE", "F8"] },
    "darwin",
    null
  );

  assert.match(info.doubleTapUnavailableReason, /F8.*key releases/);
});
