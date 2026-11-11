const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// #3030: every store OpenWhispr keeps on this device, listed once. Reset app
// data and the device policy's offboarding wipe both remove what it names, so
// a new store is added here (or to KEPT_USER_DATA_ENTRIES, with its reason);
// test/helpers/localDataWipe.test.js fails until it is.

const sqliteFiles = (name) => [name, `${name}-wal`, `${name}-shm`];
const NOTES_MIRROR_FILE = "notes-mirror.json";
const WIPE_STATE_FILE = "local-data-wipe.json";

const USER_DATA_ENTRIES = [
  ...sqliteFiles("transcriptions.db"),
  ...sqliteFiles("transcriptions-dev.db"),
  ...sqliteFiles("meta-activation.db"),
  "audio",
  "notes",
  NOTES_MIRROR_FILE,
  "logs",
  ".env",
  "secure-keys",
  "auth-token.bin",
  "account-scope-binding.json",
  "workspace-policy.json",
  "managed-enterprise-config.json",
  "globe-preference-state.json",
  ".system-audio-permission",
  "model-registry.json",
  "model-registry.json.backup",
  "paid-key-checks.json",
  "enterprise-audio-keys",
  "enterprise-audio-bootstrap.json",
  "enterprise-audio-device-id",
  "bin",
  "llama-cpp",
  "connectors",
  "skills",
  "skill-versions",
  "sidecar-pids",
  ".bundle-migrated",
  ".bundle-migrated-dismissed",
  ".gpu-pack-migration-notice",
  ".gpu-pack-orphan-flagged",
  ".whisper-gpu-retry-version",
  ".linux-system-audio-restore-token.json",
];
// The audit trail outlives the wipe it records, and the last token acted on
// keeps the wipe to once per token. Chromium's own files in userData are
// emptied through its session instead, never deleted under the running browser.
const KEPT_USER_DATA_ENTRIES = [
  "audit",
  "meeting-audit-session.json",
  "meeting-audit-session.json.tmp",
  WIPE_STATE_FILE,
];
// Kept by the offboarding wipe unless WipeLocalDataIncludesModels asks;
// installed-models.json is what still lists a model the catalog dropped.
const MODEL_USER_DATA_ENTRIES = ["installed-models.json"];
const CACHE_ENTRIES = ["qdrant-data", "qdrant-data-dev", "yt-dlp", "portal-paste-token"];
const MODEL_CACHE_ENTRIES = [
  "whisper-models",
  "parakeet-models",
  "diarization-models",
  "models",
  "whisper-vad",
  "embedding-models",
];
const TEMP_PREFIXES = [
  "ow-",
  "openwhispr-",
  "whisper-input-",
  "whisper-output-",
  "parakeet-",
  "enterprise-buffer-",
  "enterprise-chunks-",
  "kwin-active-class-",
];

const unique = (paths) => [...new Set(paths.map((entry) => path.resolve(entry)))];

function defaultRoots() {
  const { app } = require("electron");
  const { getCacheRoot } = require("./modelDirUtils");
  const { getSafeTempDir } = require("./safeTempDir");
  const { getBridgeFilePath } = require("./cliBridge");
  return {
    userData: app.getPath("userData"),
    // Search data and yt-dlp stay in the home cache; models follow getCacheRoot().
    caches: unique([path.join(os.homedir(), ".cache", "openwhispr"), getCacheRoot()]),
    temp: unique([os.tmpdir(), getSafeTempDir()]),
    bridgeFile: getBridgeFilePath(),
  };
}

