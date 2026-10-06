const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const createdWindows = [];
let devServerWaitPromise = Promise.resolve();

class FakeBrowserWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    this.loadDeferred = createDeferred();
    this.messages = [];
    this.loadUrlCount = 0;
    this.showCount = 0;
    this.ignoreMouseEvents = [];
    this.webContents = {
      send: (channel, payload) => this.messages.push({ channel, payload }),
    };
    createdWindows.push(this);
  }

  setContentProtection() {}

  setIgnoreMouseEvents(ignore, options) {
    this.ignoreMouseEvents.push({ ignore, options });
  }

  loadFile() {
    return this.loadDeferred.promise;
  }

  loadURL() {
    this.loadUrlCount += 1;
    return Promise.resolve();
  }

  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("closed");
  }

  isDestroyed() {
    return this.destroyed;
  }

  showInactive() {
    this.showCount += 1;
  }
}

class FakeHotkeyManager {
  unregisterAll() {}

  isInListeningMode() {
    return false;
  }
}
FakeHotkeyManager.isGlobeLikeHotkey = () => false;

class FakeDragManager {
  cleanup() {}
}

const originalLoad = Module._load;
Module._load = function loadWindowManagerWithStubs(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { on: () => undefined },
      screen: { getPrimaryDisplay: () => ({}), on: () => undefined },
      BrowserWindow: FakeBrowserWindow,
      shell: {},
      dialog: {},
    };
  }
  if (request === "./debugLogger") {
    return {
      info: () => undefined,
      warn: () => undefined,
      debug: () => undefined,
      error: () => undefined,
    };
  }
  if (request === "./hotkeyManager") return FakeHotkeyManager;
  if (request === "./dragManager") return FakeDragManager;
  if (request === "./menuManager") return {};
  if (request === "./devServerManager") {
    return {
      DEV_SERVER_PORT: 5173,
      DEV_SERVER_URL: "http://localhost:5173",
      getAppFilePath: () => ({ path: "/app/index.html", query: {} }),
      waitForDevServer: () => devServerWaitPromise,
    };
  }
  if (request === "./dockManager") return {};
  if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
  if (request === "./windowConfig") {
    const notificationSize = { width: 392, height: 92 };
    return {
      MAIN_WINDOW_CONFIG: {},
      CONTROL_PANEL_CONFIG: {},
      NOTIFICATION_WINDOW_CONFIG: { ...notificationSize, acceptFirstMouse: true },
      WINDOW_SIZES: {},
      WindowPositionUtil: {
        getNotificationPosition: () => ({
          ...notificationSize,
          x: 1000 - notificationSize.width,
          y: 16,
        }),
        setupAlwaysOnTop: () => undefined,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const WindowManager = require("../../src/helpers/windowManager");
const { getNotificationTimeoutMs } = require("../../src/helpers/notificationTimer");
Module._load = originalLoad;

const notificationWindowFor = (index) => createdWindows[index];

function createNormalWindowManager() {
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  return manager;
}

function installFakeTimers() {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let nextTimerId = 1;
  const timers = new Map();

  global.setTimeout = (callback, delay = 0) => {
    const timerId = nextTimerId;
    nextTimerId += 1;
    timers.set(timerId, { callback, delay });
    return timerId;
  };
  global.clearTimeout = (timerId) => timers.delete(timerId);

  return {
    pendingCount: () => timers.size,
    pendingDelays: () => [...timers.values()].map(({ delay }) => delay),
    runDelay: (delay) => {
      for (const [timerId, timer] of [...timers]) {
        if (timer.delay !== delay) continue;
        timers.delete(timerId);
        timer.callback();
      }
    },
    runAll: () => {
      for (const [timerId, { callback }] of [...timers]) {
        timers.delete(timerId);
        callback();
      }
    },
    restore: () => {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    },
  };
}

test.beforeEach(() => {
  createdWindows.length = 0;
});

test("native push-to-talk force-stops after the safety timeout", () => {
  const timers = installFakeTimers();
  const manager = createNormalWindowManager();
  let starts = 0;
  let stops = 0;
  manager.showDictationPanel = () => undefined;
  manager.hideDictationPanel = () => undefined;
  manager.sendPrepareDictation = () => undefined;
  manager.sendCancelDictationPreparation = () => undefined;
  manager.sendStartDictation = () => {
    starts += 1;
  };
  manager.sendStopDictation = () => {
    stops += 1;
  };

  try {
    manager.startWindowsPushToTalk("F8");
    assert.deepEqual(
      timers.pendingDelays().sort((left, right) => left - right),
      [150, 300000]
    );

    timers.runDelay(150);
    assert.equal(starts, 1);
    timers.runDelay(300000);
    assert.equal(stops, 1);
    assert.equal(manager.winPushState, null);
  } finally {
    timers.restore();
  }
});

test("a failed activation-mode change preserves the cached mode", async () => {
  const manager = createNormalWindowManager();
  manager.hotkeyManager.setActivationMode = async () => false;

  assert.equal(await manager.setActivationModeCache("push"), false);
  assert.equal(manager.getActivationMode(), "tap");
});

test("a busy Assistant blocks its voice hotkey before native side effects", () => {
  const manager = createNormalWindowManager();
  const rendererChannels = [];
  let showCount = 0;
  let prepareCount = 0;
  manager.mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel) => rendererChannels.push(channel) },
  };
  manager.hotkeyManager = {
    isInListeningMode: () => false,
    unregisterAll: () => undefined,
  };
  manager.textEditMonitor = { captureTargetPid: () => Promise.resolve(null) };
  manager.selectionManager = { captureTarget: () => undefined };
  manager.showDictationPanel = () => {
    showCount += 1;
  };
  manager.sendPrepareDictation = () => {
    prepareCount += 1;
  };
  // Initial Assistant thinking happens before the response panel opens; busy
  // state must stand on its own during that part of the journey.
  manager._assistantPanelOpen = false;
  manager._assistantPanelBusy = true;

  manager.sendToggleVoiceAgent();
  // Before the panel opens there is no companion pill to show a plain
  // recording either, so the busy state blocks ordinary dictation too.
  manager.sendToggleDictation();

  assert.equal(showCount, 0);
  assert.equal(prepareCount, 0);
  assert.deepEqual(rendererChannels, []);

  // The open panel alone is not enough: until the companion window is live,
  // a recording would still be invisible, so the press only re-kicks its load.
  manager._assistantPanelOpen = true;
  let pillShowCalls = 0;
  manager.showAgentDictationPill = () => {
    pillShowCalls += 1;
  };
  manager.sendToggleDictation();

  assert.equal(showCount, 0);
  assert.deepEqual(rendererChannels, []);
  assert.equal(pillShowCalls, 1);

  manager._agentDictationPillReady = true;
  manager.agentDictationPillWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    webContents: { send: () => undefined },
  };
  manager.sendToggleDictation();

  assert.equal(showCount, 1);
  assert.equal(prepareCount, 1);
  assert.deepEqual(rendererChannels, ["toggle-dictation"]);
  assert.equal(pillShowCalls, 1);

  manager._assistantPanelBusy = false;
  manager.sendToggleVoiceAgent();

  assert.equal(showCount, 2);
  assert.equal(prepareCount, 2);
  assert.deepEqual(rendererChannels, ["toggle-dictation", "toggle-voice-agent"]);
});

