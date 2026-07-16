/**
 * Persistent audio storage for meeting recordings.
 *
 * Audio is saved as WebM/Opus (via FFmpeg amix) to keep file sizes small
 * (~14 MB/hour) while remaining directly playable by Electron's Chromium renderer.
 *
 * Storage directory: {userData}/meeting-audio/
 * Filename pattern:  {noteId}-{startedAt}.webm
 */

const { app } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const { getFFmpegPath } = require("./ffmpegUtils");

let _storageDir = null;

function getStorageDir() {
  if (!_storageDir) {
    _storageDir = path.join(app.getPath("userData"), "meeting-audio");
    fs.mkdirSync(_storageDir, { recursive: true });
  }
  return _storageDir;
}

/**
 * Convert one or two raw PCM files (s16le, 24 kHz, mono) to a WebM/Opus file.
 * If both micPath and systemPath are provided they are mixed with amix (no normalisation).
 * If only one is provided it is encoded directly.
 *
 * @param {string|null} micPath     Path to mic PCM file, or null
 * @param {string|null} systemPath  Path to system audio PCM file, or null
 * @param {string}      outPath     Destination .webm file path
 * @returns {Promise<void>}
 */
function _convertToWebm(micPath, systemPath, outPath) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = getFFmpegPath();
    if (!ffmpegPath) return reject(new Error("FFmpeg not available"));

    const args = ["-y"];

    const hasMic = !!micPath && fs.existsSync(micPath) && fs.statSync(micPath).size > 0;
    const hasSys = !!systemPath && fs.existsSync(systemPath) && fs.statSync(systemPath).size > 0;

    if (!hasMic && !hasSys) return reject(new Error("No audio sources available"));

    if (hasMic) args.push("-f", "s16le", "-ar", "24000", "-ac", "1", "-i", micPath);
    if (hasSys) args.push("-f", "s16le", "-ar", "24000", "-ac", "1", "-i", systemPath);

    if (hasMic && hasSys) {
      args.push("-filter_complex", "amix=inputs=2:normalize=0");
    }

    args.push("-c:a", "libopus", "-b:a", "32k", outPath);

    debugLogger.debug("[MeetingAudio] FFmpeg convert", {
      mic: hasMic,
      system: hasSys,
      out: outPath,
    });

    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        debugLogger.warn("[MeetingAudio] FFmpeg exited with code", { code, stderr: stderr.slice(-500) });
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });
    proc.on("error", reject);
  });
}

/**
 * Save meeting audio from raw PCM temp files.
 *
 * @param {number|string} noteId
 * @param {string|null}   micPcmPath     Temp PCM file for mic audio
 * @param {string|null}   systemPcmPath  Temp PCM file for system audio
 * @returns {Promise<string|null>}  Absolute path of saved .webm, or null on failure
 */
async function saveAudio(noteId, micPcmPath, systemPcmPath) {
  try {
    const dir = getStorageDir();
    const outName = `${noteId}-${Date.now()}.webm`;
    const outPath = path.join(dir, outName);

    await _convertToWebm(micPcmPath, systemPcmPath, outPath);
    debugLogger.info("[MeetingAudio] Saved", { path: outPath });
    return outPath;
  } catch (err) {
    debugLogger.error("[MeetingAudio] saveAudio failed", { error: err.message });
    return null;
  }
}

/**
 * Return the absolute path of the .webm file for a given noteId, or null if absent.
 * @param {number|string} noteId
 */
function getAudioPath(noteId) {
  try {
    const dir = getStorageDir();
    const prefix = String(noteId) + "-";
    const files = fs.readdirSync(dir);
    const match = files.find((f) => f.startsWith(prefix) && f.endsWith(".webm"));
    return match ? path.join(dir, match) : null;
  } catch {
    return null;
  }
}

/**
 * Delete the audio file for a given noteId. Silently ignores if absent.
 * @param {number|string} noteId
 */
function deleteAudio(noteId) {
  try {
    const filePath = getAudioPath(noteId);
    if (filePath) {
      fs.unlinkSync(filePath);
      debugLogger.info("[MeetingAudio] Deleted", { path: filePath });
    }
  } catch (err) {
    debugLogger.warn("[MeetingAudio] deleteAudio failed", { error: err.message });
  }
}

/**
 * Return { fileCount, totalBytes } for the meeting-audio directory.
 */
function getStorageUsage() {
  try {
    const dir = getStorageDir();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".webm"));
    let totalBytes = 0;
    for (const f of files) {
      try { totalBytes += fs.statSync(path.join(dir, f)).size; } catch {}
    }
    return { fileCount: files.length, totalBytes };
  } catch {
    return { fileCount: 0, totalBytes: 0 };
  }
}

/**
 * Delete meeting audio files older than retentionDays. Returns { deleted, kept }.
 * @param {number} retentionDays
 */
function cleanupExpiredAudio(retentionDays) {
  try {
    const dir = getStorageDir();
    const cutoffMs = Date.now() - retentionDays * 86400000;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".webm"));
    let deleted = 0;
    let kept = 0;
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const { mtimeMs } = fs.statSync(filePath);
        if (mtimeMs < cutoffMs) {
          fs.unlinkSync(filePath);
          deleted++;
        } else {
          kept++;
        }
      } catch (err) {
        debugLogger.warn("[MeetingAudio] cleanup: could not process file", { file, error: err.message });
      }
    }
    debugLogger.info("[MeetingAudio] cleanup complete", { deleted, kept, retentionDays });
    return { deleted, kept };
  } catch (err) {
    debugLogger.error("[MeetingAudio] cleanup failed", { error: err.message });
    return { deleted: 0, kept: 0 };
  }
}

module.exports = { saveAudio, getAudioPath, deleteAudio, getStorageUsage, cleanupExpiredAudio };
