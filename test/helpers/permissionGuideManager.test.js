const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

const noSettings = () => ({ settings: null, authPrompt: false });

function fixture({
  platform = "darwin",
  packaged = true,
  deferredLoad = false,
  settingsState = noSettings,
  available = true,
} = {}) {
  const windows = [];
  const timers = { timeouts: [] };
  let finishLoad;
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      if (typeof options.x === "number") {
        this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      }
      this.webContents = new EventEmitter();
      this.webContents.sent = [];
      this.webContents.send = (...args) => this.webContents.sent.push(args);
      this.webContents.isDestroyed = () => this.destroyed;
      this.webContents.mainFrame = {};
      this.webContents.startDrag = (item) => {
        this.dragged = item;
      };
      this.webContents.setWindowOpenHandler = () => {};
      windows.push(this);
    }
    isDestroyed() {
      return !!this.destroyed;
    }
    getBounds() {
      return this.bounds ?? { x: 100, y: 100, width: 600, height: 700 };
    }
    setBounds(bounds) {
      this.bounds = bounds;
    }
    close() {
      this.destroyed = true;
      this.emit("closed");
    }
    showInactive() {
      this.shown = true;
      this.hidden = false;
      this.boundsAtShow = this.getBounds();
    }
    hide() {
      this.hidden = true;
    }
    isVisible() {
      return !!this.shown && !this.hidden;
    }
    show() {
      this.shown = true;
    }
    focus() {
      this.focused = true;
    }
    loadFile() {
      return deferredLoad
        ? new Promise((resolve) => {
            finishLoad = resolve;
          })
        : Promise.resolve();
    }
    loadURL() {
      return this.loadFile();
    }
    setVisibleOnAllWorkspaces() {}
  }
  const owner = new Window({});
  const windowManager = { controlPanelWindow: owner, _onboardingActive: true };
  const exports = {};
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../../src/helpers/permissionGuideManager.js"), "utf8"),
    {
      module: { exports },
      exports,
      __dirname: path.join(__dirname, "../../src/helpers"),
      process: {
        platform,
        env: {},
        execPath: "/Applications/OpenWhispr.app/Contents/MacOS/OpenWhispr",
        resourcesPath: "/Applications/OpenWhispr.app/Contents/Resources",
      },
      // The vm context has no globals of its own; the guide schedules its polls.
      setTimeout: (callback) => {
        timers.timeouts.push(callback);
        return timers.timeouts.length;
      },
      clearTimeout: () => {},
      require: (name) => {
        if (name === "electron")
          return {
            BrowserWindow: Window,
            app: {
              isPackaged: packaged,
              getPath: () => "/Applications/OpenWhispr.app/Contents/MacOS/OpenWhispr",
            },
            nativeImage: {
              createFromPath: () => {
                const image = {
                  toDataURL: () => "data:image/png;base64,bundled",
                  resize: () => image,
                };
                return image;
              },
            },
            screen: {
              // Two displays stacked vertically, like a laptop with an external
              // screen below it: the work area depends on which one the given
              // rectangle falls on.
              getDisplayMatching: (rect) =>
                rect && rect.y >= 900
                  ? { workArea: { x: 0, y: 900, width: 2560, height: 1440 } }
                  : { workArea: { x: 0, y: 0, width: 1440, height: 900 } },
            },
          };
        if (name === "./devServerManager")
          return { getAppFilePath: () => ({ path: "/app/index.html", query: {} }) };
        if (name === "./debugLogger") return { warn() {}, error() {}, info() {}, debug() {} };
        // The real geometry, so the manager is tested against the placement the
        // app actually ships; only the OS window query is stubbed.
        if (name === "./permissionGuidePlacement")
          return require("../../src/helpers/permissionGuidePlacement.js");
        if (name === "./settingsWindowState")
          return {
            readSettingsWindowState: async () => settingsState(),
            isSettingsWindowStateAvailable: () => available,
          };
        return require(name);
      },
    }
  );
  // The real waiter paces the "wait for the settings window" loop; tests drive
  // the same number of attempts without the wall-clock delay.
  const manager = new exports.PermissionGuideManager(windowManager, { wait: async () => {} });
  const event = (win) => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  return {
    manager,
    windows,
    owner,
    windowManager,
    event,
    timers,
    finish: () => finishLoad?.(),
  };
}

