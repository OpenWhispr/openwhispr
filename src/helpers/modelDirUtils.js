const { app } = require("electron");
const os = require("os");
const fs = require("fs");
const path = require("path");

// Same rule as safeTempDir: native whisper/parakeet binaries crash on Windows
// when model paths contain spaces or non-ASCII (CJK / Cyrillic profile dirs).
function pathHasProblematicChars(candidate) {
  return !/^[\x21-\x7E]*$/.test(candidate);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getAsciiSafeCacheRoot() {
  const envOverride =
    process.env.OPENWHISPR_CACHE_ROOT ||
    (process.env.XDG_CACHE_HOME ? path.join(process.env.XDG_CACHE_HOME, "openwhispr") : null);
  if (envOverride && !pathHasProblematicChars(envOverride)) {
    try {
      return ensureDir(envOverride);
    } catch {
      // fall through
    }
  }

  const fallbackBase = process.env.ProgramData || "C:\\ProgramData";
  const fallback = path.join(fallbackBase, "OpenWhispr", "cache");
  try {
    return ensureDir(fallback);
  } catch {
    const rootFallback = path.join(process.env.SystemDrive || "C:", "OpenWhispr", "cache");
    try {
      return ensureDir(rootFallback);
    } catch {
      return null;
    }
  }
}

// Only these subdirs resolve through getCacheRoot(). qdrant-data,
// embedding-models, and yt-dlp are read from the home cache directly by their
// managers (and tolerate non-ASCII paths), so they must stay put.
const RELOCATED_SUBDIRS = ["whisper-models", "parakeet-models", "diarization-models", "models"];

let migratedLegacyRoot = null;

function migrateLegacyModelDirs(legacyRoot, safeRoot) {
  if (migratedLegacyRoot === legacyRoot) return;
  migratedLegacyRoot = legacyRoot;
  for (const subdir of RELOCATED_SUBDIRS) {
    const from = path.join(legacyRoot, subdir);
    const to = path.join(safeRoot, subdir);
    try {
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      try {
        fs.renameSync(from, to);
      } catch {
        // Cross-volume move: copy to a staging dir first so an interrupted
        // copy can never be mistaken for a complete model dir.
        const staging = `${to}.migrating`;
        fs.rmSync(staging, { recursive: true, force: true });
        fs.cpSync(from, staging, { recursive: true });
        fs.renameSync(staging, to);
        fs.rmSync(from, { recursive: true, force: true });
      }
    } catch {
      // Leave the legacy copy in place; the model re-downloads if needed.
    }
  }
}

function getCacheRoot() {
  const homeDir = app?.getPath?.("home") || os.homedir();
  const homeCache = path.join(homeDir, ".cache", "openwhispr");

  if (process.platform !== "win32" || !pathHasProblematicChars(homeCache)) {
    return homeCache;
  }

  const safeRoot = getAsciiSafeCacheRoot();
  if (!safeRoot) return homeCache;
  migrateLegacyModelDirs(homeCache, safeRoot);
  return safeRoot;
}

function getModelsDirForService(service) {
  return path.join(getCacheRoot(), `${service}-models`);
}

module.exports = {
  getCacheRoot,
  getModelsDirForService,
  pathHasProblematicChars,
};
