const { app, BrowserWindow, nativeImage, screen } = require("electron");
const path = require("path");
const DevServerManager = require("./devServerManager");
const debugLogger = require("./debugLogger");
const { computeGuideBounds } = require("./permissionGuidePlacement");
const {
  isSettingsWindowStateAvailable,
  readSettingsWindowState,
} = require("./settingsWindowState");

const PERMISSIONS = new Set(["microphone", "accessibility", "system-audio", "screen-context"]);
const ACTIONS = new Set(["check", "settings", "close", "restart"]);
const GUIDE_SIZE = { width: 560, height: 124 };
const POLL_MS = 500;
// System Settings takes a moment to put its window up after the Enable click.
// Showing before then is what made the overlay appear low and then jump.
const SETTINGS_WAIT_ATTEMPTS = 6;

function validState(state) {
  return (
    state &&
    typeof state.sessionId === "string" &&
    state.sessionId.length > 0 &&
    state.sessionId.length <= 128 &&
    PERMISSIONS.has(state.permission) &&
    ["granted", "needsRelaunch", "busy", "error"].every((key) => typeof state[key] === "boolean")
  );
}

function fromWindow(event, window) {
  return (
    window &&
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame
  );
}

class PermissionGuideManager {
  constructor(windowManager, { wait } = {}) {
    this.windowManager = windowManager;
    this.window = null;
    this.owner = null;
    // The owner's contents, held separately: once a BrowserWindow has closed,
    // reading its webContents throws, and the listeners still have to come off.
    this.ownerContents = null;
    this.state = null;
    this.bundlePath = null;
    this.icon = null;
    this.wait = wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.sawSettings = false;
    this.steppedAside = false;
    this.pollTimer = null;
    // The onboarding document that owns this guide is gone: closed, crashed, or
    // navigated away (log out reloads it, the OAuth refresh loads a new URL).
    // Not wired to hide: on macOS that fires on occlusion too, and isVisible()
    // folds occlusion in as well, so neither can tell a covered window from one
    // sent to the tray. hideControlPanelToTray() closes the guide explicitly.
    this.ownerGone = () => this.close(false, true);
    this.ownerNavigated = (navigation) => {
      if (navigation.isMainFrame && !navigation.isSameDocument) this.ownerGone();
    };
  }

  // Not restoring focus: the renderer closes on a grant, and the user may
  // still be in System Settings for the next permission.
  closeFromOwner(event) {
    if (!this.isOwner(event)) return false;
    this.close();
    return true;
  }

  stateFor(event) {
    return fromWindow(event, this.window) ? this.snapshot() : null;
  }

  handleAction(event, action) {
    if (!fromWindow(event, this.window) || !this.matches(action) || !ACTIONS.has(action.action))
      return;
    // Closing is done here, not echoed back through the owner: the owner may
    // no longer be listening, and the guide must never outlive its controls.
    if (action.action === "close") this.close(true, true);
    else this.sendAction(action.action);
  }

  startDrag(event, target) {
    if (!fromWindow(event, this.window) || !this.matches(target) || !this.snapshot().canDrag)
      return;
    try {
      event.sender.startDrag({ file: this.bundlePath, icon: this.icon });
    } catch (error) {
      debugLogger.warn("Permission guide drag failed", { error: error.message });
    }
  }

  isOwner(event) {
    return (
      process.platform === "darwin" &&
      this.windowManager._onboardingActive &&
      fromWindow(event, this.windowManager.controlPanelWindow)
    );
  }

  matches(target) {
    return (
      target &&
      this.state &&
      target.sessionId === this.state.sessionId &&
      target.permission === this.state.permission
    );
  }

  snapshot() {
    if (!this.state) return null;
    return {
      ...this.state,
      canDrag:
        !!this.bundlePath &&
        !this.state.busy &&
        !this.state.granted &&
        ["accessibility", "screen-context"].includes(this.state.permission),
      appIcon: this.icon?.toDataURL(),
    };
  }

