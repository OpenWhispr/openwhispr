const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const debugLogger = require("./debugLogger");

// GNOME remembers whether the user allowed the Escape cancel shortcut but can't
// be asked without showing its dialog again. Keeping the answer here lets a
// recording bind only an approved shortcut and a decline stay declined.
const FILENAME = ".gnome-cancel-shortcut-approval";
const STATES = new Set(["approved", "declined"]);

function getApprovalPath() {
  return path.join(app.getPath("userData"), FILENAME);
}

function read() {
  try {
    const state = fs.readFileSync(getApprovalPath(), "utf8").trim();
    return STATES.has(state) ? state : null;
  } catch {
    return null;
  }
}

function write(state) {
  try {
    if (STATES.has(state)) fs.writeFileSync(getApprovalPath(), state);
    else fs.rmSync(getApprovalPath(), { force: true });
  } catch (err) {
    debugLogger.warn("[GnomeCancelShortcutApproval] Failed to save approval:", err.message);
  }
}

module.exports = { read, write };