test("push-to-talk dictation follows the companion pill's availability", () => {
  const manager = createNormalWindowManager();
  const rendererChannels = [];
  let showCount = 0;
  manager.mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel) => rendererChannels.push(channel) },
  };
  manager.hotkeyManager = {
    isInListeningMode: () => false,
    unregisterAll: () => undefined,
  };
  manager._dictationLifecycleState = "idle";
  manager._assistantPanelOpen = false;
  manager._assistantPanelBusy = true;
  manager.textEditMonitor = { captureTargetPid: () => Promise.resolve(null) };
  manager.selectionManager = { captureTarget: () => undefined };
  manager.showDictationPanel = () => {
    showCount += 1;
  };

  // Busy without an open panel: no surface could show the recording.
  manager.sendPrepareDictation();
  manager.sendStartDictation();

  assert.equal(showCount, 0);
  assert.deepEqual(rendererChannels, []);

  // An open panel whose companion window is not live yet keeps PTT dictation
  // blocked; each press re-kicks the companion load.
  manager._assistantPanelOpen = true;
  let pillShowCalls = 0;
  manager.showAgentDictationPill = () => {
    pillShowCalls += 1;
  };
  manager.sendPrepareDictation();
  manager.sendStartDictation();

  assert.equal(showCount, 0);
  assert.deepEqual(rendererChannels, []);
  assert.equal(pillShowCalls, 2);

  // With a live companion pill, PTT dictation flows again.
  manager._agentDictationPillReady = true;
  manager.agentDictationPillWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    webContents: { send: () => undefined },
  };
  manager.sendPrepareDictation();
  manager.sendStartDictation();

  assert.equal(showCount, 1);
  assert.deepEqual(rendererChannels, ["prepare-dictation", "start-dictation"]);
});