  setState(state) {
    // Only forward presentation fields; filesystem paths and app identity belong to main.
    this.state = Object.fromEntries(
      ["sessionId", "permission", "granted", "needsRelaunch", "busy", "error"].map((key) => [
        key,
        state[key],
      ])
    );
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send("permission-guide-state-changed", this.snapshot());
    }
  }

  workAreaFor(rect) {
    return screen.getDisplayMatching(rect).workArea;
  }

  // Anchored inside the System Settings window, falling back to the bottom of
  // the display while that window has not appeared.
  applyBounds(window, settings) {
    // Keyed off the dialog, not the onboarding window: System Settings can open
    // on a different display, and clamping to the onboarding window's screen
    // strands the overlay away from the dialog it belongs to.
    const bounds = computeGuideBounds({
      settingsBounds: settings,
      workArea: this.workAreaFor(settings ?? this.owner.getBounds()),
      size: GUIDE_SIZE,
    });
    const current = window.getBounds();
    if (current.x !== bounds.x || current.y !== bounds.y) window.setBounds(bounds);
  }

  async waitForSettings(window) {
    let state = await readSettingsWindowState();
    for (let attempt = 0; attempt < SETTINGS_WAIT_ATTEMPTS && !state?.settings; attempt++) {
      await this.wait(POLL_MS);
      if (this.window !== window || window.isDestroyed()) return null;
      state = await readSettingsWindowState();
    }
    return state;
  }

  // One tick of the overlay's relationship with the settings window: follow it,
  // step aside for an authorization prompt, and close with it.
  async poll() {
    const window = this.window;
    if (!window || window.isDestroyed()) return;

    const state = await readSettingsWindowState();
    // A failed read is unknown, not closed: acting on it would dismiss the
    // overlay over a transient hiccup.
    if (!state || this.window !== window || window.isDestroyed()) return;

    if (state.settings) {
      this.sawSettings = true;
      this.applyBounds(window, state.settings);
    } else if (this.sawSettings && !state.settingsRunning) {
      this.close(true, true);
      return;
    }

    const aside = this.shouldStepAside(state);
    if (aside === this.steppedAside) return;
    this.steppedAside = aside;
    if (aside) window.hide();
    else window.showInactive();
  }

  // The overlay belongs to the settings dialog: it steps aside for an
  // authorization prompt, for any other app the user brings to the front, and
  // while the dialog is on another Space.
  shouldStepAside(state) {
    return (
      state.authPrompt || state.frontmost === "other" || (!state.settings && state.settingsRunning)
    );
  }

  // One read at a time: an interval would keep firing while a slow helper is
  // still running, and two reads in flight can answer out of order.
  startPolling() {
    this.stopPolling();
    const window = this.window;
    const tick = async () => {
      await this.poll();
      if (this.window === window) this.pollTimer = setTimeout(tick, POLL_MS);
    };
    this.pollTimer = setTimeout(tick, POLL_MS);
  }

  stopPolling() {
    if (this.pollTimer === null) return;
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  sendAction(action) {
    if (this.state && this.ownerContents && !this.ownerContents.isDestroyed()) {
      this.ownerContents.send("permission-guide-action", {
        sessionId: this.state.sessionId,
        permission: this.state.permission,
        action,
      });
    }
  }

  async open(event, state) {
    if (!this.isOwner(event) || !validState(state)) return false;
    // Without the helper the overlay could neither follow the dialog nor close
    // with it; refusing lets Enable fall back to the plain Settings flow.
    if (!isSettingsWindowStateAvailable()) return false;
    if (this.window && !this.window.isDestroyed() && state.sessionId === this.state?.sessionId) {
      this.setState(state);
      return true;
    }
    this.close();
    const owner = this.windowManager.controlPanelWindow;
    this.owner = owner;
    this.ownerContents = owner.webContents;
    const window = new BrowserWindow({
      // Created at the fallback spot with no await between here and the
      // this.window assignment below, so a second publish takes the early
      // return above instead of tearing this window down. The anchored bounds
      // are applied further down, while the window is still hidden.
      ...computeGuideBounds({
        settingsBounds: null,
        workArea: this.workAreaFor(owner.getBounds()),
        size: GUIDE_SIZE,
      }),
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      show: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: true,
      acceptFirstMouse: true,
      hasShadow: true,
      webPreferences: {
        preload: path.join(__dirname, "../../preload.js"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    // System Settings may be on another Space; without this the overlay can be
    // ordered onto the Space being left and stay invisible there.
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    this.window = window;
    this.setState(state);
    owner.on("closed", this.ownerGone);
    this.ownerContents.on("render-process-gone", this.ownerGone);
    this.ownerContents.on("did-start-navigation", this.ownerNavigated);
    window.on("closed", () => {
      if (this.window === window) this.close(false, true);
    });
    window.webContents.on("render-process-gone", () => {
      if (this.window === window) this.close(true, true);
    });
    window.webContents.on("will-navigate", (navigation) => navigation.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    try {
      // Anchored before the load, so the overlay is already in place by the time
      // showInactive() below makes it visible.
      const settingsState = await this.waitForSettings(window);
      if (this.window !== window || window.isDestroyed()) return false;
      if (settingsState?.settings) this.sawSettings = true;
      this.applyBounds(window, settingsState?.settings ?? null);

      if (app.isPackaged) {
        this.bundlePath = path.resolve(app.getPath("exe"), "../../..");
        // The PNG, not icon.icns: nativeImage cannot read .icns. Downscaled
        // because the snapshot carries it as a data URL on every state publish.
        this.icon = nativeImage
          .createFromPath(path.join(process.resourcesPath, "src", "assets", "icon.png"))
          .resize({ width: 64, height: 64 });
      }
      if (process.env.NODE_ENV === "development") {
        await window.loadURL(`${DevServerManager.DEV_SERVER_URL}?permission-guide=true`);
      } else {
        const file = DevServerManager.getAppFilePath(false);
        await window.loadFile(file.path, { query: { ...file.query, "permission-guide": "true" } });
      }
      if (this.window !== window || window.isDestroyed()) return false;
      window.webContents.send("permission-guide-state-changed", this.snapshot());
      this.steppedAside = Boolean(settingsState && this.shouldStepAside(settingsState));
      if (!this.steppedAside) window.showInactive();
      this.startPolling();
      return true;
    } catch (error) {
      debugLogger.error("Could not open permission guide", { error: error.message });
      if (this.window === window) this.close();
      return false;
    }
  }

  close(restore = false, notify = false) {
    const window = this.window;
    const owner = this.owner;
    const ownerContents = this.ownerContents;
    this.stopPolling();
    if (notify) this.sendAction("close");
    this.window = null;
    this.state = null;
    this.owner = null;
    this.ownerContents = null;
    this.bundlePath = null;
    this.icon = null;
    this.sawSettings = false;
    this.steppedAside = false;
    if (owner) owner.removeListener("closed", this.ownerGone);
    if (ownerContents) {
      ownerContents.removeListener("render-process-gone", this.ownerGone);
      ownerContents.removeListener("did-start-navigation", this.ownerNavigated);
    }
    if (window && !window.isDestroyed()) window.close();
    if (restore && owner && !owner.isDestroyed()) {
      owner.show();
      owner.focus();
    }
  }
}

exports.PermissionGuideManager = PermissionGuideManager;
