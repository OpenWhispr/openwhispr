const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AUDIO_POLICY_REFUSAL_CODES } = require("./audioPolicyRefusals");
const { LOCAL_POLICY_CODES } = require("./localModelPolicyGate");

// A local, append-only record of meeting recordings for an IT log collector
// (#3029). Meeting audio never reaches the server, and a managed device may run
// signed out, so the record lives on the device. It holds no titles, names or
// content: only when a recording started, stopped or was refused, and how.

const DAILY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
// O_NOFOLLOW doesn't exist on Windows, so there the folder's ACLs must keep other
// users from planting links. O_NONBLOCK keeps a FIFO planted there from holding
// the open, and every write queued behind it, until someone reads it.
const APPEND_FLAGS =
  fs.constants.O_WRONLY |
  fs.constants.O_APPEND |
  fs.constants.O_CREAT |
  (fs.constants.O_NOFOLLOW ?? 0) |
  (fs.constants.O_NONBLOCK ?? 0);
const KEEP_FILES = 90;
const CHECKPOINT_MS = 30_000;
const START_SOURCES = new Set([
  "hotkey",
  "tray",
  "pill",
  "prompt",
  "calendar-join",
  "record-button",
  "new-note",
]);
const STOP_REASONS = new Set([
  "user",
  "auto-end",
  "policy",
  "account-change",
  "error",
  "window-lost",
  "app-quit",
]);
// Plus the renderer's own "restricted" refusal.
const REFUSAL_REASONS = new Set([
  ...AUDIO_POLICY_REFUSAL_CODES,
  ...LOCAL_POLICY_CODES,
  "policyRestricted",
]);

const allowed = (values, value) => (values.has(value) ? value : null);
const noteIdOf = (value) => (Number.isSafeInteger(value) ? value : null);
const durationSec = (from, to) => Math.round((to - from) / 1000);

// A marker that doesn't parse or lacks what a stop line needs can't be closed
// (path.isAbsolute throws on a missing folder, which the catch counts too).
function readMarker(text) {
  try {
    const open = JSON.parse(text);
    return typeof open?.sessionId === "string" &&
      path.isAbsolute(open.dir) &&
      Number.isFinite(open.startedAt) &&
      Number.isFinite(open.lastSeenAt)
      ? open
      : null;
  } catch {
    return null;
  }
}

function currentDeviceUser() {
  try {
    return os.userInfo().username;
  } catch {
    return null;
  }
}

