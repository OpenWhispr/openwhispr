const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const SENTINEL_FILENAME = ".bundle-migrated";
const DISMISSED_FILENAME = ".bundle-migrated-dismissed";
const DB_FILENAMES = ["transcriptions.db", "transcriptions-dev.db"];
const DISMISS_BACKOFF_MS = 24 * 60 * 60 * 1000;

function getSentinelPath() {
  return path.join(app.getPath("userData"), SENTINEL_FILENAME);
}

function getDismissedPath() {
  return path.join(app.getPath("userData"), DISMISSED_FILENAME);
}

function isWithinDismissBackoff() {
  try {
    const raw = fs.readFileSync(getDismissedPath(), "utf8");
    const ts = Date.parse(raw.trim());
    if (Number.isNaN(ts)) return false;
    return Date.now() - ts < DISMISS_BACKOFF_MS;
  } catch {
    return false;
  }
}

function isReturningFromOldBundle() {
  if (process.platform !== "darwin") return false;
  if (fs.existsSync(getSentinelPath())) return false;
  if (isWithinDismissBackoff()) return false;
  const userData = app.getPath("userData");
  const hasDb = DB_FILENAMES.some((name) => fs.existsSync(path.join(userData, name)));
  if (!hasDb) return false;
  return fs.existsSync(path.join(userData, ".env"));
}

function markBundleMigrated() {
  try {
    fs.writeFileSync(getSentinelPath(), new Date().toISOString());
  } catch {
    // Best-effort: if userData isn't writable, modal re-shows next launch.
  }
}

function markBundleMigrationDismissed() {
  try {
    fs.writeFileSync(getDismissedPath(), new Date().toISOString());
  } catch {
    // Best-effort: if userData isn't writable, modal re-shows next launch.
  }
}

module.exports = {
  isReturningFromOldBundle,
  markBundleMigrated,
  markBundleMigrationDismissed,
};
