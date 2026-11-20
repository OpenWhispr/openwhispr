const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// #3030: every store OpenWhispr keeps on this device, listed once, for the
// offboarding wipe (the WipeLocalDataOnLaunch device key, or removal from the
// managing workspace). A new store is added here (or to KEPT_USER_DATA_ENTRIES,
// with its reason); test/helpers/localDataWipe.test.js fails until it is.

const sqliteFiles = (name) => [name, `${name}-wal`, `${name}-shm`, `${name}-journal`];
const PRODUCT_EVENTS_FILE = "product-events.json";
const WIPE_STATE_FILE = "local-data-wipe.json";
// A stalled network AuditLogPath mustn't keep the fresh install from opening.
const AUDIT_FLUSH_WAIT_MS = 5000;
const auditWait = () =>
  new Promise((resolve) => setTimeout(resolve, AUDIT_FLUSH_WAIT_MS, null).unref());

const USER_DATA_ENTRIES = [
  ...sqliteFiles("transcriptions.db"),
  ...sqliteFiles("transcriptions-dev.db"),
  ...sqliteFiles("meta-activation.db"),
  "audio",
  "notes",
  "logs",
  ".env",
  ".env.tmp",
  "secure-keys",
  "auth-token.bin",
  "account-scope-binding.json",
  "affiliate-candidate.json",
  "affiliate-candidate.json.tmp",
  "workspace-policy.json",
  "managed-enterprise-config.json",
  ".system-audio-permission",
  "model-registry.json",
  "model-registry.json.tmp",
  "model-registry.json.backup",
  // A record cut short, never one of the models it lists.
  "installed-models.json.tmp",
  "paid-key-checks.json",
  PRODUCT_EVENTS_FILE,
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
// keeps the wipe to once per token. The Globe key's marker holds the system
// setting a crash left changed, which startup puts back and then deletes.
// Chromium's own files in userData are emptied through its session instead,
// never deleted under the running browser.
const KEPT_USER_DATA_ENTRIES = [
  "audit",
  "meeting-audit-session.json",
  "meeting-audit-session.json.tmp",
  WIPE_STATE_FILE,
  "globe-preference-state.json",
];
// Kept by the offboarding wipe unless WipeLocalDataIncludesModels asks;
// installed-models.json is what still lists a model the catalog dropped.
const MODEL_USER_DATA_ENTRIES = ["installed-models.json"];
const CACHE_ENTRIES = ["qdrant-data", "qdrant-data-dev", "yt-dlp"];
// The models getCacheRoot() holds (modelDirUtils' RELOCATED_SUBDIRS and the VAD
// copy whisper.js makes). OPENWHISPR_CACHE_ROOT can point that root at a folder
// other apps share, so only these are removed there.
const MODEL_CACHE_ROOT_ENTRIES = [
  "whisper-models",
  "parakeet-models",
  "diarization-models",
  "models",
  "whisper-vad",
];
const MODEL_CACHE_ENTRIES = [...MODEL_CACHE_ROOT_ENTRIES, "embedding-models"];
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
    // OpenWhispr's own cache folder, which also keeps search data and yt-dlp;
    // models follow getCacheRoot().
    homeCache: path.join(os.homedir(), ".cache", "openwhispr"),
    cacheRoot: getCacheRoot(),
    temp: unique([os.tmpdir(), getSafeTempDir()]),
    bridgeFile: getBridgeFilePath(),
    // Where clipboard.js keeps the Linux portal's paste permission.
    portalTokenFile: path.join(
      process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
      "openwhispr",
      "portal-paste-token"
    ),
  };
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

