const { app, screen, BrowserWindow, shell, dialog } = require("electron");
const debugLogger = require("./debugLogger");
const HotkeyManager = require("./hotkeyManager");
const { isGlobeLikeHotkey } = HotkeyManager;
const DragManager = require("./dragManager");
const MainWindowPlacementCoordinator = require("./mainWindowPlacementCoordinator");
const MenuManager = require("./menuManager");
const DevServerManager = require("./devServerManager");
const dockManager = require("./dockManager");
const { i18nMain } = require("./i18nMain");
const { NotificationDismissTimer, getNotificationTimeoutMs } = require("./notificationTimer");
const {
  DICTATION_LIFECYCLE,
  normalizeDictationLifecycle,
  shouldIgnoreDictationHotkey,
  isDictationRecording,
  shouldBlockDictationWhilePanelOpen,
} = require("./dictationLifecycle");
const { DEV_SERVER_PORT } = DevServerManager;
const AUTO_END_NOTIFICATION_LOAD_TIMEOUT_MS = 10_000;
const DRAG_MOVE_TOLERANCE_PX = 2;
const {
  MAIN_WINDOW_CONFIG,
  CONTROL_PANEL_CONFIG,
  ONBOARDING_WINDOW_SIZES,
  NOTIFICATION_WINDOW_CONFIG,
  fitAssistantContentWindowToWorkArea,
  fitAssistantWindowToWorkArea,
  fitDictationErrorContentWindowToWorkArea,
  fitDictationErrorWindowToWorkArea,
  resolveHorizontalWindowDirection,
  getMeetingNotificationWindowSize,
  WINDOW_SIZES,
  WindowPositionUtil,
} = require("./windowConfig");
const { centeredBounds, clampedBounds } = require("./onboardingWindowBounds");
const { ONBOARDING_DEMO_KINDS, isOnboardingInputAllowed } = require("./onboardingInputPolicy");

