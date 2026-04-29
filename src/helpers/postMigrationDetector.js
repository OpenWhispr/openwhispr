const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const SENTINEL_FILENAME = ".bundle-migrated";
const DB_FILENAMES = ["transcriptions.db", "transcriptions-dev.db"];

function getSentinelPath() {
  return path.join(app.getPath("userData"), SENTINEL_FILENAME);
}

function isReturningFromOldBundle() {
  if (process.platform !== "darwin") return false;
  if (fs.existsSync(getSentinelPath())) return false;
  const userData = app.getPath("userData");
  return DB_FILENAMES.some((name) => fs.existsSync(path.join(userData, name)));
}

function markBundleMigrated() {
  try {
    fs.writeFileSync(getSentinelPath(), new Date().toISOString());
  } catch {
    // Best-effort: if userData isn't writable, modal re-shows next launch.
  }
}

module.exports = { isReturningFromOldBundle, markBundleMigrated };
