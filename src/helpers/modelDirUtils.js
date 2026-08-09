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
    (process.env.XDG_CACHE_HOME
      ? path.join(process.env.XDG_CACHE_HOME, "openwhispr")
      : null);
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

function getCacheRoot() {
  const homeDir = app?.getPath?.("home") || os.homedir();
  const homeCache = path.join(homeDir, ".cache", "openwhispr");

  if (process.platform !== "win32" || !pathHasProblematicChars(homeCache)) {
    return homeCache;
  }

  const safeRoot = getAsciiSafeCacheRoot();
  return safeRoot || homeCache;
}

function getModelsDirForService(service) {
  return path.join(getCacheRoot(), `${service}-models`);
}

module.exports = {
  getCacheRoot,
  getModelsDirForService,
  pathHasProblematicChars,
};
