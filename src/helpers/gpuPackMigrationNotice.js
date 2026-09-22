const fs = require("fs");
const path = require("path");
const { app } = require("electron");

// The legacy-layout migration (migrateLegacyBinDir) runs before any window
// exists and can clear a GPU pack the user relied on. This sentinel carries
// the "re-download your GPU pack" notice across launches until a control
// panel window has actually shown it — a broadcast at window creation would
// be lost if the user quit first. See #1606.
const SENTINEL_FILENAME = ".gpu-pack-migration-notice";

// Launch-time orphan detection (detectOrphanedGpuPacks) finds the same
// missing pack every launch until the user re-downloads it — including after
// they saw the toast, dismissed it, and chose not to. This marker limits each
// pack to one detection-driven notice.
const FLAGGED_FILENAME = ".gpu-pack-orphan-flagged";

function getSentinelPath() {
  return path.join(app.getPath("userData"), SENTINEL_FILENAME);
}

function getFlaggedPath() {
  return path.join(app.getPath("userData"), FLAGGED_FILENAME);
}

function record(packNames) {
  if (!packNames || packNames.length === 0) return;
  const existing = read();
  const packs = [...new Set([...(existing ? existing.packs : []), ...packNames])];
  try {
    fs.writeFileSync(getSentinelPath(), JSON.stringify({ packs, ts: new Date().toISOString() }));
  } catch {
    // Best-effort: without the sentinel the user just isn't notified.
  }
}

function read() {
  try {
    const { packs } = JSON.parse(fs.readFileSync(getSentinelPath(), "utf8"));
    return Array.isArray(packs) && packs.length > 0 ? { packs } : null;
  } catch {
    return null;
  }
}

function recordOnce(packNames) {
  let flagged = [];
  try {
    const { packs } = JSON.parse(fs.readFileSync(getFlaggedPath(), "utf8"));
    if (Array.isArray(packs)) flagged = packs;
  } catch {}
  const unseen = (packNames || []).filter((name) => !flagged.includes(name));
  if (unseen.length === 0) return;
  record(unseen);
  try {
    fs.writeFileSync(getFlaggedPath(), JSON.stringify({ packs: [...flagged, ...unseen] }));
  } catch {
    // Best-effort: the user may be notified again next launch.
  }
}

function clear() {
  try {
    fs.unlinkSync(getSentinelPath());
  } catch {}
}

module.exports = { record, recordOnce, read, clear };