// What the note-file mirror wrote in each folder, the user's chosen ones
// included, from its record in the database (named as database.js names it).
// A database from before the mirror kept that record names no file.
function recordedMirrorFiles(userDataPath) {
  const name =
    process.env.NODE_ENV === "development" ? "transcriptions-dev.db" : "transcriptions.db";
  const databasePath = path.join(userDataPath, name);
  if (!fs.statSync(databasePath, { throwIfNoEntry: false })?.isFile()) return new Map();
  const db = new (require("better-sqlite3"))(databasePath, { readonly: true, fileMustExist: true });
  try {
    const table = "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'note_mirror_files'";
    if (!db.prepare(table).get()) return new Map();
    const rows = db
      .prepare(
        "SELECT base_path AS basePath, rel_path AS relPath, kind, content_hash AS hash FROM note_mirror_files"
      )
      .all();
    return Map.groupBy(rows, (row) => row.basePath);
  } finally {
    db.close();
  }
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

// The part of keep below target, a real folder ("" for target itself), or null.
async function keptBelow(target, keep) {
  const stat = await fs.promises.lstat(target).catch(() => null);
  if (!stat?.isDirectory()) return null;
  const below = path.relative(await fs.promises.realpath(target), keep);
  return below.startsWith("..") || path.isAbsolute(below) ? null : below;
}

// Returns each store that could not be removed, as "<name>: <reason>". An
// absolute auditLogPath inside a folder it removes stays, with the folders on
// its way.
async function removeLocalData({ includeModels, roots = defaultRoots(), auditLogPath = null }) {
  const errors = [];
  // One that stalls is a network folder, so none the wipe removes holds it.
  const keep = path.isAbsolute(auditLogPath ?? "")
    ? await Promise.race([fs.promises.realpath(auditLogPath).catch(() => null), auditWait()])
    : null;
  const remove = async (name, target) => {
    try {
      const below = keep && (await keptBelow(target, keep));
      if (below === "") return;
      if (typeof below === "string") {
        for (const child of await fs.promises.readdir(target))
          await remove(name, path.join(target, child));
        return;
      }
      await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      errors.push(`${name}: ${error.message}`);
    }
  };

  // Before the database that records them is deleted below.
  let mirrored = new Map();
  try {
    mirrored = recordedMirrorFiles(roots.userData);
  } catch (error) {
    errors.push(`notes mirror: ${error.message}`);
  }
  for (const [basePath, entries] of mirrored) {
    try {
      require("./markdownMirror").removeMirroredFiles(basePath, entries);
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
  const homeCacheEntries = [...CACHE_ENTRIES, ...(includeModels ? MODEL_CACHE_ENTRIES : [])];
  const cacheRootEntries =
    includeModels && path.resolve(roots.cacheRoot) !== path.resolve(roots.homeCache)
      ? MODEL_CACHE_ROOT_ENTRIES
      : [];
  await Promise.all([
    ...userDataEntries.map((name) => remove(name, path.join(roots.userData, name))),
    ...homeCacheEntries.map((name) => remove(name, path.join(roots.homeCache, name))),
    ...cacheRootEntries.map((name) => remove(name, path.join(roots.cacheRoot, name))),
    remove("cli-bridge.json", roots.bridgeFile),
    remove("portal-paste-token", roots.portalTokenFile),
    ...roots.temp.map((directory) => removeTempFiles(directory, remove)),
  ]);
  try {
    // The queue's interrupted writes, which carry the writer's pid.
    require("./productEvents")
      .createFileStore(path.join(roots.userData, PRODUCT_EVENTS_FILE))
      .erase();
  } catch (error) {
    errors.push(`product events: ${error.message}`);
  }
  return errors;
}

async function readDeviceSnapshot() {
  const { normalizeDeviceValues, readDeviceValues } = require("./managedDevicePolicy");
  return normalizeDeviceValues(await readDeviceValues());
}

// A running app that learns its account was removed from the workspace that
// managed this device (#3030) records it here and quits; the next launch wipes,
// before anything opens a file it removes.
function requestWorkspaceRemovalWipe(userDataPath, removal) {
  const statePath = path.join(userDataPath, WIPE_STATE_FILE);
  try {
    fs.writeFileSync(
      statePath,
      JSON.stringify({ ...readJson(statePath), pendingRemoval: removal })
    );
    return true;
  } catch (error) {
    require("./debugLogger").error("Could not record the workspace removal wipe", {
      error: error.message,
    });
    return false;
  }
}

// The notice a removal's wipe leaves for the fresh install, given once.
function takeWipeNotice(userDataPath) {
  const statePath = path.join(userDataPath, WIPE_STATE_FILE);
  const { notice, ...state } = readJson(statePath) ?? {};
  if (!notice) return null;
  try {
    fs.writeFileSync(statePath, JSON.stringify(state));
  } catch {
    /* Shown again next launch rather than never. */
  }
  return notice;
}

// Runs at launch, before the logger, database or any sidecar opens a file it
// removes. Two things ask for it: a WipeLocalDataOnLaunch token this device
// hasn't acted on, and a recorded workspace removal. Each wipes once.
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
  const statePath = path.join(userDataPath, WIPE_STATE_FILE);
  const state = readJson(statePath) ?? {};
  // Only a deployment this build reads and accepts can ask for a wipe or say
  // how one goes; a recorded removal wipes whatever the device policy says.
  // WipeLocalDataIncludesModels deployed on its own manages nothing, but still
  // says what a removal's wipe takes.
  let device = null;
  let includeModels = false;
  try {
    const snapshot = await readDevicePolicy();
    if (snapshot.status === "valid") device = snapshot;
    includeModels = snapshot.wipeLocalDataIncludesModels === true;
  } catch (error) {
    logger.warn("Device policy unreadable", { error: error.message });
  }
  const token = device?.wipeLocalDataOnLaunch ?? null;
  const newToken = token !== null && state.token !== token;
  const removal = state.pendingRemoval ?? null;
  if (!newToken && !removal) return false;

  const trigger = removal ? "workspace-removal" : "device-policy";
  logger.warn("Wiping local data", { trigger, includeModels });
  // main.js loaded .env into this process, and the relaunch inherits its
  // environment: what came from the file goes with the file. So do the saved
  // keys a relaunch or update restart carried in from the app that decrypted them.
  let loaded = {};
  try {
    loaded = require("dotenv").parse(fs.readFileSync(path.join(userDataPath, ".env")));
  } catch {
    /* No settings saved yet. */
  }
  // The open log file is in the wipe, and Windows can't delete an open file.
  logger.close();
  const errors = await removeLocalData({
    includeModels,
    roots,
    auditLogPath: device?.auditLogPath,
  });
  for (const [key, value] of Object.entries(loaded)) if (env[key] === value) delete env[key];
  for (const key of require("./environment").SECRET_KEYS) delete env[key];
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
  // Every channel on the device shares the key, but only production is the app
  // IT manages: a staging or dev build acting on the same token later must not
  // delete the key the next production user's saved keys now depend on.
  if ((env.OPENWHISPR_CHANNEL ?? "production") === "production") deleteMasterKey();

  const { createMeetingAuditLog } = require("./meetingAuditLog");
  const audit = createMeetingAuditLog({
    isEnabled: () => true,
    getConfiguredPath: () => device?.auditLogPath ?? null,
    userDataPath,
    appVersion,
    logger,
  });
  audit.localDataWiped({ trigger, incomplete: errors.length > 0 });
  if (errors.length > 0) logger.warn("Local data wipe incomplete", { errors });

  // Without this on record a relaunch would wipe again; this launch carries on
  // instead, and the next one retries. A removal leaves the fresh install its
  // notice. The record goes first: the audit line may be bound for a network
  // AuditLogPath, which is waited on only so long.
  try {
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        token: newToken ? token : state.token,
        notice: removal ? "workspace-removal" : state.notice,
      })
    );
  } catch (error) {
    logger.error("Could not record the local data wipe", { error: error.message });
    return false;
  }
  await Promise.race([audit.flush(), auditWait()]);
  return true;
}

module.exports = {
  CACHE_ENTRIES,
  KEPT_USER_DATA_ENTRIES,
  MODEL_CACHE_ENTRIES,
  MODEL_CACHE_ROOT_ENTRIES,
  MODEL_USER_DATA_ENTRIES,
  TEMP_PREFIXES,
  USER_DATA_ENTRIES,
  removeLocalData,
  requestWorkspaceRemovalWipe,
  takeWipeNotice,
  wipeLocalDataOnLaunch,
};
