// Read-aloud: select text anywhere, press a hotkey, hear it in a local voice.
//
// Main-process orchestrator, kept apart from the dictation pipeline:
//   - ttsWorker (utilityProcess): keeps the voice loaded, synthesizes per sentence
//   - overlay window: plays the PCM chunks (WebAudio) and, while reading, shows
//     a small pill with pause/stop controls
//   - hotkey slots "readAloud" (read / stop / switch) and "readAloudPause"
// Selection capture reuses SelectionManager, which restores the clipboard.
// Settings live in the userData .env (READ_ALOUD_* keys, see environment.js).
const path = require("path");
const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  utilityProcess,
  MessageChannelMain,
} = require("electron");
const debugLogger = require("../debugLogger");
const { createHotkeyRepeatGate } = require("../hotkeyRepeatGate");
const { prepareTextForSpeech, splitSentences, MAX_READ_CHARACTERS } = require("./textPrep");
const { i18nMain } = require("../i18nMain");
const { VOICES, defaultVoiceFor, getVoice, shareVoiceFiles } = require("./voices");
const { getVoiceDir, isVoiceInstalled, installVoice, removeVoice } = require("./voiceInstaller");

const WORKER_SCRIPT = path.join(__dirname, "..", "..", "workers", "ttsWorker.js");
const OVERLAY_HTML = path.join(__dirname, "player.html");
const OVERLAY_PRELOAD = path.join(__dirname, "playerPreload.js");
const OVERLAY_WIDTH = 300;
const OVERLAY_HEIGHT = 56;

const DEFAULT_READ_KEY = "Control+Alt+L";
const DEFAULT_PAUSE_KEY = "Control+Alt+P";
const SPEED_MIN = 0.5;
const SPEED_MAX = 2;
const SPEEDS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const REQUEST_TIMEOUT_MS = 30_000;

const ENV = {
  enabled: "READ_ALOUD_ENABLED",
  readKey: "READ_ALOUD_KEY",
  pauseKey: "READ_ALOUD_PAUSE_KEY",
  speed: "READ_ALOUD_SPEED",
  voice: "READ_ALOUD_VOICE",
  showIndicator: "READ_ALOUD_INDICATOR",
};

