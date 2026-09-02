const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Same stub set as windowManagerAssistantPanel.test.js: WindowManager pulls in
// electron + sibling managers at require time.
const originalLoad = Module._load;
Module._load = function loadWindowManagerWithStubs(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { on: () => undefined },
      screen: {
        getPrimaryDisplay: () => ({}),
        getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
        getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
        on: () => undefined,
      },
      BrowserWindow: class FakeBrowserWindow {
        constructor() {
          this.webContents = { on: () => undefined, send: () => undefined };
        }
        on() {}
        isDestroyed() {
          return false;
        }
      },
      shell: {},
      dialog: {},
    };
  }
  if (request === "./debugLogger")
    return { warn: () => undefined, debug: () => undefined, log: () => undefined };
  if (request === "./hotkeyManager") {
    const FakeHotkeyManager = class {
      unregisterAll() {}
      isInListeningMode() {
        return false;
      }
    };
    FakeHotkeyManager.isGlobeLikeHotkey = () => false;
    return FakeHotkeyManager;
  }
  if (request === "./dragManager")
    return class {
      cleanup() {}
    };
  if (request === "./menuManager") return {};
  if (request === "./devServerManager")
    return {
      DEV_SERVER_PORT: 5173,
      DEV_SERVER_URL: "http://localhost:5173",
      getAppFilePath: () => ({ path: "/app/index.html", query: {} }),
      waitForDevServer: async () => undefined,
    };
  if (request === "./dockManager") return {};
  if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
  if (request === "./windowConfig") {
    return {
      MAIN_WINDOW_CONFIG: {},
      CONTROL_PANEL_CONFIG: {},
      NOTIFICATION_WINDOW_CONFIG: {},
      AUTO_END_NOTIFICATION_WINDOW_SIZE: { width: 620, height: 116 },
      getMeetingNotificationWindowSize: () => ({ width: 392, height: 92 }),
      WINDOW_SIZES: { BASE: { width: 96, height: 96 } },
      ONBOARDING_WINDOW_SIZES: {
        COMPACT: { width: 480, height: 624 },
        EXPANDED: { width: 1000, height: 740 },
      },
      WindowPositionUtil: {
        setupAlwaysOnTop: () => undefined,
        clampToWorkArea: (bounds) => bounds,
        getMainWindowPosition: (_display, size) => ({ x: 0, y: 0, ...size }),
        getNotificationPosition: () => ({ x: 0, y: 0 }),
      },
      fitAssistantWindowToWorkArea: (size) => size,
      fitAssistantContentWindowToWorkArea: (height) => ({ width: 466, height }),
      fitDictationErrorWindowToWorkArea: (size) => size,
      fitDictationErrorContentWindowToWorkArea: (height) => ({ width: 466, height }),
      resolveHorizontalWindowDirection: () => "right",
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const WindowManager = require("../../src/helpers/windowManager");
Module._load = originalLoad;

function makeManager() {
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  const sent = [];
  manager.mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
  manager.hotkeyManager = {
    isInListeningMode: () => false,
    getCurrentHotkey: () => "F8",
    supportsPushToTalk: () => true,
    getSlotHotkey: () => "F9",
    setSlotActivationMode: async () => true,
  };
  manager.showDictationPanel = () => undefined;
  manager.hideDictationPanel = () => {
    sent.push({ channel: "__hide-panel" });
  };
  return { manager, sent };
}

const channels = (sent) => sent.map((message) => message.channel);
const useGestureTimers = (t) => t.mock.timers.enable({ apis: ["setTimeout", "Date"] });

test("tap mode never latches: a fast second toggle press stops the recording", (t) => {
  useGestureTimers(t);
  const { manager, sent } = makeManager();

  // Hands-free lives in Hold mode only. In Tap mode a single press already
  // starts an unlimited recording, so a fast second press must keep its
  // ordinary meaning (stop) instead of being swallowed as a double press.
  manager.sendToggleDictation();
  manager.setDictationLifecycleState("recording", "dictation");
  t.mock.timers.tick(250);
  manager.sendToggleDictation();

  assert.equal(channels(sent).filter((channel) => channel === "toggle-dictation").length, 2);
});

test("toggle presses of different kinds keep their normal meaning", (t) => {
  useGestureTimers(t);
  const { manager, sent } = makeManager();

  manager.sendToggleDictation();
  t.mock.timers.tick(250);
  manager.sendToggleVoiceAgent();

  assert.deepEqual(
    channels(sent).filter((channel) => channel.startsWith("toggle")),
    ["toggle-dictation", "toggle-voice-agent"]
  );
});

test("an assistant push session prepares, starts and stops with its own input kind", (t) => {
  useGestureTimers(t);
  const { manager, sent } = makeManager();

  manager.startNativePushToTalk("F9", "assistant");
  t.mock.timers.tick(150);
  manager.handleNativePushKeyUp("F9");

  assert.deepEqual(sent, [
    { channel: "prepare-dictation", payload: { inputKind: "assistant" } },
    { channel: "start-dictation", payload: { inputKind: "assistant" } },
    { channel: "stop-dictation", payload: undefined },
  ]);
});

test("a quick push release keeps the preparation warm through the double-press window", (t) => {
  useGestureTimers(t);
  const { manager, sent } = makeManager();

  manager.startNativePushToTalk("F8", "dictation");
  t.mock.timers.tick(80);
  manager.handleNativePushKeyUp("F8");

  assert.equal(channels(sent).includes("cancel-dictation-preparation"), false);

  t.mock.timers.tick(400);
  assert.equal(channels(sent).includes("cancel-dictation-preparation"), true);
  assert.equal(channels(sent).includes("__hide-panel"), true);
});

test("a double press in hold mode latches a hands-free recording", (t) => {
  useGestureTimers(t);
  const { manager, sent } = makeManager();

  manager.startNativePushToTalk("F8", "dictation");
  manager.setDictationLifecycleState("preparing", "dictation");
  t.mock.timers.tick(80);
  manager.handleNativePushKeyUp("F8");
  t.mock.timers.tick(170);
  manager.startNativePushToTalk("F8", "dictation");

  assert.equal(channels(sent).includes("start-dictation"), true);

  // The release of the latching press must not stop the recording, and the
  // deferred preparation cancel must never fire.
  manager.handleNativePushKeyUp("F8");
  t.mock.timers.tick(1000);
  assert.equal(channels(sent).includes("stop-dictation"), false);
  assert.equal(channels(sent).includes("cancel-dictation-preparation"), false);

  t.mock.timers.tick(5000);
  manager.startNativePushToTalk("F8", "dictation");
  assert.equal(channels(sent).includes("stop-dictation"), true);
});

test("a hold press for a blocked kind produces no session and no spurious stop", (t) => {
  useGestureTimers(t);
  const { manager, sent } = makeManager();
  manager._assistantPanelBusy = true;

  manager.startNativePushToTalk("F9", "assistant");
  t.mock.timers.tick(150);
  manager.handleNativePushKeyUp("F9");

  assert.deepEqual(sent, []);
  assert.equal(manager.nativePushState, null);
});

test("a stale deferred cancel never tears down another kind's preparation", (t) => {
  useGestureTimers(t);
  const { manager, sent } = makeManager();

  manager.startNativePushToTalk("F8", "dictation");
  manager.setDictationLifecycleState("preparing", "dictation");
  t.mock.timers.tick(80);
  manager.handleNativePushKeyUp("F8");

  // Before the dictation cancel timer fires, the assistant takes the pipeline.
  t.mock.timers.tick(220);
  manager.startNativePushToTalk("F9", "assistant");
  manager.setDictationLifecycleState("preparing", "assistant");

  t.mock.timers.tick(400);
  assert.equal(channels(sent).includes("cancel-dictation-preparation"), false);
  assert.equal(channels(sent).includes("__hide-panel"), false);
});

test("a latch is demoted to a plain press while another kind is recording", (t) => {
  useGestureTimers(t);
  const { manager, sent } = makeManager();
  manager.setDictationLifecycleState("recording", "assistant");

  manager.startNativePushToTalk("F8", "dictation");
  t.mock.timers.tick(80);
  manager.handleNativePushKeyUp("F8");
  t.mock.timers.tick(170);
  manager.startNativePushToTalk("F8", "dictation");

  assert.equal(manager._pressGesture.isHandsFreeActive("dictation"), false);
  assert.equal(channels(sent).includes("stop-dictation"), false);
});

test("a settings change mid-latch stops the hands-free recording", (t) => {
  useGestureTimers(t);
  const { manager, sent } = makeManager();

  manager.startNativePushToTalk("F8", "dictation");
  manager.setDictationLifecycleState("preparing", "dictation");
  t.mock.timers.tick(80);
  manager.handleNativePushKeyUp("F8");
  t.mock.timers.tick(170);
  manager.startNativePushToTalk("F8", "dictation");
  manager.setDictationLifecycleState("recording", "dictation");

  manager.resetNativePushState();

  assert.equal(channels(sent).includes("stop-dictation"), true);
  assert.equal(manager._pressGesture.isHandsFreeActive("dictation"), false);
});

test("a settings change with a pending quick-release cancels the preparation", (t) => {
  useGestureTimers(t);
  const { manager, sent } = makeManager();

  manager.startNativePushToTalk("F8", "dictation");
  t.mock.timers.tick(80);
  manager.handleNativePushKeyUp("F8");

  manager.resetNativePushState();

  assert.equal(channels(sent).includes("cancel-dictation-preparation"), true);
  assert.equal(channels(sent).includes("__hide-panel"), true);
});

test("a latch blocked by a busy assistant panel unwinds the warm preparation", (t) => {
  useGestureTimers(t);
  const { manager, sent } = makeManager();

  manager.startNativePushToTalk("F9", "assistant");
  manager.setDictationLifecycleState("preparing", "assistant");
  t.mock.timers.tick(80);
  manager.handleNativePushKeyUp("F9");

  // The panel turns busy inside the double-press window (an earlier assistant
  // request came back), so the would-be latch cannot start anything — and the
  // deferred cancel it consumed can no longer fire on its own.
  manager._assistantPanelBusy = true;
  t.mock.timers.tick(170);
  manager.startNativePushToTalk("F9", "assistant");

  assert.equal(manager._pressGesture.isHandsFreeActive("assistant"), false);
  assert.equal(channels(sent).includes("start-dictation"), false);
  assert.equal(channels(sent).includes("cancel-dictation-preparation"), true);

  // No phantom latch remains to turn a later press into a stop of nothing.
  t.mock.timers.tick(1000);
  assert.equal(channels(sent).includes("stop-dictation"), false);
});

test("boot demotes a dictation Hold whose hotkey cannot Hold on this backend", async () => {
  const { manager } = makeManager();
  manager.hotkeyManager.setActivationMode = async () => true;
  // The boot restore accepted "push" against the default hotkey before the
  // real one loaded (the legacy macOS push + plain-key combination).
  manager.hotkeyManager.getCurrentHotkey = () => "F13";
  manager.hotkeyManager.supportsPushToTalk = (hotkey) => hotkey !== "F13";
  await manager.setActivationModeCache("push");

  assert.equal(await manager.demoteUnsupportedDictationHold(), true);
  assert.equal(manager.getActivationMode(), "tap");

  // A hotkey with release detection keeps its Hold.
  manager.hotkeyManager.getCurrentHotkey = () => "Command+Period";
  await manager.setActivationModeCache("push");
  assert.equal(await manager.demoteUnsupportedDictationHold(), false);
  assert.equal(manager.getActivationMode(), "push");

  // Tap mode is left alone.
  await manager.setActivationModeCache("tap");
  assert.equal(await manager.demoteUnsupportedDictationHold(), false);
  assert.equal(manager.getActivationMode(), "tap");
});

test("resetNativePushState never cancels another kind's fresh preparation", (t) => {
  useGestureTimers(t);
  const { manager, sent } = makeManager();

  manager.startNativePushToTalk("F8", "dictation");
  manager.setDictationLifecycleState("preparing", "dictation");
  t.mock.timers.tick(80);
  manager.handleNativePushKeyUp("F8");

  // Before the deferred dictation cancel fires, an assistant tap-toggle takes
  // the pipeline; the flush must skip its stale, kind-blind cancel exactly
  // like the deferred timer itself would.
  t.mock.timers.tick(100);
  manager.sendToggleVoiceAgent();
  manager.setDictationLifecycleState("preparing", "assistant");

  manager.resetNativePushState();

  assert.equal(channels(sent).includes("cancel-dictation-preparation"), false);
  assert.equal(channels(sent).includes("__hide-panel"), false);
});

test("listening mode blocks a native hold press before any side effects", (t) => {
  useGestureTimers(t);
  const { manager, sent } = makeManager();
  manager.hotkeyManager.isInListeningMode = () => true;

  manager.startNativePushToTalk("F8", "dictation");

  assert.deepEqual(sent, []);
  assert.equal(manager.nativePushState, null);
});

test("slot activation modes default to tap and follow the hotkey manager's verdict", async () => {
  const { manager } = makeManager();
  const requests = [];
  manager.hotkeyManager.setSlotActivationMode = async (slotName, mode, options) => {
    requests.push([slotName, mode, options?.notifyFailure]);
    return slotName !== "translation";
  };

  assert.equal(manager.getSlotActivationMode("voiceAgent"), "tap");
  assert.equal(manager.getSlotActivationMode("translation"), "tap");
  assert.equal(manager.getSlotActivationMode("meeting"), "tap");

  assert.equal(await manager.setSlotActivationModeCache("voiceAgent", "push"), true);
  assert.equal(manager.getSlotActivationMode("voiceAgent"), "push");

  // The hotkey manager owns the capability check and the backend rebind; a
  // refusal leaves the cache untouched.
  assert.equal(
    await manager.setSlotActivationModeCache("translation", "push", { notifyFailure: false }),
    false
  );
  assert.equal(manager.getSlotActivationMode("translation"), "tap");
  assert.deepEqual(requests, [
    ["voiceAgent", "push", true],
    ["translation", "push", false],
  ]);

  assert.equal(await manager.setSlotActivationModeCache("meeting", "push"), false);
});

test("reconcileNativeKeyListeners passes the per-slot activation modes", async (t) => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", originalPlatform));
  const { manager } = makeManager();
  let captured = null;
  manager.hotkeyManager.isUsingNativeShortcut = () => false;
  manager.hotkeyManager.getNativeListenerKeys = (mode, slotModes) => {
    captured = { mode, slotModes };
    return [];
  };
  await manager.setSlotActivationModeCache("voiceAgent", "push");

  manager.reconcileNativeKeyListeners();

  assert.equal(captured.slotModes.voiceAgent, "push");
  assert.equal(captured.slotModes.translation, "tap");
});

test("on macOS reconcileNativeKeyListeners hands off to the listener sync hook", (t) => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", originalPlatform));
  const { manager } = makeManager();
  let synced = 0;
  manager.onMacListenerReconcile = () => {
    synced += 1;
  };
  manager.hotkeyManager.getNativeListenerKeys = () => {
    throw new Error("the Windows/Linux listener path must not run on macOS");
  };

  manager.reconcileNativeKeyListeners();
  assert.equal(synced, 1);

  // Hotkey capture stops every listener; the hook is not called then.
  manager.hotkeyManager.isInListeningMode = () => true;
  manager.reconcileNativeKeyListeners();
  assert.equal(synced, 1);
});