const state = {
  sessionId: "guide-1",
  permission: "accessibility",
  granted: false,
  needsRelaunch: false,
  busy: false,
  error: false,
};

const openGuide = async (setup) => {
  assert.equal(await setup.manager.open(setup.event(setup.owner), state), true);
  return setup.windows[setup.windows.length - 1];
};

const anchored = { x: 232, y: 232, width: 723, height: 504 };

test("waits for the System Settings window before showing the overlay", async () => {
  // System Settings needs a moment to put its window up after the Enable click;
  // showing before then is what made the overlay jump into place afterwards.
  let reads = 0;
  const setup = fixture({
    settingsState: () => {
      reads += 1;
      return reads < 3
        ? { settings: null, authPrompt: false }
        : { settings: anchored, authPrompt: false };
    },
  });

  const guide = await openGuide(setup);

  assert.equal(guide.boundsAtShow.y, 592);
});

test("anchors to the settings window on whichever display it opens on", async () => {
  // The onboarding window stays on the laptop screen, so taking the work area
  // from it clamps the overlay back onto that display and away from the dialog.
  const external = { x: 300, y: 1200, width: 723, height: 504 };
  const setup = fixture({ settingsState: () => ({ settings: external, authPrompt: false }) });

  const guide = await openGuide(setup);

  assert.equal(guide.boundsAtShow.x, 382);
  assert.equal(guide.boundsAtShow.y, 1560);
});

test("closes the overlay once the System Settings window is closed", async () => {
  let settingsOpen = true;
  const setup = fixture({
    settingsState: () => ({
      settings: settingsOpen ? anchored : null,
      authPrompt: false,
    }),
  });

  const guide = await openGuide(setup);
  settingsOpen = false;
  await setup.manager.poll();

  assert.ok(guide.isDestroyed(), "overlay closes with the dialog it belongs to");
});

test("gets out of the way while macOS asks for a password", async () => {
  let authPrompt = false;
  const setup = fixture({
    settingsState: () => ({ settings: anchored, authPrompt }),
  });

  const guide = await openGuide(setup);
  authPrompt = true;
  await setup.manager.poll();
  assert.equal(guide.isVisible(), false, "hidden while the password sheet is up");

  authPrompt = false;
  await setup.manager.poll();
  assert.equal(guide.isVisible(), true, "back once the sheet is dismissed");
});

test("hides while another app covers the settings window", async () => {
  // The overlay belongs to the dialog: floating above an unrelated app the user
  // switched to is just clutter.
  let frontmost = "settings";
  const setup = fixture({
    settingsState: () => ({ settings: anchored, authPrompt: false, frontmost }),
  });

  const guide = await openGuide(setup);
  frontmost = "other";
  await setup.manager.poll();
  assert.equal(guide.isVisible(), false, "hidden when the user switches apps");

  frontmost = "settings";
  await setup.manager.poll();
  assert.equal(guide.isVisible(), true, "back when settings returns to the front");
});

test("stays put while the user is dragging from the overlay itself", async () => {
  const setup = fixture({
    settingsState: () => ({ settings: anchored, authPrompt: false, frontmost: "self" }),
  });

  const guide = await openGuide(setup);
  await setup.manager.poll();

  assert.equal(guide.isVisible(), true);
});

test("the onboarding window's hide event never tears the overlay down", async () => {
  // macOS fires hide on occlusion, and isVisible() folds occlusion in too, so
  // neither can tell a covered window from one sent to the tray (the same trap
  // documented for the Dock icon). The tray path closes the guide explicitly.
  const setup = fixture({ settingsState: () => ({ settings: anchored, authPrompt: false }) });

  const guide = await openGuide(setup);
  setup.owner.emit("hide");

  assert.equal(guide.isDestroyed(), false);
  assert.equal(setup.owner.listenerCount("hide"), 0);
});

test("a navigation of the onboarding document closes the guide while the window is visible", async () => {
  // Log out reloads the document and the OAuth refresh loads a new URL; the
  // controller that owned this guide is gone either way.
  const setup = fixture({ settingsState: () => ({ settings: anchored, authPrompt: false }) });

  const guide = await openGuide(setup);
  setup.owner.shown = true;
  setup.owner.webContents.emit("did-start-navigation", {
    isMainFrame: true,
    isSameDocument: false,
  });

  assert.ok(guide.isDestroyed());
});

