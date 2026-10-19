const { BrowserWindow, Menu, screen } = require("electron");
const debugLogger = require("./debugLogger");
const { isFromWindow } = require("./ipcSender");
const { createLinuxWindowInputRegion } = require("./linuxWindowInputRegion");
const { plasmaWorkAreas } = require("./plasmaWorkAreas");
const { AGENT_WINDOW_CONFIG, WindowPositionUtil } = require("./windowConfig");
const {
  AGENT_LAYOUT_SIZES,
  computeAgentAnchor,
  computeAgentWindowBounds,
} = require("./agentWindowPlacement");

const VOICE_STATES = new Set(["idle", "recording", "transcribing"]);
const DISPLAY_EVENTS = ["display-metrics-changed", "display-added", "display-removed"];

const sameBounds = (a, b) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * The assistant's own window (`?agent=true`): a pill, a composer above it, or
 * a modal. It is created hidden once the normal app is up and kept alive while
 * hidden, so a conversation (and a turn waiting on the user) survives a close.
 * The renderer owns the layout and asks for bounds and keyboard focus; main
 * owns placement, focus, and the voice state that keeps dictation off the mic.
 */
class AgentWindowManager {
  constructor(windowManager, { platform = process.platform } = {}) {
    this.windowManager = windowManager;
    this.platform = platform;
    this.window = null;
    this.ready = false;
    // The one message a renderer that is still loading gets once it is ready.
    this.pending = null;
    this.layout = "pill";
    this.anchor = null;
    this.displayId = null;
    this.voiceState = "idle";
    this.keyboardFocus = false;
    // Bumped by every hide, so a show still resolving its display can't undo it.
    this.showGeneration = 0;
    this.inputRegion = null;
    this.linuxFocusRequest = null;
    this.displayListening = false;
    this.refit = () => this._refit();
  }

  isRecording() {
    return this.voiceState === "recording";
  }

  prewarm() {
    this._ensureWindow();
  }

  // The agent hotkey. The renderer decides what the press means (listen,
  // submit, switch from typing to voice); main captures what the user was
  // working in, before the window can take focus from it.
  handleHotkey() {
    const windowManager = this.windowManager;
    if (windowManager._onboardingActive || windowManager.hotkeyManager.isInListeningMode()) return;
    if (windowManager.isDictationActive()) return;
    const win = this._ensureWindow();
    const external = !(win.isVisible() && win.isFocused());
    let targetPidPromise;
    if (external) {
      targetPidPromise = windowManager.textEditMonitor?.captureTargetPid?.();
      void windowManager.selectionManager?.captureTarget?.({ force: true });
    }
    void this._show(() => windowManager._resolveActiveDisplay(targetPidPromise));
    this._send("agent-window-hotkey", { external });
  }

  // The tray's and the pill menu's Ask assistant: no app was pressed in, so
  // the window opens where the cursor is.
  open({ layout = "typing" } = {}) {
    const windowManager = this.windowManager;
    if (windowManager._onboardingActive || windowManager.hotkeyManager.isInListeningMode()) return;
    // The typing layout takes the keyboard, and with it a dictation's paste.
    if (windowManager.isDictationActive()) return;
    this._ensureWindow();
    void this._show(async () => this._cursorDisplay());
    this._send("agent-window-open", { layout });
  }

  // A conversational wake-word command, transcribed by the dictation window.
  deliverCommand(command) {
    if (this.windowManager._onboardingActive) return false;
    const text = typeof command?.text === "string" ? command.text.trim() : "";
    if (!text) return false;
    const attachment =
      typeof command.attachment?.image === "string" &&
      typeof command.attachment?.mediaType === "string"
        ? { image: command.attachment.image, mediaType: command.attachment.mediaType }
        : null;
    const selectedText =
      typeof command.selectedContext?.text === "string" ? command.selectedContext.text : "";
    this._ensureWindow();
    void this._show(() => this.windowManager._resolveActiveDisplay());
    this._send("agent-window-command", {
      text,
      attachment,
      selectedContext: selectedText.trim() ? { text: selectedText, source: "external" } : null,
    });
    return true;
  }

  // The window goes away without the renderer asking (onboarding took the
  // screen, Alt+F4, Cmd+W): it drops its take and turn, and starts over hidden.
  dismiss() {
    if (!this.window) return;
    this._send("agent-window-dismiss");
    this._hide();
  }

  markReady(event) {
    if (!isFromWindow(event, this.window)) return;
    this.ready = true;
    const pending = this.pending;
    this.pending = null;
    if (pending) this.window.webContents.send(pending.channel, pending.payload);
  }

