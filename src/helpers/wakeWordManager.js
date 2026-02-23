/**
 * Wake Word Manager - Voice-activated dictation toggle for OpenWhispr
 *
 * Self-contained module that creates its own WhisperServerManager instance
 * with the base model on a separate port. Audio capture is handled by the
 * renderer via MediaRecorder — the same mic stream the app already uses.
 * The renderer sends audio chunks via IPC, this module transcribes them
 * with the wake-word server, and checks for wake/finish phrases.
 */

const { BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const WhisperServerManager = require("./whisperServer");
const { getModelsDirForService } = require("./modelDirUtils");
const {
  downloadFile,
  createDownloadSignal,
  checkDiskSpace,
} = require("./downloadUtils");

const modelRegistryData = require("../models/modelRegistryData.json");

const WAKE_MODEL_NAME = "base";
const FUZZY_VARIANTS = new Map([
  ["whisper", ["whispr", "wisper", "whispar", "wispr", "whisp", "whi sper"]],
  ["computer", ["computa", "computar", "komputer"]],
  ["jarvis", ["jarv", "jarves", "jarvus"]],
  ["alexa", ["alexa", "alexia"]],
  ["hey", ["hey", "hay", "he"]],
]);

class WakeWordManager {
  constructor(windowManager) {
    this.windowManager = windowManager;
    this.serverManager = new WhisperServerManager();
    this.enabled = false;
    this.phrase = (process.env.WAKE_WORD_PHRASE || "whisper").toLowerCase().trim();
    this.finishPhrase = (process.env.WAKE_WORD_FINISH_PHRASE || "").toLowerCase().trim();
    this.cancelPhrase = (process.env.WAKE_WORD_CANCEL_PHRASE || "").toLowerCase().trim();
    this.enterPhrase = (process.env.WAKE_WORD_ENTER_PHRASE || "").toLowerCase().trim();
    this.listening = false;
    this.dictationActive = false;
    this.starting = false;
  }

  // --- Public API ---

  async toggle(enabled) {
    try {
      if (enabled) {
        await this.start();
      } else {
        this.stop();
      }
      this.enabled = enabled;
      process.env.WAKE_WORD_ENABLED = enabled ? "true" : "";
      process.env.WAKE_WORD_PHRASE = this.phrase;
      process.env.WAKE_WORD_FINISH_PHRASE = this.finishPhrase;
      process.env.WAKE_WORD_CANCEL_PHRASE = this.cancelPhrase;
      process.env.WAKE_WORD_ENTER_PHRASE = this.enterPhrase;
      return { success: true, enabled: this.enabled, phrase: this.phrase, finishPhrase: this.finishPhrase, cancelPhrase: this.cancelPhrase, enterPhrase: this.enterPhrase };
    } catch (err) {
      debugLogger.error("[WakeWord] Toggle failed", { error: err.message });
      return { success: false, error: err.message };
    }
  }

  setPhrase(phrase) {
    this.phrase = (phrase || "whisper").toLowerCase().trim();
    process.env.WAKE_WORD_PHRASE = this.phrase;
    return { success: true, phrase: this.phrase };
  }

  setFinishPhrase(phrase) {
    this.finishPhrase = (phrase || "").toLowerCase().trim();
    process.env.WAKE_WORD_FINISH_PHRASE = this.finishPhrase;
    return { success: true, finishPhrase: this.finishPhrase };
  }

  setCancelPhrase(phrase) {
    this.cancelPhrase = (phrase || "").toLowerCase().trim();
    process.env.WAKE_WORD_CANCEL_PHRASE = this.cancelPhrase;
    return { success: true, cancelPhrase: this.cancelPhrase };
  }

  setEnterPhrase(phrase) {
    this.enterPhrase = (phrase || "").toLowerCase().trim();
    process.env.WAKE_WORD_ENTER_PHRASE = this.enterPhrase;
    return { success: true, enterPhrase: this.enterPhrase };
  }

  getStatus() {
    return {
      enabled: this.enabled,
      phrase: this.phrase,
      finishPhrase: this.finishPhrase,
      cancelPhrase: this.cancelPhrase,
      enterPhrase: this.enterPhrase,
      listening: this.listening,
      dictationActive: this.dictationActive,
      serverRunning: this.serverManager.ready,
    };
  }

  /**
   * Called when recording state changes.
   */
  setRecordingState(isRecording) {
    if (!this.enabled) return;
    this.dictationActive = isRecording;
    debugLogger.debug("[WakeWord] Recording state changed", { isRecording });
  }

  /**
   * Receive an audio chunk from the renderer's MediaRecorder.
   * Transcribes it with the wake-word server and checks for the active phrase
   * (wake phrase when idle, finish phrase during dictation).
   * Returns { matched, text }.
   */
  async checkAudioChunk(audioBuffer) {
    if (!this.serverManager.ready) {
      debugLogger.debug("[WakeWord] Server not ready, skipping chunk");
      return { matched: false, text: "", skipped: "server_not_ready" };
    }

    // During dictation, check action phrases (cancel, enter, finish). When idle, check wake phrase.
    if (this.dictationActive) {
      const actionPhrases = [
        { phrase: this.cancelPhrase, action: "cancel" },
        { phrase: this.enterPhrase, action: "enter" },
        { phrase: this.finishPhrase, action: "finish" },
      ].filter(p => p.phrase);

      // During dictation without any action phrase, skip checking
      if (actionPhrases.length === 0) {
        return { matched: false, text: "" };
      }

      try {
        const result = await this.serverManager.transcribe(Buffer.from(audioBuffer), {
          language: "en",
        });

        const rawText = (result?.text || "").trim();
        const text = rawText.toLowerCase();

        const isJunk =
          !text ||
          text === "you" ||
          text === "the" ||
          text === "i" ||
          /^\[.*\]$/.test(text) ||
          /^\(.*\)$/.test(text) ||
          text.includes("[blank_audio]") ||
          text.includes("(silence)") ||
          text.includes("thank you") ||
          text.includes("thanks for watching") ||
          text.includes("subscribe");

        let matchedAction = null;
        if (!isJunk) {
          for (const { phrase, action } of actionPhrases) {
            if (this._matchesWakeWord(text, phrase)) {
              matchedAction = action;
              break;
            }
          }
        }

        const matched = matchedAction !== null;
        const mode = matchedAction || "finish";

        // Only broadcast non-silence entries to the listener log
        if (!isJunk || matched) {
          this._broadcast("wake-word:heard", {
            text: rawText,
            matched,
            phrase: matchedAction ? actionPhrases.find(p => p.action === matchedAction).phrase : actionPhrases[0].phrase,
            mode,
          });
        }

        if (matched) {
          if (matchedAction === "cancel") {
            debugLogger.info("[WakeWord] Cancel phrase detected!", { text, cancelPhrase: this.cancelPhrase });
            this._cancelDictation();
          } else if (matchedAction === "enter") {
            debugLogger.info("[WakeWord] Enter phrase detected!", { text, enterPhrase: this.enterPhrase });
            this._enterDictation();
          } else {
            debugLogger.info("[WakeWord] Finish phrase detected!", { text, finishPhrase: this.finishPhrase });
            this._stopDictation();
          }
        }

        return { matched, text: rawText };
      } catch (err) {
        debugLogger.debug("[WakeWord] checkAudioChunk error", { error: err.message });
        this._broadcast("wake-word:heard", {
          text: `[error] ${err.message}`,
          matched: false,
          phrase: actionPhrases[0].phrase,
          mode: "finish",
        });
        return { matched: false, text: "" };
      }
    }

    // Not dictating — check wake phrase
    const activePhrase = this.phrase;
    const mode = "wake";

    try {
      const result = await this.serverManager.transcribe(Buffer.from(audioBuffer), {
        language: "en",
      });

      const rawText = (result?.text || "").trim();
      const text = rawText.toLowerCase();

      const isJunk =
        !text ||
        text === "you" ||
        text === "the" ||
        text === "i" ||
        /^\[.*\]$/.test(text) ||
        /^\(.*\)$/.test(text) ||
        text.includes("[blank_audio]") ||
        text.includes("(silence)") ||
        text.includes("thank you") ||
        text.includes("thanks for watching") ||
        text.includes("subscribe");

      const matched = !isJunk && this._matchesWakeWord(text, activePhrase);

      // Only broadcast non-silence entries to the listener log
      if (!isJunk || matched) {
        this._broadcast("wake-word:heard", {
          text: rawText,
          matched,
          phrase: activePhrase,
          mode,
        });
      }

      if (matched) {
        debugLogger.info("[WakeWord] Wake word detected!", { text, phrase: this.phrase });
        this._triggerDictation();
      }

      return { matched, text: rawText };
    } catch (err) {
      debugLogger.debug("[WakeWord] checkAudioChunk error", { error: err.message });
      this._broadcast("wake-word:heard", {
        text: `[error] ${err.message}`,
        matched: false,
        phrase: activePhrase,
        mode,
      });
      return { matched: false, text: "" };
    }
  }

  // --- Server + Model Management ---

  async start() {
    if (this.listening || this.starting) return;
    this.starting = true;

    try {
      const modelPath = this._getModelPath();

      // Auto-download base model if not present
      if (!fs.existsSync(modelPath)) {
        debugLogger.info("[WakeWord] Base model not found, downloading...");
        await this._downloadModel();
      }

      if (!this.serverManager.isAvailable()) {
        throw new Error("whisper-server binary not found");
      }

      debugLogger.info("[WakeWord] Starting whisper-server with base model");
      await this.serverManager.start(modelPath, { language: "en" });
      debugLogger.info("[WakeWord] Server ready on port " + this.serverManager.port);

      this.listening = true;
    } catch (err) {
      debugLogger.error("[WakeWord] Failed to start", { error: err.message });
      throw err;
    } finally {
      this.starting = false;
    }
  }

  stop() {
    this.listening = false;
    this.dictationActive = false;
    this.serverManager.stop().catch(() => {});
    debugLogger.info("[WakeWord] Stopped");
  }

  // --- Wake Word Matching ---

  /**
   * Fuzzy match the transcribed text against a phrase.
   * Handles common Whisper mishearings for short words.
   */
  _matchesWakeWord(text, phrase) {
    phrase = phrase || this.phrase;
    const normalized = text.replace(/[.,!?]/g, "").trim();
    const words = normalized.split(/\s+/);

    // Direct whole-word match (check each word individually to avoid substring false positives)
    if (words.includes(phrase)) return true;

    // Multi-word phrase: check if the phrase appears as a contiguous subsequence at word boundaries
    if (phrase.includes(" ") && normalized.includes(phrase)) return true;

    // Check known fuzzy variants for the phrase (whole-word only)
    const variants = FUZZY_VARIANTS.get(phrase);
    if (variants) {
      for (const variant of variants) {
        if (words.includes(variant)) return true;
      }
    }

    // Levenshtein-based fuzzy match for each word (only for phrases 4+ chars to avoid false positives)
    if (phrase.length >= 4) {
      for (const word of words) {
        if (word.length >= 3 && this._levenshteinDistance(word, phrase) <= Math.max(1, Math.floor(phrase.length / 4))) {
          return true;
        }
      }
    }

    return false;
  }

  _levenshteinDistance(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        const cost = a[j - 1] === b[i - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost
        );
      }
    }
    return matrix[b.length][a.length];
  }

  // --- IPC Broadcast ---

  _broadcast(channel, payload) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    }
  }

  // --- Dictation Trigger ---

  _triggerDictation() {
    const mainWindow = this.windowManager?.mainWindow;
    if (mainWindow && !mainWindow.isDestroyed()) {
      this.windowManager.showDictationPanel();
      mainWindow.webContents.send("toggle-dictation");
    }
  }

  _stopDictation() {
    const mainWindow = this.windowManager?.mainWindow;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("stop-dictation");
    }
  }

  _cancelDictation() {
    const mainWindow = this.windowManager?.mainWindow;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("cancel-dictation");
    }
  }

  _enterDictation() {
    const mainWindow = this.windowManager?.mainWindow;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("enter-dictation");
    }
  }

  // --- Model Download ---

  _getModelPath() {
    const modelInfo = modelRegistryData.whisperModels[WAKE_MODEL_NAME];
    if (!modelInfo) throw new Error("Base model not found in registry");
    const modelsDir = getModelsDirForService("whisper");
    return path.join(modelsDir, modelInfo.fileName);
  }

  async _downloadModel() {
    const modelInfo = modelRegistryData.whisperModels[WAKE_MODEL_NAME];
    if (!modelInfo) throw new Error("Base model not found in registry");

    const modelsDir = getModelsDirForService("whisper");
    if (!fs.existsSync(modelsDir)) {
      fs.mkdirSync(modelsDir, { recursive: true });
    }

    const destPath = path.join(modelsDir, modelInfo.fileName);
    const expectedSize = modelInfo.expectedSizeBytes || modelInfo.sizeMb * 1_000_000;

    await checkDiskSpace(modelsDir, expectedSize);

    debugLogger.info("[WakeWord] Downloading base model", {
      url: modelInfo.downloadUrl,
      dest: destPath,
    });

    const signal = createDownloadSignal();
    await downloadFile(modelInfo.downloadUrl, destPath, {
      expectedSize,
      signal,
    });

    debugLogger.info("[WakeWord] Base model downloaded successfully");
  }
}

module.exports = WakeWordManager;