test("a same-document navigation leaves the guide alone", async () => {
  const setup = fixture({ settingsState: () => ({ settings: anchored, authPrompt: false }) });

  const guide = await openGuide(setup);
  setup.owner.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });

  assert.equal(guide.isDestroyed(), false);
});

test("a renderer crash closes the guide while the window is visible", async () => {
  const setup = fixture({ settingsState: () => ({ settings: anchored, authPrompt: false }) });

  const guide = await openGuide(setup);
  setup.owner.shown = true;
  setup.owner.webContents.emit("render-process-gone", { reason: "crashed" });

  assert.ok(guide.isDestroyed());
});

test("the owner closing after its contents are destroyed still closes the guide", async () => {
  // Once a BrowserWindow has emitted closed, reading its webContents throws
  // "Object has been destroyed"; a throw here would leak the always-on-top
  // guide window with nothing left to close it.
  const setup = fixture({ settingsState: () => ({ settings: anchored, authPrompt: false }) });

  const guide = await openGuide(setup);
  Object.defineProperty(setup.owner, "webContents", {
    get() {
      throw new TypeError("Object has been destroyed");
    },
  });
  setup.owner.destroyed = true;
  setup.owner.emit("closed");

  assert.ok(guide.isDestroyed());
});

test("the overlay's own close button closes the guide without waiting for the owner", async () => {
  // The owner may have navigated away or crashed and no longer listen; the
  // guide must never depend on an echo to take itself down.
  const setup = fixture({ settingsState: () => ({ settings: anchored, authPrompt: false }) });

  const guide = await openGuide(setup);
  setup.manager.handleAction(setup.event(guide), { ...state, action: "close" });

  assert.ok(guide.isDestroyed());
  assert.equal(setup.owner.webContents.sent.at(-1)[1].action, "close");
  assert.equal(setup.owner.focused, true);
});

test("a state that cannot be read leaves the overlay alone", async () => {
  // A failed read is unknown, not "settings closed": closing here would strand
  // the user mid-permission over a transient hiccup.
  let readable = true;
  const setup = fixture({
    settingsState: () => (readable ? { settings: anchored, authPrompt: false } : null),
  });

  const guide = await openGuide(setup);
  readable = false;
  await setup.manager.poll();

  assert.equal(guide.isDestroyed(), false);
});

test("two publishes racing the first open leave exactly one overlay on screen", async () => {
  // start() and the 2s refresh tick routinely publish together. Both calls carry
  // the same session, so the second must join the first rather than tearing its
  // window down — a false return here latches guide.error in the renderer and
  // drops every later Enable click to the settings-only fallback.
  const setup = fixture({
    settingsState: () => ({
      settings: { x: 232, y: 232, width: 723, height: 504 },
      authPrompt: false,
    }),
  });

  const [first, second] = await Promise.all([
    setup.manager.open(setup.event(setup.owner), state),
    setup.manager.open(setup.event(setup.owner), state),
  ]);

  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(setup.windows.length, 2, "owner window plus exactly one guide window");
  assert.ok(setup.windows[1].shown);
});

test("the overlay opens anchored inside the System Settings window, without moving", async () => {
  const setup = fixture({
    settingsState: () => ({
      settings: { x: 232, y: 232, width: 723, height: 504 },
      authPrompt: false,
    }),
  });

  const guide = await openGuide(setup);

  // Asserted at show time: the overlay must already be anchored when it first
  // becomes visible, rather than sliding there afterwards.
  assert.equal(guide.boundsAtShow.x, 314);
  assert.equal(guide.boundsAtShow.y, 592);
});

test("the overlay falls back to the bottom of the display when settings is closed", async () => {
  const setup = fixture();

  const guide = await openGuide(setup);

  assert.equal(guide.options.x, 440);
  assert.equal(guide.options.y, 752);
});

