const { app, screen, BrowserWindow, shell, dialog } = require("electron");
const debugLogger = require("./debugLogger");
const HotkeyManager = require("./hotkeyManager");
const DragManager = require("./dragManager");
const MenuManager = require("./menuManager");
const DevServerManager = require("./devServerManager");
const { i18nMain } = require("./i18nMain");
const { DEV_SERVER_PORT } = DevServerManager;
const {
  MAIN_WINDOW_CONFIG,
  CONTROL_PANEL_CONFIG,
  WINDOW_SIZES,
  WindowPositionUtil,
} = require("./windowConfig");

class WindowManager {
  constructor() {
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this.tray = null;
    this.hotkeyManager = new HotkeyManager();
    this.dragManager = new DragManager();
    this.isQuitting = false;
    this.isMainWindowInteractive = false;
    this.loadErrorShown = false;
    this.macCompoundPushState = null;
    this.winPushState = null;
    this._cachedActivationMode = "tap";
    this._floatingIconAutoHide = false;

    app.on("before-quit", () => {
      this.isQuitting = true;
    });
  }

  async createMainWindow() {
    const display = screen.getPrimaryDisplay();
    const position = WindowPositionUtil.getMainWindowPosition(display);

    this.mainWindow = new BrowserWindow({
      ...MAIN_WINDOW_CONFIG,
      ...position,
    });

    this.setMainWindowInteractivity(false);
    this.registerMainWindowEvents();

    // Register load event handlers BEFORE loading to catch all events
    this.mainWindow.webContents.on(
      "did-fail-load",
      async (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        if (
          process.env.NODE_ENV === "development" &&
          validatedURL &&
          validatedURL.includes(`localhost:${DEV_SERVER_PORT}`)
        ) {
          setTimeout(async () => {
            const isReady = await DevServerManager.waitForDevServer();
            if (isReady) {
              this.mainWindow.reload();
            }
          }, 2000);
        } else {
          this.showLoadFailureDialog("Dictation panel", errorCode, errorDescription, validatedURL);
        }
      }
    );

    this.mainWindow.webContents.on("did-finish-load", () => {
      this.mainWindow.setTitle(i18nMain.t("window.voiceRecorderTitle"));
      this.enforceMainWindowOnTop();
    });

    await this.loadMainWindow();
    await this.initializeHotkey();
    this.dragManager.setTargetWindow(this.mainWindow);
    MenuManager.setupMainMenu();
  }

