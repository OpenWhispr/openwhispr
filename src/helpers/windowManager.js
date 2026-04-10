const { app, screen, BrowserWindow, shell, dialog } = require("electron");
const debugLogger = require("./debugLogger");
const HotkeyManager = require("./hotkeyManager");
const { isGlobeLikeHotkey } = HotkeyManager;
const DragManager = require("./dragManager");
const MenuManager = require("./menuManager");
const DevServerManager = require("./devServerManager");
const { i18nMain } = require("./i18nMain");
const { DEV_SERVER_PORT } = DevServerManager;
const {
  MAIN_WINDOW_CONFIG,
  CONTROL_PANEL_CONFIG,
  AGENT_OVERLAY_CONFIG,
  NOTIFICATION_WINDOW_CONFIG,
  TRANSCRIPTION_PREVIEW_CONFIG,
  TRANSCRIPTION_PREVIEW_SIZE_LIMITS,
  WINDOW_SIZES,
  WindowPositionUtil,
} = require("./windowConfig");

class WindowManager {
  constructor() {
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this.agentWindow = null;
    this.notificationWindow = null;
    this._notificationTimeout = null;
    this.transcriptionPreviewWindow = null;
    this.updateNotificationWindow = null;
    this._updateNotificationDismissed = false;
    this.tray = null;
    this.hotkeyManager = new HotkeyManager();
    this.dragManager = new DragManager();
    this.isQuitting = false;
    this.loadErrorShown = false;
    this.macCompoundPushState = null;
    this.winPushState = null;
    this._cachedActivationMode = "tap";
    this._floatingIconAutoHide = false;
    this._agentAnimationState = null;
    this._panelStartPosition = "bottom-right";
    this._isDictatingToggle = false;

    app.on("before-quit", () => {
      this.isQuitting = true;
      this.hotkeyManager.unregisterAll();
    });
  }