// The mirror's folder lives only in renderer storage, so main records every
// folder the mirror has written to, for a wipe that runs before any window loads.
function rememberNotesMirrorPath(basePath, userDataPath) {
  const record = path.join(userDataPath, NOTES_MIRROR_FILE);
  const basePaths = mirrorFolders(userDataPath);
  if (basePaths.includes(basePath)) return;
  try {
    fs.writeFileSync(record, JSON.stringify({ basePaths: [...basePaths, basePath] }));
  } catch (error) {
    require("./debugLogger").warn("Could not record the notes mirror folder", {
      error: error.message,
    });
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function mirrorFolders(userDataPath) {
  const basePaths = readJson(path.join(userDataPath, NOTES_MIRROR_FILE))?.basePaths;
  return Array.isArray(basePaths) ? basePaths : [];
}

async function removeTempFiles(directory, remove) {
  const names = await fs.promises.readdir(directory).catch(() => []);
  const ours = names.filter((name) => TEMP_PREFIXES.some((prefix) => name.startsWith(prefix)));
  for (const name of ours) {
    const target = path.join(directory, name);
    const stat = await fs.promises.lstat(target).catch(() => null);
    // A shared temp folder (Linux /tmp) holds other users' files too.
    if (stat && (!process.getuid || stat.uid === process.getuid())) await remove(name, target);
  }
}

// Returns each store that could not be removed, as "<name>: <reason>".
async function removeLocalData({ includeModels, roots = defaultRoots() }) {
  const errors = [];
  const remove = async (name, target) => {
    try {
      await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      errors.push(`${name}: ${error.message}`);
    }
  };

  // Before "notes" and the record of the mirror's folders are deleted below.
  for (const basePath of mirrorFolders(roots.userData)) {
    if (typeof basePath !== "string" || !path.isAbsolute(basePath)) continue;
    try {
      require("./markdownMirror").removeMirroredFiles(basePath);
    } catch (error) {
      if (error.code !== "ENOENT") errors.push(`notes mirror: ${error.message}`);
    }
  }
  try {
    await require("./enterpriseAudioBootstrap").removeClaimedBootstraps(roots.userData);
  } catch (error) {
    errors.push(`enterprise audio bootstrap: ${error.message}`);
  }

  const userDataEntries = [...USER_DATA_ENTRIES, ...(includeModels ? MODEL_USER_DATA_ENTRIES : [])];
  const cacheEntries = [...CACHE_ENTRIES, ...(includeModels ? MODEL_CACHE_ENTRIES : [])];
  await Promise.all([
    ...userDataEntries.map((name) => remove(name, path.join(roots.userData, name))),
    ...roots.caches.flatMap((root) =>
      cacheEntries.map((name) => remove(name, path.join(root, name)))
    ),
    remove("cli-bridge.json", roots.bridgeFile),
    ...roots.temp.map((directory) => removeTempFiles(directory, remove)),
  ]);
  return errors;
}

async function readDeviceSnapshot() {
  const { normalizeDeviceValues, readDeviceValues } = require("./managedDevicePolicy");
  return normalizeDeviceValues(await readDeviceValues());
}

// Runs at launch, before the logger, database or any sidecar opens a file it
// removes. A token wipes once: the next launch that sees it again does nothing.
// Resolves true when the app should relaunch into its fresh state.
async function wipeLocalDataOnLaunch({
  userDataPath,
  appVersion,
  clearBrowserData,
  roots,
  readDevicePolicy = readDeviceSnapshot,
  deleteMasterKey = () => require("./secretCrypto").deleteMasterKey(),
  disableAutoStart = () => require("./autoStart").setAutoStartEnabled(false),
  logger = require("./debugLogger"),
  env = process.env,
}) {
  let snapshot;
  try {
    snapshot = await readDevicePolicy();
  } catch (error) {
    // Only a deployment this build reads and accepts can ask for a wipe.
    logger.warn("Device policy unreadable; no local data wipe", { error: error.message });
    return false;
  }
  const token = snapshot.status === "valid" ? snapshot.wipeLocalDataOnLaunch : null;
  const statePath = path.join(userDataPath, WIPE_STATE_FILE);
  if (!token || readJson(statePath)?.token === token) return false;

  const includeModels = snapshot.wipeLocalDataIncludesModels;
  logger.warn("Wiping local data at the device policy's request", { includeModels });
  // main.js loaded .env into this process, and the relaunch inherits its
  // environment: what came from the file goes with the file.
  let loaded = {};
  try {
    loaded = require("dotenv").parse(fs.readFileSync(path.join(userDataPath, ".env")));
  } catch {
    /* No settings saved yet. */
  }
  // The open log file is in the wipe, and Windows can't delete an open file.
  logger.close();
  const errors = await removeLocalData({ includeModels, roots });
  for (const [key, value] of Object.entries(loaded)) if (env[key] === value) delete env[key];
  for (const [name, step] of [
    ["browser data", clearBrowserData],
    ["launch at login", disableAutoStart],
  ]) {
    try {
      await step();
    } catch (error) {
      errors.push(`${name}: ${error.message}`);
    }
  }
  deleteMasterKey();

  const { createMeetingAuditLog } = require("./meetingAuditLog");
  const audit = createMeetingAuditLog({
    isEnabled: () => true,
    getConfiguredPath: () => snapshot.auditLogPath,
    userDataPath,
    appVersion,
    logger,
  });
  audit.localDataWiped({ incomplete: errors.length > 0 });
  await audit.flush();
  if (errors.length > 0) logger.warn("Local data wipe incomplete", { errors });

  // Without the token on record a relaunch would wipe again; this launch
  // carries on instead, and the next one retries.
  try {
    fs.writeFileSync(statePath, JSON.stringify({ token }));
  } catch (error) {
    logger.error("Could not record the local data wipe", { error: error.message });
    return false;
  }
  return true;
}

module.exports = {
  CACHE_ENTRIES,
  KEPT_USER_DATA_ENTRIES,
  MODEL_CACHE_ENTRIES,
  MODEL_USER_DATA_ENTRIES,
  TEMP_PREFIXES,
  USER_DATA_ENTRIES,
  rememberNotesMirrorPath,
  removeLocalData,
  wipeLocalDataOnLaunch,
};
