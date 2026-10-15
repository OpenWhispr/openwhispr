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
let tokenState = { token: null, generation: 0 };
let bindingScope = null;
let workArea = { x: 0, y: 0, width: 1200, height: 900 };

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
    this.webContents = Object.assign(new EventEmitter(), {
      send: (channel, payload) => this.messages.push({ channel, payload }),
    });
    createdWindows.push(this);
  }

  setContentProtection(value) {
    this.protected = value;
  }
  getBounds() {
    return this.bounds || { x: 608, y: 16, width: 416, height: 84 };
  }
  setBounds(bounds) {
    this.bounds = bounds;
  }
  setFocusable(value) {
    (this.focusEvents ||= []).push(value ? "focusable" : "passive");
  }
  focus() {
    (this.focusEvents ||= []).push("focus");
  }
  show() {
    (this.focusEvents ||= []).push("show");
  }
  blur() {
    (this.focusEvents ||= []).push("blur");
  }
  setShape(regions) {
    this.shape = regions;
  }

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
  if (request === "./tokenStore") return { getState: () => tokenState };
  if (request === "./accountScopeBinding")
    return {
      read: () => ({}),
      resolveActiveAccountScope: () => bindingScope,
    };
  if (request === "electron") {
    return {
      app: { on: () => undefined },
      screen: {
        getPrimaryDisplay: () => ({ workArea }),
        getDisplayMatching: () => ({ workArea }),
        getCursorScreenPoint: () => ({ x: -10000, y: -10000 }),
        on: () => undefined,
        removeListener: () => undefined,
      },
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
    const notificationSize = { width: 416, height: 84 };
    return {
      ...originalLoad.call(this, request, parent, isMain),
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
  tokenState = { token: null, generation: 0 };
  bindingScope = null;
  workArea = { x: 0, y: 0, width: 1200, height: 900 };
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
      { acceptFirstMouse: true, width: 416, height: 84, x: 584, y: 16 }
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

async function showOwned(manager, id = "calendar:editing") {
  manager.meetingDetectionEngine ||= {
    databaseManager: { activeAccountId: null },
    activeDetections: new Map(),
    handleNotificationTimeout() {},
  };
  manager.meetingDetectionEngine.activeDetections.set(id, { source: "calendar", key: id });
  const showing = manager.showMeetingNotification({ detectionId: id, source: "calendar" });
  const win = manager.notificationWindow;
  win.loadDeferred.resolve();
  await showing;
  manager.showNotificationWindow(win.webContents);
  return { win, owner: manager.captureMeetingNotificationOwner(win.webContents) };
}
const surface = (revision, mode = "form", focus = "keep") => ({
  revision,
  mode,
  focus,
  contentHeight: mode === "closed" ? 84 : 260,
  regions: [
    { x: 12, y: 12, width: 392, height: 60 },
    ...(mode === "closed" ? [] : [{ x: 116, y: 84, width: 288, height: 164 }]),
  ],
});

test("leaving the card cannot resume an open form countdown", async () => {
  const timers = installFakeTimers();
  const manager = createNormalWindowManager();
  try {
    const { win, owner } = await showOwned(manager);
    assert.ok(owner);
    manager.setNotificationInteractivity(win.webContents, true);
    manager.setMeetingNotificationSurface(owner, surface(1, "form", "request"));
    manager.setNotificationInteractivity(win.webContents, false);
    assert.equal(owner.pointerInside, false);
    timers.runAll();
    assert.equal(win.isDestroyed(), false);
    manager.setMeetingNotificationSurface(owner, surface(2, "closed", "release"));
    timers.runAll();
    assert.equal(win.isDestroyed(), true);
  } finally {
    manager.dismissMeetingNotification();
    timers.restore();
  }
});

test("only deliberate open activates; closing avoids macOS window restacking", async () => {
  const manager = createNormalWindowManager();
  try {
    const { win, owner } = await showOwned(manager);
    assert.equal(win.protected, true);
    assert.deepEqual(win.focusEvents || [], []);
    manager.setMeetingNotificationSurface(owner, surface(1, "list"));
    assert.deepEqual(win.focusEvents || [], []);
    manager.setMeetingNotificationSurface(owner, surface(2, "form", "request"));
    // Linux stays focusable from construction; setFocusable is only supported
    // by the macOS/Windows path. Both paths must activate only on request.
    const activation =
      process.platform === "linux" ? ["show", "focus"] : ["focusable", "show", "focus"];
    assert.deepEqual(win.focusEvents, activation);
    manager.setMeetingNotificationSurface(owner, surface(3, "closed", "release"));
    const release =
      process.platform === "darwin"
        ? ["passive"]
        : process.platform === "linux"
          ? ["blur"]
          : ["blur", "passive"];
    assert.deepEqual(win.focusEvents, [...activation, ...release]);
    assert.equal(win.getBounds().height, 84);
  } finally {
    manager.dismissMeetingNotification();
  }
});

test("reused detection strings and stale layout cannot mutate the current prompt", async () => {
  const manager = createNormalWindowManager();
  try {
    const first = await showOwned(manager);
    const second = await showOwned(manager);
    assert.equal(manager.captureMeetingNotificationOwner(first.win.webContents), null);
    assert.equal(
      manager.setMeetingNotificationSurface(first.owner, surface(20)).code,
      "STALE_NOTIFICATION"
    );
    assert.equal(manager.setMeetingNotificationSurface(second.owner, surface(2)).success, true);
    assert.equal(manager.setMeetingNotificationSurface(second.owner, surface(1)).success, false);
    for (const invalid of [NaN, Infinity, -1]) {
      assert.equal(
        manager.setMeetingNotificationSurface(second.owner, {
          ...surface(3),
          contentHeight: invalid,
        }).success,
        false
      );
    }
    assert.equal(second.win.getBounds().height, 260);
  } finally {
    manager.dismissMeetingNotification();
  }
});

test("small negative-origin displays bound the full surface and its input regions", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux" });
  const manager = createNormalWindowManager();
  try {
    const { win, owner } = await showOwned(manager);
    workArea = { x: -320, y: -240, width: 320, height: 240 };
    const result = manager.setMeetingNotificationSurface(owner, surface(1));
    assert.deepEqual(result.value, { width: 320, height: 240, maxHeight: 240 });
    assert.deepEqual(win.getBounds(), { x: -320, y: -240, width: 320, height: 240 });
    assert.ok(
      win.shape.every((r) => r.x >= 0 && r.y >= 0 && r.x + r.width <= 320 && r.y + r.height <= 240)
    );
  } finally {
    manager.dismissMeetingNotification();
    Object.defineProperty(process, "platform", platform);
  }
});

test("credential replacement fences ownership before database account reconciliation", async () => {
  const manager = createNormalWindowManager();
  try {
    const { owner } = await showOwned(manager);
    manager.retireMeetingNotificationScope();
    assert.equal(manager.isMeetingNotificationOwner(owner), false);
    assert.equal(manager.notificationWindow, null);
    assert.deepEqual(manager.meetingRecentDestinations, []);
  } finally {
    manager.dismissMeetingNotification();
  }
});

test("a stored token without an account binding scopes the prompt as signed out", async () => {
  tokenState = { token: "signed-out-token", generation: 0 };
  const manager = createNormalWindowManager();
  try {
    const { owner } = await showOwned(manager);
    assert.equal(manager.isMeetingNotificationOwner(owner), true);
    manager.meetingDetectionEngine.databaseManager.activeAccountId = "unbound-account";
    assert.equal(manager.isMeetingNotificationOwner(owner), false);
  } finally {
    manager.dismissMeetingNotification();
  }
});

async function navigationFixture() {
  const manager = createNormalWindowManager();
  const { owner } = await showOwned(manager);
  let row = { id: 9, space_id: 1, folder_id: 3, deleted_at: null, left_team: 0 };
  manager.meetingDetectionEngine.databaseManager = {
    activeAccountId: null,
    getNote: () => row,
    getSpace: (id) => (id === 1 ? { id: 1, name: "Private", kind: "private" } : null),
    getFolders: () => [
      { id: 3, space_id: 1, name: "Meetings" },
      { id: 4, space_id: 1, name: "Moved" },
    ],
    getSpaces: () => [{ id: 1, name: "Private", kind: "private" }],
    getMeetingsFolder: () => ({ id: 3 }),
  };
  owner.committedNoteId = 9;
  const panel = new EventEmitter();
  let loading = false;
  panel.isDestroyed = () => false;
  panel.webContents = new EventEmitter();
  panel.webContents.isLoading = () => loading;
  panel.webContents.send = () => {};
  manager.controlPanelWindow = panel;
  manager.createControlPanelWindow = async () => {};
  const payload = { navigationId: "navigate-one", noteId: 9, spaceId: 1, folderId: 3 };
  return {
    manager,
    owner,
    panel,
    payload,
    setRow: (next) => {
      row = next;
    },
    row,
    start: () => manager.queueMeetingNoteNavigation(payload, { owner }),
    // Like Electron, a new panel's load resolves inside did-finish-load, while
    // isLoading() is still true; did-stop-loading clears it a tick later.
    createPanel: async () => {
      loading = true;
      setImmediate(() => {
        loading = false;
        panel.webContents.emit("did-stop-loading");
      });
    },
  };
}

test("only the consuming current panel can confirm a navigation once", async () => {
  const f = await navigationFixture();
  try {
    const pending = f.start();
    await new Promise(setImmediate);
    assert.equal(f.manager.consumePendingMeetingNoteNavigation({}), null);
    assert.deepEqual(f.manager.consumePendingMeetingNoteNavigation(f.panel.webContents), f.payload);
    assert.equal(
      f.manager.confirmMeetingNoteNavigation({}, "navigate-one").code,
      "STALE_NOTIFICATION"
    );
    assert.equal(
      f.manager.confirmMeetingNoteNavigation(f.panel.webContents, "navigate-one").success,
      true
    );
    assert.equal((await pending).success, true);
    assert.equal(
      f.manager.confirmMeetingNoteNavigation(f.panel.webContents, "navigate-one").success,
      false
    );
  } finally {
    f.manager.dismissMeetingNotification();
  }
});

test("deleted, retracted, and moved notes fail final confirmation after delayed editor load", async () => {
  for (const change of [
    { deleted_at: "now" },
    { left_team: 1 },
    { folder_id: 4 },
    { folder_id: null },
  ]) {
    const f = await navigationFixture();
    try {
      const pending = f.start();
      await new Promise(setImmediate);
      f.manager.consumePendingMeetingNoteNavigation(f.panel.webContents);
      f.setRow({ ...f.row, ...change });
      const result = f.manager.confirmMeetingNoteNavigation(f.panel.webContents, "navigate-one");
      assert.equal(result.code, "folder_id" in change ? "LINKED_NOTE_CHANGED" : "NOTE_UNAVAILABLE");
      if ("folder_id" in change)
        assert.equal(result.context.existingNote.folderId, change.folder_id);
      assert.equal((await pending).success, false);
      assert.equal(f.manager.notificationWindow.isDestroyed(), false);
    } finally {
      f.manager.dismissMeetingNotification();
    }
  }
});

test("an absent editor times out and late confirmation cannot authorize recording", async () => {
  const timers = installFakeTimers();
  const f = await navigationFixture();
  try {
    const pending = f.start();
    await new Promise(setImmediate);
    timers.runDelay(15000);
    assert.equal((await pending).code, "START_FAILED");
    assert.equal(
      f.manager.confirmMeetingNoteNavigation(f.panel.webContents, "navigate-one").success,
      false
    );
  } finally {
    f.manager.dismissMeetingNotification();
    timers.restore();
  }
});

test("panel destruction and account retirement cancel pending navigation", async () => {
  for (const cause of ["panel", "account"]) {
    const f = await navigationFixture();
    const contents = f.panel.webContents;
    try {
      const pending = f.start();
      await new Promise(setImmediate);
      if (cause === "panel") {
        // Electron's getter throws once the window is destroyed.
        Object.defineProperty(f.panel, "webContents", {
          get() {
            throw new Error("Object has been destroyed");
          },
        });
        f.panel.emit("closed");
      }
      if (cause === "account") f.manager.retireMeetingNotificationScope();
      assert.equal((await pending).success, false);
      assert.equal(f.manager.confirmMeetingNoteNavigation(contents, "navigate-one").success, false);
    } finally {
      f.manager.dismissMeetingNotification();
    }
  }
});

test("a Start that creates the panel delivers once it loads, past the onboarding gate", async () => {
  const f = await navigationFixture();
  try {
    // A fresh control panel document raises the gate, which hides every prompt.
    f.manager.createControlPanelWindow = async () => {
      f.manager.setOnboardingActive(true);
      await f.createPanel();
    };
    const pending = f.start();
    await new Promise(setImmediate);
    assert.equal(f.manager.notificationWindow, null);
    assert.deepEqual(f.manager.consumePendingMeetingNoteNavigation(f.panel.webContents), f.payload);
    assert.equal(
      f.manager.confirmMeetingNoteNavigation(f.panel.webContents, "navigate-one").success,
      true
    );
    assert.equal((await pending).success, true);
  } finally {
    f.manager.dismissMeetingNotification();
  }
});

test("a Join navigation leaves an open panel behind the meeting it opened", async () => {
  const f = await navigationFixture();
  try {
    const opened = [];
    f.manager.createControlPanelWindow = async (options) => opened.push(options);
    const pending = f.manager.queueMeetingNoteNavigation(f.payload, {
      owner: f.owner,
      activate: false,
    });
    await new Promise(setImmediate);
    f.manager.consumePendingMeetingNoteNavigation(f.panel.webContents);
    f.manager.confirmMeetingNoteNavigation(f.panel.webContents, "navigate-one");
    assert.equal((await pending).success, true);
    await f.manager.queueMeetingNoteNavigation({ noteId: 9 }, { activate: false });
    assert.deepEqual(opened, [{ activate: false }, { activate: false }]);
  } finally {
    f.manager.dismissMeetingNotification();
  }
});

test("replacing an audio prompt retires only its captured detection", async () => {
  const manager = createNormalWindowManager();
  try {
    await showOwned(manager, "audio:sustained-audio");
    manager.meetingDetectionEngine.activeDetections.set("queued", { source: "calendar" });
    await showOwned(manager, "calendar:replacement");
    assert.equal(
      manager.meetingDetectionEngine.activeDetections.has("audio:sustained-audio"),
      false
    );
    assert.equal(manager.meetingDetectionEngine.activeDetections.has("calendar:replacement"), true);
    assert.equal(manager.meetingDetectionEngine.activeDetections.has("queued"), true);
  } finally {
    manager.dismissMeetingNotification();
  }
});

test("notification renderer crash retires its owner even while the window survives", async () => {
  const manager = createNormalWindowManager();
  const { win, owner } = await showOwned(manager);
  win.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.equal(manager.isMeetingNotificationOwner(owner), false);
  assert.equal(manager.notificationWindow, null);
});

test("identical layout reports do not resize or show the notification again", async () => {
  const manager = createNormalWindowManager();
  try {
    const { win, owner } = await showOwned(manager);
    const sizes = [];
    const initialLoads = win.loadUrlCount;
    const resize = win.setBounds.bind(win);
    win.setBounds = (bounds) => {
      sizes.push(bounds);
      resize(bounds);
    };
    manager.setMeetingNotificationSurface(owner, surface(1, "list", "request"));
    const opens = win.focusEvents.slice();
    manager.setMeetingNotificationSurface(owner, surface(2, "list"));
    assert.equal(sizes.length, 1);
    manager.setMeetingNotificationSurface(owner, surface(3, "closed", "release"));
    manager.setMeetingNotificationSurface(owner, surface(4, "closed"));
    assert.equal(sizes.length, 2);
    assert.deepEqual(win.focusEvents, [
      ...opens,
      ...(process.platform === "darwin" ? [] : ["blur"]),
      ...(process.platform === "linux" ? [] : ["passive"]),
    ]);
    assert.equal(win.loadUrlCount, initialLoads);
  } finally {
    manager.dismissMeetingNotification();
  }
});

test("closing a destroyed native window does not read its webContents getter", async () => {
  const manager = createNormalWindowManager();
  const { win } = await showOwned(manager);
  const contents = win.webContents;
  Object.defineProperty(win, "webContents", {
    get() {
      if (win.destroyed) throw new Error("Object has been destroyed");
      return contents;
    },
  });
  assert.doesNotThrow(() => manager.dismissMeetingNotification());
  assert.equal(contents.listenerCount("render-process-gone"), 0);
});

test("release preserves macOS stacking while Windows and Linux still blur", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    for (const name of ["darwin", "win32", "linux"]) {
      Object.defineProperty(process, "platform", { value: name });
      const manager = createNormalWindowManager();
      try {
        const { win, owner } = await showOwned(manager);
        manager.setMeetingNotificationSurface(owner, surface(1, "form", "request"));
        win.focusEvents = [];
        manager.setMeetingNotificationSurface(owner, surface(2, "closed", "release"));
        assert.deepEqual(
          win.focusEvents,
          name === "darwin" ? ["passive"] : name === "win32" ? ["blur", "passive"] : ["blur"],
          name
        );
        assert.equal(manager.notificationWindow, win);
        assert.equal(win.isDestroyed(), false);
      } finally {
        manager.dismissMeetingNotification();
      }
    }
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});