  async createMainWindow() {
    const cursorPos = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursorPos);
    const position = WindowPositionUtil.getMainWindowPosition(
      display,
      null,
      this._panelStartPosition
    );

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
    MenuManager.setupMainMenu(() => this.openSettings());
  }

  setMainWindowInteractivity(shouldCapture) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    if (process.platform === "win32") {
      // Windows click-through forwarding is unreliable for this floating panel.
      // Keep the panel interactive so the mic button and cancel button are always clickable.
      this.mainWindow.setIgnoreMouseEvents(false);
      return;
    }

    if (shouldCapture) {
      this.mainWindow.setIgnoreMouseEvents(false);
    } else {
      this.mainWindow.setIgnoreMouseEvents(true, { forward: true });
    }
  }

  resizeMainWindow(sizeKey) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }

    const newSize = WINDOW_SIZES[sizeKey] || WINDOW_SIZES.BASE;
    const currentBounds = this.mainWindow.getBounds();
    const position = this._panelStartPosition;

    const display = screen.getDisplayNearestPoint({
      x: currentBounds.x + currentBounds.width / 2,
      y: currentBounds.y + currentBounds.height,
    });
    const workArea = display.workArea || display.bounds;

    let newX, newY;

    if (position === "bottom-left") {
      // Anchor bottom-left corner: keep x, expand rightward and upward
      newX = currentBounds.x;
      newY = currentBounds.y + currentBounds.height - newSize.height;
    } else if (position === "center") {
      // Anchor bottom-center: expand symmetrically and upward
      const centerX = currentBounds.x + currentBounds.width / 2;
      newX = centerX - newSize.width / 2;
      newY = currentBounds.y + currentBounds.height - newSize.height;
    } else {
      // bottom-right (default): anchor bottom-right corner, expand leftward and upward
      const bottomRightX = currentBounds.x + currentBounds.width;
      newX = bottomRightX - newSize.width;
      newY = currentBounds.y + currentBounds.height - newSize.height;
    }

    // Clamp to work area
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

  async loadWindowContent(window, isControlPanel = false, isAgent = false) {
    if (process.env.NODE_ENV === "development") {
      let appUrl = DevServerManager.getAppUrl(isControlPanel);
      if (isAgent) {
        appUrl = `${DevServerManager.getAppUrl(false)}?agent=true`;
      }
      await DevServerManager.waitForDevServer();
      await window.loadURL(appUrl);
    } else {
      const fileInfo = DevServerManager.getAppFilePath(isControlPanel);
      if (!fileInfo) {
        throw new Error("Failed to get app file path");
      }

      if (isAgent) {
        fileInfo.query = { agent: "true" };
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
        !isGlobeLikeHotkey(currentHotkey) &&
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

      this.sendToggleDictation();
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

  sendToggleDictation() {
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.showDictationPanel();
      this.mainWindow.webContents.send("toggle-dictation");
      this._isDictatingToggle = !this._isDictatingToggle;
      this.meetingDetectionEngine?.setUserRecording(this._isDictatingToggle);
    }
  }

  sendStartDictation() {
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.showDictationPanel();
      this.mainWindow.webContents.send("start-dictation");
      this.meetingDetectionEngine?.setUserRecording(true);
    }
  }

  sendStopDictation() {
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("stop-dictation");
      this._isDictatingToggle = false;
      this.meetingDetectionEngine?.setUserRecording(false);
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

  setPanelStartPosition(position) {
    this._panelStartPosition = position || "bottom-right";
    // Reposition the window immediately
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const currentBounds = this.mainWindow.getBounds();
      const display = screen.getDisplayNearestPoint({
        x: currentBounds.x + currentBounds.width / 2,
        y: currentBounds.y + currentBounds.height / 2,
      });
      const newPos = WindowPositionUtil.getMainWindowPosition(
        display,
        { width: currentBounds.width, height: currentBounds.height },
        this._panelStartPosition
      );
      this.mainWindow.setBounds(newPos);
    }
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

  isUsingHyprlandHotkeys() {
    return this.hotkeyManager.isUsingHyprland();
  }

  isUsingKDEHotkeys() {
    return this.hotkeyManager.isUsingKDE();
  }

  isUsingNativeShortcutHotkeys() {
    return this.hotkeyManager.isUsingNativeShortcut();
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

    MenuManager.setupControlPanelMenu(this.controlPanelWindow, () => this.openSettings());

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

  async createAgentWindow() {
    if (this.agentWindow && !this.agentWindow.isDestroyed()) {
      return;
    }

    this.agentWindow = new BrowserWindow(AGENT_OVERLAY_CONFIG);

    this.agentWindow.once("ready-to-show", () => {
      WindowPositionUtil.setupAlwaysOnTop(this.agentWindow);
    });

    this.agentWindow.webContents.on("did-finish-load", () => {
      this.agentWindow.setTitle(i18nMain.t("window.agentChatTitle"));
    });

    this.agentWindow.on("closed", () => {
      this.agentWindow = null;
    });

    await this.loadWindowContent(this.agentWindow, false, true);
  }

  toggleAgentOverlay() {
    if (!this.agentWindow || this.agentWindow.isDestroyed()) return;

    if (this.agentWindow.isVisible()) {
      this.agentWindow.webContents.send("agent-toggle-recording");
    } else {
      this.showAgentOverlay();
    }
  }

  showAgentOverlay() {
    if (!this.agentWindow || this.agentWindow.isDestroyed()) return;

    this._clearAgentAnimation();

    // Get work area to fill full screen height
    const mainBounds =
      this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow.getBounds() : null;
    const refPoint = mainBounds || { x: 0, y: 0 };
    const display = screen.getDisplayNearestPoint({ x: refPoint.x, y: refPoint.y });
    const workArea = display.workArea || display.bounds;

    const width = AGENT_OVERLAY_CONFIG.width;
    const height = workArea.height;

    // Center horizontally relative to main window, fill work area height
    let x = workArea.x;
    if (mainBounds) {
      x = mainBounds.x + Math.round((mainBounds.width - width) / 2);
      x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width));
    }

    this.agentWindow.setBounds({
      x,
      y: workArea.y,
      width,
      height,
    });

    WindowPositionUtil.setupAlwaysOnTop(this.agentWindow);

    if (typeof this.agentWindow.showInactive === "function") {
      this.agentWindow.showInactive();
    } else {
      this.agentWindow.show();
    }
  }

  hideAgentOverlay() {
    if (!this.agentWindow || this.agentWindow.isDestroyed()) return;

    this._clearAgentAnimation();
    this.agentWindow.webContents.send("agent-stop-recording");
    this.agentWindow.hide();
  }

  async ensureTranscriptionPreviewWindow() {
    if (this.transcriptionPreviewWindow && !this.transcriptionPreviewWindow.isDestroyed()) {
      return;
    }

    this.transcriptionPreviewWindow = new BrowserWindow(TRANSCRIPTION_PREVIEW_CONFIG);

    this.transcriptionPreviewWindow.on("closed", () => {
      this.transcriptionPreviewWindow = null;
    });

    if (process.env.NODE_ENV === "development") {
      await DevServerManager.waitForDevServer();
      await this.transcriptionPreviewWindow.loadURL(
        `${DevServerManager.DEV_SERVER_URL}?transcription-preview=true`
      );
    } else {
      const fileInfo = DevServerManager.getAppFilePath(false);
      await this.transcriptionPreviewWindow.loadFile(fileInfo.path, {
        query: { ...fileInfo.query, "transcription-preview": "true" },
      });
    }
  }

  async showTranscriptionPreview(text) {
    await this.ensureTranscriptionPreviewWindow();

    if (!this.transcriptionPreviewWindow || this.transcriptionPreviewWindow.isDestroyed()) return;

    const mainBounds =
      this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow.getBounds() : null;

    if (mainBounds) {
      const display = screen.getDisplayNearestPoint({ x: mainBounds.x, y: mainBounds.y });
      const position = WindowPositionUtil.getTranscriptionPreviewPosition(display, mainBounds, {
        width: TRANSCRIPTION_PREVIEW_CONFIG.width,
        height: TRANSCRIPTION_PREVIEW_CONFIG.height,
      });
      this.transcriptionPreviewWindow.setBounds(position);
    }

    this.transcriptionPreviewWindow.webContents.send("preview-text", text);
    this.transcriptionPreviewWindow.showInactive();
    WindowPositionUtil.setupAlwaysOnTop(this.transcriptionPreviewWindow);
  }

  appendTranscriptionPreview(text) {
    if (!this.transcriptionPreviewWindow || this.transcriptionPreviewWindow.isDestroyed()) return;
    this.transcriptionPreviewWindow.webContents.send("preview-append", text);
  }

  holdTranscriptionPreview(options = {}) {
    if (!this.transcriptionPreviewWindow || this.transcriptionPreviewWindow.isDestroyed()) return;
    this.transcriptionPreviewWindow.webContents.send("preview-hold", {
      showCleanup: !!options.showCleanup,
    });
  }

  completeTranscriptionPreview(text) {
    if (!this.transcriptionPreviewWindow || this.transcriptionPreviewWindow.isDestroyed()) return;
    this.transcriptionPreviewWindow.webContents.send("preview-result", { text });
    this.transcriptionPreviewWindow.showInactive();
    WindowPositionUtil.setupAlwaysOnTop(this.transcriptionPreviewWindow);
  }

  hideTranscriptionPreview() {
    if (!this.transcriptionPreviewWindow || this.transcriptionPreviewWindow.isDestroyed()) return;

    this.transcriptionPreviewWindow.webContents.send("preview-hide");
    setTimeout(() => {
      if (this.transcriptionPreviewWindow && !this.transcriptionPreviewWindow.isDestroyed()) {
        this.transcriptionPreviewWindow.hide();
      }
    }, 200);
  }

  resizeTranscriptionPreview(width, height) {
    if (!this.transcriptionPreviewWindow || this.transcriptionPreviewWindow.isDestroyed()) {
      return { success: false, error: "Preview window not available" };
    }

    const targetWidth = Math.max(
      TRANSCRIPTION_PREVIEW_SIZE_LIMITS.minWidth,
      Math.min(Math.round(width), TRANSCRIPTION_PREVIEW_SIZE_LIMITS.maxWidth)
    );
    const targetHeight = Math.max(
      TRANSCRIPTION_PREVIEW_SIZE_LIMITS.minHeight,
      Math.min(Math.round(height), TRANSCRIPTION_PREVIEW_SIZE_LIMITS.maxHeight)
    );

    const anchorBounds =
      this.mainWindow && !this.mainWindow.isDestroyed()
        ? this.mainWindow.getBounds()
        : this.transcriptionPreviewWindow.getBounds();
    const display = screen.getDisplayNearestPoint({ x: anchorBounds.x, y: anchorBounds.y });
    const bounds = WindowPositionUtil.getTranscriptionPreviewPosition(display, anchorBounds, {
      width: targetWidth,
      height: targetHeight,
    });

    const currentBounds = this.transcriptionPreviewWindow.getBounds();
    if (
      currentBounds.x === bounds.x &&
      currentBounds.y === bounds.y &&
      currentBounds.width === bounds.width &&
      currentBounds.height === bounds.height
    ) {
      return { success: true, bounds };
    }

    this.transcriptionPreviewWindow.setBounds(bounds);
    return { success: true, bounds };
  }

  resizeAgentWindow(width, height) {
    if (!this.agentWindow || this.agentWindow.isDestroyed()) return;

    const ANIMATION_DURATION_MS = 250;
    const TICK_MS = 16;

    const targetWidth = Math.max(
      AGENT_OVERLAY_CONFIG.minWidth,
      Math.min(width, AGENT_OVERLAY_CONFIG.maxWidth)
    );
    const targetHeight = Math.max(
      AGENT_OVERLAY_CONFIG.minHeight,
      Math.min(height, AGENT_OVERLAY_CONFIG.maxHeight)
    );

    const currentBounds = this.agentWindow.getBounds();

    if (currentBounds.height === targetHeight && currentBounds.width === targetWidth) {
      this._clearAgentAnimation();
      return;
    }

    // If animation already running, retarget from current position
    if (this._agentAnimationState) {
      this._agentAnimationState.targetHeight = targetHeight;
      this._agentAnimationState.targetWidth = targetWidth;
      this._agentAnimationState.startHeight = currentBounds.height;
      this._agentAnimationState.startWidth = currentBounds.width;
      this._agentAnimationState.startTime = Date.now();
      return;
    }

    this._agentAnimationState = {
      startHeight: currentBounds.height,
      startWidth: currentBounds.width,
      targetHeight,
      targetWidth,
      startTime: Date.now(),
      intervalId: null,
    };

    this._agentAnimationState.intervalId = setInterval(() => {
      if (!this.agentWindow || this.agentWindow.isDestroyed()) {
        this._clearAgentAnimation();
        return;
      }

      const state = this._agentAnimationState;
      if (!state) return;

      const elapsed = Date.now() - state.startTime;
      const rawT = Math.min(elapsed / ANIMATION_DURATION_MS, 1);
      // Ease-out quadratic
      const t = 1 - (1 - rawT) * (1 - rawT);

      const newHeight = Math.round(
        state.startHeight + (state.targetHeight - state.startHeight) * t
      );
      const newWidth = Math.round(state.startWidth + (state.targetWidth - state.startWidth) * t);

      const bounds = this.agentWindow.getBounds();

      // Clamp to screen work area
      const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
      const workArea = display.workArea || display.bounds;
      const clampedHeight = Math.min(newHeight, workArea.y + workArea.height - bounds.y);

      this.agentWindow.setBounds({
        x: bounds.x,
        y: bounds.y,
        width: newWidth,
        height: Math.max(AGENT_OVERLAY_CONFIG.minHeight, clampedHeight),
      });

      if (rawT >= 1) {
        this._clearAgentAnimation();
      }
    }, TICK_MS);
  }

  _clearAgentAnimation() {
    if (this._agentAnimationState?.intervalId) {
      clearInterval(this._agentAnimationState.intervalId);
    }
    this._agentAnimationState = null;
  }

  getAgentWindowBounds() {
    if (!this.agentWindow || this.agentWindow.isDestroyed()) return null;
    return this.agentWindow.getBounds();
  }

  setAgentWindowBounds(x, y, width, height) {
    if (!this.agentWindow || this.agentWindow.isDestroyed()) return;

    const bounds = {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    };

    // Enforce minimums
    bounds.width = Math.max(AGENT_OVERLAY_CONFIG.minWidth, bounds.width);
    bounds.height = Math.max(AGENT_OVERLAY_CONFIG.minHeight, bounds.height);

    // Clamp to screen work area
    const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
    const workArea = display.workArea || display.bounds;
    bounds.width = Math.min(bounds.width, workArea.width);
    bounds.height = Math.min(bounds.height, workArea.y + workArea.height - bounds.y);

    this.agentWindow.setBounds(bounds);
  }

  _repositionToCursorDisplay() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    const cursorPos = screen.getCursorScreenPoint();
    const cursorDisplay = screen.getDisplayNearestPoint(cursorPos);

    const currentBounds = this.mainWindow.getBounds();
    const currentDisplay = screen.getDisplayNearestPoint({
      x: currentBounds.x + currentBounds.width / 2,
      y: currentBounds.y + currentBounds.height / 2,
    });

    if (currentDisplay.id === cursorDisplay.id) return;

    const newPos = WindowPositionUtil.getMainWindowPosition(
      cursorDisplay,
      { width: currentBounds.width, height: currentBounds.height },
      this._panelStartPosition
    );
    this.mainWindow.setBounds(newPos);
  }

  showDictationPanel(options = {}) {
    const { focus = false } = options;
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const wasHidden = !this.mainWindow.isVisible() || this.mainWindow.isMinimized();

      if (wasHidden) {
        this._repositionToCursorDisplay();
      }

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
    });
  }

  enforceMainWindowOnTop() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      WindowPositionUtil.setupAlwaysOnTop(this.mainWindow);
    }
  }

  async showMeetingNotification(promptData) {
    if (this.notificationWindow && !this.notificationWindow.isDestroyed()) {
      this.notificationWindow.close();
      this.notificationWindow = null;
    }
    if (this._notificationTimeout) {
      clearTimeout(this._notificationTimeout);
      this._notificationTimeout = null;
    }

    const display = screen.getPrimaryDisplay();
    const position = WindowPositionUtil.getNotificationPosition(display);

    this.notificationWindow = new BrowserWindow({
      ...NOTIFICATION_WINDOW_CONFIG,
      ...position,
    });

    WindowPositionUtil.setupAlwaysOnTop(this.notificationWindow);

    this._pendingNotificationData = promptData;

    if (process.env.NODE_ENV === "development") {
      await DevServerManager.waitForDevServer();
      await this.notificationWindow.loadURL(
        `${DevServerManager.DEV_SERVER_URL}?meeting-notification=true`
      );
    } else {
      const fileInfo = DevServerManager.getAppFilePath(false);
      await this.notificationWindow.loadFile(fileInfo.path, {
        query: { ...fileInfo.query, "meeting-notification": "true" },
      });
    }

    this._notificationReadyFallback = setTimeout(() => {
      this._notificationReadyFallback = null;
      if (this.notificationWindow && !this.notificationWindow.isDestroyed()) {
        debugLogger.warn(
          "Notification renderer did not signal ready, force-showing",
          {},
          "meeting"
        );
        this.notificationWindow.webContents.send("meeting-notification-data", promptData);
        this.notificationWindow.showInactive();
      }
    }, 3000);

    this._notificationTimeout = setTimeout(() => {
      if (this.meetingDetectionEngine) {
        this.meetingDetectionEngine.handleNotificationTimeout();
      }
      this.dismissMeetingNotification();
    }, 30000);

    this.notificationWindow.on("closed", () => {
      this.notificationWindow = null;
      if (this._notificationTimeout) {
        clearTimeout(this._notificationTimeout);
        this._notificationTimeout = null;
      }
    });
  }

  showNotificationWindow() {
    if (this._notificationReadyFallback) {
      clearTimeout(this._notificationReadyFallback);
      this._notificationReadyFallback = null;
    }
    if (this.notificationWindow && !this.notificationWindow.isDestroyed()) {
      this.notificationWindow.showInactive();
    }
  }

  dismissMeetingNotification() {
    this._pendingNotificationData = null;
    if (this._notificationReadyFallback) {
      clearTimeout(this._notificationReadyFallback);
      this._notificationReadyFallback = null;
    }
    if (this._notificationTimeout) {
      clearTimeout(this._notificationTimeout);
      this._notificationTimeout = null;
    }
    if (this.notificationWindow && !this.notificationWindow.isDestroyed()) {
      this.notificationWindow.close();
    }
    this.notificationWindow = null;
  }

  async showUpdateNotification(info) {
    if (this._updateNotificationDismissed) return;
    if (this.updateNotificationWindow && !this.updateNotificationWindow.isDestroyed()) {
      this.updateNotificationWindow.close();
      this.updateNotificationWindow = null;
    }

    const display = screen.getPrimaryDisplay();
    const position = WindowPositionUtil.getNotificationPosition(display);

    this.updateNotificationWindow = new BrowserWindow({
      ...NOTIFICATION_WINDOW_CONFIG,
      ...position,
    });

    WindowPositionUtil.setupAlwaysOnTop(this.updateNotificationWindow);

    if (process.env.NODE_ENV === "development") {
      await DevServerManager.waitForDevServer();
      await this.updateNotificationWindow.loadURL(
        `${DevServerManager.DEV_SERVER_URL}?update-notification=true`
      );
    } else {
      const fileInfo = DevServerManager.getAppFilePath(false);
      await this.updateNotificationWindow.loadFile(fileInfo.path, {
        query: { ...fileInfo.query, "update-notification": "true" },
      });
    }

    this._pendingUpdateNotificationData = {
      version: info?.version,
      releaseDate: info?.releaseDate,
    };

    this._updateNotificationReadyFallback = setTimeout(() => {
      this._updateNotificationReadyFallback = null;
      if (this.updateNotificationWindow && !this.updateNotificationWindow.isDestroyed()) {
        this.updateNotificationWindow.webContents.send(
          "update-notification-data",
          this._pendingUpdateNotificationData
        );
        this.updateNotificationWindow.showInactive();
      }
    }, 3000);

    this.updateNotificationWindow.on("closed", () => {
      this.updateNotificationWindow = null;
    });
  }

  showUpdateNotificationWindow() {
    if (this._updateNotificationReadyFallback) {
      clearTimeout(this._updateNotificationReadyFallback);
      this._updateNotificationReadyFallback = null;
    }
    if (this.updateNotificationWindow && !this.updateNotificationWindow.isDestroyed()) {
      this.updateNotificationWindow.showInactive();
    }
  }

  dismissUpdateNotification() {
    this._pendingUpdateNotificationData = null;
    this._updateNotificationDismissed = true;
    if (this._updateNotificationReadyFallback) {
      clearTimeout(this._updateNotificationReadyFallback);
      this._updateNotificationReadyFallback = null;
    }
    if (this.updateNotificationWindow && !this.updateNotificationWindow.isDestroyed()) {
      this.updateNotificationWindow.close();
    }
    this.updateNotificationWindow = null;
  }

  sendToControlPanel(channel, data) {
    const win = this.controlPanelWindow;
    if (!win || win.isDestroyed()) return;
    if (win.webContents.isLoading()) {
      win.webContents.once("did-finish-load", () => {
        if (!win.isDestroyed()) win.webContents.send(channel, data);
      });
    } else {
      win.webContents.send(channel, data);
    }
  }

  snapControlPanelToMeetingMode() {
    const win = this.controlPanelWindow;
    if (!win || win.isDestroyed()) return;
    this._preMeetingBounds = win.getBounds();
    const display = screen.getPrimaryDisplay();
    const workArea = display.workArea;
    const width = Math.round(workArea.width / 3);
    win.setBounds({
      x: workArea.x + workArea.width - width,
      y: workArea.y,
      width,
      height: workArea.height,
    });
    win.focus();
  }

  restoreControlPanelFromMeetingMode() {
    const win = this.controlPanelWindow;
    if (!win || win.isDestroyed()) return;
    if (this._preMeetingBounds) {
      win.setBounds(this._preMeetingBounds);
      this._preMeetingBounds = null;
    } else {
      const { width, height } = CONTROL_PANEL_CONFIG;
      win.setSize(width, height);
      win.center();
    }
  }

  refreshLocalizedUi() {
    MenuManager.setupMainMenu(() => this.openSettings());

    if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
      MenuManager.setupControlPanelMenu(this.controlPanelWindow, () => this.openSettings());
      this.controlPanelWindow.setTitle(i18nMain.t("window.controlPanelTitle"));
    }

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.setTitle(i18nMain.t("window.voiceRecorderTitle"));
    }

    if (this.agentWindow && !this.agentWindow.isDestroyed()) {
      this.agentWindow.setTitle(i18nMain.t("window.agentChatTitle"));
    }
  }

  async openSettings() {
    await this.createControlPanelWindow();
    if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
      this.controlPanelWindow.webContents.send("show-settings");
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
