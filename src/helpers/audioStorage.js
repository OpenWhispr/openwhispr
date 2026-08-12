const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const debugLogger = require("./debugLogger");
const { planAudioCleanup } = require("./audioRetention");

class AudioStorageManager {
  constructor() {
    this.audioDir = path.join(app.getPath("userData"), "audio");
    this.ensureAudioDir();
  }

  ensureAudioDir() {
    try {
      fs.mkdirSync(this.audioDir, { recursive: true });
    } catch (error) {
      debugLogger.error(
        "Failed to create audio directory",
        { error: error.message },
        "audio-storage"
      );
    }
  }

  _buildFilename(transcriptionId, timestamp) {
    if (timestamp) {
      const d = new Date(timestamp);
      if (!isNaN(d.getTime())) {
        const pad = (n) => String(n).padStart(2, "0");
        const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
        return `OpenWhispr-${date}-${time}-${transcriptionId}.webm`;
      }
    }
    return `OpenWhispr-${transcriptionId}.webm`;
  }

  saveAudio(transcriptionId, audioBuffer, timestamp) {
    try {
      const filename = this._buildFilename(transcriptionId, timestamp);
      const filePath = path.join(this.audioDir, filename);
      fs.writeFileSync(filePath, audioBuffer);
      debugLogger.debug(
        "Audio saved",
        { transcriptionId, filename, size: audioBuffer.length },
        "audio-storage"
      );
      return { success: true, path: filePath };
    } catch (error) {
      debugLogger.error(
        "Failed to save audio",
        { transcriptionId, error: error.message },
        "audio-storage"
      );
      return { success: false };
    }
  }

  getAudioPath(transcriptionId) {
    try {
      const files = fs.readdirSync(this.audioDir);
      const match = files.find(
        (f) => f.endsWith(`-${transcriptionId}.webm`) || f === `${transcriptionId}.webm`
      );
      if (match) return path.join(this.audioDir, match);
    } catch {}
    return null;
  }

  getAudioBuffer(transcriptionId) {
    const filePath = this.getAudioPath(transcriptionId);
    if (!filePath) return null;
    try {
      return fs.readFileSync(filePath);
    } catch (error) {
      debugLogger.error(
        "Failed to read audio",
        { transcriptionId, error: error.message },
        "audio-storage"
      );
      return null;
    }
  }

  deleteAudio(transcriptionId) {
    try {
      const filePath = this.getAudioPath(transcriptionId);
      if (filePath) {
        fs.unlinkSync(filePath);
        debugLogger.debug("Audio deleted", { transcriptionId }, "audio-storage");
      }
      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Failed to delete audio",
        { transcriptionId, error: error.message },
        "audio-storage"
      );
      return { success: false };
    }
  }

  cleanupExpiredAudio(retentionDays, databaseManager) {
    try {
      const cutoffMs = Date.now() - retentionDays * 86400000;
      const names = fs
        .readdirSync(this.audioDir)
        .filter((f) => f.endsWith(".webm") || f.endsWith(".opus"));

      const files = [];
      for (const name of names) {
        try {
          files.push({ name, mtimeMs: fs.statSync(path.join(this.audioDir, name)).mtimeMs });
        } catch (error) {
          debugLogger.error(
            "Failed to process audio file during cleanup",
            { file: name, error: error.message },
            "audio-storage"
          );
        }
      }

      // A meeting with no generated notes keeps its audio however old it is:
      // the app asks users to defer processing when memory is tight, and a
      // deferral that expires is data loss, not housekeeping.
      const plan = planAudioCleanup({
        files,
        cutoffMs,
        isMeetingUnprocessed: (noteId) => {
          const note = databaseManager?.getNote?.(noteId);
          if (!note) return false;
          return !String(note.enhanced_content || "").trim();
        },
      });

      for (const name of plan.deleteFiles) {
        try {
          fs.unlinkSync(path.join(this.audioDir, name));
        } catch (error) {
          debugLogger.error(
            "Failed to delete expired audio file",
            { file: name, error: error.message },
            "audio-storage"
          );
        }
      }

      const expiredTranscriptionIds = plan.expiredTranscriptionIds;
      const expiredNoteIds = plan.expiredNoteIds;
      const kept = plan.keptCount;

      if (plan.retainedNoteIds.size > 0) {
        debugLogger.notice(
          "Kept expired audio for meetings that were never processed",
          { noteIds: [...plan.retainedNoteIds], retentionDays },
          "audio-storage"
        );
      }

      if (expiredTranscriptionIds.length > 0 && databaseManager) {
        databaseManager.clearAudioFlags(expiredTranscriptionIds);
      }
      for (const noteId of expiredNoteIds) {
        try {
          databaseManager?.updateNote(noteId, { mic_audio_path: null, system_audio_path: null });
        } catch (_) {}
      }

      const totalDeleted = expiredTranscriptionIds.length + expiredNoteIds.size;
      debugLogger.info(
        "Audio cleanup complete",
        { deleted: totalDeleted, kept, retentionDays },
        "audio-storage"
      );
      return { deleted: totalDeleted, kept };
    } catch (error) {
      debugLogger.error("Audio cleanup failed", { error: error.message }, "audio-storage");
      return { deleted: 0, kept: 0 };
    }
  }

  deleteAllAudio() {
    try {
      const files = fs.readdirSync(this.audioDir).filter(
        (f) => f.endsWith(".webm") || f.endsWith(".opus")
      );
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(this.audioDir, file));
        } catch (error) {
          debugLogger.error(
            "Failed to delete audio file",
            { file, error: error.message },
            "audio-storage"
          );
        }
      }
      debugLogger.info("All audio deleted", { count: files.length }, "audio-storage");
      return { deleted: files.length };
    } catch (error) {
      debugLogger.error("Failed to delete all audio", { error: error.message }, "audio-storage");
      return { deleted: 0 };
    }
  }

  getStorageUsage() {
    try {
      const files = fs.readdirSync(this.audioDir).filter(
        (f) => f.endsWith(".webm") || f.endsWith(".opus")
      );
      let totalBytes = 0;
      for (const file of files) {
        try {
          const stats = fs.statSync(path.join(this.audioDir, file));
          totalBytes += stats.size;
        } catch {
          // Skip files that can't be stat'd
        }
      }
      return { fileCount: files.length, totalBytes };
    } catch (error) {
      debugLogger.error("Failed to get storage usage", { error: error.message }, "audio-storage");
      return { fileCount: 0, totalBytes: 0 };
    }
  }
}

module.exports = AudioStorageManager;
