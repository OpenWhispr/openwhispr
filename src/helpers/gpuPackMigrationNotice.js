const fs = require("fs");
const path = require("path");
const { app } = require("electron");

// The legacy-layout migration (migrateLegacyBinDir) runs before any window
// exists and can clear a GPU pack the user relied on. This sentinel carries
// the "re-download your GPU pack" notice across launches until a control
// panel window has actually shown it — a broadcast at window creation would
// be lost if the user quit first. See #1606.
const SENTINEL_FILENAME = ".gpu-pack-migration-notice";

function getSentinelPath() {
  return path.join(app.getPath("userData"), SENTINEL_FILENAME);
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

function clear() {
  try {
    fs.unlinkSync(getSentinelPath());
  } catch {}
}

module.exports = { record, read, clear };
