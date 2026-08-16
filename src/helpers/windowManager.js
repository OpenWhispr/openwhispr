const { app, screen, BrowserWindow, shell, dialog } = require("electron");
const debugLogger = require("./debugLogger");
const HotkeyManager = require("./hotkeyManager");
const { isGlobeLikeHotkey } = HotkeyManager;
const DragManager = require("./dragManager");
const MenuManager = require("./menuManager");
const DevServerManager = require("./devServerManager");
const dockManager = require("./dockManager");
const { i18nMain } = require("./i18nMain");
const { NotificationDismissTimer, getNotificationTimeoutMs } = require("./notificationTimer");
const { DEV_SERVER_PORT } = DevServerManager;
const {
  MAIN_WINDOW_CONFIG,
  CONTROL_PANEL_CONFIG,
  NOTIFICATION_WINDOW_CONFIG,
  fitAssistantContentWindowToWorkArea,
  fitAssistantWindowToWorkArea,
  fitDictationErrorContentWindowToWorkArea,
  fitDictationErrorWindowToWorkArea,
  WINDOW_SIZES,
  WindowPositionUtil,
} = require("./windowConfig");

class WindowManager {
  constructor() {
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this.notificationWindow = null;
    this._notificationDismissTimer = new NotificationDismissTimer(() => {
      if (this.meetingDetectionEngine) {
        this.meetingDetectionEngine.handleNotificationTimeout();
      }
      this.dismissMeetingNotification();
    });
    this.updateNotificationWindow = null;
    this._updateNotificationDismissed = false;
    this.notificationPrefs = {
      notificationsEnabled: true,
      notifyMeetingDetection: true,
      notifyCalendarReminders: true,
      notifyUpdates: true,
    };
    this.tray = null;
    this.hotkeyManager = new HotkeyManager();
    this.dragManager = new DragManager();
    this.isQuitting = false;
    this.loadErrorShown = false;
    this.macCompoundPushState = null;
    this.winPushState = null;
    this._cachedActivationMode = "tap";
    this._floatingIconAutoHide = false;
    this._panelStartPosition = "bottom-right";
    this._isDictatingToggle = false;
    this._pendingMeetingNoteNavigation = null;
    this._pendingNoteNavigation = null;

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

  // Content protection keeps the overlay out of screenshots and screen shares.
  // Two independent reasons demand it: the screen-context capture setting and
  // an open assistant panel (which renders AI responses over anything).
  _updateMainContentProtection() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.setContentProtection(
      Boolean(this._screenContextProtection || this._assistantPanelOpen)
    );
  }

  setScreenContextProtection(enabled) {
    this._screenContextProtection = Boolean(enabled);
    this._updateMainContentProtection();
  }

  // The pill window is created focusable:false so it never steals focus; the
  // assistant panel needs keyboard focus so Escape can dismiss it reliably.
  setAssistantPanelOpen(open) {
    this._assistantPanelOpen = Boolean(open);
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      if (this._assistantPanelOpen) {
        this.mainWindow.setFocusable(true);
        this.mainWindow.focus();
      } else {
        // On Windows/Linux the pill is a normal/toolbar window, so focus()
        // activated OpenWhispr — blur before dropping focusability to hand
        // the foreground back to the app the user was in.
        this.mainWindow.blur();
        this.mainWindow.setFocusable(false);
      }
      this.enforceMainWindowOnTop();
    }
    this._updateMainContentProtection();
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

  // Only the meeting prompt owns this: another overlay reporting its own hover
  // must not pause a countdown it cannot resume — it may be destroyed before
  // its pointer ever leaves.
  setNotificationInteractivity(sender, interactive) {
    const win = this.notificationWindow;
    if (!win || win.isDestroyed() || sender !== win.webContents) {
      return;
    }
    // Linux ignores the `forward` option, so a card returned to click-through
    // there never sees another mouseenter and Start/Dismiss stay unreachable
    // for the rest of its life (#1456). It is only click-through on macOS to
    // begin with, so on Linux leave the hit-testing alone and move the
    // countdown alone.
    const togglesClickThrough = process.platform !== "linux";
    // Hovering means the user is reading or about to click — the auto-dismiss
    // countdown must not close the card under their pointer.
    if (interactive) {
      if (togglesClickThrough) win.setIgnoreMouseEvents(false);
      this._notificationDismissTimer.pause();
    } else {
      if (togglesClickThrough) win.setIgnoreMouseEvents(true, { forward: true });
      this._notificationDismissTimer.resume();
    }
  }

