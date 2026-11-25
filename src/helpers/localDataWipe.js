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
// Left by an MDM script (scripts/mdm) that couldn't finish this folder.
const SCRIPT_WIPE_MARKER = "local-data-wipe.pending";
// A stalled network AuditLogPath mustn't keep the app from opening.
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
// keeps the wipe to once per token. A script's marker stays until the wipe it
// asks for is done. The Globe key's marker holds the system setting a crash
// left changed, which startup puts back and then deletes.
// Chromium's own files in userData are emptied through its session instead,
// never deleted under the running browser.
const KEPT_USER_DATA_ENTRIES = [
  "audit",
  "meeting-audit-session.json",
  "meeting-audit-session.json.tmp",
  WIPE_STATE_FILE,
  `${WIPE_STATE_FILE}.tmp`,
  SCRIPT_WIPE_MARKER,
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

function defaultRoots() {
  const { app } = require("electron");
  const { getCacheRoot } = require("./modelDirUtils");
  const { getSafeTempDir } = require("./safeTempDir");
  const { getBridgeFilePath } = require("./cliBridge");
  const safeTemp = getSafeTempDir();
  return {
    userData: app.getPath("userData"),
    // OpenWhispr's own cache folder, which also keeps search data and yt-dlp;
    // models follow getCacheRoot().
    homeCache: path.join(os.homedir(), ".cache", "openwhispr"),
    cacheRoot: getCacheRoot(),
    temp: [os.tmpdir()],
    // getSafeTempDir()'s fallback on Windows, which every account there writes in.
    sharedTemp: path.resolve(safeTemp) === path.resolve(os.tmpdir()) ? [] : [safeTemp],
    // Where macOS and Linux mount removable and network drives (GNOME's under
    // /run/user/<uid>/gvfs).
    mounts:
      process.platform === "win32" ? [] : ["/Volumes", "/media", "/run/media", "/mnt", "/run/user"],
    bridgeFile: getBridgeFilePath(),
    // Where clipboard.js keeps the Linux portal's paste permission.
    portalTokenFile: path.join(
      process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
      "openwhispr",
      "portal-paste-token"
    ),
  };
}

// Replaced whole, and on disk before it replaces the last one, so a crash or
// power cut never leaves a torn or empty record.
function writeState(statePath, state) {
  const pending = `${statePath}.tmp`;
  fs.writeFileSync(pending, JSON.stringify(state), { flush: true });
  fs.renameSync(pending, statePath);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

// Named as database.js names it.
const databaseName = () =>
  process.env.NODE_ENV === "development" ? "transcriptions-dev.db" : "transcriptions.db";

// What the note-file mirror wrote in each folder, the user's chosen ones
// included, from its record in the database. A database from before the
// mirror kept that record names no file.
function recordedMirrorFiles(userDataPath) {
  const databasePath = path.join(userDataPath, databaseName());
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

async function removeTempFiles(directory, remove, { shared = false } = {}) {
  const names = await fs.promises.readdir(directory).catch(() => []);
  const ours = names.filter((name) => TEMP_PREFIXES.some((prefix) => name.startsWith(prefix)));
  for (const name of ours) {
    const target = path.join(directory, name);
    const stat = await fs.promises.lstat(target).catch(() => null);
    // A shared temp folder (Linux /tmp, or getSafeTempDir()'s on Windows) holds
    // other users' files too. Windows can't say whose a file is, so in its
    // shared folder one this user may not delete is another's.
    if (stat && (!process.getuid || stat.uid === process.getuid()))
      await remove(name, target, { othersMayOwn: shared && !process.getuid });
  }
}

// The part of keep below target, a real folder ("" for target itself), or null.
async function keptBelow(target, keep) {
  const stat = await fs.promises.lstat(target).catch(() => null);
  if (!stat?.isDirectory()) return null;
  const below = path.relative(await fs.promises.realpath(target), keep);
  return below === ".." || below.startsWith(`..${path.sep}`) || path.isAbsolute(below)
    ? null
    : below;
}

// Returns each store that could not be removed, as "<name>: <reason>". An
// absolute auditLogPath inside a folder it removes keeps its audit files, and
// the folders on their way; everything else in it goes.
async function removeLocalData({ includeModels, roots = defaultRoots(), auditLogPath = null }) {
  const { isAuditFileName } = require("./meetingAuditLog");
  const errors = [];
  // One that stalls is a network folder, so none the wipe removes holds it.
  const keep = path.isAbsolute(auditLogPath ?? "")
    ? await Promise.race([fs.promises.realpath(auditLogPath).catch(() => null), auditWait()])
    : null;
  const remove = async (name, target, { othersMayOwn = false } = {}) => {
    try {
      const below = keep && (await keptBelow(target, keep));
      if (typeof below === "string") {
        for (const child of await fs.promises.readdir(target))
          if (below !== "" || !isAuditFileName(child)) await remove(name, path.join(target, child));
        return;
      }
      await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      if (!(othersMayOwn && ["EPERM", "EACCES"].includes(error.code)))
        errors.push(`${name}: ${error.message}`);
    }
  };

  // Before the database that records them is deleted below. A recorded file
  // that didn't go, or a record that can't be read, keeps the database, so the
  // next launch's retry still knows which files are the mirror's.
  let mirrored = new Map();
  let keepDatabase = false;
  try {
    mirrored = recordedMirrorFiles(roots.userData);
  } catch (error) {
    // Named, so whoever has to delete a damaged one knows which file it is.
    errors.push(`notes mirror: ${path.join(roots.userData, databaseName())}: ${error.message}`);
    keepDatabase = true;
  }
  for (const [basePath, entries] of mirrored) {
    try {
      require("./markdownMirror").removeMirroredFiles(basePath, entries);
    } catch (error) {
      // One on a drive or share that isn't connected, whatever error that
      // gives (an unreachable Windows share isn't ENOENT), still holds its
      // notes, so it is reported, but the database still goes: kept until the
      // drive is back, which it may never be, it would keep every note here.
      // Any other notes folder that is gone took its notes with it.
      const unplugged =
        !fs.existsSync(path.parse(basePath).root) ||
        (roots.mounts.some((mount) => basePath.startsWith(`${mount}${path.sep}`)) &&
          !fs.existsSync(basePath));
      if (unplugged) {
        errors.push(`notes mirror: The notes folder ${basePath} can't be reached`);
        continue;
      }
      if (error.code === "ENOENT" && !fs.existsSync(basePath)) continue;
      errors.push(`notes mirror: ${error.message}`);
      keepDatabase = true;
    }
  }
  try {
    await require("./enterpriseAudioBootstrap").removeClaimedBootstraps(roots.userData);
  } catch (error) {
    errors.push(`enterprise audio bootstrap: ${error.message}`);
  }

  const keptDatabase = keepDatabase ? sqliteFiles(databaseName()) : [];
  const userDataEntries = [
    ...USER_DATA_ENTRIES,
    ...(includeModels ? MODEL_USER_DATA_ENTRIES : []),
  ].filter((name) => !keptDatabase.includes(name));
  const homeCacheEntries = [...CACHE_ENTRIES, ...(includeModels ? MODEL_CACHE_ENTRIES : [])];
  const cacheRootEntries =
    includeModels && path.resolve(roots.cacheRoot) !== path.resolve(roots.homeCache)
      ? MODEL_CACHE_ROOT_ENTRIES
      : [];
  await Promise.all([
    ...userDataEntries.map((name) => remove(name, path.join(roots.userData, name))),
    ...homeCacheEntries.map((name) => remove(name, path.join(roots.homeCache, name))),
    // On Windows that root is getCacheRoot()'s fallback, which every account
    // there writes in, or OPENWHISPR_CACHE_ROOT's: as in the shared temp folder,
    // a model this user may not delete is another's.
    ...cacheRootEntries.map((name) =>
      remove(name, path.join(roots.cacheRoot, name), { othersMayOwn: !process.getuid })
    ),
    remove("cli-bridge.json", roots.bridgeFile),
    remove("portal-paste-token", roots.portalTokenFile),
    ...roots.temp.map((directory) => removeTempFiles(directory, remove)),
    ...roots.sharedTemp.map((directory) => removeTempFiles(directory, remove, { shared: true })),
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

// A running app that learns its account was removed from the workspace that
// managed this device (#3030) records it here and quits; the next launch wipes,
// before anything opens a file it removes.
function requestWorkspaceRemovalWipe(userDataPath, removal) {
  const statePath = path.join(userDataPath, WIPE_STATE_FILE);
  try {
    writeState(statePath, { ...readJson(statePath), pendingRemoval: removal });
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
    writeState(statePath, state);
  } catch {
    /* Shown again next launch rather than never. */
  }
  return notice;
}

const pendingWipes = (state) => (Array.isArray(state?.pendingAudit) ? state.pendingAudit : []);

// Writes the record's wipe lines to the audit log, then drops the ones written
// from the record. A line no folder took, or one a network AuditLogPath that
// stalls hasn't taken yet (it is waited on only so long), stays for a later
// launch.
async function writeWipeAudit(
  { statePath, auditLogPath, userDataPath, appVersion, logger },
  entries
) {
  if (entries.length === 0) return;
  const { createMeetingAuditLog } = require("./meetingAuditLog");
  const audit = createMeetingAuditLog({
    isEnabled: () => true,
    getConfiguredPath: () => auditLogPath ?? null,
    userDataPath,
    appVersion,
    logger,
  });
  const written = Promise.all(entries.map((entry) => audit.localDataWiped(entry)))
    .then((delivered) => {
      // A record it can't read is left as it is, token and all.
      const state = readJson(statePath);
      const left = entries.filter((_, index) => delivered[index] !== true);
      if (state)
        writeState(statePath, { ...state, pendingAudit: left.length > 0 ? left : undefined });
    })
    .catch((error) =>
      logger.error("Could not update the local data wipe record", { error: error.message })
    );
  await Promise.race([written, auditWait()]);
}

// Runs at launch, before the logger, database or any sidecar opens a file it
// removes. Three things ask for it: a WipeLocalDataOnLaunch token this device
// hasn't acted on, a recorded workspace removal, and the marker of a script
// that couldn't finish. Each wipes until nothing is left behind, and a wipe
// that started finishes as it began, with the settings it saved. Resolves true
// when the app should relaunch into its fresh state; rejects when something
// stayed or the wipe isn't on record, and the app must not open.
async function wipeLocalDataOnLaunch({
  userDataPath,
  appVersion,
  clearBrowserData,
  roots,
  readDevicePolicy,
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
  const auditRecord = { statePath, userDataPath, appVersion, logger };
  // A token whose wipe left something behind wipes again, whatever the policy
  // reads now.
  const token = device?.wipeLocalDataOnLaunch ?? null;
  const wipeToken = token !== null && state.token !== token ? token : (state.pendingToken ?? null);
  const removal = state.pendingRemoval ?? null;
  const markerPath = path.join(userDataPath, SCRIPT_WIPE_MARKER);
  const scriptWipe = fs.existsSync(markerPath);
  const started = state.pendingSettings ?? null;
  if (!wipeToken && !removal && !scriptWipe && !started) {
    // The app opens meanwhile, however long the audit log takes.
    void writeWipeAudit(
      { ...auditRecord, auditLogPath: device?.auditLogPath },
      pendingWipes(state)
    );
    return false;
  }

  // A started wipe with nothing else pending was a marker's, which a script that
  // finished, or this wipe before its end record failed, has taken since.
  const trigger = removal ? "workspace-removal" : wipeToken ? "device-policy" : "script";
  // On record before anything goes, so a wipe cut short by a crash or a failure
  // is tried again at every launch, taking what it was asked to and keeping its
  // audit files, even once the policy can't be read. A new token is a new
  // request, with the settings deployed beside it.
  const newToken = token !== null && token !== state.token && token !== state.pendingToken;
  const settings = (!newToken && started) || {
    includeModels,
    auditLogPath: device?.auditLogPath ?? null,
  };
  const intent = { ...state, pendingToken: wipeToken ?? undefined, pendingSettings: settings };
  try {
    writeState(statePath, intent);
  } catch (error) {
    // A full disk mustn't keep the data: what asked for the wipe is still there
    // for a retry, and the end record below decides whether the app opens.
    logger.error("Could not record the local data wipe", { error: error.message });
  }
  logger.warn("Wiping local data", { trigger, includeModels: settings.includeModels });
  // main.js loaded .env into this process, and the relaunch inherits its
  // environment: what came from the file goes with the file. So do the saved
  // keys a relaunch or update restart carried in from the app that decrypted them.
  let loaded = {};
  try {
    loaded = require("dotenv").parse(fs.readFileSync(path.join(userDataPath, ".env")));
  } catch {
    /* No settings saved yet. */
  }
  // Every channel on the device shares the keyring key, but only production is
  // the app IT manages: a staging or dev build acting on the same token later
  // must not delete the key the next production user's saved keys now depend
  // on. Read before the .env values go, since .env may name the channel too.
  const production = (env.OPENWHISPR_CHANNEL ?? "production") === "production";
  // The open log file is in the wipe, and Windows can't delete an open file.
  logger.close();
  const errors = await removeLocalData({
    includeModels: settings.includeModels,
    roots,
    auditLogPath: settings.auditLogPath,
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
  if (production) deleteMasterKey();
  // The marker goes before the end record, so a crash between the two leaves
  // the saved settings for the retry.
  if (errors.length === 0) {
    try {
      fs.rmSync(markerPath, { force: true });
    } catch (error) {
      errors.push(`script marker: ${error.message}`);
    }
  }

  const incomplete = errors.length > 0;
  if (incomplete) logger.warn("Local data wipe incomplete", { errors });

  // A complete wipe goes on record, and a removal leaves the fresh install its
  // notice. An incomplete one leaves what asked for it pending, so the next
  // launch tries again; so does one whose completion isn't on record, before
  // the app opens anything a retry would remove. Either way its audit line
  // waits in the record until the audit log has it.
  const pendingAudit = [...pendingWipes(state), { trigger, incomplete, at: Date.now() }];
  try {
    writeState(
      statePath,
      incomplete
        ? { ...intent, pendingAudit }
        : {
            token: wipeToken ?? state.token,
            notice: removal ? "workspace-removal" : state.notice,
            pendingAudit,
          }
    );
  } catch (error) {
    logger.error("Could not record the local data wipe", { error: error.message });
    errors.push(`wipe record: ${error.message}`);
    pendingAudit.at(-1).incomplete = true;
  }
  await writeWipeAudit({ ...auditRecord, auditLogPath: settings.auditLogPath }, pendingAudit);
  if (errors.length > 0) throw Object.assign(new Error("Local data wipe incomplete"), { errors });
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