  setLayout(event, request) {
    if (!isFromWindow(event, this.window) || !AGENT_LAYOUT_SIZES[request?.layout]) return false;
    this.layout = request.layout;
    this._applyBounds();
    this._setKeyboardFocus(request.focus === true);
    return true;
  }

  hide(event) {
    if (!isFromWindow(event, this.window)) return false;
    this._hide();
    return true;
  }

  // False refuses a recording while dictation owns the microphone.
  setVoiceState(event, state) {
    if (!isFromWindow(event, this.window) || !VOICE_STATES.has(state)) return false;
    if (state === "recording" && this.windowManager.isDictationActive()) return false;
    this._applyVoiceState(state);
    return true;
  }

  _applyVoiceState(state) {
    if (state === this.voiceState) return;
    const wasRecording = this.isRecording();
    this.voiceState = state;
    this.windowManager.syncUserRecording();
    // The dictation window's own starts (a pill click, its menu) never pass
    // through main's hotkey guard, so it is told when the agent holds the mic.
    const main = this.windowManager.mainWindow;
    if (wasRecording !== this.isRecording() && main && !main.isDestroyed()) {
      main.webContents.send("agent-recording-changed", this.isRecording());
    }
  }

  _ensureWindow() {
    if (this.window) return this.window;
    const win = new BrowserWindow({
      ...AGENT_WINDOW_CONFIG,
      ...AGENT_LAYOUT_SIZES.pill,
      // A macOS panel stays focusable from creation: making it focusable later
      // needs show(), which activates the app and can slide to another Space.
      focusable: this.platform === "darwin",
    });
    this.window = win;
    this.ready = false;
    win.setContentProtection(true);
    this.windowManager.registerExternalLinkHandlers(win, false);
    win.webContents.on("context-menu", (_event, params) => {
      if (params?.selectionText?.trim()) {
        Menu.buildFromTemplate([{ role: "copy" }]).popup({ window: win });
      }
    });
    win.on("close", (event) => {
      if (this.windowManager.isQuitting) return;
      event.preventDefault();
      this.dismiss();
    });
    win.on("closed", () => {
      if (this.window === win) this._forget();
    });
    // A reload (development, or the error screen's Reload) is a new renderer:
    // it starts hidden with no take, and says when it is ready again. Only a
    // committed main-frame navigation counts: an in-page one (a footnote link)
    // keeps the renderer, and so does one will-navigate blocks (a dropped file).
    win.webContents.on("did-navigate", () => {
      if (this.window !== win) return;
      if (this.ready) {
        this._applyVoiceState("idle");
        this._hide();
      }
      this.ready = false;
    });
    win.webContents.on("render-process-gone", (_event, details) => {
      if (this.window !== win || details?.reason === "clean-exit") return;
      debugLogger.warn(
        "Agent window renderer gone; the next press recreates it",
        { reason: details?.reason, exitCode: details?.exitCode },
        "window"
      );
      this._forget();
      if (!win.isDestroyed()) win.destroy();
    });
    if (this.platform === "linux") {
      // A click never focuses an override-redirect window; while the user is
      // typing, a click back into the composer has to take focus again.
      win.webContents.on("input-event", (_event, input) => {
        if (
          input.type === "mouseDown" &&
          this.keyboardFocus &&
          !win.isFocused() &&
          !this.linuxFocusRequest
        ) {
          this._focusLinux();
        }
      });
    }
    if (!this.displayListening) {
      this.displayListening = true;
      for (const event of DISPLAY_EVENTS) screen.on(event, this.refit);
    }
    this.windowManager.loadWindowContent(win, false, { agent: "true" }).catch((error) => {
      debugLogger.warn("Failed to load the agent window", { error: error.message }, "window");
      if (this.window !== win) return;
      this._forget();
      if (!win.isDestroyed()) win.destroy();
    });
    return win;
  }

  // The window is gone (crash, failed load): nothing it held may block dictation.
  _forget() {
    this.window = null;
    this.ready = false;
    this.pending = null;
    this.layout = "pill";
    this.keyboardFocus = false;
    this.inputRegion?.stop();
    this.inputRegion = null;
    this.linuxFocusRequest = null;
    this._applyVoiceState("idle");
  }

  _send(channel, payload) {
    if (!this.window) return;
    if (this.ready) this.window.webContents.send(channel, payload);
    else this.pending = { channel, payload };
  }