test("a stop press probes the target again instead of reusing the start press's", () => {
  const manager = createNormalWindowManager();
  const captures = [];
  manager.mainWindow = { isDestroyed: () => false, webContents: { send: () => undefined } };
  manager.hotkeyManager = {
    isInListeningMode: () => false,
    unregisterAll: () => undefined,
  };
  manager.textEditMonitor = { captureTargetPid: () => Promise.resolve(null) };
  manager.selectionManager = { captureTarget: (options) => captures.push(options) };
  manager.showDictationPanel = () => undefined;
  manager.sendPrepareDictation = () => undefined;

  manager.sendToggleDictation();
  manager.setDictationLifecycleState("recording");
  manager.sendToggleDictation();

  assert.deepEqual(captures, [{ force: false }, { force: true }]);
});

test("window manager starts fail-closed and suppresses normal-app popup surfaces", async () => {
  const manager = new WindowManager();

  assert.equal(manager.isMeetingInputAllowed(), false);
  assert.equal(await manager.showMeetingNotification({ detectionId: "onboarding" }), false);
  assert.equal(await manager.showTranscriptionPreview("partial transcript"), undefined);
  assert.deepEqual(createdWindows, []);
});

test("window creation uses the notification dimensions and position", async () => {
  const manager = createNormalWindowManager();
  const notification = { detectionId: "calendar:next", source: "calendar" };

  try {
    const showPromise = manager.showMeetingNotification(notification, { autoDismiss: false });
    const notificationWindow = createdWindows[0];

    assert.deepEqual(
      {
        acceptFirstMouse: notificationWindow.options.acceptFirstMouse,
        width: notificationWindow.options.width,
        height: notificationWindow.options.height,
        x: notificationWindow.options.x,
        y: notificationWindow.options.y,
      },
      { acceptFirstMouse: true, width: 392, height: 92, x: 608, y: 16 }
    );
    // The payload the overlay fetches is stored verbatim.
    assert.deepEqual(manager._pendingNotificationData, notification);

    notificationWindow.loadDeferred.resolve();
    await showPromise;
  } finally {
    manager.dismissMeetingNotification();
  }
});

test("a replaced deferred notification cannot send its payload to the newer window", async () => {
  const timers = installFakeTimers();
  const manager = createNormalWindowManager();
  let secondShowPromise;

  try {
    const firstShowPromise = manager.showMeetingNotification(
      { detectionId: "first" },
      { autoDismiss: false }
    );
    const firstWindow = createdWindows[0];
    secondShowPromise = manager.showMeetingNotification(
      { detectionId: "second" },
      { autoDismiss: false }
    );
    const secondWindow = createdWindows[1];

    firstWindow.loadDeferred.resolve();
    await firstShowPromise;
    timers.runAll();

    assert.deepEqual(secondWindow.messages, []);
    assert.equal(secondWindow.showCount, 0);
  } finally {
    createdWindows[1]?.loadDeferred.resolve();
    await secondShowPromise?.catch(() => undefined);
    manager.dismissMeetingNotification();
    timers.restore();
  }
});