function readFlag(name, fallback) {
  const raw = (process.env[name] || "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

class ReadAloudManager {
  constructor({ selectionManager, hotkeyManager, environmentManager }) {
    this.selectionManager = selectionManager;
    this.hotkeyManager = hotkeyManager;
    this.environmentManager = environmentManager;
    this.child = null;
    this.port = null;
    this.pending = new Map();
    this.nextId = 1;
    this.nextRequestId = 1;
    this.currentRequestId = null;
    this.currentText = null;
    this.state = "idle"; // idle | capturing | speaking | paused
    this.active = false; // hotkeys registered and voice warm
    this.overlay = null;
    this.overlayReady = null;
    this.voiceReady = null;
    this.loadedVoice = null;
    this.installing = null;
    this._onOverlayState = this._onOverlayState.bind(this);
    this._onOverlayAction = this._onOverlayAction.bind(this);
  }

  // --- configuration --------------------------------------------------------

  getConfig() {
    const voice = getVoice(process.env[ENV.voice])
      ? process.env[ENV.voice]
      : defaultVoiceFor(i18nMain.language);
    const speed = Number(process.env[ENV.speed] || 1);
    const hotkey = (name, fallback) => {
      const raw = process.env[name];
      if (!raw) return fallback;
      return raw === "none" ? "" : raw;
    };
    return {
      enabled: readFlag(ENV.enabled, false),
      readKey: hotkey(ENV.readKey, DEFAULT_READ_KEY),
      pauseKey: hotkey(ENV.pauseKey, DEFAULT_PAUSE_KEY),
      speed: Number.isFinite(speed) && speed >= SPEED_MIN && speed <= SPEED_MAX ? speed : 1,
      voice,
      showIndicator: readFlag(ENV.showIndicator, true),
    };
  }

  getStatus() {
    const config = this.getConfig();
    return {
      ...config,
      state: this.state,
      active: this.active,
      installing: this.installing,
      voices: VOICES.map((v) => ({ ...v, installed: isVoiceInstalled(v.id) })),
    };
  }

  _persist(values) {
    for (const [field, value] of Object.entries(values)) {
      // An empty string would delete the key and fall back to the default
      // hotkey; "none" keeps "no hotkey" explicit across restarts.
      const stored = value === "" ? "none" : String(value);
      this.environmentManager._saveKey(ENV[field], stored);
    }
    return this.environmentManager
      .saveAllKeysToEnvFile()
      .catch((err) =>
        debugLogger.warn("Read aloud settings save failed", { error: err.message }, "read-aloud")
      );
  }

  async setConfig(patch = {}) {
    const before = this.getConfig();
    const next = { ...before };
    if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
    if (typeof patch.showIndicator === "boolean") next.showIndicator = patch.showIndicator;
    if (typeof patch.speed === "number" && patch.speed >= SPEED_MIN && patch.speed <= SPEED_MAX) {
      next.speed = patch.speed;
    }
    if (typeof patch.voice === "string" && getVoice(patch.voice)) next.voice = patch.voice;
    if (typeof patch.readKey === "string") next.readKey = patch.readKey;
    if (typeof patch.pauseKey === "string") next.pauseKey = patch.pauseKey;

    // Hotkeys are validated by actually registering them.
    if (this.active && next.enabled) {
      for (const field of ["readKey", "pauseKey"]) {
        if (next[field] === before[field]) continue;
        const result = await this._registerSlot(field, next[field]);
        if (!result.success) {
          await this._registerSlot(field, before[field]);
          return { success: false, error: result.error, status: this.getStatus() };
        }
      }
    }

    await this._persist({
      enabled: next.enabled,
      showIndicator: next.showIndicator,
      speed: next.speed,
      voice: next.voice,
      readKey: next.readKey,
      pauseKey: next.pauseKey,
    });

    if (next.speed !== before.speed) this._sendToOverlay({ type: "speed", speed: next.speed });
    if (next.voice !== before.voice) {
      this.stop();
      this.voiceReady = null;
    }
    if (!next.showIndicator) this._hideOverlay();

    if (next.enabled && !this.active) await this.start();
    else if (!next.enabled && this.active) await this.deactivate();
    else if (this.active && next.voice !== before.voice) this._preload();

    return { success: true, status: this.getStatus() };
  }

  // --- lifecycle ------------------------------------------------------------

  async init() {
    this._registerIpc();
    if (this.getConfig().enabled) await this.start();
  }

  async start() {
    const config = this.getConfig();
    if (!isVoiceInstalled(config.voice)) {
      debugLogger.warn("Read aloud voice not installed", { voice: config.voice }, "read-aloud");
      return;
    }
    const read = await this._registerSlot("readKey", config.readKey);
    const pause = await this._registerSlot("pauseKey", config.pauseKey);
    debugLogger.info(
      "Read aloud hotkeys",
      {
        readKey: config.readKey,
        read: read.success,
        pauseKey: config.pauseKey,
        pause: pause.success,
      },
      "read-aloud"
    );
    this.active = true;
    this._preload();
  }

  async deactivate() {
    this.stop();
    this.hotkeyManager.unregisterSlot("readAloud");
    this.hotkeyManager.unregisterSlot("readAloudPause");
    this.active = false;
    await this._stopWorker();
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.destroy();
  }

  _preload() {
    // Warm up in the background so the first press speaks immediately. A voice
    // picked while its download is still running has no files yet; the install
    // handler preloads it once the download finishes.
    if (isVoiceInstalled(this.getConfig().voice)) {
      this._ensureVoice().catch((err) =>
        debugLogger.error("Read aloud voice preload failed", { error: err.message }, "read-aloud")
      );
    }
    this._ensureOverlay().catch((err) =>
      debugLogger.error("Read aloud overlay failed", { error: err.message }, "read-aloud")
    );
  }

  _registerSlot(field, hotkey) {
    const slot = field === "readKey" ? "readAloud" : "readAloudPause";
    if (!hotkey || hotkey === "none") {
      this.hotkeyManager.unregisterSlot(slot);
      return Promise.resolve({ success: true });
    }
    const isPress = createHotkeyRepeatGate();
    const action = field === "readKey" ? () => this.toggle() : () => this.togglePause();
    return this.hotkeyManager.registerSlot(slot, hotkey, () => {
      if (isPress()) action();
    });
  }

  // --- public actions -------------------------------------------------------

  async toggle() {
    const pressedAt = Date.now();
    if (this.state === "capturing") return;
    const wasActive = this.state === "speaking" || this.state === "paused";
    const previousText = this.currentText;
    if (wasActive) this.stop();

    this.state = "capturing";
    let text = "";
    try {
      await this.selectionManager.captureTarget();
      const capture = await this.selectionManager.captureSelectedText({
        maxCharacters: MAX_READ_CHARACTERS,
        acceptClipboardEcho: process.platform === "win32",
      });
      if (capture?.status === "selected") text = prepareTextForSpeech(capture.text);
      debugLogger.info(
        "Read aloud capture",
        { status: capture?.status, chars: text.length, ms: Date.now() - pressedAt },
        "read-aloud"
      );
    } catch (err) {
      debugLogger.warn("Read aloud capture failed", { error: err.message }, "read-aloud");
    } finally {
      if (this.state === "capturing") this.state = "idle";
    }

    // Pressing again on the text already being read means "stop".
    if (wasActive && (!text || text === previousText)) return;
    if (!text) {
      await this.speak(this._spokenText("noSelection"), { remember: false });
      return;
    }
    await this.speak(text, { pressedAt });
  }

  togglePause() {
    if (this.state === "speaking") {
      this._sendToOverlay({ type: "pause" });
      this.state = "paused";
    } else if (this.state === "paused") {
      this._sendToOverlay({ type: "resume" });
      this.state = "speaking";
    }
  }

  stop() {
    if (this.currentRequestId !== null && this.port) {
      this._request("cancel", {}).catch(() => {});
    }
    this._sendToOverlay({ type: "stop" });
    this._hideOverlay();
    this.currentRequestId = null;
    this.currentText = null;
    if (this.state !== "capturing") this.state = "idle";
  }

  async test() {
    if (!isVoiceInstalled(this.getConfig().voice)) {
      return { success: false, error: "voice-not-installed" };
    }
    this.stop();
    await this.speak(this._spokenText("test"), { remember: false });
    return { success: true };
  }

  // Messages the app says itself go in the voice's language, not the UI's:
  // a Portuguese voice reading an English sentence sounds broken.
  _spokenText(key) {
    const language = getVoice(this.getConfig().voice)?.language || "en";
    return i18nMain.getFixedT(language)(`settingsPage.readAloud.spoken.${key}`);
  }

  async speak(text, { remember = true, pressedAt = Date.now() } = {}) {
    this.currentText = remember ? text : null;
    this.currentSentences = splitSentences(text);
    this._pressedAt = pressedAt;
    await this._speakFrom(0);
  }

  async _speakFrom(startIndex) {
    await Promise.all([this._ensureVoice(), this._ensureOverlay()]);
    const requestId = this.nextRequestId++;
    const { speed } = this.getConfig();
    this.currentRequestId = requestId;
    this.state = "speaking";
    this._firstChunkLogged = false;
    this._sendToOverlay({ type: "start", requestId, speed });
    this._showOverlay();
    // Always synthesize at natural pace; the overlay applies the user's speed
    // as a pitch-preserving playback rate, so speed changes are instant.
    await this._request("speak", {
      requestId,
      sentences: this.currentSentences,
      startIndex,
      speed: 1,
    });
  }

  // Steps the speed up or down one notch. Applied to playback right away
  // (pitch-preserving), without stopping or re-synthesizing the text.
  async changeSpeed(direction) {
    const { speed } = this.getConfig();
    const current = SPEEDS.reduce(
      (best, value, i) => (Math.abs(value - speed) < Math.abs(SPEEDS[best] - speed) ? i : best),
      0
    );
    const nextIndex = Math.min(SPEEDS.length - 1, Math.max(0, current + Math.sign(direction)));
    const next = SPEEDS[nextIndex];
    if (next === speed) return;
    await this.setConfig({ speed: next });
  }

  // --- worker ---------------------------------------------------------------

  _ensureVoice() {
    const voice = this.getConfig().voice;
    if (this.voiceReady && this.loadedVoice === voice) return this.voiceReady;
    this.loadedVoice = voice;
    this.voiceReady = (async () => {
      await this._spawnWorker();
      const meta = getVoice(voice);
      await this._request("load", {
        voice: meta,
        voiceDir: getVoiceDir(voice),
        numThreads: meta?.numThreads ?? 2,
      });
    })();
    this.voiceReady.catch(() => {
      this.voiceReady = null;
      this.loadedVoice = null;
    });
    return this.voiceReady;
  }

  async _spawnWorker() {
    if (this.child) return;
    const env = { ...process.env };
    try {
      env.OPENWHISPR_TTS_WORKER_LOG = path.join(app.getPath("userData"), "logs", "tts-worker.log");
    } catch {}
    const child = utilityProcess.fork(WORKER_SCRIPT, [], {
      serviceName: "openwhispr-tts",
      stdio: "pipe",
      env,
    });
    const forward = (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line) debugLogger.warn("tts worker output", { line }, "read-aloud");
      }
    };
    child.stdout?.on("data", forward);
    child.stderr?.on("data", forward);
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const { port1, port2 } = new MessageChannelMain();
    port1.on("message", (event) => this._onWorkerMessage(event.data));
    port1.start();
    child.postMessage("init", [port2]);
    child.on("exit", (code) => this._onWorkerExit(code));
    this.child = child;
    this.port = port1;
    debugLogger.info("tts worker spawned", { pid: child.pid }, "read-aloud");
  }

  _request(method, payload) {
    if (!this.port) return Promise.reject(new Error("tts worker not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`tts request timeout: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
      this.port.postMessage({ id, method, payload });
    });
  }

  _onWorkerMessage(msg) {
    if (msg.type === "chunk") {
      if (msg.requestId !== this.currentRequestId) return;
      if (!this._firstChunkLogged) {
        this._firstChunkLogged = true;
        debugLogger.info(
          "Read aloud first audio",
          { msFromHotkey: Date.now() - this._pressedAt },
          "read-aloud"
        );
      }
      this._sendToOverlay({
        type: "chunk",
        requestId: msg.requestId,
        index: msg.index,
        sampleRate: msg.sampleRate,
        samples: msg.samples,
      });
      return;
    }
    if (msg.type === "done") {
      this._sendToOverlay({ type: "done", requestId: msg.requestId });
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timeout);
    if (msg.error) entry.reject(new Error(msg.error.message));
    else entry.resolve(msg.result);
  }

  _onWorkerExit(code) {
    debugLogger.warn("tts worker exited", { code }, "read-aloud");
    this.child = null;
    this.port = null;
    this.voiceReady = null;
    this.loadedVoice = null;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(new Error("tts worker exited"));
    }
    this.pending.clear();
    if (this.state !== "idle") {
      this._sendToOverlay({ type: "stop" });
      this._hideOverlay();
      this.state = "idle";
    }
    // Respawned lazily on the next press via _ensureVoice().
  }

  async _stopWorker() {
    if (!this.child) return;
    const child = this.child;
    try {
      this.port?.postMessage({ id: 0, method: "shutdown", payload: {} });
    } catch {}
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // --- overlay (player + indicator) ------------------------------------------

  _ensureOverlay() {
    if (this.overlay && !this.overlay.isDestroyed()) return this.overlayReady;
    this.overlay = new BrowserWindow({
      show: false,
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // Focusable on purpose: a Windows window that cannot be activated has its
      // clicks eaten at WM_MOUSEACTIVATE, so the pill's pause/stop/speed would
      // stop responding mid-reading while the renderer kept running. It still
      // never steals focus, because it is only ever shown with showInactive().
      focusable: true,
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences: {
        preload: OVERLAY_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        autoplayPolicy: "no-user-gesture-required",
      },
    });
    this.overlay.setAlwaysOnTop(true, "screen-saver");
    this.overlay.on("closed", () => {
      this.overlay = null;
      this.overlayReady = null;
    });
    this.overlayReady = this.overlay.loadFile(OVERLAY_HTML);
    return this.overlayReady;
  }

  _showOverlay() {
    if (!this.getConfig().showIndicator) return;
    if (!this.overlay || this.overlay.isDestroyed() || this.overlay.isVisible()) return;
    // Bottom-center of the display the user is working on.
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { x, y, width, height } = display.workArea;
    this.overlay.setBounds({
      x: Math.round(x + (width - OVERLAY_WIDTH) / 2),
      y: Math.round(y + height - OVERLAY_HEIGHT - 72),
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
    });
    this.overlay.showInactive();
    this._keepOverlayOnTop();
  }

  _hideOverlay() {
    this._stopKeepingOverlayOnTop();
    if (this.overlay && !this.overlay.isDestroyed() && this.overlay.isVisible()) {
      this.overlay.hide();
    }
  }

  // Among always-on-top windows Windows orders by whichever was raised last, so
  // the dictation pill, a fullscreen app or a click elsewhere can bury the
  // pill. While it is on screen, put it back on top every half second; moveTop
  // never takes focus.
  _keepOverlayOnTop() {
    if (this._onTopTimer) return;
    const raise = () => {
      const overlay = this.overlay;
      if (!overlay || overlay.isDestroyed() || !overlay.isVisible()) {
        this._stopKeepingOverlayOnTop();
        return;
      }
      overlay.setAlwaysOnTop(true, "screen-saver");
      overlay.moveTop();
    };
    raise();
    this._onTopTimer = setInterval(raise, 500);
  }

  _stopKeepingOverlayOnTop() {
    if (!this._onTopTimer) return;
    clearInterval(this._onTopTimer);
    this._onTopTimer = null;
  }

  _sendToOverlay(command) {
    if (!this.overlay || this.overlay.isDestroyed()) return;
    this.overlay.webContents.send("tts-player:command", command);
  }

  _isOverlaySender(event) {
    return (
      !!this.overlay && !this.overlay.isDestroyed() && event.sender === this.overlay.webContents
    );
  }

  _onOverlayState(event, { state, requestId }) {
    if (!this._isOverlaySender(event) || requestId !== this.currentRequestId) return;
    if (state === "idle" && this.state !== "capturing") {
      this.state = "idle";
      this.currentRequestId = null;
      this.currentText = null;
      this._hideOverlay();
    }
  }

  _onOverlayAction(event, action) {
    if (!this._isOverlaySender(event)) return;
    debugLogger.info(
      "Read aloud overlay action",
      { action: typeof action === "string" ? action : action?.type, state: this.state },
      "read-aloud"
    );
    if (action === "stop") this.stop();
    else if (action === "toggle-pause") this.togglePause();
    else if (action?.type === "speed") {
      this.changeSpeed(action.direction).catch((err) =>
        debugLogger.warn("Read aloud speed change failed", { error: err.message }, "read-aloud")
      );
    }
  }

  // --- IPC --------------------------------------------------------------------

  _registerIpc() {
    ipcMain.on("tts-player:state", this._onOverlayState);
    ipcMain.on("tts-player:action", this._onOverlayAction);
    ipcMain.handle("read-aloud:get-status", () => this.getStatus());
    ipcMain.handle("read-aloud:set-config", (_event, patch) => this.setConfig(patch));
    ipcMain.handle("read-aloud:test", () => this.test());
    ipcMain.handle("read-aloud:stop", () => {
      this.stop();
      return { success: true };
    });
    ipcMain.handle("read-aloud:install-voice", async (event, voiceId) => {
      this.installing = voiceId;
      const sender = event.sender;
      try {
        await installVoice(voiceId, (progress) => {
          if (!sender.isDestroyed()) {
            sender.send("read-aloud:install-progress", { voiceId, ...progress });
          }
        });
        this.installing = null;
        const config = this.getConfig();
        if (config.enabled && !this.active) await this.start();
        else if (this.active && shareVoiceFiles(voiceId, config.voice)) {
          // The selected voice just arrived: load it now instead of on first press.
          this.voiceReady = null;
          this._preload();
        }
        return { success: true, status: this.getStatus() };
      } catch (err) {
        this.installing = null;
        debugLogger.error(
          "Read aloud voice install failed",
          { voiceId, error: err.message },
          "read-aloud"
        );
        return { success: false, error: err.message, status: this.getStatus() };
      }
    });
    ipcMain.handle("read-aloud:remove-voice", async (_event, voiceId) => {
      // Removing a voice deletes its archive directory, which another voice
      // (e.g. the other Kokoro speaker) may be using right now.
      if (shareVoiceFiles(voiceId, this.loadedVoice)) {
        this.stop();
        await this._stopWorker();
      }
      await removeVoice(voiceId);
      if (shareVoiceFiles(voiceId, this.getConfig().voice) && this.active) await this.deactivate();
      return { success: true, status: this.getStatus() };
    });
  }

  async shutdown() {
    ipcMain.removeListener("tts-player:state", this._onOverlayState);
    ipcMain.removeListener("tts-player:action", this._onOverlayAction);
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.destroy();
    await this._stopWorker();
  }
}

module.exports = ReadAloudManager;