class WindowManager {
  constructor() {
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this._controlPanelVisibilityTimer = null;
    this._onboardingRestoreBounds = null;
    this._onboardingWindowMode = null;
    this._onboardingWindowState = null;
    // Fail closed until AppRouter has resolved persisted onboarding state and
    // committed the normal app. This covers the startup gap before React mounts.
    this._onboardingActive = true;
    this._onboardingDemoKind = null;
    // Set by IPCHandlers so its demo session dies with the demo kind on every
    // teardown path (id-matched end, onboarding exit, control panel closed).
    this.onOnboardingDemoTeardown = null;
    this.notificationWindow = null;
    this._notificationLoadTimeout = null;
    this._notificationDismissTimer = new NotificationDismissTimer(() => {
      if (this.meetingDetectionEngine) {
        this.meetingDetectionEngine.handleNotificationTimeout();
      }
      this.dismissMeetingNotification();
    });
    this.updateNotificationWindow = null;
    this._pendingUpdateNotificationData = null;
    this._deferredUpdateNotificationInfo = null;
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
    this._mainWindowPlacementCoordinator = new MainWindowPlacementCoordinator();
    this.isQuitting = false;
    this.loadErrorShown = false;
    this.macCompoundPushState = null;
    this.winPushState = null;
    this._cachedActivationMode = "tap";
    this._floatingIconAutoHide = false;
    this._panelStartPosition = "bottom-right";
    this._activeHorizontalDirection = null;
    this._isDictatingToggle = false;
    this._dictationLifecycleState = DICTATION_LIFECYCLE.IDLE;
    this._assistantPanelOpen = false;
    this._assistantPanelBusy = false;
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
      // A reload has not resolved its route yet. AppRouter releases this gate
      // after it renders the normal app; fresh onboarding keeps it active.
      this.setOnboardingActive(true);
      this.endOnboardingDemo();
      this.mainWindow.setTitle(i18nMain.t("window.voiceRecorderTitle"));
      this.enforceMainWindowOnTop();
      this._notifyMainWindowHorizontalDirection();
    });

    await this.loadMainWindow();
    await this.initializeHotkey();
    this.dragManager.setTargetWindow(this.mainWindow);
    MenuManager.setupMainMenu(() => this.openSettings());
  }

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
    if (!this._assistantPanelOpen) {
      this._assistantPanelBusy = false;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      if (this._assistantPanelOpen) {
        // The window may have been hidden while the command was in flight
        // (PTT tap, auto-hide, tray); focus() is a no-op on a hidden window.
        if (!this.mainWindow.isVisible()) this.mainWindow.showInactive();
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

  setAssistantPanelBusy(busy) {
    this._assistantPanelBusy = Boolean(busy);
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
    return this._enqueueMainWindowMutation(() => this._performMainWindowResize(sizeKey));
  }

  resizeAssistantWindowToContent(surfaceHeight) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }

    // Content-height resizing belongs to Live Transcript. Agent Mode keeps the
    // shared modal at its normal responsive footprint and scrolls its center.
    if (this._assistantPanelOpen) {
      return this.resizeMainWindow("ASSISTANT");
    }

    return this._enqueueMainWindowMutation(() =>
      this._performMainWindowResize("ASSISTANT_CONTENT", { surfaceHeight })
    );
  }

  resizeDictationErrorWindowToContent(surfaceHeight) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }

    // A dictation error is an overlay when Agent Mode already owns the shared
    // window. Its card may measure itself, but that measurement must not
    // replace the Agent surface geometry underneath it. Otherwise the native
    // window contracts to the error card's height and remains there after the
    // overlay dismisses because the Agent panel never actually closed.
    if (this._assistantPanelOpen) {
      const bounds = this.mainWindow.getBounds();
      return { success: true, bounds, changed: false };
    }

    return this._enqueueMainWindowMutation(() =>
      this._performMainWindowResize("DICTATION_ERROR_CONTENT", { surfaceHeight })
    );
  }

  // Deliberate moves are not anchored resizes: the renderer must drop any live
  // resize mask rather than hold a translation against invalidated bounds.
  _clearRendererResizeMask() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send("main-window-will-resize", { anchor: "none" });
  }

  async _prepareRendererForMainWindowResize(bounds, anchor) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send("main-window-will-resize", { bounds, anchor });

    // Give the renderer one frame to install screen-space anchor compensation
    // before setBounds reaches the OS compositor. Without this handshake,
    // Windows and macOS can paint the new viewport size one frame before the
    // corresponding window position, which visibly kicks the pill or panel.
    await new Promise((resolve) => setTimeout(resolve, 24));
  }

  _enqueueMainWindowMutation(run) {
    // Renderer voice requests are latest-wins, while errors and other overlays
    // and active-display placement can also mutate the native bounds. Serialize
    // once more at the native boundary so setBounds calls cannot interleave.
    this._mainWindowResizeQueue = (this._mainWindowResizeQueue || Promise.resolve()).then(run, run);
    return this._mainWindowResizeQueue;
  }

  // The pill is bottom-anchored, so the display that owns its bottom-center
  // point is the one that must keep it through resizes and repositions.
  _getMainWindowDisplayFor(bounds) {
    return screen.getDisplayNearestPoint({
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height,
    });
  }

  _resolveMainWindowSize(sizeKey, workArea, request) {
    switch (sizeKey) {
      case "ASSISTANT":
        return fitAssistantWindowToWorkArea(WINDOW_SIZES.ASSISTANT, workArea);
      case "DICTATION_ERROR":
      case "DICTATION_ERROR_WITH_TRANSCRIPT":
        return fitDictationErrorWindowToWorkArea(WINDOW_SIZES[sizeKey], workArea);
      case "ASSISTANT_CONTENT":
        return fitAssistantContentWindowToWorkArea(request?.surfaceHeight, workArea);
      case "DICTATION_ERROR_CONTENT":
        return fitDictationErrorContentWindowToWorkArea(request?.surfaceHeight, workArea);
      default:
        return WINDOW_SIZES[sizeKey] || WINDOW_SIZES.BASE;
    }
  }

  async _performMainWindowResize(sizeKey, request) {
    // The queue can drain after the window is gone (quit, recreate); the
    // caller's guard ran before enqueueing.
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false, error: "Main window not available" };
    }
    // Bounds, display and the work-area fit are all sampled inside the queue:
    // a queued cross-display move would otherwise leave a fit computed at
    // enqueue time describing the display the window is about to leave.
    const currentBounds = this.mainWindow.getBounds();
    const display = this._getMainWindowDisplayFor(currentBounds);
    const newSize = this._resolveMainWindowSize(
      sizeKey,
      display.workArea || display.bounds,
      request
    );

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
      this._activeHorizontalDirection = null;
    }

    // Returning to BASE restores the exact pre-grow bounds. Anchoring the
    // shrink on the grown bounds instead would re-anchor on whatever the
    // work-area clamp did on the way up, walking the pill away from where the
    // user put it a little more on every grow/shrink cycle.
    if (sizeKey === "BASE" && this._baseBoundsBeforeResize) {
      // The work area can shrink while the window is grown (dock/taskbar
      // reappearing, resolution change) — clamp the restore so the pill
      // cannot come back off-screen.
      const restored = {
        ...this._baseBoundsBeforeResize,
        ...WindowPositionUtil.clampToWorkArea(this._baseBoundsBeforeResize, display),
      };
      const restoreAnchor =
        this._panelStartPosition === "center"
          ? "center"
          : `bottom-${this._activeHorizontalDirection || this.getMainWindowHorizontalDirection()}`;
      this._baseBoundsBeforeResize = null;
      await this._prepareRendererForMainWindowResize(restored, restoreAnchor);
      if (!this.mainWindow || this.mainWindow.isDestroyed()) {
        return { success: false, message: "Window not available" };
      }
      this._lastResizeBounds = restored;
      this.mainWindow.setBounds(restored);
      this._activeHorizontalDirection = null;
      this._notifyMainWindowHorizontalDirection();
      return { success: true, bounds: restored, changed: true };
    }

    if (
      sizeKey !== "BASE" &&
      !this._baseBoundsBeforeResize &&
      currentBounds.width === WINDOW_SIZES.BASE.width &&
      currentBounds.height === WINDOW_SIZES.BASE.height
    ) {
      this._baseBoundsBeforeResize = { ...currentBounds };
      this._activeHorizontalDirection = resolveHorizontalWindowDirection(
        currentBounds,
        display,
        this._panelStartPosition
      );
    }

    if (sizeKey !== "BASE" && !this._activeHorizontalDirection) {
      this._activeHorizontalDirection = resolveHorizontalWindowDirection(
        currentBounds,
        display,
        this._panelStartPosition
      );
    }
    const position =
      this._panelStartPosition === "center"
        ? "center"
        : `bottom-${this._activeHorizontalDirection || this.getMainWindowHorizontalDirection()}`;

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

    // Opening a voice mode and the size-priority effect can request the same
    // footprint in adjacent ticks. Avoid asking the OS compositor to rebuild
    // an unchanged transparent window surface.
    if (
      currentBounds.x === newBounds.x &&
      currentBounds.y === newBounds.y &&
      currentBounds.width === newBounds.width &&
      currentBounds.height === newBounds.height
    ) {
      this._lastResizeBounds = { ...currentBounds };
      if (sizeKey === "BASE") {
        this._activeHorizontalDirection = null;
        this._notifyMainWindowHorizontalDirection();
      }
      return { success: true, bounds: currentBounds, changed: false };
    }

    await this._prepareRendererForMainWindowResize(newBounds, position);
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }
    this.mainWindow.setBounds(newBounds);
    this._lastResizeBounds = newBounds;
    if (sizeKey === "BASE") {
      this._activeHorizontalDirection = null;
      this._notifyMainWindowHorizontalDirection();
    }

    return { success: true, bounds: newBounds, changed: true };
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
      if (this.isDictationProcessing()) {
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

      this.sendToggleDictation();
    };
  }

  startMacCompoundPushToTalk(hotkey) {
    if (!this._isOnboardingInputAllowed("dictation")) return;
    if (this.macCompoundPushState?.active || this.isDictationProcessing()) {
      return;
    }

    const requiredModifiers = this.getMacRequiredModifiers(hotkey);
    if (requiredModifiers.size === 0) {
      return;
    }

    const MIN_HOLD_DURATION_MS = 150;
    const MAX_PUSH_DURATION_MS = 300000; // 5 minutes max recording
    const downTime = Date.now();

    const targetPidPromise = this.textEditMonitor?.captureTargetPid?.();
    this.showDictationPanel({ reposition: true, targetPidPromise });
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
    if (!this._isOnboardingInputAllowed("dictation")) return;
    if (this.winPushState?.active || this.isDictationProcessing()) {
      return;
    }

    const MIN_HOLD_DURATION_MS = 150;
    const downTime = Date.now();

    this.showDictationPanel({ reposition: true });
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

  _isOnboardingInputAllowed(inputKind) {
    return isOnboardingInputAllowed(this._onboardingActive, this._onboardingDemoKind, inputKind);
  }

  // Public gate for main.js's meeting hotkey call sites, which invoke the
  // detection engine directly rather than routing through a send method here.
  // "meeting" is never a demo kind, so this is simply "not during onboarding".
  isMeetingInputAllowed() {
    return this._isOnboardingInputAllowed("meeting");
  }

  _sendDictationToggle(channel, inputKind) {
    if (!this._isOnboardingInputAllowed(inputKind)) return;
    const voiceAgentRequested = channel === "toggle-voice-agent";
    if (
      shouldBlockDictationWhilePanelOpen({
        assistantPanelOpen: this._assistantPanelOpen,
        assistantPanelBusy: this._assistantPanelBusy,
        voiceAgentRequested,
      })
    ) {
      return;
    }
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (shouldIgnoreDictationHotkey(this._dictationLifecycleState)) {
      debugLogger.debug("Ignoring dictation toggle while transcription is processing", {
        channel,
      });
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const isStarting = !this._isDictatingToggle;
      // Capture the paste target and any selection on every toggle press,
      // before the overlay steals focus — the paste can't refocus the target
      // otherwise (#668). The renderer owns the real recording state and may
      // decline a toggle (mic error, silence gate, Esc cancel), so gating this
      // on _isDictatingToggle desyncs and leaves a stale target from a
      // previous app. Press-time capture matches the dictation hotkey call
      // sites in main.js; a stop-press capture resolves the same frontmost
      // app, since NSWorkspace ignores the overlay panel.
      const targetPidPromise = this.textEditMonitor?.captureTargetPid?.();
      void this.selectionManager?.captureTarget?.();
      if (!isStarting) {
        this._mainWindowPlacementCoordinator.cancelPending();
      }
      this.showDictationPanel({
        reposition: isStarting,
        targetPidPromise,
      });
      // About-to-start guess: open the mic one IPC message ahead of the toggle.
      // A wrong guess (renderer declines) is bounded by the prepared capture's
      // max-age expiry, and the renderer dedups its own prepare call. Pass the
      // toggle's own kind so the pre-warm survives the assistant demo, whose
      // gate rejects "dictation".
      if (isStarting) {
        this.sendPrepareDictation({ inputKind, voiceAgentRequested });
      }
      this.mainWindow.webContents.send(channel);
    }
  }

  setDictationLifecycleState(state) {
    const nextState = normalizeDictationLifecycle(state);
    if (nextState === this._dictationLifecycleState) return;

    this._dictationLifecycleState = nextState;
    this._isDictatingToggle = isDictationRecording(nextState);
    this.meetingDetectionEngine?.setUserRecording(this._isDictatingToggle);
  }

  isDictationProcessing() {
    return shouldIgnoreDictationHotkey(this._dictationLifecycleState);
  }

  sendToggleDictation() {
    this._sendDictationToggle("toggle-dictation", "dictation");
  }

  sendToggleVoiceAgent() {
    this._sendDictationToggle("toggle-voice-agent", "assistant");
  }

  sendToggleTranslation() {
    this._sendDictationToggle("toggle-translation", "translation");
  }

  sendStartDictation() {
    if (!this._isOnboardingInputAllowed("dictation")) return;
    if (
      shouldBlockDictationWhilePanelOpen({
        assistantPanelOpen: this._assistantPanelOpen,
        assistantPanelBusy: this._assistantPanelBusy,
      })
    ) {
      return;
    }
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (shouldIgnoreDictationHotkey(this._dictationLifecycleState)) {
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const targetPidPromise = this.textEditMonitor?.captureTargetPid?.();
      void this.selectionManager?.captureTarget?.();
      this.showDictationPanel({ reposition: true, targetPidPromise });
      this.mainWindow.webContents.send("start-dictation");
    }
  }

  sendStopDictation() {
    if (shouldBlockDictationWhilePanelOpen({ assistantPanelOpen: this._assistantPanelOpen })) {
      return;
    }
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("stop-dictation");
    }
  }

  sendPrepareDictation({ inputKind = "dictation", voiceAgentRequested = false } = {}) {
    if (!this._isOnboardingInputAllowed(inputKind)) return;
    if (
      shouldBlockDictationWhilePanelOpen({
        assistantPanelOpen: this._assistantPanelOpen,
        assistantPanelBusy: this._assistantPanelBusy,
        voiceAgentRequested,
      })
    ) {
      return;
    }
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (shouldIgnoreDictationHotkey(this._dictationLifecycleState)) {
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
    const activationMode = this.getActivationMode();
    const nativeListenerKeys = this.hotkeyManager.getNativeListenerKeys(activationMode);
    // GNOME/KDE/Hyprland native shortcuts are press-only. They replace the
    // low-level listener in tap mode, but push-to-talk still needs raw dictation
    // key-down/key-up events; createHotkeyCallback ignores the native press in
    // that mode, so keeping only this slot cannot double-fire.
    const keys = this.hotkeyManager.isUsingNativeShortcut()
      ? activationMode === "push"
        ? nativeListenerKeys.filter((key) => this.hotkeyManager.slotHasHotkey("dictation", key))
        : []
      : nativeListenerKeys;
    if (process.platform === "win32" && this.windowsKeyManager) {
      this.windowsKeyManager.setKeys(keys);
    } else if (process.platform === "linux" && this.linuxKeyManager) {
      this.linuxKeyManager.setKeys(keys);
    }
  }

  setFloatingIconAutoHide(enabled) {
    this._floatingIconAutoHide = Boolean(enabled);
  }

  getMainWindowHorizontalDirection() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return this._panelStartPosition === "bottom-left" ? "left" : "right";
    }
    const bounds = this.mainWindow.getBounds();
    const display = this._getMainWindowDisplayFor(bounds);
    return resolveHorizontalWindowDirection(bounds, display, this._panelStartPosition);
  }

  _notifyMainWindowHorizontalDirection() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send(
      "main-window-horizontal-direction-changed",
      this.getMainWindowHorizontalDirection()
    );
  }

  setPanelStartPosition(position) {
    this._panelStartPosition = position || "bottom-right";
    this._mainWindowPlacementCoordinator.resetManualPosition();
    this._activeHorizontalDirection = null;
    // Reposition the window immediately
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const currentBounds = this.mainWindow.getBounds();
      const display = this._getMainWindowDisplayFor(currentBounds);
      const newPos = WindowPositionUtil.getMainWindowPosition(
        display,
        { width: currentBounds.width, height: currentBounds.height },
        this._panelStartPosition
      );
      this._clearRendererResizeMask();
      this.mainWindow.setBounds(newPos);
      this._notifyMainWindowHorizontalDirection();
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
    // A lookup started by a prior hotkey must never land while the user is
    // taking ownership of the panel position.
    this._mainWindowPlacementCoordinator.cancelPending();
    this._dragStartBounds =
      this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow.getBounds() : null;
    return await this.dragManager.startWindowDrag();
  }

  async stopWindowDrag() {
    const result = await this.dragManager.stopWindowDrag();
    if (result.success && this.mainWindow && !this.mainWindow.isDestroyed()) {
      const draggedBounds = this.mainWindow.getBounds();
      const start = this._dragStartBounds;
      // Every pill click goes through start/stopWindowDrag; only an actual
      // move hands position ownership to the user.
      const moved =
        !start ||
        Math.abs(draggedBounds.x - start.x) > DRAG_MOVE_TOLERANCE_PX ||
        Math.abs(draggedBounds.y - start.y) > DRAG_MOVE_TOLERANCE_PX;
      if (moved) {
        this._mainWindowPlacementCoordinator.markManuallyPositioned();
        this._baseBoundsBeforeResize = null;
        this._lastResizeBounds = { ...draggedBounds };
      }
    }
    this._dragStartBounds = null;
    this._activeHorizontalDirection = null;
    this._notifyMainWindowHorizontalDirection();
    return result;
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
    this._onboardingRestoreBounds = null;
    this._onboardingWindowMode = null;
    this._onboardingWindowState = null;

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

    // Nothing else shows this window: ready-to-show deliberately doesn't, so the
    // renderer can pick the onboarding size first and avoid a visible
    // expanded → compact flash on fresh installs. That makes this the only
    // backstop if the renderer never gets that far — it loads but throws, a lazy
    // chunk fails, or auth/policy resolution never settles — so it must outlive
    // did-finish-load. Only a real show cancels it.
    this._controlPanelVisibilityTimer = setTimeout(() => {
      this._showControlPanel();
    }, 10000);

    this.controlPanelWindow.on("close", (event) => {
      if (!this.isQuitting) {
        event.preventDefault();
        this.hideControlPanelToTray();
      }
    });

    this.controlPanelWindow.on("closed", () => {
      this._clearControlPanelVisibilityTimer();
      this.endOnboardingDemo();
      this.controlPanelWindow = null;
      this._onboardingActive = true;
      this._hideNormalAppSurfaces();
      this._onboardingRestoreBounds = null;
      this._onboardingWindowMode = null;
      this._onboardingWindowState = null;
      dockManager.setControlPanelVisible(false);
    });

    MenuManager.setupControlPanelMenu(this.controlPanelWindow, () => this.openSettings());

    this.controlPanelWindow.webContents.on("did-finish-load", () => {
      // Every fresh document starts unresolved. AppRouter releases the gate
      // only after it commits the normal app, so OAuth/onboarding reloads cannot
      // expose the dictation pill, hotkeys, or popup surfaces in between.
      this.setOnboardingActive(true);
      this.endOnboardingDemo();
      this.controlPanelWindow.setTitle(i18nMain.t("window.controlPanelTitle"));
    });

    this.controlPanelWindow.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        if (process.env.NODE_ENV !== "development") {
          this.showLoadFailureDialog("Control panel", errorCode, errorDescription, validatedURL);
        }
        // Show it regardless: a failed load can't reach the renderer path that
        // normally does, and a hidden window leaves the failure invisible.
        this._showControlPanel();
      }
    );

    this.controlPanelWindow.webContents.on("render-process-gone", (_event, details) => {
      if (details.reason === "crashed" || details.reason === "killed" || details.reason === "oom") {
        debugLogger.error(
          "Control panel renderer process gone",
          { reason: details.reason, exitCode: details.exitCode },
          "window"
        );
        // The renderer owned any running demo; without this, its stale session
        // keeps swallowing dictations after the reload.
        this.endOnboardingDemo();
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
    if (this._onboardingActive) return;
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send("preview-text", text);
    this.mainWindow.showInactive();
    this.enforceMainWindowOnTop();
  }

  appendTranscriptionPreview(text) {
    if (this._onboardingActive) return;
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send("preview-append", text);
  }

  holdTranscriptionPreview(options = {}) {
    if (this._onboardingActive) return;
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send("preview-hold", {
      showCleanup: !!options.showCleanup,
    });
  }

  completeTranscriptionPreview(text) {
    if (this._onboardingActive) return;
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send("preview-result", { text });
    this.enforceMainWindowOnTop();
  }

  hideTranscriptionPreview() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send("preview-hide");
  }

  // The display the user is working on is the one showing the app being dictated
  // into, which on a multi-monitor desk is often not the one the mouse rests on.
  // Falls back to the cursor when the target has no readable window (non-macOS,
  // no target captured yet, or an app with no ordinary window).
  async _resolveActiveDisplay(targetPidPromise) {
    let pid = this.textEditMonitor?.lastTargetPid;
    if (targetPidPromise) {
      try {
        pid = await targetPidPromise;
      } catch {
        pid = null;
      }
    }
    const bounds = pid ? await this.textEditMonitor.getTargetWindowBounds(pid) : null;
    return bounds
      ? screen.getDisplayMatching(bounds)
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }

  _repositionToActiveDisplay(targetPidPromise) {
    return this._mainWindowPlacementCoordinator.request(
      () => this._resolveActiveDisplay(targetPidPromise),
      (activeDisplay, isCurrent) =>
        this._enqueueMainWindowMutation(() =>
          this._performActiveDisplayReposition(activeDisplay, isCurrent)
        )
    );
  }

  _performActiveDisplayReposition(activeDisplay, isCurrent) {
    if (
      !isCurrent() ||
      this.dragManager.isDragActive() ||
      !this.mainWindow ||
      this.mainWindow.isDestroyed()
    ) {
      return { applied: false, reason: "superseded" };
    }

    const currentBounds = this.mainWindow.getBounds();
    const currentDisplay = this._getMainWindowDisplayFor(currentBounds);

    if (currentDisplay.id === activeDisplay.id) {
      // Nearest-display math can't tell "on this display" from "just past its
      // edge", so a rearranged monitor or a drag that ended over another
      // display can leave the panel stranded in dead space, looking like the
      // overlay vanished. Pull it back before showing it.
      const clamped = WindowPositionUtil.clampToWorkArea(currentBounds, currentDisplay);
      if (clamped.x !== currentBounds.x || clamped.y !== currentBounds.y) {
        const clampedBounds = { ...currentBounds, ...clamped };
        this._clearRendererResizeMask();
        this.mainWindow.setBounds(clampedBounds);
        this._lastResizeBounds = { ...clampedBounds };
        this._baseBoundsBeforeResize = null;
        return { applied: true, bounds: clampedBounds };
      }
      return { applied: false, reason: "same-display" };
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
    this._clearRendererResizeMask();
    this.mainWindow.setBounds(newPos);
    // This is an intentional native move, not a drag. Keep resize restoration
    // from treating the old display's bounds as the user's desired base state.
    this._lastResizeBounds = { ...newPos };
    this._baseBoundsBeforeResize = null;
    this._activeHorizontalDirection = null;
    this._notifyMainWindowHorizontalDirection();
    return { applied: true, bounds: newPos };
  }

  showDictationPanel(options = {}) {
    if (this._onboardingActive) return;
    const { focus = false, reposition = false, targetPidPromise } = options;
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    if (this._assistantPanelOpen) {
      // The open panel owns geometry (no reposition), but it must never be
      // left invisible: surface the window if something hid it.
      if (!this.mainWindow.isVisible()) this.mainWindow.showInactive();
      if (focus) this.mainWindow.focus();
      return;
    }
    if (reposition) {
      void this._repositionToActiveDisplay(targetPidPromise);
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

  setOnboardingActive(active) {
    const nextActive = active === true;
    if (nextActive === this._onboardingActive) {
      if (nextActive) this._hideNormalAppSurfaces();
      return true;
    }

    if (nextActive) {
      this._onboardingActive = true;
      this.sendCancelDictation();
      this._hideNormalAppSurfaces();
      return true;
    }

    this.endOnboardingDemo();
    this.sendCancelDictation();
    this.hideDictationPanel();
    this._onboardingActive = false;
    if (!this._floatingIconAutoHide) this.showDictationPanel();
    const deferredUpdate = this._deferredUpdateNotificationInfo;
    this._deferredUpdateNotificationInfo = null;
    if (deferredUpdate) void this.showUpdateNotification(deferredUpdate);
    return true;
  }

  _hideNormalAppSurfaces() {
    this.hideDictationPanel();
    this.hideTranscriptionPreview();
    this.dismissMeetingNotification();

    if (this._pendingUpdateNotificationData) {
      this._deferredUpdateNotificationInfo = { ...this._pendingUpdateNotificationData };
    }
    this.dismissUpdateNotification({ persistent: false });
  }

  beginOnboardingDemo(kind) {
    if (!ONBOARDING_DEMO_KINDS.has(kind)) return false;
    this._onboardingActive = true;
    this._onboardingDemoKind = kind;
    // A prior recording must not leak into a new correlated demo session.
    this.sendCancelDictation();
    this.hideDictationPanel();
    return true;
  }

  isOnboardingDemoActive() {
    return this._onboardingDemoKind !== null;
  }

  stopOnboardingDemoRecording() {
    if (!this._onboardingDemoKind) return false;
    this.sendStopDictation();
    this.hideDictationPanel();
    return true;
  }

  endOnboardingDemo() {
    // Before the early return on purpose: IPCHandlers' demo session must die
    // on every teardown path even if the demo kind is already gone — a stale
    // session broadcasts every later dictation on onboarding-demo-event.
    this.onOnboardingDemoTeardown?.();
    if (!this._onboardingDemoKind) return false;
    // Leaving/retrying is cancellation, not a transcription request. The
    // overlay owns AudioManager, so route cleanup must be delivered there.
    this.sendCancelDictation();
    this.hideDictationPanel();
    this._onboardingDemoKind = null;
    return true;
  }

  _clearControlPanelVisibilityTimer() {
    clearTimeout(this._controlPanelVisibilityTimer);
    this._controlPanelVisibilityTimer = null;
  }

  _showControlPanel() {
    const win = this.controlPanelWindow;
    if (!win || win.isDestroyed()) return;
    // Cancel the backstop either way: once the window has been shown on purpose,
    // a later timer firing could pull it back out of the tray.
    this._clearControlPanelVisibilityTimer();
    if (win.isVisible()) return;
    win.show();
    win.focus();
    dockManager.setControlPanelVisible(true);
  }

  // Compact onboarding stays fixed-size; expanded onboarding can resize and
  // maximize. Both modes remain minimizable and closable so a frameless window
  // never traps the user in setup.
  _applyOnboardingWindowChrome(win, mode) {
    const expanded = mode === "expanded";
    win.setResizable(expanded);
    win.setMinimizable(true);
    win.setMaximizable(expanded);
    win.setClosable(true);
    win.setFullScreenable(false);
    // Floor at the mode's canonical size so no step renders below the bounds
    // it was designed for — clamped to the work area, or a 1366x768-class
    // display could never fit (and setContentBounds would fight the minimum).
    const floor = expanded ? ONBOARDING_WINDOW_SIZES.EXPANDED : ONBOARDING_WINDOW_SIZES.COMPACT;
    const { workArea } = screen.getDisplayMatching(win.getBounds());
    win.setMinimumSize(
      Math.min(floor.width, workArea.width),
      Math.min(floor.height, workArea.height)
    );
    if (process.platform === "darwin" && typeof win.setWindowButtonVisibility === "function") {
      win.setWindowButtonVisibility(expanded);
    }
  }

  setOnboardingWindowMode(mode) {
    const win = this.controlPanelWindow;
    if (!win || win.isDestroyed()) return false;
    if (!new Set(["compact", "expanded", "restore"]).has(mode)) return false;
    if (mode !== "restore" && (win.isFullScreen() || win.isMaximized())) {
      // Entering onboarding from a maximized/fullscreen control panel must not
      // refuse: refusing leaves the native chrome (traffic lights, resize) on a
      // window whose flow assumes it is locked to the canonical bounds.
      if (win.isFullScreen()) win.setFullScreen(false);
      if (win.isMaximized()) win.unmaximize();
    }

    const current = win.getContentBounds();
    const { workArea } = screen.getDisplayMatching(win.getBounds());

    if (mode === "restore") {
      // A maximized/fullscreen window the user made keeps its bounds, but the
      // chrome state below must still be restored and the tracking cleared —
      // refusing outright left setFullScreenable(false) and onboarding's
      // minimum-size floor on the control panel for the rest of its life.
      if (!win.isFullScreen() && !win.isMaximized() && this._onboardingRestoreBounds) {
        win.setContentBounds(clampedBounds(this._onboardingRestoreBounds, workArea), true);
      }
      const state = this._onboardingWindowState;
      if (state) {
        win.setResizable(state.resizable);
        win.setMinimizable(state.minimizable);
        win.setMaximizable(state.maximizable);
        win.setClosable(state.closable);
        win.setFullScreenable(state.fullscreenable);
        if (state.minimumSize) win.setMinimumSize(...state.minimumSize);
      }
      if (process.platform === "darwin" && typeof win.setWindowButtonVisibility === "function") {
        win.setWindowButtonVisibility(true);
      }
      this._onboardingRestoreBounds = null;
      this._onboardingWindowMode = null;
      this._onboardingWindowState = null;
      this._showControlPanel();
      return true;
    }

    if (!this._onboardingRestoreBounds) {
      this._onboardingRestoreBounds = current;
      this._onboardingWindowState = {
        resizable: win.isResizable(),
        minimizable: win.isMinimizable(),
        maximizable: win.isMaximizable(),
        closable: win.isClosable(),
        fullscreenable: win.isFullScreenable(),
        minimumSize: win.getMinimumSize(),
      };
    }

    this._applyOnboardingWindowChrome(win, mode);

    if (this._onboardingWindowMode === mode) {
      this._showControlPanel();
      return true;
    }

    const target =
      mode === "compact" ? ONBOARDING_WINDOW_SIZES.COMPACT : ONBOARDING_WINDOW_SIZES.EXPANDED;
    const next = centeredBounds(current, target, workArea);
    if (
      current.x === next.x &&
      current.y === next.y &&
      current.width === next.width &&
      current.height === next.height
    ) {
      this._onboardingWindowMode = mode;
      this._showControlPanel();
      return true;
    }

    win.setContentBounds(next, true);
    this._onboardingWindowMode = mode;
    this._showControlPanel();
    return true;
  }

  hideControlPanelToTray() {
    if (!this.controlPanelWindow || this.controlPanelWindow.isDestroyed()) {
      return;
    }

    // An explicit hide is authoritative: the visibility backstop exists to
    // rescue a window that never got shown, and letting it fire now would
    // pull the panel (and the Dock icon) back out of the tray.
    this._clearControlPanelVisibilityTimer();
    // A demo left running when the panel hides would keep swallowing normal
    // dictations (paste suppressed, transcripts rerouted to the demo session).
    this.endOnboardingDemo();
    this.controlPanelWindow.hide();
    dockManager.setControlPanelVisible(false);
  }

  hideDictationPanel() {
    // An open panel, or a command still thinking toward one, must not lose
    // its window (a PTT tap during thinking used to hide it — the panel then
    // opened invisibly and nothing could show it again).
    if (this._assistantPanelOpen || this._assistantPanelBusy) return;
    this._mainWindowPlacementCoordinator.cancelPending();
    if (this.mainWindow && !this.mainWindow.isDestroyed()) this.mainWindow.hide();
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
        this.showDictationPanel();
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

  async showMeetingNotification(promptData, { autoDismiss = true } = {}) {
    if (this._onboardingActive) return false;
    if (this.notificationWindow && !this.notificationWindow.isDestroyed()) {
      const previousWindow = this.notificationWindow;
      this.notificationWindow = null;
      this._pendingNotificationData = null;
      previousWindow.close();
    }
    this._notificationDismissTimer.cancel();
    if (this._notificationLoadTimeout) {
      clearTimeout(this._notificationLoadTimeout);
      this._notificationLoadTimeout = null;
    }
    if (this._notificationReadyFallback) {
      clearTimeout(this._notificationReadyFallback);
      this._notificationReadyFallback = null;
    }

    const display = screen.getPrimaryDisplay();
    const notificationSize = getMeetingNotificationWindowSize(promptData);
    const position = WindowPositionUtil.getNotificationPosition(display, notificationSize);

    const win = new BrowserWindow({
      ...NOTIFICATION_WINDOW_CONFIG,
      ...notificationSize,
      ...position,
    });
    this.notificationWindow = win;

    // "closed" fires asynchronously, so a replaced prompt's window emits it
    // after the replacement already took over the reference and the countdown.
    win.on("closed", () => {
      if (this.notificationWindow !== win) return;
      const unavailableAutoEndSessionId =
        this._pendingNotificationData?.kind === "auto-end"
          ? this._pendingNotificationData.sessionId
          : null;
      this.notificationWindow = null;
      this._pendingNotificationData = null;
      this._notificationDismissTimer.cancel();
      if (this._notificationLoadTimeout) {
        clearTimeout(this._notificationLoadTimeout);
        this._notificationLoadTimeout = null;
      }
      if (this._notificationReadyFallback) {
        clearTimeout(this._notificationReadyFallback);
        this._notificationReadyFallback = null;
      }
      if (unavailableAutoEndSessionId) {
        this.meetingDetectionEngine?.handleAutoEndNotificationUnavailable?.(
          unavailableAutoEndSessionId
        );
      }
    });

    win.setContentProtection(true);

    if (process.platform === "darwin") {
      win.setIgnoreMouseEvents(true, { forward: true });
    }

    WindowPositionUtil.setupAlwaysOnTop(win);

    this._pendingNotificationData = promptData;

    // Everything past the load addresses `win` directly: a replacement taking
    // over mid-load must not have this prompt's data, countdown or force-show
    // applied to its window.
    let loadTimeout = null;
    try {
      const loadNotification = async () => {
        if (process.env.NODE_ENV === "development") {
          await DevServerManager.waitForDevServer();
          if (this.notificationWindow !== win) return;
          await win.loadURL(`${DevServerManager.DEV_SERVER_URL}?meeting-notification=true`);
          return;
        }

        const fileInfo = DevServerManager.getAppFilePath(false);
        await win.loadFile(fileInfo.path, {
          query: { ...fileInfo.query, "meeting-notification": "true" },
        });
      };
      const loadPromise = loadNotification();
      if (promptData?.kind === "auto-end") {
        const timeoutPromise = new Promise((_, reject) => {
          loadTimeout = setTimeout(() => {
            if (this._notificationLoadTimeout === loadTimeout) {
              this._notificationLoadTimeout = null;
            }
            reject(new Error("Meeting auto-end notification load timed out"));
          }, AUTO_END_NOTIFICATION_LOAD_TIMEOUT_MS);
          this._notificationLoadTimeout = loadTimeout;
        });
        await Promise.race([loadPromise, timeoutPromise]);
      } else {
        await loadPromise;
      }
    } catch (error) {
      // A load aborted by our own replacement or dismissal is not a failure.
      if (this.notificationWindow !== win) return;
      this.dismissMeetingNotification();
      throw error;
    } finally {
      if (loadTimeout && this._notificationLoadTimeout === loadTimeout) {
        clearTimeout(loadTimeout);
        this._notificationLoadTimeout = null;
      }
    }
    if (this.notificationWindow !== win) return;
    if (this._onboardingActive) {
      this.dismissMeetingNotification();
      return false;
    }

    const readyFallback = setTimeout(() => {
      if (this._notificationReadyFallback !== readyFallback) return;
      this._notificationReadyFallback = null;
      if (this._onboardingActive || this.notificationWindow !== win || win.isDestroyed()) return;
      debugLogger.warn("Notification renderer did not signal ready, force-showing", {}, "meeting");
      win.webContents.send("meeting-notification-data", promptData);
      win.showInactive();
    }, 3000);
    this._notificationReadyFallback = readyFallback;

    // The auto-end countdown is owned by its controller — it stays until kept,
    // canceled by fresh activity, or expired — so it never auto-dismisses.
    if (autoDismiss) {
      this._notificationDismissTimer.start(getNotificationTimeoutMs(promptData.source));
    }
  }

  // Only the window that loaded the prompt may reveal it: a stale window's late
  // "ready" must not clear the fallback that would force-show its replacement.
  showNotificationWindow(ownerWebContents) {
    if (this._onboardingActive) {
      this.dismissMeetingNotification();
      return;
    }
    const win = this.notificationWindow;
    if (!win || win.isDestroyed() || (ownerWebContents && win.webContents !== ownerWebContents)) {
      return;
    }

    if (this._notificationReadyFallback) {
      clearTimeout(this._notificationReadyFallback);
      this._notificationReadyFallback = null;
    }
    win.showInactive();
  }

  dismissMeetingNotification() {
    this._pendingNotificationData = null;
    if (this._notificationReadyFallback) {
      clearTimeout(this._notificationReadyFallback);
      this._notificationReadyFallback = null;
    }
    this._notificationDismissTimer.cancel();
    if (this._notificationLoadTimeout) {
      clearTimeout(this._notificationLoadTimeout);
      this._notificationLoadTimeout = null;
    }
    const win = this.notificationWindow;
    this.notificationWindow = null;
    if (win && !win.isDestroyed()) win.close();
  }

  showMeetingAutoEndCountdown({ sessionId, expiresAt, reason }) {
    return this.showMeetingNotification(
      { kind: "auto-end", sessionId, expiresAt, reason },
      { autoDismiss: false }
    );
  }

  dismissMeetingAutoEndCountdown(sessionId) {
    if (
      this._pendingNotificationData?.kind !== "auto-end" ||
      this._pendingNotificationData.sessionId !== sessionId
    ) {
      return;
    }
    this.dismissMeetingNotification();
  }

  async showUpdateNotification(info) {
    if (this._onboardingActive) {
      this._deferredUpdateNotificationInfo = info;
      return false;
    }
    this._deferredUpdateNotificationInfo = null;
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
    this._pendingUpdateNotificationData = {
      version: info?.version,
      releaseDate: info?.releaseDate,
    };

    WindowPositionUtil.setupAlwaysOnTop(win);

    try {
      if (process.env.NODE_ENV === "development") {
        await DevServerManager.waitForDevServer();
        await win.loadURL(`${DevServerManager.DEV_SERVER_URL}?update-notification=true`);
      } else {
        const fileInfo = DevServerManager.getAppFilePath(false);
        await win.loadFile(fileInfo.path, {
          query: { ...fileInfo.query, "update-notification": "true" },
        });
      }
    } catch (error) {
      // Entering onboarding closes any in-flight normal-app popup. Its aborted
      // load is expected, and the saved update is replayed once the gate opens.
      if (this._onboardingActive || this.updateNotificationWindow !== win) return false;
      throw error;
    }

    if (this._onboardingActive || this.updateNotificationWindow !== win) return false;

    this._updateNotificationReadyFallback = setTimeout(() => {
      this._updateNotificationReadyFallback = null;
      if (this._onboardingActive || this.updateNotificationWindow !== win || win.isDestroyed())
        return;
      win.webContents.send("update-notification-data", this._pendingUpdateNotificationData);
      win.showInactive();
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
    if (this._onboardingActive) return;
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
    if (persistent) {
      this._updateNotificationDismissed = true;
      this._deferredUpdateNotificationInfo = null;
    }
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