test("a renderer idle report clears the hands-free latch", (t) => {
  useGestureTimers(t);
  const { manager, sent } = makeManager();

  manager.startNativePushToTalk("F9", "assistant");
  manager.setDictationLifecycleState("preparing", "assistant");
  t.mock.timers.tick(80);
  manager.handleNativePushKeyUp("F9");
  t.mock.timers.tick(170);
  manager.startNativePushToTalk("F9", "assistant");
  manager.setDictationLifecycleState("recording", "assistant");

  // The recording ended through another path (Escape, UI stop, mic error).
  manager.setDictationLifecycleState("idle");
  sent.length = 0;

  t.mock.timers.tick(1000);
  manager.startNativePushToTalk("F9", "assistant");
  assert.equal(channels(sent).includes("stop-dictation"), false);
  assert.equal(channels(sent).includes("prepare-dictation"), true);
});

test("an interrupt right after a latch cancels the accidental recording", (t) => {
  useGestureTimers(t);
  const { manager, sent } = makeManager();

  manager.startNativePushToTalk("F8", "dictation");
  manager.setDictationLifecycleState("preparing", "dictation");
  t.mock.timers.tick(80);
  manager.handleNativePushKeyUp("F8");
  t.mock.timers.tick(170);
  manager.startNativePushToTalk("F8", "dictation");

  t.mock.timers.tick(300);
  assert.equal(manager.interruptPushGesture("dictation"), "cancel-recording");
  assert.equal(channels(sent).includes("cancel-hotkey-pressed"), true);
});

