const path = require("path");
const fs = require("fs");
const fsPromises = require("fs/promises");
const { app } = require("electron");
const debugLogger = require("./debugLogger");
const { normalizeUiLanguage } = require("./i18nMain");
const secretCrypto = require("./secretCrypto");
const { BYOK_API_KEYS, SECRET_ENV_NAMES, NON_REF_SECRET_ENV } = require("../config/secretKeys");
const envKeyResolve = require("./envKeyResolve");
const { isEnvRef, usableSecret, envRefName, resolveEnvRef, classifySecretInput } = envKeyResolve;

// Every name EnvironmentManager encrypts and persists. SECRET_REF_NAMES (shared
// with secretKeys.js) are the credentials a $VAR field may point at and the
// login shell may fill; the rest are stored secrets that are not credentials.
const SECRET_KEYS = [...SECRET_ENV_NAMES, ...NON_REF_SECRET_ENV];
const SECRET_REF_SET = new Set(SECRET_ENV_NAMES);

const SECRET_KEY_SET = new Set(SECRET_KEYS);
const LEGACY_CLEANUP_KEY = "CUSTOM_REASONING_API_KEY";
const CLEANUP_FALLBACK_DISABLED = "CUSTOM_CLEANUP_LEGACY_FALLBACK_DISABLED";

function hasLegacyCleanupReference() {
  return SECRET_ENV_NAMES.some((name) => envRefName(process.env[name]) === LEGACY_CLEANUP_KEY);
}

function secretEnvLine(name, value) {
  const { parse } = require("dotenv");
  for (const quote of ["", "'", '"', "`"]) {
    const line = `${name}=${quote}${value}${quote}\n`;
    if (parse(line)[name] === value) return line;
  }
  throw new Error(`Cannot represent ${name} in plaintext storage`);
}

const PERSISTED_KEYS = [
  ...SECRET_KEYS,
  CLEANUP_FALLBACK_DISABLED,
  "LOCAL_TRANSCRIPTION_PROVIDER",
  "PARAKEET_MODEL",
  "DICTATION_LANGUAGE",
  "LOCAL_WHISPER_MODEL",
  "CLEANUP_PROVIDER",
  "LOCAL_CLEANUP_MODEL",
  "DICTATION_AGENT_PROVIDER",
  "LOCAL_DICTATION_AGENT_MODEL",
  "LLAMA_GPU_BACKEND",
  "LLAMA_VULKAN_ENABLED",
  "DICTATION_KEY",
  "VOICE_AGENT_KEY",
  "TRANSLATION_KEY",
  "MEETING_KEY",
  "ACTIVATION_MODE",
  "FLOATING_ICON_AUTO_HIDE",
  "PANEL_START_POSITION",
  "START_MINIMIZED",
  "UI_LANGUAGE",
  "WHISPER_CUDA_ENABLED",
  "WHISPER_VULKAN_ENABLED",
  "WHISPER_VULKAN_DEVICE",
  "WHISPER_GPU_FAILED",
  "WHISPER_GPU_FAILED_REASON_CUDA",
  "WHISPER_GPU_FAILED_REASON_VULKAN",
  "WHISPER_THREADS",
  "TRANSCRIPTION_GPU_UUID",
  "INTELLIGENCE_GPU_UUID",
  "BEDROCK_REGION",
  "BEDROCK_PROFILE",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_DEPLOYMENT",
  "AZURE_OPENAI_API_VERSION",
  "VERTEX_PROJECT",
  "VERTEX_LOCATION",
  // Written by the Settings debug toggle (set-debug-logging)
  "OPENWHISPR_LOG_LEVEL",
  // "bundled" turns off model catalog updates (Settings privacy toggle, or managed installs)
  "OPENWHISPR_MODEL_REGISTRY_MODE",
];

// Module-level so writes are serialized across all instances — hotkeyManager
// creates its own EnvironmentManager alongside the main.js singleton.
let envWriteQueue = Promise.resolve();
// Shared across EnvironmentManager instances so a second constructor cannot
// persist login-shell imports that the first one recorded.
const shellImportedSecrets = new Set();
// Counts Settings saves per secret, so a login-shell import that was already
// waiting on the shell never overwrites a key the user saved meanwhile.
const secretSaveCounts = new Map();
const pendingMigrations = new Map();
const unreadableSecrets = new Set();
// Called with the env names a login-shell import filled, so open windows that
// read their keys before the import finished can read them again.
const shellImportListeners = new Set();