test("canceling during a deferred load prevents later timers and timeout callbacks", async () => {
  const timers = installFakeTimers();
  const manager = createNormalWindowManager();
  let timeoutCount = 0;
  manager.meetingDetectionEngine = {
    handleNotificationTimeout: () => {
      timeoutCount += 1;
    },
  };
  const showPromise = manager.showMeetingNotification({ detectionId: "first" });
  const notificationWindow = createdWindows[0];

  try {
    manager.dismissMeetingNotification();
    notificationWindow.loadDeferred.reject(new Error("ERR_ABORTED"));

    await assert.doesNotReject(showPromise);
    timers.runAll();

    assert.equal(timeoutCount, 0);
    assert.deepEqual(notificationWindow.messages, []);
    assert.equal(notificationWindow.showCount, 0);
    assert.equal(manager.notificationWindow, null);
  } finally {
    await showPromise.catch(() => undefined);
    manager.dismissMeetingNotification();
    timers.restore();
  }
});

test("canceling while waiting for the dev server never loads the stale window", async () => {
  const timers = installFakeTimers();
  const manager = createNormalWindowManager();
  const originalNodeEnv = process.env.NODE_ENV;
  const devServerWait = createDeferred();
  devServerWaitPromise = devServerWait.promise;
  process.env.NODE_ENV = "development";

  try {
    const showPromise = manager.showMeetingNotification({ detectionId: "first" });
    const notificationWindow = createdWindows[0];
    manager.dismissMeetingNotification();
    devServerWait.resolve();

    await assert.doesNotReject(showPromise);
    assert.equal(notificationWindow.loadUrlCount, 0);
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
    devServerWaitPromise = Promise.resolve();
    manager.dismissMeetingNotification();
    timers.restore();
  }
});

test("a stale ready callback cannot show the replacement notification window", async () => {
  const timers = installFakeTimers();
  const manager = createNormalWindowManager();

  try {
    const firstShowPromise = manager.showMeetingNotification(
      { detectionId: "first" },
      { autoDismiss: false }
    );
    const firstWindow = createdWindows[0];
    firstWindow.loadDeferred.resolve();
    await firstShowPromise;

    const secondShowPromise = manager.showMeetingNotification(
      { detectionId: "second" },
      { autoDismiss: false }
    );
    const secondWindow = createdWindows[1];
    secondWindow.loadDeferred.resolve();
    await secondShowPromise;

    manager.showNotificationWindow(firstWindow.webContents);
    assert.equal(secondWindow.showCount, 0);

    manager.showNotificationWindow(secondWindow.webContents);
    assert.equal(secondWindow.showCount, 1);
  } finally {
    manager.dismissMeetingNotification();
    timers.restore();
  }
});

// The engine may raise the next queued prompt from its timeout handler, so that
// prompt must outlive the dismissal that closes the expired card.
test("a notification raised from the timeout handler survives the dismissal that follows", async () => {
  const timers = installFakeTimers();
  const manager = createNormalWindowManager();
  let replacementPromise = null;
  manager.meetingDetectionEngine = {
    handleNotificationTimeout: () => {
      replacementPromise = manager.showMeetingNotification(
        { detectionId: "calendar:next", source: "calendar" },
        { autoDismiss: false }
      );
    },
    handleDetectionNotificationClosed: () => undefined,
  };

  const showPromise = manager.showMeetingNotification({
    detectionId: "calendar:first",
    source: "calendar",
  });

  try {
    notificationWindowFor(0).loadDeferred.resolve();
    await showPromise;

    timers.runDelay(getNotificationTimeoutMs("calendar"));
    notificationWindowFor(1).loadDeferred.resolve();
    await replacementPromise;

    assert.equal(createdWindows.length, 2);
    assert.equal(notificationWindowFor(1).isDestroyed(), false);
    assert.equal(manager.notificationWindow, notificationWindowFor(1));
  } finally {
    manager.dismissMeetingNotification();
    timers.restore();
  }
});

