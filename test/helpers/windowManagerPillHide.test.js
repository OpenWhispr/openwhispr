// Task 9's main-process half: a hide asks the renderer to zoop first and only
// hides the native window once the renderer's own hide-window IPC lands (or
// the fallback expires); a show cancels a pending hide and tells the renderer
// to unzoop. Drives the orderings, not just the happy path — a hide during a
// hide, a show during a zoop, an already-hidden window, a refused hide, and a
// window destroyed mid-zoop.
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

function fakeMainWindow() {
  const sent = [];
  const events = new Map();
  let visible = true;
  let destroyed = false;
  return {
    sent,
    events,
    destroy() {
      destroyed = true;
    },
    emit(name, ...args) {
      for (const fn of [...(events.get(name) ?? [])]) fn(...args);
    },
    on: (name, fn) => {
      if (!events.has(name)) events.set(name, new Set());
      events.get(name).add(fn);
    },
    once: (name, fn) => {
      if (!events.has(name)) events.set(name, new Set());
      events.get(name).add(fn);
    },
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    isMinimized: () => false,
    hide: () => {
      visible = false;
    },
    showInactive: () => {
      visible = true;
    },
    restore: () => undefined,
    focus: () => undefined,
    webContents: {
      on: () => undefined,
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  };
}

function manager() {
  const m = new WindowManager();
  // The constructor fails closed on onboarding until AppRouter reports in;
  // set the field directly rather than going through setOnboardingActive,
  // which would itself hide and show the panel before the test starts.
  m._onboardingActive = false;
  m.mainWindow = fakeMainWindow();
  m._mainWindowPlacementCoordinator = { cancelPending: () => undefined };
  m._repositionToActiveDisplay = async () => undefined;
  m.enforceMainWindowOnTop = () => undefined;
  m.showAgentDictationPill = () => undefined;
  m.hideAgentDictationPill = () => undefined;
  return m;
}

const channels = (win) => win.sent.map((message) => message.channel);

test("an animated hide asks the renderer to zoop and hides on the fallback if it never answers", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const m = manager();
  m.hideDictationPanel();
  assert.equal(m.mainWindow.sent.at(-1).channel, "pill-will-hide");
  assert.equal(m.mainWindow.isVisible(), true);
  t.mock.timers.tick(WindowManager.PILL_HIDE_FALLBACK_MS);
  assert.equal(m.mainWindow.isVisible(), false);
});

test("the renderer's own hide request lands immediately and clears the fallback", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const m = manager();
  m.hideDictationPanel();
  m.hideDictationPanel({ animate: false });
  assert.equal(m.mainWindow.isVisible(), false);
  t.mock.timers.tick(1000); // no second hide, no throw
  assert.equal(
    channels(m.mainWindow).filter((channel) => channel === "pill-will-hide").length,
    1,
    "the renderer must not be asked to zoop twice for one exit"
  );
});

test("a show during the zoop cancels the pending hide and tells the renderer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const m = manager();
  m.hideDictationPanel();
  m.showDictationPanel();
  t.mock.timers.tick(1000);
  assert.equal(m.mainWindow.isVisible(), true);
  assert.equal(m.mainWindow.sent.at(-1).channel, "pill-will-show");
});

test("an open assistant panel still refuses the hide, and says so", () => {
  const m = manager();
  m._assistantPanelOpen = true;
  assert.equal(m.hideDictationPanel(), false, "a refusal must be reportable, not silent");
  assert.equal(m.mainWindow.sent.length, 0);
  assert.equal(m.mainWindow.isVisible(), true);

  m._assistantPanelOpen = false;
  m._assistantPanelBusy = true;
  assert.equal(m.hideDictationPanel({ animate: false }), false);
  assert.equal(m.mainWindow.isVisible(), true);

  m._assistantPanelBusy = false;
  assert.equal(m.hideDictationPanel({ animate: false }), true);
  assert.equal(m.mainWindow.isVisible(), false);
});

test("a show while the assistant panel owns the window still cancels a pending hide", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const m = manager();
  m.hideDictationPanel();
  // The panel opens mid-zoop; showDictationPanel then takes its early-return
  // path. Without cancelling there, the pending timer would hide the window
  // out from under the panel that just claimed it.
  m._assistantPanelOpen = true;
  m.showDictationPanel();
  t.mock.timers.tick(1000);
  assert.equal(m.mainWindow.isVisible(), true);
  assert.equal(m.mainWindow.sent.at(-1).channel, "pill-will-show");
});

