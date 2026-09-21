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
} = {}) {
  const handlers = new Map();
  const listeners = new Map();
  const windows = [];
  const iconPaths = [];
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
  }
  const owner = new Window({});
  const windowManager = { controlPanelWindow: owner, _onboardingActive: true };
  const exports = {};
  const icon = { isEmpty: () => false, toDataURL: () => "data:image/png;base64,test" };
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
      // The vm context has no globals of its own; the guide polls on an interval.
      setInterval: () => 1,
      clearInterval: () => {},
      require: (name) => {
        if (name === "electron")
          return {
            BrowserWindow: Window,
            app: {
              isPackaged: packaged,
              getName: () => "OpenWhispr",
              getPath: () => "/Applications/OpenWhispr.app/Contents/MacOS/OpenWhispr",
              getFileIcon: async () => icon,
            },
            nativeImage: {
              createFromPath: (iconPath) => {
                iconPaths.push(iconPath);
                const image = {
                  isEmpty: () => false,
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
            ipcMain: {
              handle: (name, handler) => handlers.set(name, handler),
              on: (name, handler) => listeners.set(name, handler),
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
          return { readSettingsWindowState: async () => settingsState() };
        if (name === "fs") return { existsSync: () => true };
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
    handlers,
    listeners,
    windows,
    iconPaths,
    owner,
    windowManager,
    event,
    finish: () => finishLoad?.(),
  };
}

const state = {
  sessionId: "guide-1",
  permission: "accessibility",
  position: 2,
  total: 4,
  granted: false,
  needsRelaunch: false,
  busy: false,
  attempted: true,
  canGoBack: true,
  error: false,
};

const openGuide = async (setup) => {
  assert.equal(
    await setup.handlers.get("permission-guide-open")(setup.event(setup.owner), state),
    true
  );
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
  // Two misses: one reading can be a drag between displays rather than a close.
  await setup.manager.poll();
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
  let frontmost = "System Settings";
  const setup = fixture({
    settingsState: () => ({ settings: anchored, authPrompt: false, frontmost }),
  });

  const guide = await openGuide(setup);
  frontmost = "Safari";
  await setup.manager.poll();
  assert.equal(guide.isVisible(), false, "hidden when the user switches apps");

  frontmost = "System Settings";
  await setup.manager.poll();
  assert.equal(guide.isVisible(), true, "back when settings returns to the front");
});

test("stays put while the user is dragging from the overlay itself", async () => {
  const setup = fixture({
    settingsState: () => ({ settings: anchored, authPrompt: false, frontmost: "OpenWhispr" }),
  });

  const guide = await openGuide(setup);
  await setup.manager.poll();

  assert.equal(guide.isVisible(), true);
});

test("one blink of the settings window does not close the overlay", async () => {
  // Dragging the dialog between displays momentarily drops it out of the window
  // list; closing on the first miss dismissed the overlay for good.
  let visible = true;
  const setup = fixture({
    settingsState: () => ({ settings: visible ? anchored : null, authPrompt: false }),
  });

  const guide = await openGuide(setup);
  visible = false;
  await setup.manager.poll();
  assert.equal(guide.isDestroyed(), false, "a single miss is not a closed dialog");

  await setup.manager.poll();
  assert.ok(guide.isDestroyed(), "a sustained disappearance still closes it");
});

test("the onboarding window being merely covered does not tear the overlay down", async () => {
  // macOS fires hide on occlusion, not just on a real hide, so the event alone
  // cannot be trusted (see the same trap documented for the Dock icon).
  const setup = fixture({ settingsState: () => ({ settings: anchored, authPrompt: false }) });

  const guide = await openGuide(setup);
  setup.owner.shown = true;
  setup.owner.emit("hide");

  assert.equal(guide.isDestroyed(), false);
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

test("the drag row shows the app's own icon, not a generic one", async () => {
  // getFileIcon returns a generic icon for a bundle LaunchServices has not
  // registered, which is every unsigned local build.
  const setup = fixture({ settingsState: () => ({ settings: anchored, authPrompt: false }) });

  await openGuide(setup);

  assert.equal(setup.manager.snapshot().appIcon, "data:image/png;base64,bundled");
  // nativeImage cannot read .icns — it returns an empty image, which silently
  // drops the drag row back onto the generic icon.
  assert.ok(
    setup.iconPaths.length > 0 && setup.iconPaths.every((iconPath) => iconPath.endsWith(".png")),
    `icon must be read from a PNG, got ${setup.iconPaths.join(", ")}`
  );
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
  const open = setup.handlers.get("permission-guide-open");

  const [first, second] = await Promise.all([
    open(setup.event(setup.owner), state),
    open(setup.event(setup.owner), state),
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

test("the overlay paints a themed surface rather than a vibrancy material", async () => {
  const setup = fixture();

  const guide = await openGuide(setup);

  assert.equal(guide.options.vibrancy, undefined);
  assert.equal(guide.options.visualEffectState, undefined);
  assert.equal(guide.options.transparent, true);
  assert.equal(guide.options.width, 560);
  assert.equal(guide.options.height, 124);
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
  assert.equal(await setup.handlers.get("permission-guide-open")({ sender: {} }, state), false);
  assert.equal(
    await setup.handlers.get("permission-guide-open")(setup.event(setup.owner), {
      ...state,
      permission: "files",
    }),
    false
  );
  assert.equal(
    await setup.handlers.get("permission-guide-open")(
      { ...setup.event(setup.owner), senderFrame: {} },
      state
    ),
    false
  );
  const other = fixture({ platform: "win32" });
  assert.equal(
    await other.handlers.get("permission-guide-open")(other.event(other.owner), state),
    false
  );
  assert.equal(other.windows.length, 1);
});

test("actions reject stale steps and drag only the packaged application", async () => {
  const setup = fixture();
  assert.equal(
    await setup.handlers.get("permission-guide-open")(setup.event(setup.owner), state),
    true
  );
  const helper = setup.windows[1];
  setup.listeners.get("permission-guide-action")(setup.event(helper), {
    ...state,
    permission: "microphone",
    action: "settings",
  });
  assert.equal(setup.owner.webContents.sent.length, 0);
  setup.listeners.get("permission-guide-action")(setup.event(helper), {
    ...state,
    action: "settings",
  });
  assert.equal(setup.owner.webContents.sent[0][1].action, "settings");
  setup.listeners.get("permission-guide-drag")(setup.event(helper), {
    ...state,
    path: "/private/secret",
  });
  assert.equal(helper.dragged.file, "/Applications/OpenWhispr.app");
  assert.ok(helper.shown);
});

test("development guides disable dragging and owner teardown closes the helper", async () => {
  const setup = fixture({ packaged: false });
  await setup.handlers.get("permission-guide-open")(setup.event(setup.owner), state);
  const helper = setup.windows[1];
  const snapshot = setup.handlers.get("permission-guide-state")(setup.event(helper));
  assert.equal(snapshot.canDrag, false);
  setup.listeners.get("permission-guide-drag")(setup.event(helper), state);
  assert.equal(helper.dragged, undefined);
  setup.owner.emit("hide");
  assert.equal(helper.isDestroyed(), true);
  assert.equal(setup.owner.listenerCount("hide"), 0);
});

test("a helper closed while loading never reappears", async () => {
  const setup = fixture({ deferredLoad: true });
  const opening = setup.handlers.get("permission-guide-open")(setup.event(setup.owner), state);
  await new Promise((resolve) => setImmediate(resolve));
  setup.manager.close();
  setup.finish();
  assert.equal(await opening, false);
  assert.equal(setup.windows[1].shown, undefined);
});

test("helper falls back to a compact bottom overlay without stealing Settings focus", async () => {
  const setup = fixture();
  await setup.handlers.get("permission-guide-open")(setup.event(setup.owner), state);
  const helper = setup.windows[1];
  assert.equal(helper.options.width, 560);
  assert.equal(helper.options.height, 124);
  assert.equal(helper.options.alwaysOnTop, true);
  assert.equal(helper.focused, undefined);
  assert.ok(helper.options.y + helper.options.height <= 900);
});