test("unexpected detection card closure releases that detection", async () => {
  const manager = createNormalWindowManager();
  const closedDetections = [];
  manager.meetingDetectionEngine = {
    handleDetectionNotificationClosed: (detectionId) => closedDetections.push(detectionId),
  };

  const showPromise = manager.showMeetingNotification({
    detectionId: "audio:sustained-audio",
    source: "audio",
  });
  const notificationWindow = createdWindows[0];
  notificationWindow.loadDeferred.resolve();
  await showPromise;

  // A compositor window kill never reaches the renderer's response IPC.
  notificationWindow.close();

  assert.deepEqual(closedDetections, ["audio:sustained-audio"]);
});

test("an expired detection reports the timeout once, not also as a close", async () => {
  const timers = installFakeTimers();
  const manager = createNormalWindowManager();
  const closedDetections = [];
  let timeouts = 0;
  manager.meetingDetectionEngine = {
    handleDetectionNotificationClosed: (detectionId) => closedDetections.push(detectionId),
    handleNotificationTimeout: () => {
      timeouts += 1;
    },
  };

  const showPromise = manager.showMeetingNotification({
    detectionId: "audio:sustained-audio",
    source: "audio",
  });
  createdWindows[0].loadDeferred.resolve();
  await showPromise;

  try {
    timers.runDelay(30_000);
    assert.equal(timeouts, 1, "the countdown owns this dismissal");
    assert.deepEqual(closedDetections, [], "the close must not double-report the same card");
  } finally {
    manager.dismissMeetingNotification();
    timers.restore();
  }
});

test("a detection card whose load fails releases that detection", async () => {
  const manager = createNormalWindowManager();
  const closedDetections = [];
  manager.meetingDetectionEngine = {
    handleDetectionNotificationClosed: (detectionId) => closedDetections.push(detectionId),
  };

  const showPromise = manager.showMeetingNotification({
    detectionId: "audio:sustained-audio",
    source: "audio",
  });
  createdWindows[0].loadDeferred.reject(new Error("load failed"));

  // The card never appeared and no countdown ever started, so nothing else
  // would ever settle this detection.
  await assert.rejects(showPromise, /load failed/);
  assert.deepEqual(closedDetections, ["audio:sustained-audio"]);
});

test("manual meeting starts fail closed like the meeting hotkey", async () => {
  let starts = 0;
  const engine = { startManualMeeting: async () => (starts += 1) };

  const onboarding = new WindowManager();
  onboarding.meetingDetectionEngine = engine;
  await onboarding.startManualMeeting();
  assert.equal(starts, 0);

  const manager = createNormalWindowManager();
  manager.meetingDetectionEngine = engine;
  manager.hotkeyManager.isInListeningMode = () => true;
  await manager.startManualMeeting();
  assert.equal(starts, 0);

  manager.hotkeyManager.isInListeningMode = () => false;
  await manager.startManualMeeting();
  assert.equal(starts, 1);
});

// Only the renderer can open the assistant panel, and it owns the policy and
// recording state the pill menu gates the item on, so nothing may be shown,
// focused, or created before it accepts.
test("the tray's Ask assistant asks the renderer without showing or focusing the pill", () => {
  const fakeMainWindow = (events) => ({
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    focus: () => events.push("focus"),
    show: () => events.push("show"),
    showInactive: () => events.push("show"),
    webContents: { send: (channel) => events.push(channel) },
  });

  const onboardingEvents = [];
  const onboarding = new WindowManager();
  onboarding.mainWindow = fakeMainWindow(onboardingEvents);
  onboarding.sendOpenAssistantPanel();
  assert.deepEqual(onboardingEvents, []);

  const events = [];
  const manager = createNormalWindowManager();
  manager.mainWindow = fakeMainWindow(events);
  manager.sendOpenAssistantPanel();
  assert.deepEqual(events, ["open-assistant-panel"]);

  // Capturing a hotkey swallows it, like every other input path.
  const capturingEvents = [];
  const capturing = createNormalWindowManager();
  capturing.mainWindow = fakeMainWindow(capturingEvents);
  capturing.hotkeyManager.isInListeningMode = () => true;
  capturing.sendOpenAssistantPanel();
  assert.deepEqual(capturingEvents, []);
});
