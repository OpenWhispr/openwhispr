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
  };
  manager.showDictationPanel = () => undefined;
  manager.hideDictationPanel = () => {
    sent.push({ channel: "__hide-panel" });
  };
  return { manager, sent };
}

const channels = (sent) => sent.map((message) => message.channel);
const useGestureTimers = (t) => t.mock.timers.enable({ apis: ["setTimeout", "Date"] });

test("a fast second dictation toggle press latches instead of stopping", (t) => {
  useGestureTimers(t);
  const { manager, sent } = makeManager();

  manager.sendToggleDictation();
  manager.setDictationLifecycleState("preparing", "dictation");
  t.mock.timers.tick(250);
  manager.sendToggleDictation();

  assert.deepEqual(channels(sent).filter((channel) => channel === "toggle-dictation").length, 1);

  t.mock.timers.tick(600);
  manager.sendToggleDictation();
  assert.deepEqual(channels(sent).filter((channel) => channel === "toggle-dictation").length, 2);
});

test("a declined start leaves the retry press working", (t) => {
  useGestureTimers(t);
  const { manager, sent } = makeManager();

  // The renderer never reported preparing/recording (mic in use, permission
  // denied): the second press must not be swallowed as a latch.
  manager.sendToggleDictation();
  t.mock.timers.tick(250);
  manager.sendToggleDictation();

  assert.equal(channels(sent).filter((channel) => channel === "toggle-dictation").length, 2);
});

test("a companion-pill toggle is never treated as a double press", (t) => {
  useGestureTimers(t);
  const { manager, sent } = makeManager();

  manager.sendToggleDictation();
  manager.setDictationLifecycleState("preparing", "dictation");
  t.mock.timers.tick(250);
  manager.sendToggleDictation({ applyPressGesture: false });

  assert.equal(channels(sent).filter((channel) => channel === "toggle-dictation").length, 2);
});

test("the tap latch also works once the renderer reports the recording", (t) => {
  useGestureTimers(t);
  const { manager, sent } = makeManager();

  manager.sendToggleDictation();
  manager.setDictationLifecycleState("recording", "dictation");
  t.mock.timers.tick(250);
  manager.sendToggleDictation();

  assert.equal(channels(sent).filter((channel) => channel === "toggle-dictation").length, 1);
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

test("listening mode blocks a native hold press before any side effects", (t) => {
  useGestureTimers(t);
  const { manager, sent } = makeManager();
  manager.hotkeyManager.isInListeningMode = () => true;

  manager.startNativePushToTalk("F8", "dictation");

  assert.deepEqual(sent, []);
  assert.equal(manager.nativePushState, null);
});

test("slot activation modes default to tap and are cached per slot", async () => {
  const { manager } = makeManager();

  assert.equal(manager.getSlotActivationMode("voiceAgent"), "tap");
  assert.equal(manager.getSlotActivationMode("translation"), "tap");
  assert.equal(manager.getSlotActivationMode("meeting"), "tap");

  assert.equal(await manager.setSlotActivationModeCache("voiceAgent", "push"), true);
  assert.equal(manager.getSlotActivationMode("voiceAgent"), "push");
  assert.equal(manager.getSlotActivationMode("translation"), "tap");
});

test("an unsupported Hold request is rejected and reported", async () => {
  const { manager } = makeManager();
  const failures = [];
  manager.hotkeyManager.supportsPushToTalk = () => false;
  manager.hotkeyManager.getPushToTalkUnavailableReason = () => "no hold here";
  manager.hotkeyManager.notifyHotkeyFailure = (hotkey, result) => failures.push({ hotkey, result });

  assert.equal(await manager.setSlotActivationModeCache("voiceAgent", "push"), false);
  assert.equal(manager.getSlotActivationMode("voiceAgent"), "tap");
  assert.equal(failures.length, 1);

  // A slot with no hotkey cannot be verified: Hold is refused, not assumed.
  manager.hotkeyManager.getSlotHotkey = () => null;
  assert.equal(await manager.setSlotActivationModeCache("voiceAgent", "push"), false);

  // The startup restore validates silently — no toast on every launch.
  manager.hotkeyManager.getSlotHotkey = () => "F9";
  assert.equal(
    await manager.setSlotActivationModeCache("voiceAgent", "push", { notifyFailure: false }),
    false
  );
  assert.equal(failures.length, 1);
});

test("reconcileNativeKeyListeners passes the per-slot activation modes", async () => {
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
