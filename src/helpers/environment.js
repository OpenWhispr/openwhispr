const path = require("path");
const fs = require("fs");
const { app } = require("electron");

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
  "DICTATION_KEY",
  "ACTIVATION_MODE",
];

class EnvironmentManager {
  constructor() {
    this.loadEnvironmentVariables();
  }

  loadEnvironmentVariables() {
    // Loaded in priority order — dotenv won't override, so first file wins per variable
    const possibleEnvPaths = [
      path.join(app.getPath("userData"), ".env"),
      path.join(__dirname, "..", "..", ".env"), // Development
      path.join(process.resourcesPath, ".env"),
      path.join(process.resourcesPath, "app.asar.unpacked", ".env"),
      path.join(process.resourcesPath, "app", ".env"), // Legacy
    ];

    for (const envPath of possibleEnvPaths) {
      try {
        if (fs.existsSync(envPath)) {
          require("dotenv").config({ path: envPath });
        }
      } catch (error) {}
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
    this.saveAllKeysToEnvFile();
    return result;
  }

  getActivationMode() {
    const mode = this._getKey("ACTIVATION_MODE");
    return mode === "push" ? "push" : "tap";
  }

  saveActivationMode(mode) {
    const validMode = mode === "push" ? "push" : "tap";
    const result = this._saveKey("ACTIVATION_MODE", validMode);
    this.saveAllKeysToEnvFile();
    return result;
  }

  createProductionEnvFile(apiKey) {
    const envPath = path.join(app.getPath("userData"), ".env");

    const envContent = `# OpenWhispr Environment Variables
# This file was created automatically for production use
OPENAI_API_KEY=${apiKey}
`;

    fs.writeFileSync(envPath, envContent, "utf8");
    require("dotenv").config({ path: envPath });

    return { success: true, path: envPath };
  }

  saveAllKeysToEnvFile() {
    const envPath = path.join(app.getPath("userData"), ".env");

    let envContent = "# OpenWhispr Environment Variables\n";

    for (const key of PERSISTED_KEYS) {
      if (process.env[key]) {
        envContent += `${key}=${process.env[key]}\n`;
      }
    }

    fs.writeFileSync(envPath, envContent, "utf8");
    require("dotenv").config({ path: envPath });

    return { success: true, path: envPath };
  }
}

module.exports = EnvironmentManager;
