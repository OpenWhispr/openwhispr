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
// Outside the ciphertext so no old password, whatever its contents, can be
// confused with a reference record after decryption.
const REFERENCE_RECORD = Buffer.from("OpenWhispr/credential-reference/v1\0");
const CLEARED_RECORD = Buffer.from("OpenWhispr/cleared-credential/v1\0");
const legacyLiteralSecrets = new Map();

function refProfileKey(name) {
  return `OPENWHISPR_REF_${name}`;
}

function profileHasReference(profile, name) {
  const target = envRefName(profile[name]);
  return !!target && profile[refProfileKey(name)] === target;
}

function rememberStoredCredential(name, value, reference) {
  if (!reference && SECRET_REF_SET.has(name) && isEnvRef(value)) {
    legacyLiteralSecrets.set(name, value);
  } else {
    legacyLiteralSecrets.delete(name);
  }
}

function isLegacyLiteral(name, value) {
  return typeof value === "string" && legacyLiteralSecrets.get(name) === value;
}

function isCredentialReference(name, value) {
  return SECRET_REF_SET.has(name) && isEnvRef(value) && !isLegacyLiteral(name, value);
}

function decryptStoredCredential(buffer) {
  if (buffer.equals(CLEARED_RECORD)) return { cleared: true, value: "", reference: false };
  const reference = buffer.subarray(0, REFERENCE_RECORD.length).equals(REFERENCE_RECORD);
  return {
    ...secretCrypto.decrypt(reference ? buffer.subarray(REFERENCE_RECORD.length) : buffer),
    reference,
  };
}

function hasLegacyCleanupReference() {
  return SECRET_ENV_NAMES.some(
    (name) =>
      !isLegacyLiteral(name, process.env[name]) &&
      envRefName(process.env[name]) === LEGACY_CLEANUP_KEY
  );
}

function secretEnvLine(name, value) {
  const { parse } = require("dotenv");
  for (const quote of ["", "'", '"', "`"]) {
    const line = `${name}=${quote}${value}${quote}\n`;
    if (parse(line)[name] === value) return line;
  }
  throw new Error(`Cannot represent ${name} in plaintext storage`);
}

function profileCredentialLines(name, value, reference) {
  const line = secretEnvLine(name, value);
  return reference ? line + `${refProfileKey(name)}=${envRefName(value)}\n` : line;
}