test("a show that is itself blocked must not cancel a hide it cannot honour", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const m = manager();
  m.hideDictationPanel();
  // Onboarding takes over mid-zoop. showDictationPanel refuses outright there,
  // so cancelling the pending hide would finish the "will-hide" half and never
  // its native hide, stranding the pill visible with nothing left to hide it
  // (the shape Task 7's review found on the companion pill).
  m._onboardingActive = true;
  m.showDictationPanel();
  t.mock.timers.tick(WindowManager.PILL_HIDE_FALLBACK_MS);
  assert.equal(m.mainWindow.isVisible(), false);
  assert.equal(channels(m.mainWindow).filter((channel) => channel === "pill-will-show").length, 0);
});

test("a second animated hide while one is pending neither re-asks the renderer nor double-hides", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const m = manager();
  assert.equal(m.hideDictationPanel(), true);
  assert.equal(m.hideDictationPanel(), true);
  assert.equal(channels(m.mainWindow).filter((channel) => channel === "pill-will-hide").length, 1);
  t.mock.timers.tick(WindowManager.PILL_HIDE_FALLBACK_MS);
  assert.equal(m.mainWindow.isVisible(), false);
});

test("hiding an already-hidden window skips the renderer round trip entirely", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const m = manager();
  m.mainWindow.hide();
  assert.equal(m.hideDictationPanel(), true);
  assert.deepEqual(channels(m.mainWindow), [], "there is nothing on screen left to zoop");
  t.mock.timers.tick(1000);
  assert.equal(m.mainWindow.isVisible(), false);
});

test("a window destroyed mid-zoop is never hidden and never throws", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const m = manager();
  m.hideDictationPanel();
  m.mainWindow.destroy();
  t.mock.timers.tick(WindowManager.PILL_HIDE_FALLBACK_MS);
  assert.equal(m.mainWindow.isVisible(), true, "hide() must not be called on a destroyed window");
});

test("the mainWindow's closed handler clears a pending hide so it cannot outlive its window", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const m = manager();
  m.registerMainWindowEvents();
  m.hideDictationPanel();
  const first = m.mainWindow;
  first.emit("closed");
  assert.equal(m.mainWindow, null);

  // A replacement window must not inherit the dead one's pending hide.
  const replacement = fakeMainWindow();
  m.mainWindow = replacement;
  t.mock.timers.tick(1000);
  assert.equal(replacement.isVisible(), true);
  assert.equal(first.isVisible(), true);
});

// Fix round 1, finding 1: the panel guard used to be atomic with hide(); the
// 320ms deferral split them, so it has to be re-read when the timer fires and
// not only when it is armed. Hiding here is the exact failure the guard's own
// comment names — the panel then opens invisibly and nothing can show it again.
test("a panel that claims the window mid-zoop is not hidden when the fallback fires", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const m = manager();
  m.hideDictationPanel();
  m.setAssistantPanelBusy(true);
  assert.equal(m.hideDictationPanel(), false, "sanity: a fresh hide is refused in this state");
  t.mock.timers.tick(WindowManager.PILL_HIDE_FALLBACK_MS);
  assert.equal(m.mainWindow.isVisible(), true, "a thinking command must not lose its window");

  // The refusal must also retire the timer, not leave it to fire later.
  m.setAssistantPanelBusy(false);
  t.mock.timers.tick(10000);
  assert.equal(m.mainWindow.isVisible(), true, "a refused fallback must not fire again");
  // …and a fresh hide must still work afterwards.
  assert.equal(m.hideDictationPanel(), true);
  t.mock.timers.tick(WindowManager.PILL_HIDE_FALLBACK_MS);
  assert.equal(m.mainWindow.isVisible(), false);
});

test("an open panel claiming the window mid-zoop is protected by the same re-check", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const m = manager();
  m.hideDictationPanel();
  m._assistantPanelOpen = true;
  t.mock.timers.tick(WindowManager.PILL_HIDE_FALLBACK_MS);
  assert.equal(m.mainWindow.isVisible(), true);
});

// The renderer's zoop duration lives in springEasing.ts, which main-process
// code has no import path into. Bind the two together so a retune of one
// without the other fails a test instead of silently desyncing the native
// hide from the CSS collapse — the duplicated-literal class of regression
// Task 7 already shipped once.
test("PILL_HIDE_FALLBACK_MS stays bound to the renderer's own zoop settle window", async () => {
  const { MOTION_TIMING } = await import("../../src/utils/springEasing.ts");
  const { settleFallbackMs } = await import("../../src/utils/transitionSettled.ts");
  assert.equal(WindowManager.PILL_HIDE_FALLBACK_MS, settleFallbackMs(MOTION_TIMING.zoopMs));
});