  resizeMainWindow(sizeKey) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }

    let newSize = WINDOW_SIZES[sizeKey] || WINDOW_SIZES.BASE;
    if (
      sizeKey === "ASSISTANT" ||
      sizeKey === "DICTATION_ERROR" ||
      sizeKey === "DICTATION_ERROR_WITH_TRANSCRIPT"
    ) {
      const currentBounds = this.mainWindow.getBounds();
      const display = screen.getDisplayNearestPoint({
        x: currentBounds.x + currentBounds.width / 2,
        y: currentBounds.y + currentBounds.height,
      });
      const workArea = display.workArea || display.bounds;
      newSize =
        sizeKey === "ASSISTANT"
          ? fitAssistantWindowToWorkArea(newSize, workArea)
          : fitDictationErrorWindowToWorkArea(newSize, workArea);
    }
    return this._resizeMainWindowTo(newSize, sizeKey);
  }

  resizeAssistantWindowToContent(surfaceHeight) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }

    const currentBounds = this.mainWindow.getBounds();
    const display = screen.getDisplayNearestPoint({
      x: currentBounds.x + currentBounds.width / 2,
      y: currentBounds.y + currentBounds.height,
    });
    const newSize = fitAssistantContentWindowToWorkArea(
      surfaceHeight,
      display.workArea || display.bounds
    );
    return this._resizeMainWindowTo(newSize, "ASSISTANT_CONTENT");
  }

  resizeDictationErrorWindowToContent(surfaceHeight) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }

    const currentBounds = this.mainWindow.getBounds();
    const display = screen.getDisplayNearestPoint({
      x: currentBounds.x + currentBounds.width / 2,
      y: currentBounds.y + currentBounds.height,
    });
    const newSize = fitDictationErrorContentWindowToWorkArea(
      surfaceHeight,
      display.workArea || display.bounds
    );
    return this._resizeMainWindowTo(newSize, "DICTATION_ERROR_CONTENT");
  }

  _resizeMainWindowTo(newSize, sizeKey) {
    const currentBounds = this.mainWindow.getBounds();

    // A window moved since the last resize (dragged) means the captured BASE
    // bounds no longer describe where the user wants the pill — drop them.
    // Tolerate a couple of pixels: fractional DPI scaling can round setBounds
    // values, and treating that as a drag would defeat the restore forever.
    const MOVE_TOLERANCE_PX = 2;
    if (
      this._lastResizeBounds &&
      (Math.abs(currentBounds.x - this._lastResizeBounds.x) > MOVE_TOLERANCE_PX ||
        Math.abs(currentBounds.y - this._lastResizeBounds.y) > MOVE_TOLERANCE_PX)
    ) {
      this._baseBoundsBeforeResize = null;
    }

    // Returning to BASE restores the exact pre-grow bounds. Anchoring the
    // shrink on the grown bounds instead would re-anchor on whatever the
    // work-area clamp did on the way up, walking the pill away from where the
    // user put it a little more on every grow/shrink cycle.
    if (sizeKey === "BASE" && this._baseBoundsBeforeResize) {
      const restored = { ...this._baseBoundsBeforeResize };
      this._baseBoundsBeforeResize = null;
      this._lastResizeBounds = restored;
      this.mainWindow.setBounds(restored);
      return { success: true, bounds: restored };
    }

    if (
      sizeKey !== "BASE" &&
      !this._baseBoundsBeforeResize &&
      currentBounds.width === WINDOW_SIZES.BASE.width &&
      currentBounds.height === WINDOW_SIZES.BASE.height
    ) {
      this._baseBoundsBeforeResize = { ...currentBounds };
    }

    const position = this._panelStartPosition;

    const display = screen.getDisplayNearestPoint({
      x: currentBounds.x + currentBounds.width / 2,
      y: currentBounds.y + currentBounds.height,
    });

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

    const clamped = WindowPositionUtil.clampToWorkArea({ x: newX, y: newY, ...newSize }, display);
    const newBounds = { ...clamped, ...newSize };

    this.mainWindow.setBounds(newBounds);
    this._lastResizeBounds = newBounds;

    return { success: true, bounds: newBounds };
  }

  async loadWindowContent(window, isControlPanel = false) {
    if (process.env.NODE_ENV === "development") {
      const appUrl = DevServerManager.getAppUrl(isControlPanel);
      await DevServerManager.waitForDevServer();
      await window.loadURL(appUrl);
    } else {
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

    // globalShortcut registrations pass the hotkey that fired; native-shortcut
    // backends invoke the callback bare (their slot holds only the primary).
    return async (triggeredHotkey) => {
      if (this.hotkeyManager.isInListeningMode()) {
        return;
      }

      const activationMode = this.getActivationMode();
      const currentHotkey = triggeredHotkey || this.hotkeyManager.getCurrentHotkey?.();

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

      // Push mode: defer to native listener (globalShortcut can't detect key-up)
      if (
        (process.platform === "win32" || process.platform === "linux") &&
        activationMode === "push"
      ) {
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
    this.sendPrepareDictation();

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
      this.sendCancelDictationPreparation();
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
    } else {
      this.sendCancelDictationPreparation();
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

  startWindowsPushToTalk(key) {
    if (this.winPushState?.active) {
      return;
    }

    const MIN_HOLD_DURATION_MS = 150;
    const downTime = Date.now();

    this.showDictationPanel();
    this.sendPrepareDictation();

    this.winPushState = {
      active: true,
      key,
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

  // With several dictation hotkeys bound, only the key that started the push
  // may stop it; called without a key to force-stop (resetWindowsPushState).
  handleWindowsPushKeyUp(key) {
    if (!this.winPushState?.active) {
      return;
    }
    if (key && this.winPushState.key && key !== this.winPushState.key) {
      return;
    }

    const wasRecording = this.winPushState.isRecording;
    this.winPushState = null;

    if (wasRecording) {
      this.sendStopDictation();
    } else {
      this.sendCancelDictationPreparation();
      this.hideDictationPanel();
    }
  }

  resetWindowsPushState() {
    if (!this.winPushState?.active) {
      return;
    }

    this.handleWindowsPushKeyUp();
  }

  _sendDictationToggle(channel) {
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      // Capture the paste target and any selection on every toggle press,
      // before the overlay steals focus — the paste can't refocus the target
      // otherwise (#668). The renderer owns the real recording state and may
      // decline a toggle (mic error, silence gate, Esc cancel), so gating this
      // on _isDictatingToggle desyncs and leaves a stale target from a
      // previous app. Press-time capture matches the dictation hotkey call
      // sites in main.js; a stop-press capture resolves the same frontmost
      // app, since NSWorkspace ignores the overlay panel.
      if (this.textEditMonitor) this.textEditMonitor.captureTargetPid();
      void this.selectionManager?.captureTarget?.();
      this.showDictationPanel();
      // About-to-start guess: open the mic one IPC message ahead of the toggle.
      // A wrong guess (renderer declines) is bounded by the prepared capture's
      // max-age expiry, and the renderer dedups its own prepare call.
      if (!this._isDictatingToggle) this.sendPrepareDictation();
      this.mainWindow.webContents.send(channel);
      this._isDictatingToggle = !this._isDictatingToggle;
      this.meetingDetectionEngine?.setUserRecording(this._isDictatingToggle);
    }
  }

  sendToggleDictation() {
    this._sendDictationToggle("toggle-dictation");
  }

  sendToggleVoiceAgent() {
    this._sendDictationToggle("toggle-voice-agent");
  }

  sendToggleTranslation() {
    // Same PID-capture need as the voice agent: translation hotkeys don't
    // capture the target at their call sites.
    if (this.textEditMonitor) this.textEditMonitor.captureTargetPid();
    this._sendDictationToggle("toggle-translation");
  }

  sendStartDictation() {
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      if (this.textEditMonitor) this.textEditMonitor.captureTargetPid();
      void this.selectionManager?.captureTarget?.();
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

  sendPrepareDictation() {
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("prepare-dictation");
    }
  }

  sendCancelDictationPreparation() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("cancel-dictation-preparation");
    }
  }

  sendCancelDictation() {
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("cancel-dictation-preparation");
      this.mainWindow.webContents.send("cancel-hotkey-pressed");
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

  /**
   * Sync the native low-level key listeners (Windows/Linux) so every hotkey slot
   * that needs one is watched. Call after any change to a slot hotkey or the
   * activation mode. No-op during hotkey capture (listeners are stopped then).
   */
  reconcileNativeKeyListeners() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    if (this.hotkeyManager.isInListeningMode()) return;
    // GNOME/KDE/Hyprland deliver hotkeys via D-Bus native shortcuts; the low-level
    // listener would be redundant there and could double-fire, so watch nothing.
    const keys = this.hotkeyManager.isUsingNativeShortcut()
      ? []
      : this.hotkeyManager.getNativeListenerKeys(this.getActivationMode());
    if (process.platform === "win32" && this.windowsKeyManager) {
      this.windowsKeyManager.setKeys(keys);
    } else if (process.platform === "linux" && this.linuxKeyManager) {
      this.linuxKeyManager.setKeys(keys);
    }
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

  getHyprlandConfigStatus() {
    return this.hotkeyManager.getHyprlandConfigStatus();
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
      dockManager.setControlPanelVisible(true);
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
        dockManager.setControlPanelVisible(true);
      }
    }, 10000);

    const clearVisibilityTimer = () => {
      clearTimeout(visibilityTimer);
    };

    this.controlPanelWindow.once("ready-to-show", () => {
      clearVisibilityTimer();
      this.controlPanelWindow.show();
      this.controlPanelWindow.focus();
      dockManager.setControlPanelVisible(true);
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
      dockManager.setControlPanelVisible(false);
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
          dockManager.setControlPanelVisible(true);
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

  async showTranscriptionPreview(text) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send("preview-text", text);
    this.mainWindow.showInactive();
    this.enforceMainWindowOnTop();
  }

  appendTranscriptionPreview(text) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send("preview-append", text);
  }

  holdTranscriptionPreview(options = {}) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send("preview-hold", {
      showCleanup: !!options.showCleanup,
    });
  }

  completeTranscriptionPreview(text) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send("preview-result", { text });
    this.enforceMainWindowOnTop();
  }

  hideTranscriptionPreview() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send("preview-hide");
  }

  resizeTranscriptionPreview() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false, error: "Dictation window not available" };
    }
    return { success: true, bounds: this.mainWindow.getBounds() };
  }

  // The display the user is working on is the one showing the app being dictated
  // into, which on a multi-monitor desk is often not the one the mouse rests on.
  // Falls back to the cursor when the target has no readable window (non-macOS,
  // no target captured yet, or an app with no ordinary window).
  async _resolveActiveDisplay() {
    const pid = this.textEditMonitor?.lastTargetPid;
    const bounds = pid ? await this.textEditMonitor.getTargetWindowBounds(pid) : null;
    return bounds
      ? screen.getDisplayMatching(bounds)
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }

  async _repositionToActiveDisplay() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    const activeDisplay = await this._resolveActiveDisplay();
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    const currentBounds = this.mainWindow.getBounds();
    const currentDisplay = screen.getDisplayNearestPoint({
      x: currentBounds.x + currentBounds.width / 2,
      y: currentBounds.y + currentBounds.height / 2,
    });

    if (currentDisplay.id === activeDisplay.id) {
      // Nearest-display math can't tell "on this display" from "just past its
      // edge", so a rearranged monitor or a drag that ended over another
      // display can leave the panel stranded in dead space, looking like the
      // overlay vanished. Pull it back before showing it.
      const clamped = WindowPositionUtil.clampToWorkArea(currentBounds, currentDisplay);
      if (clamped.x !== currentBounds.x || clamped.y !== currentBounds.y) {
        this.mainWindow.setBounds({ ...currentBounds, ...clamped });
      }
      return;
    }

    const newPos = WindowPositionUtil.getMainWindowPosition(
      activeDisplay,
      { width: currentBounds.width, height: currentBounds.height },
      this._panelStartPosition
    );
    debugLogger.debug(
      "[WindowManager] Moving dictation panel to the active display",
      { from: currentBounds, to: newPos, displayId: activeDisplay.id },
      "window"
    );
    this.mainWindow.setBounds(newPos);
  }

  showDictationPanel(options = {}) {
    const { focus = false } = options;
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      // Reading the target's window costs a helper spawn, so show now and move
      // when the answer lands: a visible hop only happens when the panel was on
      // the wrong display, which is the case being corrected.
      void this._repositionToActiveDisplay();

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
    dockManager.setControlPanelVisible(false);
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
    this._notificationDismissTimer.cancel();

    const display = screen.getPrimaryDisplay();
    const position = WindowPositionUtil.getNotificationPosition(display);

    const win = new BrowserWindow({
      ...NOTIFICATION_WINDOW_CONFIG,
      ...position,
    });
    this.notificationWindow = win;

    // Keep the prompt visible to the user but out of screen shares and recordings.
    win.setContentProtection(true);

    if (process.platform === "darwin") {
      win.setIgnoreMouseEvents(true, { forward: true });
    }

    WindowPositionUtil.setupAlwaysOnTop(win);

    this._pendingNotificationData = promptData;

    // Everything past the load addresses `win` directly: a replacement taking
    // over mid-load must not have this prompt's data, countdown or force-show
    // applied to its window.
    if (process.env.NODE_ENV === "development") {
      await DevServerManager.waitForDevServer();
      await win.loadURL(`${DevServerManager.DEV_SERVER_URL}?meeting-notification=true`);
    } else {
      const fileInfo = DevServerManager.getAppFilePath(false);
      await win.loadFile(fileInfo.path, {
        query: { ...fileInfo.query, "meeting-notification": "true" },
      });
    }
    if (this.notificationWindow !== win) return;

    this._notificationReadyFallback = setTimeout(() => {
      this._notificationReadyFallback = null;
      if (!win.isDestroyed()) {
        debugLogger.warn(
          "Notification renderer did not signal ready, force-showing",
          {},
          "meeting"
        );
        win.webContents.send("meeting-notification-data", promptData);
        win.showInactive();
      }
    }, 3000);

    this._notificationDismissTimer.start(getNotificationTimeoutMs(promptData.source));

    // "closed" fires asynchronously, so a replaced prompt's window emits it
    // after the replacement already took over the reference and the countdown.
    win.on("closed", () => {
      if (this.notificationWindow !== win) return;
      this.notificationWindow = null;
      this._notificationDismissTimer.cancel();
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
    this._notificationDismissTimer.cancel();
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
    if (this._updateNotificationAutoDismiss) {
      clearTimeout(this._updateNotificationAutoDismiss);
      this._updateNotificationAutoDismiss = null;
    }

    const display = screen.getPrimaryDisplay();
    const position = WindowPositionUtil.getNotificationPosition(display);

    const win = new BrowserWindow({
      ...NOTIFICATION_WINDOW_CONFIG,
      ...position,
    });
    this.updateNotificationWindow = win;

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

    this._updateNotificationAutoDismiss = setTimeout(() => {
      this.dismissUpdateNotification({ persistent: false });
    }, 5000);

    win.on("closed", () => {
      if (this.updateNotificationWindow !== win) return;
      this.updateNotificationWindow = null;
      if (this._updateNotificationAutoDismiss) {
        clearTimeout(this._updateNotificationAutoDismiss);
        this._updateNotificationAutoDismiss = null;
      }
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

  dismissUpdateNotification({ persistent = true } = {}) {
    this._pendingUpdateNotificationData = null;
    if (persistent) this._updateNotificationDismissed = true;
    if (this._updateNotificationReadyFallback) {
      clearTimeout(this._updateNotificationReadyFallback);
      this._updateNotificationReadyFallback = null;
    }
    if (this._updateNotificationAutoDismiss) {
      clearTimeout(this._updateNotificationAutoDismiss);
      this._updateNotificationAutoDismiss = null;
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

  async queueMeetingNoteNavigation(payload) {
    this._pendingMeetingNoteNavigation = payload;
    await this.createControlPanelWindow();
    this.sendToControlPanel("meeting-note-navigation-pending");
  }

  consumePendingMeetingNoteNavigation() {
    const payload = this._pendingMeetingNoteNavigation;
    this._pendingMeetingNoteNavigation = null;
    return payload;
  }

  async queueNoteNavigation(payload) {
    this._pendingNoteNavigation = payload;
    await this.createControlPanelWindow();
    this.sendToControlPanel("note-navigation-pending");
  }

  consumePendingNoteNavigation() {
    const payload = this._pendingNoteNavigation;
    this._pendingNoteNavigation = null;
    return payload;
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