// Match complete dotenv assignments so a lookalike line inside another field's
// quoted multiline value stays intact.
const PROFILE_ASSIGNMENT =
  /^[ \t]*(?:export[ \t]+)?([\w.-]+)[ \t]*(?:=[ \t]*|:[ \t]+)(?:'(?:\\'|[^'])*'|"(?:\\"|[^"])*"|\x60(?:\\\x60|[^\x60])*\x60|[^\r\n]*)[^\r\n]*(?:\r?\n|$)/gm;

function replaceProfileCredential(content, name, value, reference) {
  const fields = new Set([name, refProfileKey(name)]);
  const cleanup = !value && name === "CUSTOM_CLEANUP_API_KEY";
  if (cleanup) fields.add(CLEANUP_FALLBACK_DISABLED);
  let retained = content.replace(PROFILE_ASSIGNMENT, (assignment, field) =>
    fields.has(field) ? "" : assignment
  );
  if (cleanup || value) {
    if (retained && !retained.endsWith("\n")) retained += "\n";
    retained += value
      ? profileCredentialLines(name, value, reference)
      : CLEANUP_FALLBACK_DISABLED + "=true\n";
  }
  return retained;
}

async function readProfileEnv(file) {
  try {
    return require("dotenv").parse(await fsPromises.readFile(file));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeEncryptedFile(file, value, verify = false, reference = false) {
  if (!value) return fsPromises.rm(file, { force: true });
  await fsPromises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    const ciphertext = secretCrypto.encrypt(value);
    await fsPromises.writeFile(
      tmp,
      reference ? Buffer.concat([REFERENCE_RECORD, ciphertext]) : ciphertext
    );
    if (verify) {
      const saved = decryptStoredCredential(await fsPromises.readFile(tmp));
      if (saved.value !== value || saved.reference !== reference) {
        throw new Error("Encrypted credential failed round-trip verification");
      }
    }
    await fsPromises.rename(tmp, file);
  } catch (error) {
    await fsPromises.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
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
const pendingSecretSaves = new Map();
const pendingEncryptedWrites = new Map();
const clearedSecrets = new Set();
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
        const { parsed = {} } = require("dotenv").config({ path: userDataEnv, override: true });
        for (const name of SECRET_ENV_NAMES) {
          if (Object.hasOwn(parsed, name)) {
            rememberStoredCredential(name, parsed[name], profileHasReference(parsed, name));
          }
        }
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
    const fallback = fs.existsSync(this._getMigrationSentinelPath())
      ? undefined
      : await this._migrateToSecureStorage();
    await this._loadAllSecrets(fallback);
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
      secretNames: SECRET_ENV_NAMES.filter(
        (name) => !unreadableSecrets.has(name) && !clearedSecrets.has(name)
      ),
      env: process.env,
      importedSet: this._shellImportedSecrets,
      // Re-checked after the shell answers: a key saved in Settings meanwhile wins.
      canImport: (name) =>
        !process.env[name] &&
        !unreadableSecrets.has(name) &&
        !clearedSecrets.has(name) &&
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

  _loadAllSecrets(fallback = new Map()) {
    const versions = new Map(secretSaveCounts);
    envWriteQueue = envWriteQueue
      .catch(() => {})
      .then(() =>
        Promise.all(
          SECRET_KEYS.map((name) =>
            this._loadSecretKey(name, versions.get(name), fallback.get(name))
          )
        )
      );
    return envWriteQueue;
  }

  async _loadSecretKey(envVarName, version, fallback) {
    const filePath = this._getSecretFilePath(envVarName);
    try {
      const buffer = await fsPromises.readFile(filePath);
      const { value, needsReencrypt, reference, cleared } = decryptStoredCredential(buffer);
      if (version !== secretSaveCounts.get(envVarName)) return;
      unreadableSecrets.delete(envVarName);
      if (cleared) {
        // Only a subsequent Settings save can supersede a clear. A launcher
        // variable, login shell or an old renderer mirror is not a replacement.
        if (!version) {
          delete process.env[envVarName];
          const profile = await readProfileEnv(path.join(app.getPath("userData"), ".env"));
          if (version !== secretSaveCounts.get(envVarName)) return;
          if (profile[envVarName]) process.env[envVarName] = profile[envVarName];
          rememberStoredCredential(
            envVarName,
            profile[envVarName],
            profileHasReference(profile, envVarName)
          );
        }
        if (process.env[envVarName]) clearedSecrets.delete(envVarName);
        else clearedSecrets.add(envVarName);
        this._shellImportedSecrets.delete(envVarName);
        if (!secretSaveCounts.has(envVarName)) secretSaveCounts.set(envVarName, 0);
        return;
      }
      clearedSecrets.delete(envVarName);
      this._shellImportedSecrets.delete(envVarName);
      const selected = fallback && fallback.version === version ? fallback : { value, reference };
      process.env[envVarName] = selected.value;
      rememberStoredCredential(envVarName, selected.value, selected.reference);
      if (needsReencrypt && selected.value === value && selected.reference === reference) {
        await writeEncryptedFile(filePath, value, true, reference).catch((error) => {
          debugLogger.error(
            "Failed to update credential encryption",
            { key: envVarName, code: error.code },
            "environment"
          );
        });
      }
    } catch (error) {
      if (version !== secretSaveCounts.get(envVarName)) return;
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

  _saveSecretKey(envVarName, value, reference = false) {
    if (value) process.env[envVarName] = value;
    else delete process.env[envVarName];
    const filePath = this._getSecretFilePath(envVarName);
    // An upgrade copy and a user's edit can otherwise race on the same .tmp file.
    envWriteQueue = envWriteQueue
      .catch(() => {})
      .then(() => writeEncryptedFile(filePath, value, false, reference));
    const write = envWriteQueue;
    pendingEncryptedWrites.set(envVarName, write);
    const settled = () => {
      if (pendingEncryptedWrites.get(envVarName) === write)
        pendingEncryptedWrites.delete(envVarName);
    };
    write.then(settled, settled);
    return write;
  }

  _migrateToSecureStorage() {
    const versions = new Map(secretSaveCounts);
    envWriteQueue = envWriteQueue.catch(() => {}).then(() => this._migrateProfileSecrets(versions));
    return envWriteQueue;
  }

  async _migrateProfileSecrets(versions) {
    const dir = this._getSecureKeysDir();
    const envPath = path.join(app.getPath("userData"), ".env");
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
      if (isLegacyLiteral(LEGACY_CLEANUP_KEY, process.env[LEGACY_CLEANUP_KEY])) {
        rememberStoredCredential("CUSTOM_CLEANUP_API_KEY", process.env[LEGACY_CLEANUP_KEY], false);
      }
    }

    const fallback = new Map();
    let failed = false;
    let count = 0;
    let profile;
    try {
      profile = await readProfileEnv(envPath);
    } catch (error) {
      debugLogger.error(
        "Could not read profile for secret migration",
        { code: error.code },
        "environment"
      );
      return;
    }
    for (const name of SECRET_KEYS) {
      try {
        if (versions.get(name) !== secretSaveCounts.get(name)) continue;
        const file = this._getSecretFilePath(name);
        let value = profile[name] || process.env[name];
        let reference = profile[name]
          ? profileHasReference(profile, name)
          : isCredentialReference(name, value);
        if (fs.existsSync(file)) {
          // Before migration completes, the profile's plaintext is still where
          // earlier releases saved user edits. An inherited variable has no such precedence.
          const encrypted = decryptStoredCredential(await fsPromises.readFile(file));
          if (versions.get(name) !== secretSaveCounts.get(name)) continue;
          if (encrypted.cleared && !profile[name]) {
            if (!versions.get(name)) delete process.env[name];
            continue;
          }
          if (!profile[name]) {
            value = encrypted.value;
            reference = encrypted.reference;
          }
          process.env[name] = value;
          rememberStoredCredential(name, value, reference);
          if (value === encrypted.value && reference === encrypted.reference) continue;
        }
        if (!value) continue;
        rememberStoredCredential(name, value, reference);
        await writeEncryptedFile(file, value, true, reference);
        count++;
      } catch (error) {
        failed = true;
        if (profile[name])
          fallback.set(name, {
            value: profile[name],
            reference: profileHasReference(profile, name),
            version: versions.get(name),
          });
        debugLogger.error(
          "Could not migrate credential; profile preserved",
          { key: name, code: error.code },
          "environment"
        );
      }
    }
    if (failed) return fallback;

    // Write sentinel before stripping plaintext from .env so a crash mid-rewrite is recoverable.
    await fsPromises.writeFile(this._getMigrationSentinelPath(), "");
    if (fs.existsSync(envPath)) await this._writeEnvFile(envPath);
    debugLogger.info("Migrated secrets to encrypted storage", { count }, "environment");
  }

  _persistLockedCredential(name, value, reference) {
    const slot = this._getSecretFilePath(name);
    const profile = path.join(app.getPath("userData"), ".env");
    const replaceProfile = async (content) => {
      await fsPromises.writeFile(profile + ".tmp", content, { mode: 0o600 });
      await fsPromises.rename(profile + ".tmp", profile);
    };
    envWriteQueue = envWriteQueue
      .catch(() => {})
      .then(async () => {
        let original;
        try {
          original = await fsPromises.readFile(profile, "utf8");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const retained = replaceProfileCredential(original ?? "", name, value, reference);
        let changed = false;
        try {
          await fsPromises.mkdir(path.dirname(slot), { recursive: true });
          await fsPromises.writeFile(slot + ".tmp", CLEARED_RECORD, { mode: 0o600 });
          if (retained !== (original ?? "")) {
            await replaceProfile(retained);
            changed = true;
          }
          await fsPromises.rename(slot + ".tmp", slot);
        } catch (error) {
          if (changed) {
            if (original === undefined) await fsPromises.rm(profile, { force: true });
            else await replaceProfile(original);
          }
          throw error;
        } finally {
          await Promise.all(
            [slot, profile].map((file) =>
              fsPromises.rm(file + ".tmp", { force: true }).catch(() => {})
            )
          );
        }
      });
    return envWriteQueue;
  }

  _writeEnvFileAtomic(envPath) {
    // Concurrent write+rename pairs share the same .env.tmp path, and the
    // loser's rename throws ENOENT (#903).
    envWriteQueue = envWriteQueue.catch(() => {}).then(() => this._writeEnvFile(envPath));
    return envWriteQueue;
  }

  _persistMigratedPlaintext(name, value, reference) {
    const file = path.join(app.getPath("userData"), ".env");
    envWriteQueue = envWriteQueue
      .catch(() => {})
      .then(async () => {
        if (fs.existsSync(this._getSecretFilePath(name))) {
          throw new Error("Cannot seed over an existing encrypted credential");
        }
        let content = "";
        try {
          content = await fsPromises.readFile(file, "utf8");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        // Migrating one field must preserve unrelated config and launcher-only credentials.
        if (content && !content.endsWith("\n")) content += "\n";
        if (
          !reference &&
          isEnvRef(value) &&
          require("dotenv").parse(content)[refProfileKey(name)]
        ) {
          content += `${refProfileKey(name)}=\n`;
        }
        const tmp = `${file}.tmp`;
        await fsPromises.writeFile(tmp, content + profileCredentialLines(name, value, reference), {
          mode: 0o600,
        });
        await fsPromises.rename(tmp, file);
      });
    return envWriteQueue;
  }

  async _writeEnvFile(envPath) {
    // Only strip plaintext secrets once migration has fully completed —
    // otherwise a partial-migration recovery can lose unencrypted secrets.
    const stripSecrets =
      this._encryptionAvailable() && fs.existsSync(this._getMigrationSentinelPath());
    const keepPlaintext = new Map();
    if (stripSecrets) {
      // A vault can recover after an already-migrated profile used plaintext
      // fallback. Verify each saved slot before discarding that fallback.
      const profile = await readProfileEnv(envPath);
      for (const name of SECRET_KEYS) {
        if (!profile[name] || (!process.env[name] && secretSaveCounts.has(name))) continue;
        const file = this._getSecretFilePath(name);
        const reference = profileHasReference(profile, name);
        try {
          if (fs.existsSync(file)) {
            const encrypted = decryptStoredCredential(await fsPromises.readFile(file));
            // A completed migration normally uses the encrypted slot. If Settings
            // still uses the fallback, that is the value to secure before stripping it.
            if (
              (encrypted.value === profile[name] && encrypted.reference === reference) ||
              process.env[name] !== profile[name] ||
              isCredentialReference(name, process.env[name]) !== reference
            ) {
              continue;
            }
          }
          await writeEncryptedFile(file, profile[name], true, reference);
        } catch (error) {
          // Keep this field for another attempt while allowing other preferences to save.
          keepPlaintext.set(name, profileCredentialLines(name, profile[name], reference));
          debugLogger.warn(
            "Could not secure profile credential",
            { key: name, code: error.code },
            "environment"
          );
        }
      }
    }
    let envContent = "# OpenWhispr Environment Variables\n";
    for (const key of PERSISTED_KEYS) {
      if (stripSecrets && SECRET_KEY_SET.has(key)) {
        if (keepPlaintext.has(key)) envContent += keepPlaintext.get(key);
        continue;
      }
      if (this._shellImportedSecrets.has(key)) continue;
      if (process.env[key]) {
        const value =
          key === "SELF_HOSTED_STT_HEADERS" && !process.env[key].startsWith("base64:")
            ? `base64:${Buffer.from(process.env[key], "utf8").toString("base64")}`
            : process.env[key];
        envContent += SECRET_REF_SET.has(key)
          ? profileCredentialLines(key, value, isCredentialReference(key, value))
          : `${key}=${value}\n`;
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
    // A field marker can travel through a renderer that only understands
    // references. Main knows this slot contains an old, literal password.
    if (isLegacyLiteral(envVarName, raw)) return `$${envVarName}`;
    // A shell-exported reference is already safe to display. Wrapping it in
    // another reference would require two hops when the renderer uses it.
    if (this._shellImportedSecrets.has(envVarName)) {
      return isEnvRef(raw) ? raw.trim() : `$${envVarName}`;
    }
    return raw;
  }

  _cleanupCustomEnvName() {
    const current = "CUSTOM_CLEANUP_API_KEY";
    if (process.env[CLEANUP_FALLBACK_DISABLED] === "true" || unreadableSecrets.has(current)) {
      return current;
    }
    const legacyConfigured =
      !this._shellImportedSecrets.has(LEGACY_CLEANUP_KEY) &&
      (process.env[LEGACY_CLEANUP_KEY] || unreadableSecrets.has(LEGACY_CLEANUP_KEY));
    if (this._shellImportedSecrets.has(current) && legacyConfigured) return LEGACY_CLEANUP_KEY;
    return process.env[current] ? current : LEGACY_CLEANUP_KEY;
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
    if (name && isLegacyLiteral(name, process.env[name])) return process.env[name];
    return usableSecret(resolveEnvRef(raw, process.env));
  }

  _getKey(envVarName) {
    const raw = this._getRawKey(envVarName);
    if (isLegacyLiteral(envVarName, raw)) return raw;
    // Only credential fields hold references; a region, endpoint or the headers
    // list is returned as stored, so it can never carry another secret's value.
    return SECRET_REF_SET.has(envVarName) ? this.resolveSecretRef(raw) : raw;
  }

  _saveKey(envVarName, key, migration = false) {
    const trimmed = typeof key === "string" ? key.trim() : key;
    const previous = process.env[envVarName];
    const wasLiteral = isLegacyLiteral(envVarName, previous);
    let literal = false;
    const pending = pendingSecretSaves.get(envVarName);
    if (migration && pending) {
      return pending.promise.then((result) =>
        result.success ? { success: true, retained: this.getRawKey(envVarName) } : result
      );
    }
    if (migration && unreadableSecrets.has(envVarName)) {
      return { success: false, reason: "storage-unavailable" };
    }
    const previousVersion = secretSaveCounts.get(envVarName);
    if (!migration && !key && pending?.clear && pending.version === previousVersion) {
      return pending.promise;
    }
    if (SECRET_REF_SET.has(envVarName)) {
      const imported = this._shellImportedSecrets.has(envVarName);
      const shown = this.getRawKey(envVarName);
      const keepShown = shown && (!imported || migration === "if-empty");
      if (migration && (keepShown || secretSaveCounts.has(envVarName))) {
        return { success: true, retained: shown };
      }
      if (!migration && (imported || wasLiteral) && trimmed === shown) return { success: true };
      if (isEnvRef(trimmed)) {
        const source = envRefName(trimmed);
        // A legacy password in the seed's source field is copied. A reference
        // that field explicitly made to another slot must keep following it.
        literal = migration === true;
        if (migration === "if-empty" && isLegacyLiteral(source, process.env[source])) {
          const copyOwnMarker =
            (envVarName === "DICTATION_AGENT_CUSTOM_API_KEY" &&
              source === "CHAT_AGENT_CUSTOM_API_KEY") ||
            (envVarName === "OPENROUTER_API_KEY" && source === this._cleanupCustomEnvName());
          if (copyOwnMarker) {
            key = process.env[source];
            literal = true;
          }
        }
        if (!literal) {
          const reason = classifySecretInput(trimmed, envVarName, SECRET_REF_SET);
          if (reason) return { success: false, reason };
        }
      }
    }
    const reference = SECRET_REF_SET.has(envVarName) && isEnvRef(key) && !literal;
    rememberStoredCredential(envVarName, key, reference);
    const version = (previousVersion || 0) + 1;
    secretSaveCounts.set(envVarName, version);
    const wasImported = this._shellImportedSecrets.delete(envVarName);
    const encrypted = SECRET_KEY_SET.has(envVarName) && this._encryptionAvailable();
    const lockedSlot = (name) =>
      unreadableSecrets.has(name) ||
      (!encrypted &&
        (pendingEncryptedWrites.has(name) ||
          clearedSecrets.has(name) ||
          fs.existsSync(this._getSecretFilePath(name))));
    const cleanup = envVarName === "CUSTOM_CLEANUP_API_KEY";
    const lockedEdit =
      !migration &&
      SECRET_KEY_SET.has(envVarName) &&
      (lockedSlot(envVarName) || (!key && cleanup && lockedSlot(LEGACY_CLEANUP_KEY)));
    const lockedClear = lockedEdit && !key;
    const wasCleared = clearedSecrets.has(envVarName);
    const previousFallbackFlag = process.env[CLEANUP_FALLBACK_DISABLED];
    let write;
    if (lockedClear) {
      delete process.env[envVarName];
      clearedSecrets.add(envVarName);
      if (cleanup) process.env[CLEANUP_FALLBACK_DISABLED] = "true";
      write = this._persistLockedCredential(envVarName, "", false);
    } else if (lockedEdit && (!encrypted || reference)) {
      // The stored slot must point to this fallback even if the vault reopens
      // before the renderer's next ordinary settings-file flush.
      process.env[envVarName] = key;
      write = this._persistLockedCredential(envVarName, key, reference);
    } else if (encrypted) {
      write = this._saveSecretKey(envVarName, key, reference);
    } else {
      if (key) process.env[envVarName] = key;
      else delete process.env[envVarName];
      if (migration) write = this._persistMigratedPlaintext(envVarName, key, reference);
    }
    if (migration || lockedEdit) {
      const transaction = { version, clear: lockedClear };
      const predecessor = pending?.version === previousVersion ? pending : undefined;
      const restorePrevious = () => {
        if (previousVersion === undefined) secretSaveCounts.delete(envVarName);
        else secretSaveCounts.set(envVarName, previousVersion);
        if (wasCleared && !(predecessor && previous)) clearedSecrets.add(envVarName);
        else clearedSecrets.delete(envVarName);
        if (cleanup) {
          if (previousFallbackFlag === undefined) delete process.env[CLEANUP_FALLBACK_DISABLED];
          else process.env[CLEANUP_FALLBACK_DISABLED] = previousFallbackFlag;
        }
        if (previous === undefined) delete process.env[envVarName];
        else process.env[envVarName] = previous;
        rememberStoredCredential(envVarName, previous, !wasLiteral);
        if (wasImported) this._shellImportedSecrets.add(envVarName);
        else this._shellImportedSecrets.delete(envVarName);
        if (predecessor) unreadableSecrets.delete(envVarName);
      };
      transaction.promise = write
        .then(
          () => {
            if (lockedEdit && secretSaveCounts.get(envVarName) === version) {
              unreadableSecrets.delete(envVarName);
              if (key) clearedSecrets.delete(envVarName);
            }
            if (lockedClear && !wasCleared) return { success: true, stored: "" };
            return literal ? { success: true, stored: `$${envVarName}` } : { success: true };
          },
          () => {
            // A preceding edit may also have failed while this edit was pending.
            // Restore the most recent durable state, skipping any failed edits.
            transaction.rollback = predecessor?.rollback ?? restorePrevious;
            if (secretSaveCounts.get(envVarName) === version) {
              transaction.rollback();
              if (lockedEdit) {
                return {
                  success: false,
                  reason: "storage-unavailable",
                  retained: this.getRawFieldValue(envVarName),
                };
              }
            }
            return { success: false, reason: "storage-unavailable" };
          }
        )
        .finally(() => {
          if (pendingSecretSaves.get(envVarName) === transaction)
            pendingSecretSaves.delete(envVarName);
        });
      pendingSecretSaves.set(envVarName, transaction);
      return transaction.promise;
    }
    write?.then(
      () => {
        if (secretSaveCounts.get(envVarName) === version) {
          unreadableSecrets.delete(envVarName);
          if (key) clearedSecrets.delete(envVarName);
        }
      },
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

  saveCustomTranscriptionKey(key, migration = false) {
    return this._saveKey("CUSTOM_TRANSCRIPTION_API_KEY", key, migration);
  }

  getCleanupCustomKey() {
    return this._getKey(this._cleanupCustomEnvName());
  }

  saveCleanupCustomKey(key, migration = false) {
    const trimmed = typeof key === "string" ? key.trim() : "";
    if (migration) {
      if (pendingSecretSaves.has("CUSTOM_CLEANUP_API_KEY")) {
        return this._saveKey("CUSTOM_CLEANUP_API_KEY", key, migration);
      }
      if (this._cleanupCustomEnvName() === LEGACY_CLEANUP_KEY) {
        if (unreadableSecrets.has(LEGACY_CLEANUP_KEY)) {
          return { success: false, reason: "storage-unavailable" };
        }
        if (
          process.env[LEGACY_CLEANUP_KEY] &&
          (migration === "if-empty" || !this._shellImportedSecrets.has(LEGACY_CLEANUP_KEY))
        ) {
          return { success: true, retained: this.getRawCleanupCustomKey() };
        }
      }
      if (
        process.env[CLEANUP_FALLBACK_DISABLED] === "true" &&
        (!process.env.CUSTOM_CLEANUP_API_KEY ||
          this._shellImportedSecrets.has("CUSTOM_CLEANUP_API_KEY"))
      ) {
        return { success: true, retained: this.getRawCleanupCustomKey() };
      }
      return this._saveKey("CUSTOM_CLEANUP_API_KEY", key, migration);
    }
    // An unchanged legacy field should not replace a separate shell export
    // under the canonical name or remove the legacy value referenced elsewhere.
    if (
      trimmed &&
      this._cleanupCustomEnvName() === LEGACY_CLEANUP_KEY &&
      trimmed === this.getRawCleanupCustomKey()
    ) {
      return { success: true };
    }
    const result = this._saveKey("CUSTOM_CLEANUP_API_KEY", key);
    // A locked clear commits the legacy opt-out. An unreadable profile may
    // still have other fields that explicitly reference the old key.
    if (result instanceof Promise || !result.success) return result;
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
      if (SECRET_REF_SET.has(envVarName)) delete process.env[refProfileKey(envVarName)];
    }
    this._shellImportedSecrets.clear();
    legacyLiteralSecrets.clear();
    clearedSecrets.clear();
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
  legacyLiteralSecrets.clear();
  secretSaveCounts.clear();
  unreadableSecrets.clear();
  clearedSecrets.clear();
  shellImportListeners.clear();
};