function createMeetingAuditLog({
  isEnabled,
  getConfiguredPath,
  userDataPath,
  appVersion,
  deviceUser = currentDeviceUser(),
  logger,
  now = Date.now,
  setInterval = global.setInterval,
  clearInterval = global.clearInterval,
}) {
  // The recording that started, kept on disk so a crash or power cut
  // mid-meeting can still be closed on the next launch.
  const markerPath = path.join(userDataPath, "meeting-audit-session.json");
  // AuditLogPath is device-wide, so OS users sharing a device each append to
  // and rotate only files named for them.
  const filePrefix = `meeting-audit-${(deviceUser || "unknown").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")}-`;
  const warned = new Set();
  let queue = Promise.resolve();
  let lastFile = null;
  let session = null;
  let checkpointTimer = null;

  // A write never blocks or fails the recording; each problem is logged once.
  const warnOnce = (message, meta) => {
    if (warned.has(message)) return;
    warned.add(message);
    logger.warn(message, meta);
  };

  const enqueue = (task) => {
    queue = queue
      .then(task)
      .catch((error) => warnOnce("Meeting audit log write failed", { error: error.message }));
  };

  function directory() {
    const configured = getConfiguredPath();
    if (configured && path.isAbsolute(configured)) return configured;
    if (configured) warnOnce("AuditLogPath is not an absolute path; using the default", {});
    return path.join(userDataPath, "audit");
  }

  // Counts only this user's own files up to today's, so names another user
  // planted in a shared folder can't push the real ones out.
  async function rotate(dir, today) {
    try {
      const files = [];
      for (const name of (await fs.promises.readdir(dir)).sort()) {
        if (!name.startsWith(filePrefix) || !DAILY_FILE.test(name.slice(filePrefix.length)))
          continue;
        if (name > today) continue;
        const stat = await fs.promises.lstat(path.join(dir, name));
        if (stat.isFile() && stat.nlink === 1 && (!process.getuid || stat.uid === process.getuid()))
          files.push(name);
      }
      await Promise.all(
        files.slice(0, -KEEP_FILES).map((name) => fs.promises.unlink(path.join(dir, name)))
      );
    } catch (error) {
      warnOnce("Meeting audit log rotation failed", { error: error.message });
    }
  }

  // Every user of a shared AuditLogPath can create files there, so a daily file
  // another user planted as a symlink or hard link to one of this user's files,
  // or as a FIFO, is refused rather than appended to.
  async function appendLine(file, line) {
    const handle = await fs.promises.open(file, APPEND_FLAGS);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid()))
        throw new Error("Not this user's own audit file");
      await handle.appendFile(line);
    } finally {
      await handle.close();
    }
  }

  async function append(dir, at, entry) {
    const ts = new Date(at).toISOString();
    const file = path.join(dir, `${filePrefix}${ts.slice(0, 10)}.jsonl`);
    await fs.promises.mkdir(dir, { recursive: true });
    await appendLine(
      file,
      `${JSON.stringify({
        ts,
        event: entry.event,
        // The renderer names the session, so only an id-shaped value is kept.
        sessionId: /^[\w-]{1,64}$/.test(entry.sessionId ?? "") ? entry.sessionId : null,
        noteId: entry.noteId ?? null,
        trigger: entry.trigger ?? null,
        reason: entry.reason ?? null,
        durationSec: entry.durationSec ?? null,
        // Filled in by participant notification (#3031) and the outside-guest
        // policy (#3025), which define them.
        participantsNotified: null,
        notificationMethod: null,
        externalAttendees: null,
        appVersion,
        deviceUser,
      })}\n`
    );
    if (file === lastFile) return;
    lastFile = file;
    await rotate(dir, path.basename(file));
  }

  // Replaced whole, so a crash mid-write never leaves a torn marker.
  async function writeMarker(open) {
    const pending = `${markerPath}.tmp`;
    await fs.promises.writeFile(pending, JSON.stringify(open));
    await fs.promises.rename(pending, markerPath);
  }

  // Closes, as of its last checkpoint, a recording the last launch never
  // stopped. Tried once: if that write fails the marker still goes, since the
  // start line already shows the recording didn't end cleanly.
  function recoverInterrupted() {
    enqueue(async () => {
      let text;
      try {
        text = await fs.promises.readFile(markerPath, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      try {
        const open = readMarker(text);
        if (!open) warnOnce("Dropped a crash marker that can't be closed", {});
        else
          await append(open.dir, open.lastSeenAt, {
            event: "recording.stopped",
            sessionId: open.sessionId,
            noteId: open.noteId,
            reason: "interrupted",
            durationSec: durationSec(open.startedAt, open.lastSeenAt),
          });
      } finally {
        await fs.promises.rm(markerPath, { force: true });
      }
    });
  }

  function recordingStarted({ sessionId, noteId, trigger }) {
    if (!isEnabled()) return;
    const startedAt = now();
    const open = {
      sessionId,
      noteId: noteIdOf(noteId),
      trigger: allowed(START_SOURCES, trigger),
      dir: directory(),
      startedAt,
      lastSeenAt: startedAt,
    };
    session = open;
    enqueue(async () => {
      await append(open.dir, startedAt, { event: "recording.started", ...open });
      await writeMarker(open);
    });
    checkpointTimer = setInterval(() => {
      const checkpoint = { ...open, lastSeenAt: now() };
      enqueue(() => writeMarker(checkpoint));
    }, CHECKPOINT_MS);
    checkpointTimer.unref?.();
  }

  // Written where its start was, even if the policy has changed since.
  function recordingStopped({ sessionId, reason }) {
    if (session?.sessionId !== sessionId) return;
    const open = session;
    session = null;
    clearInterval(checkpointTimer);
    checkpointTimer = null;
    const stoppedAt = now();
    enqueue(async () => {
      await append(open.dir, stoppedAt, {
        event: "recording.stopped",
        sessionId,
        noteId: open.noteId,
        reason: allowed(STOP_REASONS, reason),
        durationSec: durationSec(open.startedAt, stoppedAt),
      });
      await fs.promises.rm(markerPath, { force: true });
    });
  }

  return {
    recordingStarted,
    recordingStopped,
    recoverInterrupted,

    recordingRefused({ noteId, trigger, reason }) {
      if (!isEnabled()) return;
      const dir = directory();
      const at = now();
      enqueue(() =>
        append(dir, at, {
          event: "recording.refused",
          noteId: noteIdOf(noteId),
          trigger: allowed(START_SOURCES, trigger),
          reason: allowed(REFUSAL_REASONS, reason),
        })
      );
    },

    // A quit ends a live recording with the app, before its session is torn down.
    closeOpenSession() {
      if (session) recordingStopped({ sessionId: session.sessionId, reason: "app-quit" });
      return queue;
    },

    flush: () => queue,
  };
}

module.exports = { createMeetingAuditLog };