test("the overlay follows the settings window when the user moves it", async () => {
  const settingsBounds = { x: 232, y: 232, width: 723, height: 504 };
  const setup = fixture({ settingsState: () => ({ settings: settingsBounds, authPrompt: false }) });

  const guide = await openGuide(setup);
  settingsBounds.y = 100;
  await setup.manager.poll();

  assert.equal(guide.getBounds().y, 460);
});

test("only the onboarding owner can open a guide, and unsupported platforms do nothing", async () => {
  const setup = fixture();
  assert.equal(await setup.manager.open({ sender: {} }, state), false);
  assert.equal(
    await setup.manager.open(setup.event(setup.owner), {
      ...state,
      permission: "files",
    }),
    false
  );
  assert.equal(
    await setup.manager.open({ ...setup.event(setup.owner), senderFrame: {} }, state),
    false
  );
  const other = fixture({ platform: "win32" });
  assert.equal(await other.manager.open(other.event(other.owner), state), false);
  assert.equal(other.windows.length, 1);
});

test("actions reject stale steps and drag only the packaged application", async () => {
  const setup = fixture();
  assert.equal(await setup.manager.open(setup.event(setup.owner), state), true);
  const helper = setup.windows[1];
  setup.manager.handleAction(setup.event(helper), {
    ...state,
    permission: "microphone",
    action: "settings",
  });
  assert.equal(setup.owner.webContents.sent.length, 0);
  setup.manager.handleAction(setup.event(helper), {
    ...state,
    action: "settings",
  });
  assert.equal(setup.owner.webContents.sent[0][1].action, "settings");
  setup.manager.startDrag(setup.event(helper), {
    ...state,
    path: "/private/secret",
  });
  assert.equal(helper.dragged.file, "/Applications/OpenWhispr.app");
  assert.ok(helper.shown);
});

test("development guides disable dragging and owner teardown closes the helper", async () => {
  const setup = fixture({ packaged: false });
  await setup.manager.open(setup.event(setup.owner), state);
  const helper = setup.windows[1];
  const snapshot = setup.manager.stateFor(setup.event(helper));
  assert.equal(snapshot.canDrag, false);
  setup.manager.startDrag(setup.event(helper), state);
  assert.equal(helper.dragged, undefined);
  setup.owner.close();
  assert.equal(helper.isDestroyed(), true);
  assert.equal(setup.owner.listenerCount("closed"), 0);
});

test("a helper closed while loading never reappears", async () => {
  const setup = fixture({ deferredLoad: true });
  const opening = setup.manager.open(setup.event(setup.owner), state);
  await new Promise((resolve) => setImmediate(resolve));
  setup.manager.close();
  setup.finish();
  assert.equal(await opening, false);
  assert.equal(setup.windows[1].shown, undefined);
});

test("a guide that fails to open reports it only through its return value", async () => {
  // A close action would read as the user dismissing the guide, withdrawing
  // the Screen Context opt-in and skipping the renderer's fallback. The
  // throwing read stands in for any failure on the open path, such as a load.
  const setup = fixture({
    settingsState: () => {
      throw new Error("helper failed");
    },
  });

  assert.equal(await setup.manager.open(setup.event(setup.owner), state), false);
  assert.equal(setup.windows[1].isDestroyed(), true);
  assert.deepEqual(setup.owner.webContents.sent, []);
});

test("helper falls back to a compact bottom overlay without stealing Settings focus", async () => {
  const setup = fixture();
  await setup.manager.open(setup.event(setup.owner), state);
  const helper = setup.windows[1];
  assert.equal(helper.options.width, 560);
  assert.equal(helper.options.height, 124);
  assert.equal(helper.options.alwaysOnTop, true);
  assert.equal(helper.focused, undefined);
  assert.ok(helper.options.y + helper.options.height <= 900);
});

test("System Settings on another Space hides the overlay rather than closing it", async () => {
  // The window list is per Space, so swiping away or minimizing the dialog
  // reads as "no window" while the app is still running. Closing (and pulling
  // focus back to onboarding) would yank the user out of what they were doing.
  let onScreen = true;
  const setup = fixture({
    settingsState: () => ({
      settings: onScreen ? anchored : null,
      authPrompt: false,
      settingsRunning: true,
    }),
  });

  const guide = await openGuide(setup);
  onScreen = false;
  await setup.manager.poll();
  await setup.manager.poll();
  await setup.manager.poll();
  assert.equal(guide.isDestroyed(), false);
  assert.equal(guide.isVisible(), false, "hidden while the dialog is off screen");

  onScreen = true;
  await setup.manager.poll();
  assert.equal(guide.isVisible(), true, "back with the dialog");
});

