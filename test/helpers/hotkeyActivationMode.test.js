const test = require("node:test");
const assert = require("node:assert/strict");

require.cache[require.resolve("electron")] = {
  exports: {
    globalShortcut: {
      register: () => true,
      unregister: () => undefined,
      isRegistered: () => false,
      unregisterAll: () => undefined,
    },
    BrowserWindow: class {
      static getAllWindows() {
        return [];
      }
    },
  },
};

const HotkeyManager = require("../../src/helpers/hotkeyManager");
const GnomeShortcutManager = require("../../src/helpers/gnomeShortcut");

test("native push-to-talk support is hotkey-aware", () => {
  const manager = new HotkeyManager();
  manager.useKDE = true;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    assert.equal(manager.supportsPushToTalk("Control+Super"), false);
    assert.equal(manager.supportsPushToTalk("F8"), true);
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

test("non-dictation slots Hold on KDE and GNOME (portal); only Hyprland refuses", () => {
  const manager = new HotkeyManager();
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    // globalShortcut + evdev listener: every regular key can Hold.
    assert.equal(manager.supportsPushToTalk("F9", "voiceAgent"), true);
    assert.equal(manager.supportsPushToTalk("F7", "translation"), true);

    // KGlobalAccel reports press and release for every action it owns.
    manager.useKDE = true;
    assert.equal(manager.supportsPushToTalk("F9", "voiceAgent"), true);
    assert.equal(manager.supportsPushToTalk("F7", "translation"), true);
    assert.equal(manager.supportsPushToTalk("Control+Super", "voiceAgent"), false);
    assert.equal(manager.supportsPushToTalk("F8", "dictation"), true);

    // GNOME: the GlobalShortcuts portal is the phase source, for every slot.
    manager.useKDE = false;
    manager.useGnome = true;
    manager.gnomeManager = { supportsPushToTalk: () => true };
    assert.equal(manager.supportsPushToTalk("F9", "voiceAgent"), true);
    manager.gnomeManager = { supportsPushToTalk: () => false };
    assert.equal(manager.supportsPushToTalk("F9", "voiceAgent"), false);
    assert.equal(manager.supportsPushToTalk("F8", "dictation"), false);

    // Hyprland binds only the dictation slot, so the others have no phase source.
    manager.useGnome = false;
    manager.gnomeManager = null;
    manager.useHyprland = true;
    assert.equal(manager.supportsPushToTalk("F9", "voiceAgent"), false);
    assert.equal(manager.supportsPushToTalk("F8", "dictation"), true);
    const reason = manager.getPushToTalkUnavailableReason("F9", "voiceAgent");
    assert.equal(typeof reason, "string");
    assert.notEqual(reason, manager.getPushToTalkUnavailableReason("F8", "dictation"));
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

test("setSlotActivationMode verifies Hold, rebinds a GNOME slot via the portal, and rolls back on failure", async () => {
  const manager = new HotkeyManager();
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  const calls = [];
  const failures = [];
  let portalAccepts = true;
  manager.useGnome = true;
  manager.gnomeManager = {
    supportsPushToTalk: () => true,
    registerPushToTalk: async (hotkey, _callback, slotName) => {
      calls.push(["push", slotName, hotkey]);
      return portalAccepts;
    },
    registerKeybinding: async (shortcut, slotName) => {
      calls.push(["tap", slotName, shortcut]);
      return true;
    },
    unregisterKeybinding: async () => true,
    unregisterPushToTalk: async () => undefined,
    setVoiceAgentCallback: () => undefined,
    setTranslationCallback: () => undefined,
    setMeetingCallback: () => undefined,
  };
  manager.notifyHotkeyFailure = (hotkey) => failures.push(hotkey);
  const slot = manager._ensureSlot("voiceAgent");
  slot.hotkeys = ["F9"];
  slot.callback = () => undefined;

  try {
    assert.equal(manager.getSlotActivationMode("voiceAgent"), "tap");

    assert.equal(await manager.setSlotActivationMode("voiceAgent", "push"), true);
    assert.equal(manager.getSlotActivationMode("voiceAgent"), "push");
    assert.deepEqual(calls.at(-1), ["push", "voiceAgent", "F9"]);

    assert.equal(await manager.setSlotActivationMode("voiceAgent", "tap"), true);
    assert.equal(manager.getSlotActivationMode("voiceAgent"), "tap");
    assert.deepEqual(calls.at(-1), ["tap", "voiceAgent", "F9"]);

    // The portal refuses: the mode stays Tap, the gsettings binding comes
    // back, and the user hears about it once.
    portalAccepts = false;
    assert.equal(await manager.setSlotActivationMode("voiceAgent", "push"), false);
    assert.equal(manager.getSlotActivationMode("voiceAgent"), "tap");
    assert.deepEqual(calls.at(-1), ["tap", "voiceAgent", "F9"]);
    assert.deepEqual(failures, ["F9"]);

    // The startup restore validates silently.
    assert.equal(
      await manager.setSlotActivationMode("voiceAgent", "push", { notifyFailure: false }),
      false
    );
    assert.deepEqual(failures, ["F9"]);

    // A slot with no hotkey cannot be verified: Hold is refused, not assumed.
    assert.equal(await manager.setSlotActivationMode("translation", "push"), false);
    // Dictation and meeting are not slot-mode slots.
    assert.equal(await manager.setSlotActivationMode("dictation", "push"), false);
    assert.equal(await manager.setSlotActivationMode("meeting", "push"), false);
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

test("updateHotkey converges a Hold dictation mode to Tap when the new hotkey cannot Hold", async () => {
  const manager = new HotkeyManager();
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  manager.saveHotkeyToRenderer = async () => true;
  manager.notifyActiveHotkey = () => undefined;
  // The capability verdict is the backend's; here only F13 cannot Hold (the
  // shape of a modifier-only combo on a DE-native Linux backend).
  manager.supportsPushToTalk = (hotkey) => hotkey !== "F13";
  try {
    manager.activationMode = "push";
    const converged = await manager.updateHotkey("F13", () => undefined);
    assert.equal(converged.success, true);
    assert.equal(converged.activationMode, "tap");
    assert.equal(manager.activationMode, "tap");
    assert.equal(manager.getCurrentHotkey(), "F13");

    // A hotkey with release detection leaves Hold alone and reports nothing.
    manager.activationMode = "push";
    const kept = await manager.updateHotkey("Command+Period", () => undefined);
    assert.equal(kept.success, true);
    assert.equal(kept.activationMode, undefined);
    assert.equal(manager.activationMode, "push");

    // A registration that fails keeps the stored Hold: nothing changed hands.
    // F13 cannot Hold, so this actually attempts the push→tap demotion and
    // must roll it back on failure, not merely leave an untouched mode alone.
    manager.setupShortcuts = () => ({ success: false, error: "nope" });
    const failed = await manager.updateHotkey("F13", () => undefined);
    assert.equal(failed.success, false);
    assert.equal(manager.activationMode, "push");
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

test("updateHotkey promotes a demoted dictation slot back to Hold when the new hotkey can Hold", async () => {
  const manager = new HotkeyManager();
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  manager.saveHotkeyToRenderer = async () => true;
  manager.notifyActiveHotkey = () => undefined;
  manager.supportsPushToTalk = (hotkey) => hotkey !== "F13";
  try {
    // A slot demoted to Tap for F13 (cannot Hold) comes back to Hold on a
    // hotkey that can — Tap is a verdict about the hotkey, not a choice.
    manager.activationMode = "tap";
    const promoted = await manager.updateHotkey("Command+Period", () => undefined);
    assert.equal(promoted.success, true);
    assert.equal(promoted.activationMode, "push");
    assert.equal(manager.activationMode, "push");

    // A registration that fails keeps Tap: nothing changed hands.
    manager.activationMode = "tap";
    manager.setupShortcuts = () => ({ success: false, error: "nope" });
    const failed = await manager.updateHotkey("Command+Comma", () => undefined);
    assert.equal(failed.success, false);
    assert.equal(manager.activationMode, "tap");
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

test("a failed KDE hotkey change restores the old hotkey under the mode it was registered with", async () => {
  const manager = new HotkeyManager();
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  const calls = [];
  manager.useKDE = true;
  manager.kdeManager = {
    unregisterKeybinding: async () => true,
    registerKeybinding: async (hotkey, _slotName, _callback, isPushToTalk) => {
      calls.push([hotkey, isPushToTalk]);
      // Another app already owns the new hotkey.
      return hotkey === "Control+Shift+Space" ? "conflict" : true;
    },
  };
  manager.notifyActiveHotkey = () => undefined;
  manager.saveHotkeyToRenderer = async () => true;
  // Tap is the correct verdict for a modifier-only hotkey on a DE backend,
  // and it is the mode Control+Super is currently registered under.
  manager.activationMode = "tap";
  manager.currentHotkey = "Control+Super";

  try {
    const result = await manager.updateHotkey("Control+Shift+Space", () => undefined);

    assert.equal(result.success, false);
    // The new hotkey is attempted under its own verdict, Hold ...
    assert.deepEqual(calls[0], ["Control+Shift+Space", true]);
    // ... and the old one goes back under the mode it actually had, Tap.
    // KGlobalAccel refuses a modifier-only shortcut on Hold, so restoring it
    // under the new Hold would leave dictation with no binding at all.
    assert.deepEqual(calls[1], ["Control+Super", false]);
    assert.equal(calls.length, 2);
    // Nothing changed hands, so the mode rolls back too.
    assert.equal(manager.activationMode, "tap");
    assert.equal(manager.getCurrentHotkey(), "Control+Super");
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

test("macOS supports Hold for every hotkey kind, plain keys through the listener's key watch", () => {
  const manager = new HotkeyManager();
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  try {
    for (const hotkey of ["Command+Period", "GLOBE", "RightOption", "MouseButton4", "F13", "F9"]) {
      assert.equal(manager.supportsPushToTalk(hotkey), true, `${hotkey} should Hold`);
    }
    assert.equal(manager.supportsPushToTalk("F13", "voiceAgent"), true);
    // No hotkey to judge yet (early startup): stay permissive.
    assert.equal(manager.supportsPushToTalk(null), true);
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

test("on macOS a plain key on Hold is owned by the native listener, never by globalShortcut", async () => {
  const manager = new HotkeyManager();
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  const { globalShortcut } = require("electron");
  const originalRegister = globalShortcut.register;
  const originalUnregister = globalShortcut.unregister;
  const registered = [];
  const unregistered = [];
  globalShortcut.register = (accelerator) => {
    registered.push(accelerator);
    return true;
  };
  globalShortcut.unregister = (accelerator) => {
    unregistered.push(accelerator);
  };
  try {
    manager.activationMode = "push";
    const held = manager.setupShortcuts("F13", () => undefined, "dictation");
    assert.equal(held.success, true);
    assert.deepEqual(manager.slots.get("dictation").accelerators, [null]);
    assert.deepEqual(registered, []);
    assert.equal(manager.isMacListenerOwnedKey("F13", "dictation"), true);

    // Combos keep the Carbon hot key (modifier-up is their release source).
    const combo = manager.setupShortcuts("Command+Period", () => undefined, "dictation");
    assert.equal(combo.success, true);
    assert.deepEqual(registered, ["Command+Period"]);

    // Flipping to Tap moves a plain key back to globalShortcut, and Hold takes
    // it away again — with the previous accelerator released each time.
    manager.setupShortcuts("F13", () => undefined, "dictation");
    registered.length = 0;
    assert.equal(await manager.setActivationMode("tap"), true);
    assert.deepEqual(manager.slots.get("dictation").accelerators, ["F13"]);
    assert.deepEqual(registered, ["F13"]);
    assert.equal(manager.isMacListenerOwnedKey("F13", "dictation"), false);

    unregistered.length = 0;
    assert.equal(await manager.setActivationMode("push"), true);
    assert.deepEqual(manager.slots.get("dictation").accelerators, [null]);
    assert.ok(unregistered.includes("F13"));

    // The per-slot modes re-register the same way.
    const slot = manager._ensureSlot("voiceAgent");
    manager.setupShortcuts("F14", () => undefined, "voiceAgent");
    assert.deepEqual(slot.accelerators, ["F14"]);
    assert.equal(await manager.setSlotActivationMode("voiceAgent", "push"), true);
    assert.deepEqual(slot.accelerators, [null]);
    assert.equal(await manager.setSlotActivationMode("voiceAgent", "tap"), true);
    assert.deepEqual(slot.accelerators, ["F14"]);
  } finally {
    globalShortcut.register = originalRegister;
    globalShortcut.unregister = originalUnregister;
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

test("a failed activation-mode registration preserves Tap and notifies the user", async () => {
  const manager = new HotkeyManager();
  const failures = [];
  manager.activationMode = "tap";
  manager.useGnome = true;
  manager.currentHotkey = "Alt+R";
  manager.hotkeyCallback = () => undefined;
  manager.gnomeManager = {
    registerPushToTalk: async () => false,
  };
  manager.notifyHotkeyFailure = (hotkey, result) => failures.push({ hotkey, result });

  assert.equal(await manager.setActivationMode("push"), false);
  assert.equal(manager.activationMode, "tap");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].hotkey, "Alt+R");
});

// --- the settled dictation verdict on a DE-native Linux backend ---------
//
// A DE backend is only known after initializeHotkey has detected it, and the
// saved hotkey is only read a second later inside the deferred registration.
// The seam is that setTimeout: capture the callback it schedules, put the
// real timer back, then run the callback — the same order the app runs it in.

function fakeMainWindow() {
  return {
    isDestroyed: () => false,
    webContents: {
      isLoading: () => false,
      once: () => undefined,
      send: () => undefined,
      executeJavaScript: async () => "",
    },
  };
}

// Records which mechanism each hotkey was bound through: "tap" is gsettings,
// "push" is the GlobalShortcuts portal.
function fakeGnomeManager({ portalAvailable = true } = {}) {
  const calls = [];
  return {
    calls,
    api: {
      supportsPushToTalk: () => portalAvailable,
      registerPushToTalk: async (hotkey) => {
        calls.push(["push", hotkey]);
        return true;
      },
      registerKeybinding: async (shortcut) => {
        calls.push(["tap", shortcut]);
        return true;
      },
      unregisterPushToTalk: async () => undefined,
    },
  };
}

async function runDeferredGnomeRegistration(manager) {
  const scheduled = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => {
    scheduled.push(fn);
    return 0;
  };
  try {
    await manager.initializeHotkey(fakeMainWindow(), () => undefined);
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.equal(scheduled.length, 1, "the GNOME backend defers exactly one registration");
  await scheduled[0]();
}

async function withGnomeSession(fn, { savedHotkey, activationMode, portalAvailable = true }) {
  const manager = new HotkeyManager();
  const gnome = fakeGnomeManager({ portalAvailable });
  const announced = [];
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalIsGnome = GnomeShortcutManager.isGnome;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  GnomeShortcutManager.isGnome = () => true;
  manager.activationMode = activationMode;
  manager.getSavedHotkey = async () => savedHotkey;
  // Never touch a real .env: only the fallback path writes one, and a
  // regression here is exactly what sends us down it.
  manager._persistHotkeyToEnvFile = async () => undefined;
  manager.initializeGnomeShortcuts = async () => {
    manager.useGnome = true;
    manager.gnomeManager = gnome.api;
    return true;
  };
  manager.on("dictation-activation-mode-settled", (mode) => announced.push(mode));
  try {
    await runDeferredGnomeRegistration(manager);
    await fn({ manager, announced, bindings: gnome.calls });
  } finally {
    GnomeShortcutManager.isGnome = originalIsGnome;
    Object.defineProperty(process, "platform", originalPlatform);
  }
}

test("GNOME judges the saved hotkey before binding it, so the shipped Linux default survives", async () => {
  await withGnomeSession(
    ({ manager, announced, bindings }) => {
      // Control+Super is modifier-only: a DE backend has no key-up for it,
      // so the Hold seeded before any backend was known must converge to Tap.
      assert.equal(manager.activationMode, "tap");
      assert.deepEqual(announced, ["tap"]);
      // Bound through gsettings as Tap — never offered to the portal (which
      // refuses it outright) and so never dropped into the F8/F9 fallbacks.
      assert.deepEqual(
        bindings.map(([mode]) => mode),
        ["tap"]
      );
      assert.equal(manager.getCurrentHotkey(), "Control+Super");
    },
    { savedHotkey: "Control+Super", activationMode: "push" }
  );
});

test("GNOME leaves a Hold-capable hotkey on Hold and announces nothing", async () => {
  await withGnomeSession(
    ({ manager, announced, bindings }) => {
      assert.equal(manager.activationMode, "push");
      assert.deepEqual(announced, []);
      assert.deepEqual(bindings, [["push", "F8"]]);
    },
    { savedHotkey: "F8", activationMode: "push" }
  );
});

test("GNOME promotes a stored Tap back to Hold once the hotkey can deliver a release", async () => {
  await withGnomeSession(
    ({ manager, announced, bindings }) => {
      assert.equal(manager.activationMode, "push");
      assert.deepEqual(announced, ["push"]);
      assert.deepEqual(bindings, [["push", "F8"]]);
    },
    { savedHotkey: "F8", activationMode: "tap" }
  );
});

test("GNOME without the portal converges even a plain key to Tap", async () => {
  await withGnomeSession(
    ({ manager, announced, bindings }) => {
      assert.equal(manager.activationMode, "tap");
      assert.deepEqual(announced, ["tap"]);
      assert.deepEqual(
        bindings.map(([mode]) => mode),
        ["tap"]
      );
    },
    { savedHotkey: "F8", activationMode: "push", portalAvailable: false }
  );
});