class EnvironmentManager {
  constructor() {
    this._shellImportedSecrets = shellImportedSecrets;
    this.loadEnvironmentVariables();
  }

  loadEnvironmentVariables() {
    // Plain dotenv — it does not expand $VAR. A stored $OPENAI_API_KEY stays
    // a reference until _getKey / resolveSecretRef.
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

  // Encryption initializes lazily. Probing it eagerly would touch the macOS
  // Keychain before any window is visible. Migration and _loadAllSecrets are
  // both no-ops on fresh installs, so neither path triggers Keychain until
  // the user actually saves their first secret.
  async init() {
    if (!fs.existsSync(this._getMigrationSentinelPath())) {
      await this._migrateToSecureStorage();
    }
    await this._loadAllSecrets();
    // After stored secrets win: fill any still-empty keys from a login shell
    // (so ~/.zshrc exports work when launched from a desktop icon). Never
    // persist these — that would copy shell secrets into Settings. Do not
    // await: a slow rc must not gate window creation.
    this._importLoginShellSecrets().catch((error) => {
      debugLogger.error(
        "login-shell secret import failed",
        { error: error?.message || String(error) },
        "environment"
      );
    });
  }

  async _importLoginShellSecrets() {
    const savesAtStart = new Map(secretSaveCounts);
    const { imported, reason } = await envKeyResolve.importMissingSecretsFromLoginShell({
      secretNames: SECRET_ENV_NAMES.filter((name) => !unreadableSecrets.has(name)),
      env: process.env,
      importedSet: this._shellImportedSecrets,
      // Re-checked after the shell answers: a key saved in Settings meanwhile wins.
      canImport: (name) =>
        !process.env[name] &&
        !unreadableSecrets.has(name) &&
        (secretSaveCounts.get(name) || 0) === (savesAtStart.get(name) || 0),
    });
    debugLogger.info(
      "login-shell secret import",
      { reason, count: imported.length },
      "environment"
    );
    if (imported.length > 0) {
      for (const listener of shellImportListeners) {
        try {
          listener(imported);
        } catch {}
      }
    }
    return imported;
  }

  onLoginShellImport(listener) {
    shellImportListeners.add(listener);
    return () => shellImportListeners.delete(listener);
  }

  _getMigrationSentinelPath() {
    return path.join(this._getSecureKeysDir(), ".migrated");
  }

  _encryptionAvailable() {
    try {
      return secretCrypto.isAvailable();
    } catch {
      return false;
    }
  }

  _getSecureKeysDir() {
    return path.join(app.getPath("userData"), "secure-keys");
  }

  _getSecretFilePath(envVarName) {
    return path.join(this._getSecureKeysDir(), `${envVarName}.enc`);
  }

  async _loadAllSecrets() {
    await Promise.all(SECRET_KEYS.map((name) => this._loadSecretKey(name)));
  }

  async _loadSecretKey(envVarName) {
    const filePath = this._getSecretFilePath(envVarName);
    try {
      const buffer = await fsPromises.readFile(filePath);
      const { value, needsReencrypt } = secretCrypto.decrypt(buffer);
      unreadableSecrets.delete(envVarName);
      this._shellImportedSecrets.delete(envVarName);
      process.env[envVarName] = value;
      if (needsReencrypt) await this._saveSecretKey(envVarName, value);
    } catch (error) {
      if (error.code === "ENOENT") {
        unreadableSecrets.delete(envVarName);
        return;
      }
      unreadableSecrets.add(envVarName);
      debugLogger.error(
        "Failed to decrypt secret — user must re-enter",
        { key: envVarName, code: error.code, error: error.message },
        "environment"
      );
    }
  }

  _saveSecretKey(envVarName, value) {
    if (value) process.env[envVarName] = value;
    else delete process.env[envVarName];
    const filePath = this._getSecretFilePath(envVarName);
    // An upgrade copy and a user's edit can otherwise race on the same .tmp file.
    envWriteQueue = envWriteQueue
      .catch(() => {})
      .then(async () => {
        if (!value) return fsPromises.rm(filePath, { force: true });
        await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
        const tmpPath = `${filePath}.tmp`;
        await fsPromises.writeFile(tmpPath, secretCrypto.encrypt(value));
        await fsPromises.rename(tmpPath, filePath);
      });
    return envWriteQueue;
  }

  async _migrateToSecureStorage() {
    const dir = this._getSecureKeysDir();
    await fsPromises.mkdir(dir, { recursive: true });

    // Keep the original name as a reference target. Older references may still
    // be in renderer localStorage when main encrypts the profile.
    if (
      process.env[LEGACY_CLEANUP_KEY] &&
      !fs.existsSync(this._getSecretFilePath(LEGACY_CLEANUP_KEY)) &&
      !hasLegacyCleanupReference() &&
      !process.env.CUSTOM_CLEANUP_API_KEY &&
      process.env[CLEANUP_FALLBACK_DISABLED] !== "true"
    ) {
      process.env.CUSTOM_CLEANUP_API_KEY = process.env[LEGACY_CLEANUP_KEY];
    }

    const migrated = [];
    try {
      for (const name of SECRET_KEYS) {
        const file = this._getSecretFilePath(name);
        // A previous upgrade may have encrypted this slot before it stopped.
        // Verify the existing copy before trusting or replacing it.
        if (fs.existsSync(file)) {
          process.env[name] = secretCrypto.decrypt(await fsPromises.readFile(file)).value;
          continue;
        }
        const value = process.env[name];
        if (!value) continue;
        await this._saveSecretKey(name, value);
        // Round-trip verify before stripping plaintext .env.
        const buffer = await fsPromises.readFile(file);
        if (secretCrypto.decrypt(buffer).value !== value) {
          throw new Error(`round-trip verification failed for ${name}`);
        }
        migrated.push(name);
      }
    } catch (error) {
      debugLogger.error(
        "Secret migration aborted — plaintext .env preserved",
        { error: error.message, migrated },
        "environment"
      );
      return;
    }

    // Write sentinel before stripping plaintext from .env so a crash mid-rewrite is recoverable.
    await fsPromises.writeFile(this._getMigrationSentinelPath(), "");
    const envPath = path.join(app.getPath("userData"), ".env");
    if (fs.existsSync(envPath)) await this._writeEnvFileAtomic(envPath);
    debugLogger.info(
      "Migrated secrets to encrypted storage",
      { count: migrated.length },
      "environment"
    );
  }

  _writeEnvFileAtomic(envPath) {
    // Concurrent write+rename pairs share the same .env.tmp path, and the
    // loser's rename throws ENOENT (#903).
    envWriteQueue = envWriteQueue.catch(() => {}).then(() => this._writeEnvFile(envPath));
    return envWriteQueue;
  }

  _persistMigratedPlaintext(name, value) {
    const file = path.join(app.getPath("userData"), ".env");
    envWriteQueue = envWriteQueue
      .catch(() => {})
      .then(async () => {
        let content = "";
        try {
          content = await fsPromises.readFile(file, "utf8");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        // Migrating one field must preserve unrelated config and launcher-only credentials.
        if (content && !content.endsWith("\n")) content += "\n";
        const tmp = `${file}.tmp`;
        await fsPromises.writeFile(tmp, content + secretEnvLine(name, value), { mode: 0o600 });
        await fsPromises.rename(tmp, file);
      });
    return envWriteQueue;
  }

  async _writeEnvFile(envPath) {
    // Only strip plaintext secrets once migration has fully completed —
    // otherwise a partial-migration recovery can lose unencrypted secrets.
    const stripSecrets =
      this._encryptionAvailable() && fs.existsSync(this._getMigrationSentinelPath());
    let envContent = "# OpenWhispr Environment Variables\n";
    for (const key of PERSISTED_KEYS) {
      if (stripSecrets && SECRET_KEY_SET.has(key)) continue;
      if (this._shellImportedSecrets.has(key)) continue;
      if (process.env[key]) {
        const value =
          key === "SELF_HOSTED_STT_HEADERS" && !process.env[key].startsWith("base64:")
            ? `base64:${Buffer.from(process.env[key], "utf8").toString("base64")}`
            : process.env[key];
        envContent += SECRET_REF_SET.has(key) ? secretEnvLine(key, value) : `${key}=${value}\n`;
      }
    }
    const tmpPath = `${envPath}.tmp`;
    await fsPromises.writeFile(tmpPath, envContent, "utf8");
    await fsPromises.rename(tmpPath, envPath);
  }

  _getRawKey(envVarName) {
    return process.env[envVarName] || "";
  }

  getRawKey(envVarName) {
    const raw = this._getRawKey(envVarName);
    // A shell-exported reference is already safe to display. Wrapping it in
    // another reference would require two hops when the renderer uses it.
    if (this._shellImportedSecrets.has(envVarName)) {
      return isEnvRef(raw) ? raw.trim() : `$${envVarName}`;
    }
    return raw;
  }

  _cleanupCustomEnvName() {
    return process.env.CUSTOM_CLEANUP_API_KEY || process.env[CLEANUP_FALLBACK_DISABLED] === "true"
      ? "CUSTOM_CLEANUP_API_KEY"
      : LEGACY_CLEANUP_KEY;
  }

  getRawCleanupCustomKey() {
    return this.getRawKey(this._cleanupCustomEnvName());
  }

  // What a Settings field shows for `envVarName`: the stored text (a $VAR stays a
  // reference), the cleanup key's legacy alias, the headers decoded. Used to tell
  // an unedited field from a change.
  getRawFieldValue(envVarName) {
    if (envVarName === "CUSTOM_CLEANUP_API_KEY") return this.getRawCleanupCustomKey();
    if (envVarName === "SELF_HOSTED_STT_HEADERS") return this.getSelfHostedSttHeaders();
    return this.getRawKey(envVarName);
  }

  resolveSecretRef(value) {
    const raw = value || "";
    const name = envRefName(raw);
    if (name && !SECRET_REF_SET.has(name)) return "";
    return usableSecret(resolveEnvRef(raw, process.env));
  }

  _getKey(envVarName) {
    const raw = this._getRawKey(envVarName);
    // Only credential fields hold references; a region, endpoint or the headers
    // list is returned as stored, so it can never carry another secret's value.
    return SECRET_REF_SET.has(envVarName) ? this.resolveSecretRef(raw) : raw;
  }

  _saveKey(envVarName, key, migration = false) {
    const trimmed = typeof key === "string" ? key.trim() : key;
    if (migration && unreadableSecrets.has(envVarName)) {
      return { success: false, reason: "storage-unavailable" };
    }
    const pending = pendingMigrations.get(envVarName);
    if (migration && pending) {
      return pending.then((result) =>
        result.success ? { success: true, retained: this.getRawKey(envVarName) } : result
      );
    }
    if (SECRET_REF_SET.has(envVarName)) {
      const imported = this._shellImportedSecrets.has(envVarName);
      const shown = this.getRawKey(envVarName);
      const keepShown = shown && (!imported || migration === "if-empty");
      if (migration && (keepShown || secretSaveCounts.has(envVarName))) {
        return { success: true, retained: shown };
      }
      if (!migration && imported && trimmed === shown) return { success: true };
      const reason = classifySecretInput(trimmed, envVarName, SECRET_REF_SET);
      if (reason) return { success: false, reason };
    }
    const previous = process.env[envVarName];
    const version = (secretSaveCounts.get(envVarName) || 0) + 1;
    secretSaveCounts.set(envVarName, version);
    const wasImported = this._shellImportedSecrets.delete(envVarName);
    let write;
    if (SECRET_KEY_SET.has(envVarName) && this._encryptionAvailable()) {
      write = this._saveSecretKey(envVarName, key);
    } else {
      if (key) process.env[envVarName] = key;
      else delete process.env[envVarName];
      if (migration) write = this._persistMigratedPlaintext(envVarName, key);
    }
    if (migration) {
      const persisted = write
        .then(
          () => ({ success: true }),
          () => {
            if (secretSaveCounts.get(envVarName) === version) {
              // A failed upgrade write must leave its source eligible for the next attempt.
              secretSaveCounts.delete(envVarName);
              if (previous === undefined) delete process.env[envVarName];
              else process.env[envVarName] = previous;
              if (wasImported) this._shellImportedSecrets.add(envVarName);
            }
            return { success: false, reason: "storage-unavailable" };
          }
        )
        .finally(() => pendingMigrations.delete(envVarName));
      pendingMigrations.set(envVarName, persisted);
      return persisted;
    }
    write?.then(
      () => unreadableSecrets.delete(envVarName),
      (error) => {
        debugLogger.error(
          "Failed to persist encrypted secret",
          { key: envVarName, error: error.message },
          "environment"
        );
      }
    );
    return { success: true };
  }

  getCortiClientId() {
    return this._getKey("CORTI_CLIENT_ID");
  }

  saveCortiClientId(key) {
    return this._saveKey("CORTI_CLIENT_ID", key);
  }

  getCortiClientSecret() {
    return this._getKey("CORTI_CLIENT_SECRET");
  }

  saveCortiClientSecret(key) {
    return this._saveKey("CORTI_CLIENT_SECRET", key);
  }

  getSelfHostedSttHeaders() {
    const value = this._getRawKey("SELF_HOSTED_STT_HEADERS");
    return value.startsWith("base64:")
      ? Buffer.from(value.slice(7), "base64").toString("utf8")
      : value;
  }

  saveSelfHostedSttHeaders(value) {
    return this._saveKey("SELF_HOSTED_STT_HEADERS", value);
  }

  getCustomTranscriptionKey() {
    return this._getKey("CUSTOM_TRANSCRIPTION_API_KEY");
  }

  saveCustomTranscriptionKey(key) {
    return this._saveKey("CUSTOM_TRANSCRIPTION_API_KEY", key);
  }

  getCleanupCustomKey() {
    return this._getKey(this._cleanupCustomEnvName());
  }

  saveCleanupCustomKey(key) {
    const trimmed = typeof key === "string" ? key.trim() : "";
    // The field shows a shell-imported legacy alias as $CUSTOM_REASONING_API_KEY.
    // Committing it unchanged keeps the import as it is (never saved, never cleared).
    const previous = this.getRawCleanupCustomKey();
    if (
      trimmed &&
      !this._getRawKey("CUSTOM_CLEANUP_API_KEY") &&
      this._shellImportedSecrets.has(LEGACY_CLEANUP_KEY) &&
      trimmed === previous
    ) {
      return { success: true };
    }
    const result = this._saveKey("CUSTOM_CLEANUP_API_KEY", key);
    if (!result.success) return result;
    // Clearing Cleanup must not revoke another field's reference, or re-enable
    // the implicit legacy fallback when the same shell export returns on launch.
    if (!trimmed && process.env[CLEANUP_FALLBACK_DISABLED] !== "true") {
      process.env[CLEANUP_FALLBACK_DISABLED] = "true";
      this.saveAllKeysToEnvFile().catch((error) => {
        debugLogger.error("Failed to persist the cleared Cleanup setting", {
          error: error.message,
        });
      });
    }
    if (
      process.env[LEGACY_CLEANUP_KEY] &&
      !this._shellImportedSecrets.has(LEGACY_CLEANUP_KEY) &&
      !hasLegacyCleanupReference()
    ) {
      this._saveKey(LEGACY_CLEANUP_KEY, "");
    }
    return result;
  }

  // Enterprise providers — AWS Bedrock
  getBedrockRegion() {
    return this._getKey("BEDROCK_REGION");
  }
  saveBedrockRegion(value) {
    return this._saveKey("BEDROCK_REGION", value);
  }
  getBedrockProfile() {
    return this._getKey("BEDROCK_PROFILE");
  }
  saveBedrockProfile(value) {
    return this._saveKey("BEDROCK_PROFILE", value);
  }
  getBedrockAccessKeyId() {
    return this._getKey("BEDROCK_ACCESS_KEY_ID");
  }
  saveBedrockAccessKeyId(key) {
    return this._saveKey("BEDROCK_ACCESS_KEY_ID", key);
  }
  getBedrockSecretAccessKey() {
    return this._getKey("BEDROCK_SECRET_ACCESS_KEY");
  }
  saveBedrockSecretAccessKey(key) {
    return this._saveKey("BEDROCK_SECRET_ACCESS_KEY", key);
  }
  getBedrockSessionToken() {
    return this._getKey("BEDROCK_SESSION_TOKEN");
  }
  saveBedrockSessionToken(key) {
    return this._saveKey("BEDROCK_SESSION_TOKEN", key);
  }

  // Enterprise providers — Azure OpenAI
  getAzureEndpoint() {
    return this._getKey("AZURE_OPENAI_ENDPOINT");
  }
  saveAzureEndpoint(value) {
    return this._saveKey("AZURE_OPENAI_ENDPOINT", value);
  }
  getAzureApiKey() {
    return this._getKey("AZURE_OPENAI_API_KEY");
  }
  saveAzureApiKey(key) {
    return this._saveKey("AZURE_OPENAI_API_KEY", key);
  }
  getAzureDeployment() {
    return this._getKey("AZURE_OPENAI_DEPLOYMENT");
  }
  saveAzureDeployment(value) {
    return this._saveKey("AZURE_OPENAI_DEPLOYMENT", value);
  }
  getAzureApiVersion() {
    return this._getKey("AZURE_OPENAI_API_VERSION");
  }
  saveAzureApiVersion(value) {
    return this._saveKey("AZURE_OPENAI_API_VERSION", value);
  }

  // Enterprise providers — GCP Vertex AI
  getVertexProject() {
    return this._getKey("VERTEX_PROJECT");
  }
  saveVertexProject(value) {
    return this._saveKey("VERTEX_PROJECT", value);
  }
  getVertexLocation() {
    return this._getKey("VERTEX_LOCATION");
  }
  saveVertexLocation(value) {
    return this._saveKey("VERTEX_LOCATION", value);
  }
  getVertexApiKey() {
    return this._getKey("VERTEX_API_KEY");
  }
  saveVertexApiKey(key) {
    return this._saveKey("VERTEX_API_KEY", key);
  }

  getDictationKey() {
    return this._getKey("DICTATION_KEY");
  }

  saveDictationKey(key) {
    const result = this._saveKey("DICTATION_KEY", key);
    this.saveAllKeysToEnvFile().catch(() => {});
    return result;
  }

  getVoiceAgentKey() {
    const key = this._getKey("VOICE_AGENT_KEY");
    if (key) return key;
    // The chat-agent window is gone; its hotkey now opens the assistant by voice.
    const legacy = this._getKey("CHAT_AGENT_KEY");
    if (legacy) {
      this.saveVoiceAgentKey(legacy);
      delete process.env.CHAT_AGENT_KEY;
    }
    return legacy;
  }

  saveVoiceAgentKey(key) {
    const result = this._saveKey("VOICE_AGENT_KEY", key);
    this.saveAllKeysToEnvFile().catch(() => {});
    return result;
  }

  getTranslationKey() {
    return this._getKey("TRANSLATION_KEY");
  }

  saveTranslationKey(key) {
    const result = this._saveKey("TRANSLATION_KEY", key);
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

  getUiLanguage(fallbackLanguage = "") {
    const language = this._getKey("UI_LANGUAGE") || fallbackLanguage;
    return language ? normalizeUiLanguage(language) : "";
  }

  saveUiLanguage(language) {
    const normalized = normalizeUiLanguage(language);
    const result = this._saveKey("UI_LANGUAGE", normalized);
    this.saveAllKeysToEnvFile().catch(() => {});
    return { ...result, language: normalized };
  }

  async saveAllKeysToEnvFile() {
    const envPath = path.join(app.getPath("userData"), ".env");
    await this._writeEnvFileAtomic(envPath);
    require("dotenv").config({ path: envPath });
    return { success: true, path: envPath };
  }

  saveDebugLogging(enabled) {
    const logLevel = enabled ? "debug" : "info";
    const envPath = path.join(app.getPath("userData"), ".env");
    // Queue the entire read-modify-write so other saves cannot restore a stale level.
    envWriteQueue = envWriteQueue
      .catch(() => {})
      .then(async () => {
        let content = "";
        try {
          content = await fsPromises.readFile(envPath, "utf8");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }

        const lines = content.split("\n");
        const logLevelIndex = lines.findIndex((line) =>
          line.trim().startsWith("OPENWHISPR_LOG_LEVEL=")
        );
        const logLevelLine = `OPENWHISPR_LOG_LEVEL=${logLevel}`;
        if (logLevelIndex !== -1) {
          lines[logLevelIndex] = logLevelLine;
        } else {
          if (lines[lines.length - 1] !== "") lines.push("");
          lines.push(logLevelLine);
        }

        const tmpPath = `${envPath}.tmp`;
        await fsPromises.writeFile(tmpPath, lines.join("\n"), "utf8");
        await fsPromises.rename(tmpPath, envPath);
        process.env.OPENWHISPR_LOG_LEVEL = logLevel;
      });
    return envWriteQueue;
  }

  // Off keeps the app on its bundled model catalog: no cached update, no network check.
  saveModelRegistryUpdates(enabled) {
    if (enabled) {
      delete process.env.OPENWHISPR_MODEL_REGISTRY_MODE;
      return this.removeKeyFromEnvFile("OPENWHISPR_MODEL_REGISTRY_MODE");
    }
    process.env.OPENWHISPR_MODEL_REGISTRY_MODE = "bundled";
    return this._writeEnvFileAtomic(path.join(app.getPath("userData"), ".env"));
  }

  async clearAllPersistedData() {
    for (const envVarName of PERSISTED_KEYS) {
      delete process.env[envVarName];
    }
    this._shellImportedSecrets.clear();
    for (const name of SECRET_ENV_NAMES) {
      secretSaveCounts.set(name, (secretSaveCounts.get(name) || 0) + 1);
    }

    unreadableSecrets.clear();
    envWriteQueue = envWriteQueue
      .catch(() => {})
      .then(() =>
        Promise.all([
          fsPromises.rm(path.join(app.getPath("userData"), ".env"), { force: true }),
          fsPromises.rm(this._getSecureKeysDir(), { recursive: true, force: true }),
        ])
      );
    await envWriteQueue;
    return { success: true };
  }

  // Removes a single key's line from .env, preserving every other line
  // verbatim. saveAllKeysToEnvFile() would instead regenerate the file from
  // PERSISTED_KEYS, dropping hand-added lines and materializing session/shell
  // env values into the file.
  removeKeyFromEnvFile(key) {
    const envPath = path.join(app.getPath("userData"), ".env");
    envWriteQueue = envWriteQueue.catch(() => {}).then(() => this._removeKeyLine(envPath, key));
    return envWriteQueue;
  }

  async _removeKeyLine(envPath, key) {
    let content;
    try {
      content = await fsPromises.readFile(envPath, "utf8");
    } catch {
      return; // No .env — nothing to remove.
    }
    const keyLine = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
    const lines = content.split("\n");
    const kept = lines.filter((line) => !keyLine.test(line));
    if (kept.length === lines.length) return;
    const tmpPath = `${envPath}.tmp`;
    await fsPromises.writeFile(tmpPath, kept.join("\n"), "utf8");
    await fsPromises.rename(tmpPath, envPath);
  }
}

// Generate the uniform BYOK key accessors (getOpenAIKey/saveOpenAIKey/…) from
// the shared manifest so each provider is defined in exactly one place.
for (const k of BYOK_API_KEYS) {
  EnvironmentManager.prototype[k.get] = function () {
    return this._getKey(k.env);
  };
  EnvironmentManager.prototype[k.save] = function (key, migration = false) {
    return this._saveKey(k.env, key, migration);
  };
}

module.exports = EnvironmentManager;
module.exports._resetShellImportedSecrets = () => {
  shellImportedSecrets.clear();
  secretSaveCounts.clear();
  unreadableSecrets.clear();
  shellImportListeners.clear();
};