  setMainWindowInteractivity(shouldCapture) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    if (shouldCapture) {
      this.mainWindow.setIgnoreMouseEvents(false);
    } else {
      this.mainWindow.setIgnoreMouseEvents(true, { forward: true });
    }
    this.isMainWindowInteractive = shouldCapture;
  }

  resizeMainWindow(sizeKey) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }

    const newSize = WINDOW_SIZES[sizeKey] || WINDOW_SIZES.BASE;
    const currentBounds = this.mainWindow.getBounds();

    const bottomRightX = currentBounds.x + currentBounds.width;
    const bottomRightY = currentBounds.y + currentBounds.height;

    const display = screen.getDisplayNearestPoint({ x: bottomRightX, y: bottomRightY });
    const workArea = display.workArea || display.bounds;

    let newX = bottomRightX - newSize.width;
    let newY = bottomRightY - newSize.height;

    newX = Math.max(workArea.x, Math.min(newX, workArea.x + workArea.width - newSize.width));
    newY = Math.max(workArea.y, Math.min(newY, workArea.y + workArea.height - newSize.height));

    this.mainWindow.setBounds({
      x: newX,
      y: newY,
      width: newSize.width,
      height: newSize.height,
    });

    return { success: true, bounds: { x: newX, y: newY, ...newSize } };
  }

  async loadWindowContent(window, isControlPanel = false) {
    if (process.env.NODE_ENV === "development") {
      const appUrl = DevServerManager.getAppUrl(isControlPanel);
      await DevServerManager.waitForDevServer();
      await window.loadURL(appUrl);
    } else {
      // Production: use loadFile() for better compatibility with Electron 36+
      const fileInfo = DevServerManager.getAppFilePath(isControlPanel);
      if (!fileInfo) {
        throw new Error("Failed to get app file path");
      }

      const fs = require("fs");
      if (!fs.existsSync(fileInfo.path)) {
        throw new Error(`HTML file not found: ${fileInfo.path}`);
      }

      await window.loadFile(fileInfo.path, { query: fileInfo.query });
    }
  }

  async loadMainWindow() {
    await this.loadWindowContent(this.mainWindow, false);
  }

  createHotkeyCallback() {
    let lastToggleTime = 0;
    const DEBOUNCE_MS = 150;

    return async () => {
      if (this.hotkeyManager.isInListeningMode()) {
        return;
      }

      const activationMode = this.getActivationMode();
      const currentHotkey = this.hotkeyManager.getCurrentHotkey?.();

      if (
        process.platform === "darwin" &&
        activationMode === "push" &&
        currentHotkey &&
        currentHotkey !== "GLOBE" &&
        currentHotkey.includes("+")
      ) {
        this.startMacCompoundPushToTalk(currentHotkey);
        return;
      }

      // Windows push mode: always defer to native listener (globalShortcut can't detect key-up)
      if (process.platform === "win32" && activationMode === "push") {
        return;
      }

      const now = Date.now();
      if (now - lastToggleTime < DEBOUNCE_MS) {
        return;
      }
      lastToggleTime = now;

      // Capture target app PID before the window might steal focus
      if (this.textEditMonitor) this.textEditMonitor.captureTargetPid();

      this.showDictationPanel();
      this.mainWindow.webContents.send("toggle-dictation");
    };
  }

  startMacCompoundPushToTalk(hotkey) {
    if (this.macCompoundPushState?.active) {
      return;
    }

    const requiredModifiers = this.getMacRequiredModifiers(hotkey);
    if (requiredModifiers.size === 0) {
      return;
    }

    const MIN_HOLD_DURATION_MS = 150;
    const MAX_PUSH_DURATION_MS = 300000; // 5 minutes max recording
    const downTime = Date.now();

    if (this.textEditMonitor) this.textEditMonitor.captureTargetPid();
    this.showDictationPanel();

    const safetyTimeoutId = setTimeout(() => {
      if (this.macCompoundPushState?.active) {
        debugLogger.warn("Compound PTT safety timeout", undefined, "ptt");
        this.forceStopMacCompoundPush("timeout");
      }
    }, MAX_PUSH_DURATION_MS);

    this.macCompoundPushState = {
      active: true,
      downTime,
      isRecording: false,
      requiredModifiers,
      safetyTimeoutId,
    };

    setTimeout(() => {
      if (!this.macCompoundPushState || this.macCompoundPushState.downTime !== downTime) {
        return;
      }

      if (!this.macCompoundPushState.isRecording) {
        this.macCompoundPushState.isRecording = true;
        this.sendStartDictation();
      }
    }, MIN_HOLD_DURATION_MS);
  }

  handleMacPushModifierUp(modifier) {
    if (!this.macCompoundPushState?.active) {
      return;
    }

    if (!this.macCompoundPushState.requiredModifiers.has(modifier)) {
      return;
    }

    if (this.macCompoundPushState.safetyTimeoutId) {
      clearTimeout(this.macCompoundPushState.safetyTimeoutId);
    }

    const wasRecording = this.macCompoundPushState.isRecording;
    this.macCompoundPushState = null;

    if (wasRecording) {
      this.sendStopDictation();
    } else {
      this.hideDictationPanel();
    }
  }

  forceStopMacCompoundPush(reason = "manual") {
    if (!this.macCompoundPushState) {
      return;
    }

    if (this.macCompoundPushState.safetyTimeoutId) {
      clearTimeout(this.macCompoundPushState.safetyTimeoutId);
    }

    const wasRecording = this.macCompoundPushState.isRecording;
    this.macCompoundPushState = null;

    if (wasRecording) {
      this.sendStopDictation();
    }
    this.hideDictationPanel();

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("compound-ptt-force-stopped", { reason });
    }
  }

  getMacRequiredModifiers(hotkey) {
    const required = new Set();
    const parts = hotkey.split("+").map((part) => part.trim());

    for (const part of parts) {
      switch (part) {
        case "Command":
        case "Cmd":
        case "RightCommand":
        case "RightCmd":
        case "CommandOrControl":
        case "Super":
        case "Meta":
          required.add("command");
          break;
        case "Control":
        case "Ctrl":
        case "RightControl":
        case "RightCtrl":
          required.add("control");
          break;
        case "Alt":
        case "Option":
        case "RightAlt":
        case "RightOption":
          required.add("option");
          break;
        case "Shift":
        case "RightShift":
          required.add("shift");
          break;
        case "Fn":
          required.add("fn");
          break;
        default:
          break;
      }
    }

    return required;
  }

  startWindowsPushToTalk() {
    if (this.winPushState?.active) {
      return;
    }

    const MIN_HOLD_DURATION_MS = 150;
    const downTime = Date.now();

    this.showDictationPanel();

    this.winPushState = {
      active: true,
      downTime,
      isRecording: false,
    };

    setTimeout(() => {
      if (!this.winPushState || this.winPushState.downTime !== downTime) {
        return;
      }

      if (!this.winPushState.isRecording) {
        this.winPushState.isRecording = true;
        this.sendStartDictation();
      }
    }, MIN_HOLD_DURATION_MS);
  }

  handleWindowsPushKeyUp() {
    if (!this.winPushState?.active) {
      return;
    }

    const wasRecording = this.winPushState.isRecording;
    this.winPushState = null;

    if (wasRecording) {
      this.sendStopDictation();
    } else {
      this.hideDictationPanel();
    }
  }

  resetWindowsPushState() {
    this.winPushState = null;
  }

  sendStartDictation() {
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.showDictationPanel();
      this.mainWindow.webContents.send("start-dictation");
    }
  }

  sendStopDictation() {
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("stop-dictation");
    }
  }

  getActivationMode() {
    return this._cachedActivationMode;
  }

  setActivationModeCache(mode) {
    this._cachedActivationMode = mode === "push" ? "push" : "tap";
  }

  setFloatingIconAutoHide(enabled) {
    this._floatingIconAutoHide = Boolean(enabled);
  }

  setHotkeyListeningMode(enabled) {
    this.hotkeyManager.setListeningMode(enabled);
  }

  async initializeHotkey() {
    await this.hotkeyManager.initializeHotkey(this.mainWindow, this.createHotkeyCallback());
  }

  async updateHotkey(hotkey) {
    return await this.hotkeyManager.updateHotkey(hotkey, this.createHotkeyCallback());
  }

  isUsingGnomeHotkeys() {
    return this.hotkeyManager.isUsingGnome();
  }

  async startWindowDrag() {
    return await this.dragManager.startWindowDrag();
  }

  async stopWindowDrag() {
    return await this.dragManager.stopWindowDrag();
  }

  openExternalUrl(url, showError = true) {
    shell.openExternal(url).catch((error) => {
      if (showError) {
        dialog.showErrorBox(
          i18nMain.t("dialog.openLink.title"),
          i18nMain.t("dialog.openLink.message", { url, error: error.message })
        );
      }
    });
  }

  async createControlPanelWindow() {
    if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
      if (this.controlPanelWindow.isMinimized()) {
        this.controlPanelWindow.restore();
      }
      if (!this.controlPanelWindow.isVisible()) {
        this.controlPanelWindow.show();
      }
      this.controlPanelWindow.focus();
      return;
    }

    this.controlPanelWindow = new BrowserWindow(CONTROL_PANEL_CONFIG);

    this.controlPanelWindow.webContents.on("will-navigate", (event, url) => {
      const appUrl = DevServerManager.getAppUrl(true);
      const controlPanelUrl = appUrl.startsWith("http") ? appUrl : `file://${appUrl}`;

      if (
        url.startsWith(controlPanelUrl) ||
        url.startsWith("file://") ||
        url.startsWith("devtools://")
      ) {
        return;
      }

      event.preventDefault();
      this.openExternalUrl(url);
    });

    this.controlPanelWindow.webContents.setWindowOpenHandler(({ url }) => {
      this.openExternalUrl(url);
      return { action: "deny" };
    });

    this.controlPanelWindow.webContents.on("did-create-window", (childWindow, details) => {
      childWindow.close();
      if (details.url && !details.url.startsWith("devtools://")) {
        this.openExternalUrl(details.url, false);
      }
    });

    const visibilityTimer = setTimeout(() => {
      if (!this.controlPanelWindow || this.controlPanelWindow.isDestroyed()) {
        return;
      }
      if (!this.controlPanelWindow.isVisible()) {
        this.controlPanelWindow.show();
        this.controlPanelWindow.focus();
      }
    }, 10000);

    const clearVisibilityTimer = () => {
      clearTimeout(visibilityTimer);
    };

    this.controlPanelWindow.once("ready-to-show", () => {
      clearVisibilityTimer();
      if (process.platform === "darwin" && app.dock) {
        app.dock.show();
      }
      this.controlPanelWindow.show();
      this.controlPanelWindow.focus();
    });

    this.controlPanelWindow.on("close", (event) => {
      if (!this.isQuitting) {
        event.preventDefault();
        this.hideControlPanelToTray();
      }
    });

    this.controlPanelWindow.on("closed", () => {
      clearVisibilityTimer();
      this.controlPanelWindow = null;
    });

    MenuManager.setupControlPanelMenu(this.controlPanelWindow);

    this.controlPanelWindow.webContents.on("did-finish-load", () => {
      clearVisibilityTimer();
      this.controlPanelWindow.setTitle(i18nMain.t("window.controlPanelTitle"));
    });

    this.controlPanelWindow.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        clearVisibilityTimer();
        if (process.env.NODE_ENV !== "development") {
          this.showLoadFailureDialog("Control panel", errorCode, errorDescription, validatedURL);
        }
        if (!this.controlPanelWindow.isVisible()) {
          this.controlPanelWindow.show();
          this.controlPanelWindow.focus();
        }
      }
    );

    this.controlPanelWindow.webContents.on("render-process-gone", (_event, details) => {
      if (details.reason === "crashed" || details.reason === "killed" || details.reason === "oom") {
        debugLogger.error(
          "Control panel renderer process gone",
          { reason: details.reason, exitCode: details.exitCode },
          "window"
        );
        setTimeout(() => this.loadControlPanel(), 1000);
      }
    });

    this.controlPanelWindow.on("show", () => {
      if (this.controlPanelWindow.webContents.isCrashed()) {
        debugLogger.error("Control panel crashed, reloading on show", undefined, "window");
        this.loadControlPanel();
      }
    });

    await this.loadControlPanel();
  }

  async loadControlPanel() {
    await this.loadWindowContent(this.controlPanelWindow, true);
  }

  showDictationPanel(options = {}) {
    const { focus = false } = options;
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      if (this.mainWindow.isMinimized()) {
        this.mainWindow.restore();
      }
      if (!this.mainWindow.isVisible()) {
        if (typeof this.mainWindow.showInactive === "function") {
          this.mainWindow.showInactive();
        } else {
          this.mainWindow.show();
        }
      }
      if (focus) {
        this.mainWindow.focus();
      }
    }
  }

  hideControlPanelToTray() {
    if (!this.controlPanelWindow || this.controlPanelWindow.isDestroyed()) {
      return;
    }

    this.controlPanelWindow.hide();

    if (process.platform === "darwin" && app.dock) {
      app.dock.hide();
    }
  }

  hideDictationPanel() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.hide();
    }
  }

  isDictationPanelVisible() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return false;
    }

    if (this.mainWindow.isMinimized && this.mainWindow.isMinimized()) {
      return false;
    }

    return this.mainWindow.isVisible();
  }

  registerMainWindowEvents() {
    if (!this.mainWindow) {
      return;
    }

    // Safety timeout: force show the window if ready-to-show doesn't fire within 10 seconds
    const showTimeout = setTimeout(() => {
      if (
        this.mainWindow &&
        !this.mainWindow.isDestroyed() &&
        !this.mainWindow.isVisible() &&
        !this._floatingIconAutoHide
      ) {
        this.showDictationPanel();
      }
    }, 10000);

    this.mainWindow.once("ready-to-show", () => {
      clearTimeout(showTimeout);
      this.enforceMainWindowOnTop();
      if (!this.mainWindow.isVisible() && !this._floatingIconAutoHide) {
        if (typeof this.mainWindow.showInactive === "function") {
          this.mainWindow.showInactive();
        } else {
          this.mainWindow.show();
        }
      }
    });

    this.mainWindow.on("show", () => {
      this.enforceMainWindowOnTop();
    });

    this.mainWindow.on("focus", () => {
      this.enforceMainWindowOnTop();
    });

    this.mainWindow.on("closed", () => {
      this.dragManager.cleanup();
      this.mainWindow = null;
      this.isMainWindowInteractive = false;
    });
  }

  enforceMainWindowOnTop() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      WindowPositionUtil.setupAlwaysOnTop(this.mainWindow);
    }
  }

  refreshLocalizedUi() {
    MenuManager.setupMainMenu();

    if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
      MenuManager.setupControlPanelMenu(this.controlPanelWindow);
      this.controlPanelWindow.setTitle(i18nMain.t("window.controlPanelTitle"));
    }

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.setTitle(i18nMain.t("window.voiceRecorderTitle"));
    }
  }

  showLoadFailureDialog(windowName, errorCode, errorDescription, validatedURL) {
    if (this.loadErrorShown) {
      return;
    }
    this.loadErrorShown = true;
    const detailLines = [
      i18nMain.t("dialog.loadFailure.detail.window", { windowName }),
      i18nMain.t("dialog.loadFailure.detail.error", { errorCode, errorDescription }),
      validatedURL ? i18nMain.t("dialog.loadFailure.detail.url", { url: validatedURL }) : null,
      i18nMain.t("dialog.loadFailure.detail.hint"),
    ].filter(Boolean);
    dialog.showMessageBox({
      type: "error",
      title: i18nMain.t("dialog.loadFailure.title"),
      message: i18nMain.t("dialog.loadFailure.message"),
      detail: detailLines.join("\n"),
    });
  }
}

module.exports = WindowManager;