test("stopHandsFreeSession ends a latched recording on demand", (t) => {
  useGestureTimers(t);
  const { manager, sent } = makeManager();

  manager.startNativePushToTalk("GLOBE", "dictation");
  manager.setDictationLifecycleState("preparing", "dictation");
  t.mock.timers.tick(80);
  manager.handleNativePushKeyUp("GLOBE");
  t.mock.timers.tick(170);
  manager.startNativePushToTalk("GLOBE", "dictation");

  assert.equal(manager.isHandsFreeActive("dictation"), true);
  manager.stopHandsFreeSession("dictation");
  assert.equal(channels(sent).includes("stop-dictation"), true);
  assert.equal(manager.isHandsFreeActive("dictation"), false);
  // A second call is a no-op.
  manager.stopHandsFreeSession("dictation");
  assert.equal(channels(sent).filter((channel) => channel === "stop-dictation").length, 1);
});

test("an interrupted native push session is cancelled, not transcribed", (t) => {
  useGestureTimers(t);
  const { manager, sent } = makeManager();

  manager.startNativePushToTalk("GLOBE", "assistant");
  t.mock.timers.tick(150);
  manager.interruptNativePushSession("GLOBE");

  assert.equal(channels(sent).includes("cancel-hotkey-pressed"), true);
  assert.equal(channels(sent).includes("stop-dictation"), false);
  assert.equal(manager.nativePushState, null);

  // A session on another key is left alone.
  manager.startNativePushToTalk("F9", "assistant");
  manager.interruptNativePushSession("GLOBE");
  assert.equal(manager.nativePushState?.active, true);
});

test("the dictation hotkey callback drives compound push-to-talk with the slot's kind", async (t) => {
  useGestureTimers(t);
  const { manager, sent } = makeManager();
  await manager.setSlotActivationModeCache("voiceAgent", "push");

  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    const callback = manager.createHotkeyCallback("assistant");
    await callback("Command+Period", undefined);
    t.mock.timers.tick(150);
    manager.handleMacPushModifierUp("command");
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
  }

  assert.deepEqual(sent, [
    { channel: "prepare-dictation", payload: { inputKind: "assistant" } },
    { channel: "start-dictation", payload: { inputKind: "assistant" } },
    { channel: "stop-dictation", payload: undefined },
  ]);
});

test("the assistant hotkey callback toggles normally while its slot stays on tap", async () => {
  const { manager, sent } = makeManager();

  const callback = manager.createHotkeyCallback("assistant");
  await callback("F9", undefined);

  assert.equal(channels(sent).includes("toggle-voice-agent"), true);
});
