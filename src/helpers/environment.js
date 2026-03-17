const path = require("path");
const fs = require("fs");
const fsPromises = require("fs/promises");
const { app } = require("electron");
const { normalizeUiLanguage } = require("./i18nMain");

const PERSISTED_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "CUSTOM_TRANSCRIPTION_API_KEY",
  "CUSTOM_REASONING_API_KEY",
  "LOCAL_TRANSCRIPTION_PROVIDER",
  "PARAKEET_MODEL",
  "LOCAL_WHISPER_MODEL",
  "REASONING_PROVIDER",
  "LOCAL_REASONING_MODEL",
  "LLAMA_GPU_BACKEND",
  "LLAMA_VULKAN_ENABLED",
  "DICTATION_KEY",
  "AGENT_KEY",
  "MEETING_KEY",
  "ACTIVATION_MODE",
  "FLOATING_ICON_AUTO_HIDE",
  "START_MINIMIZED",
  "UI_LANGUAGE",
  "WHISPER_CUDA_ENABLED",
];

class EnvironmentManager {
  constructor() {
    this.loadEnvironmentVariables();
  }

  loadEnvironmentVariables() {
    // App config (.env in userData) takes precedence over system env vars,
    // so keys saved by the user in Settings always win.
    const userDataEnv = path.join(app.getPath("userData"), ".env");
    try {
      if (fs.existsSync(userDataEnv)) {
        require("dotenv").config({ path: userDataEnv, override: true });
      }
    } catch {}

    const fallbackPaths = [
      path.join(__dirname, "..", "..", ".env"), // Development
      path.join(process.resourcesPath, ".env"),
      path.join(process.resourcesPath, "app.asar.unpacked", ".env"),
      path.join(process.resourcesPath, "app", ".env"), // Legacy
    ];

    for (const envPath of fallbackPaths) {
      try {
        if (fs.existsSync(envPath)) {
          require("dotenv").config({ path: envPath });
        }
      } catch {}
    }
  }

  _getKey(envVarName) {
    return process.env[envVarName] || "";
  }

  _saveKey(envVarName, key) {
    process.env[envVarName] = key;
    return { success: true };
  }

  getOpenAIKey() {
    return this._getKey("OPENAI_API_KEY");
  }

  saveOpenAIKey(key) {
    return this._saveKey("OPENAI_API_KEY", key);
  }

  getAnthropicKey() {
    return this._getKey("ANTHROPIC_API_KEY");
  }

  saveAnthropicKey(key) {
    return this._saveKey("ANTHROPIC_API_KEY", key);
  }

  getGeminiKey() {
    return this._getKey("GEMINI_API_KEY");
  }

  saveGeminiKey(key) {
    return this._saveKey("GEMINI_API_KEY", key);
  }

  getGroqKey() {
    return this._getKey("GROQ_API_KEY");
  }

  saveGroqKey(key) {
    return this._saveKey("GROQ_API_KEY", key);
  }

  getMistralKey() {
    return this._getKey("MISTRAL_API_KEY");
  }

  saveMistralKey(key) {
    return this._saveKey("MISTRAL_API_KEY", key);
  }

  getCustomTranscriptionKey() {
    return this._getKey("CUSTOM_TRANSCRIPTION_API_KEY");
  }

  saveCustomTranscriptionKey(key) {
    return this._saveKey("CUSTOM_TRANSCRIPTION_API_KEY", key);
  }

  getCustomReasoningKey() {
    return this._getKey("CUSTOM_REASONING_API_KEY");
  }

  saveCustomReasoningKey(key) {
    return this._saveKey("CUSTOM_REASONING_API_KEY", key);
  }

  getDictationKey() {
    return this._getKey("DICTATION_KEY");
  }

  saveDictationKey(key) {
    const result = this._saveKey("DICTATION_KEY", key);
    this.saveAllKeysToEnvFile().catch(() => {});
    return result;
  }

  getAgentKey() {
    return this._getKey("AGENT_KEY");
  }

  saveAgentKey(key) {
    const result = this._saveKey("AGENT_KEY", key);
    this.saveAllKeysToEnvFile().catch(() => {});
    return result;
  }

  getMeetingKey() {
    return this._getKey("MEETING_KEY");
  }

  saveMeetingKey(key) {
    const result = this._saveKey("MEETING_KEY", key);
    this.saveAllKeysToEnvFile().catch(() => {});
    return result;
  }

  getActivationMode() {
    const mode = this._getKey("ACTIVATION_MODE");
    return mode === "push" ? "push" : "tap";
  }

  saveActivationMode(mode) {
    const validMode = mode === "push" ? "push" : "tap";
    const result = this._saveKey("ACTIVATION_MODE", validMode);
    this.saveAllKeysToEnvFile().catch(() => {});
    return result;
  }

  getFloatingIconAutoHide() {
    return this._getKey("FLOATING_ICON_AUTO_HIDE") === "true";
  }

  saveFloatingIconAutoHide(enabled) {
    const result = this._saveKey("FLOATING_ICON_AUTO_HIDE", String(enabled));
    this.saveAllKeysToEnvFile().catch(() => {});
    return result;
  }

  getStartMinimized() {
    return this._getKey("START_MINIMIZED") === "true";
  }

  saveStartMinimized(enabled) {
    const result = this._saveKey("START_MINIMIZED", String(enabled));
    this.saveAllKeysToEnvFile().catch(() => {});
    return result;
  }

  getPanelStartPosition() {
    const v = this._getKey("PANEL_START_POSITION");
    if (v === "bottom-right" || v === "center" || v === "bottom-left") return v;
    return "bottom-right";
  }

  savePanelStartPosition(position) {
    const result = this._saveKey("PANEL_START_POSITION", position);
    this.saveAllKeysToEnvFile().catch(() => {});
    return result;
  }

  getUiLanguage() {
    return normalizeUiLanguage(this._getKey("UI_LANGUAGE"));
  }

  saveUiLanguage(language) {
    const normalized = normalizeUiLanguage(language);
    const result = this._saveKey("UI_LANGUAGE", normalized);
    this.saveAllKeysToEnvFile().catch(() => {});
    return { ...result, language: normalized };
  }

  async createProductionEnvFile(apiKey) {
    const envPath = path.join(app.getPath("userData"), ".env");

    const envContent = `# OpenWhispr Environment Variables
# This file was created automatically for production use
OPENAI_API_KEY=${apiKey}
`;

    await fsPromises.writeFile(envPath, envContent, "utf8");
    require("dotenv").config({ path: envPath });

    return { success: true, path: envPath };
  }

  async saveAllKeysToEnvFile() {
    const envPath = path.join(app.getPath("userData"), ".env");

    let envContent = "# OpenWhispr Environment Variables\n";

    for (const key of PERSISTED_KEYS) {
      if (process.env[key]) {
        envContent += `${key}=${process.env[key]}\n`;
      }
    }

    await fsPromises.writeFile(envPath, envContent, "utf8");
    require("dotenv").config({ path: envPath });

    return { success: true, path: envPath };
  }
}

module.exports = EnvironmentManager;