  async _show(resolveDisplay) {
    const win = this.window;
    if (win.isVisible()) {
      win.moveTop?.();
      return;
    }
    // A KDE panel edit raises no display event, so Plasma is asked again on
    // every show, as for the dictation pill; a change re-anchors the window.
    void plasmaWorkAreas.refresh();
    const generation = this.showGeneration;
    const display = await resolveDisplay();
    if (this.window !== win || win.isDestroyed() || generation !== this.showGeneration) return;
    this._place(display);
    WindowPositionUtil.setupAlwaysOnTop(win);
    win.showInactive();
    win.moveTop?.();
  }

  _hide() {
    const win = this.window;
    if (!win) return;
    this.showGeneration += 1;
    // Hidden before the keyboard is released: hiding hands focus back by
    // itself, and a release first could raise another window (the dictation
    // pill on Windows) or flash a remap on Linux.
    if (win.isVisible()) win.hide();
    this._setKeyboardFocus(false);
    // Shrunk while hidden, so the next show never paints a stale modal frame.
    this.layout = "pill";
    if (this.anchor) this._applyBounds();
  }

  _place(display) {
    this.displayId = display.id;
    this.anchor = computeAgentAnchor({
      workArea: display.workArea || display.bounds,
      dictationBounds: this._centerDockedDictationBounds(display),
      // Windows sends every click in the dictation window to it; elsewhere its
      // transparent area lets clicks through.
      wholeDictationWindowTakesClicks: this.platform === "win32",
    });
    this._applyBounds();
  }

  // The dictation pill shares the bottom center only when docked there; the
  // agent pill then sits above it.
  _centerDockedDictationBounds(display) {
    const windowManager = this.windowManager;
    const main = windowManager.mainWindow;
    if (
      windowManager._panelStartPosition !== "center" ||
      !main ||
      main.isDestroyed() ||
      !main.isVisible()
    ) {
      return null;
    }
    const bounds = main.getBounds();
    return screen.getDisplayMatching(bounds).id === display.id ? bounds : null;
  }

  // Displays as the dictation pill sees them: on KDE, each monitor's own work
  // area (plasmaWorkAreas.js).
  _cursorDisplay() {
    return plasmaWorkAreas.resolve(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));
  }

  // The window's display, or the cursor's when that one is gone.
  _windowDisplay() {
    const display = screen.getAllDisplays().find((candidate) => candidate.id === this.displayId);
    return display ? plasmaWorkAreas.resolve(display) : this._cursorDisplay();
  }

  _applyBounds() {
    const win = this.window;
    if (!win || !this.anchor) return;
    const display = this._windowDisplay();
    const bounds = computeAgentWindowBounds({
      anchor: this.anchor,
      layout: this.layout,
      workArea: display.workArea || display.bounds,
    });
    if (!sameBounds(win.getBounds(), bounds)) win.setBounds(bounds);
  }

  // Displays changed: re-anchor on the window's display.
  _refit() {
    if (!this.window || this.anchor === null) return;
    this._place(this._windowDisplay());
  }

  // Keyboard mode asks for focus; voice mode hands it back to the app the user
  // was in. macOS never focuses: focus() activates the app (and can slide to
  // another Space), while a click makes the non-activating panel key.
  _setKeyboardFocus(requested) {
    const win = this.window;
    if (!win || this.platform === "darwin") {
      this.keyboardFocus = requested;
      return;
    }
    if (requested) {
      this.keyboardFocus = true;
      if (this.platform === "win32") {
        win.setFocusable(true);
        win.focus();
      } else {
        this._focusLinux();
      }
      return;
    }
    if (!this.keyboardFocus) return;
    this.keyboardFocus = false;
    if (this.platform === "win32") {
      // focus() activated OpenWhispr; blur hands the foreground back. A window
      // that no longer has it (hidden, or the user clicked away) must not
      // blur: that can move the foreground while a press is copying a selection.
      if (win.isFocused()) win.blur();
      win.setFocusable(false);
      return;
    }
    // GNOME hands focus back to the previous app only when the focused
    // override-redirect window unmaps; wait out a focus request still landing.
    const returnFocus = () => {
      if (this.keyboardFocus || this.window !== win || !win.isVisible()) return;
      win.hide();
      win.showInactive();
    };
    if (this.linuxFocusRequest) void this.linuxFocusRequest.then(returnFocus);
    else returnFocus();
  }

  // An override-redirect X11 window takes focus only through the helper.
  _focusLinux() {
    const win = this.window;
    if (this.inputRegion?.window !== win) {
      this.inputRegion?.stop();
      this.inputRegion = { window: win, ...createLinuxWindowInputRegion(win) };
    }
    const request = this.inputRegion.focus().catch(() => {});
    this.linuxFocusRequest = request;
    void request.then(() => {
      if (this.linuxFocusRequest === request) this.linuxFocusRequest = null;
    });
  }
}

module.exports = { AgentWindowManager };