test("opens hidden while System Settings is on another Space", async () => {
  const setup = fixture({
    settingsState: () => ({ settings: null, authPrompt: false, settingsRunning: true }),
  });

  const guide = await openGuide(setup);

  assert.equal(guide.isVisible(), false);
});

test("polls one read at a time, scheduling the next only after the last one answers", async () => {
  // An interval keeps firing while a slow helper is still running, leaving two
  // reads in flight that can answer out of order.
  const setup = fixture({ settingsState: () => ({ settings: anchored, authPrompt: false }) });

  await openGuide(setup);

  assert.equal(setup.timers.timeouts.length, 1);
  await setup.timers.timeouts[0]();
  assert.equal(setup.timers.timeouts.length, 2);
});

test("a poll still reading when the guide reopens does not start a second chain", async () => {
  let pending = null;
  const setup = fixture({
    settingsState: () => pending ?? { settings: anchored, authPrompt: false },
  });

  await openGuide(setup);
  let answer;
  pending = new Promise((resolve) => (answer = resolve));
  const stale = setup.timers.timeouts[0]();
  pending = null;
  setup.manager.close();
  await openGuide(setup);
  answer({ settings: anchored, authPrompt: false });
  await stale;

  assert.equal(setup.timers.timeouts.length, 2, "only the reopened guide keeps polling");
});

test("a missing helper binary refuses to open so Enable falls back to the plain flow", async () => {
  const setup = fixture({ available: false });

  assert.equal(await setup.manager.open(setup.event(setup.owner), state), false);
  assert.equal(setup.windows.length, 1);
});

test("a close from the onboarding renderer does not pull focus back to it", async () => {
  // The renderer closes on a grant; the user may still be in System Settings
  // for the next permission. Only the dialog going away restores onboarding.
  const setup = fixture({ settingsState: () => ({ settings: anchored, authPrompt: false }) });

  const guide = await openGuide(setup);
  assert.equal(await setup.manager.closeFromOwner(setup.event(setup.owner)), true);

  assert.ok(guide.isDestroyed());
  assert.equal(setup.owner.focused, undefined);
});

test("System Settings going away restores the onboarding window", async () => {
  let settingsOpen = true;
  const setup = fixture({
    settingsState: () => ({ settings: settingsOpen ? anchored : null, authPrompt: false }),
  });

  await openGuide(setup);
  settingsOpen = false;
  await setup.manager.poll();

  assert.equal(setup.owner.focused, true);
});

test("the guide is only for an onboarding that is still active", async () => {
  const setup = fixture();
  setup.windowManager._onboardingActive = false;

  assert.equal(await setup.manager.open(setup.event(setup.owner), state), false);
  assert.equal(setup.windows.length, 1);
});

test("dragging is disabled while a check is in flight", async () => {
  const setup = fixture({ settingsState: () => ({ settings: anchored, authPrompt: false }) });

  const guide = await openGuide(setup);
  await setup.manager.open(setup.event(setup.owner), {
    ...state,
    busy: true,
  });
  setup.manager.startDrag(setup.event(guide), state);

  assert.equal(setup.manager.snapshot().canDrag, false);
  assert.equal(guide.dragged, undefined);
});

test("a guide closed while waiting for the settings window never positions or shows", async () => {
  let reads = 0;
  const setup = fixture({
    settingsState: () => {
      reads += 1;
      if (reads === 2) setup.manager.close();
      return { settings: reads >= 2 ? anchored : null, authPrompt: false };
    },
  });

  const opening = setup.manager.open(setup.event(setup.owner), state);

  assert.equal(await opening, false);
  const guide = setup.windows[1];
  assert.ok(guide.isDestroyed());
  assert.equal(guide.shown, undefined);
  assert.deepEqual(guide.bounds, {
    x: guide.options.x,
    y: guide.options.y,
    width: guide.options.width,
    height: guide.options.height,
  });
});
