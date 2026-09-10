const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const debugLogger = require("./debugLogger");

class AudioStorageManager {
  constructor(options = {}) {
    let baseDir;
    if (options.audioDir) {
      baseDir = options.audioDir;
    } else {
      try {
        baseDir = path.join(app.getPath("userData"), "audio");
      } catch {
        baseDir = path.join(process.cwd(), "audio");
      }
    }
    this.audioDir = baseDir;
    this.spoolDir = path.join(this.audioDir, "spool");
    this.ensureAudioDir();
    this.ensureSpoolDir();
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

  ensureSpoolDir() {
    try {
      fs.mkdirSync(this.spoolDir, { recursive: true });
    } catch (error) {
      debugLogger.error(
        "Failed to create audio spool directory",
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
      const files = fs.readdirSync(this.audioDir).filter((f) => f.endsWith(".webm"));
      const expiredIds = [];
      let kept = 0;

      for (const file of files) {
        const filePath = path.join(this.audioDir, file);
        try {
          const stats = fs.statSync(filePath);
          if (stats.mtimeMs < cutoffMs) {
            fs.unlinkSync(filePath);
            // Extract ID from "OpenWhispr-...-{id}.webm" or legacy "{id}.webm"
            const basename = path.basename(file, ".webm");
            const lastDash = basename.lastIndexOf("-");
            const id = lastDash !== -1 ? basename.slice(lastDash + 1) : basename;
            expiredIds.push(id);
          } else {
            kept++;
          }
        } catch (error) {
          debugLogger.error(
            "Failed to process audio file during cleanup",
            { file, error: error.message },
            "audio-storage"
          );
        }
      }

      if (expiredIds.length > 0 && databaseManager) {
        databaseManager.clearAudioFlags(expiredIds);
      }

      debugLogger.info(
        "Audio cleanup complete",
        { deleted: expiredIds.length, kept, retentionDays },
        "audio-storage"
      );
      return { deleted: expiredIds.length, kept };
    } catch (error) {
      debugLogger.error("Audio cleanup failed", { error: error.message }, "audio-storage");
      return { deleted: 0, kept: 0 };
    }
  }

  deleteAllAudio() {
    try {
      const files = fs.readdirSync(this.audioDir).filter((f) => f.endsWith(".webm"));
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
      try {
        if (fs.existsSync(this.spoolDir)) {
          const spoolFiles = fs.readdirSync(this.spoolDir);
          for (const file of spoolFiles) {
            try {
              fs.unlinkSync(path.join(this.spoolDir, file));
            } catch {}
          }
        }
      } catch {}
      debugLogger.info("All audio deleted", { count: files.length }, "audio-storage");
      return { deleted: files.length };
    } catch (error) {
      debugLogger.error("Failed to delete all audio", { error: error.message }, "audio-storage");
      return { deleted: 0 };
    }
  }

  getStorageUsage() {
    try {
      const files = fs.readdirSync(this.audioDir).filter((f) => f.endsWith(".webm"));
      let totalBytes = 0;
      for (const file of files) {
        try {
          const stats = fs.statSync(path.join(this.audioDir, file));
          totalBytes += stats.size;
        } catch {
          // Skip files that can't be stat'd
        }
      }
      try {
        if (fs.existsSync(this.spoolDir)) {
          const spoolFiles = fs.readdirSync(this.spoolDir);
          for (const file of spoolFiles) {
            try {
              const stats = fs.statSync(path.join(this.spoolDir, file));
              totalBytes += stats.size;
            } catch {}
          }
        }
      } catch {}
      return { fileCount: files.length, totalBytes };
    } catch (error) {
      debugLogger.error("Failed to get storage usage", { error: error.message }, "audio-storage");
      return { fileCount: 0, totalBytes: 0 };
    }
  }

  startRecordingSpool(sessionId, mimeType = "audio/webm") {
    if (!sessionId) return { success: false, error: "Missing sessionId" };
    try {
      this.ensureSpoolDir();
      const manifestPath = path.join(this.spoolDir, `${sessionId}.json`);
      const audioPath = path.join(this.spoolDir, `${sessionId}.webm`);
      const manifest = {
        sessionId,
        startedAt: new Date().toISOString(),
        mimeType: mimeType || "audio/webm",
        audioFile: `${sessionId}.webm`,
      };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
      fs.writeFileSync(audioPath, Buffer.alloc(0));
      debugLogger.debug("Started recording spool", { sessionId, mimeType }, "audio-storage");
      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Failed to start recording spool",
        { sessionId, error: error.message },
        "audio-storage"
      );
      return { success: false, error: error.message };
    }
  }

  appendRecordingSpoolChunk(sessionId, chunk) {
    if (!sessionId || !chunk) return { success: false, error: "Missing parameters" };
    try {
      const audioPath = path.join(this.spoolDir, `${sessionId}.webm`);
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      fs.appendFileSync(audioPath, buffer);
      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Failed to append recording spool chunk",
        { sessionId, error: error.message },
        "audio-storage"
      );
      return { success: false, error: error.message };
    }
  }

  finishRecordingSpool(sessionId) {
    if (!sessionId) return { success: false, error: "Missing sessionId" };
    try {
      const manifestPath = path.join(this.spoolDir, `${sessionId}.json`);
      const audioPath = path.join(this.spoolDir, `${sessionId}.webm`);
      if (fs.existsSync(manifestPath)) {
        fs.unlinkSync(manifestPath);
      }
      if (fs.existsSync(audioPath)) {
        fs.unlinkSync(audioPath);
      }
      debugLogger.debug("Finished recording spool", { sessionId }, "audio-storage");
      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Failed to finish recording spool",
        { sessionId, error: error.message },
        "audio-storage"
      );
      return { success: false, error: error.message };
    }
  }

  recoverOrphanedRecordings(databaseManager) {
    if (!databaseManager) {
      debugLogger.warn(
        "Cannot recover orphaned recordings without databaseManager",
        {},
        "audio-storage"
      );
      return [];
    }

    try {
      this.ensureSpoolDir();
      const files = fs.readdirSync(this.spoolDir);
      const manifestFiles = files.filter((f) => f.endsWith(".json"));
      const recovered = [];
      const MIN_RECOVERABLE_BYTES = 1024;

      for (const manifestFile of manifestFiles) {
        const manifestPath = path.join(this.spoolDir, manifestFile);
        let manifest = null;
        try {
          const content = fs.readFileSync(manifestPath, "utf8");
          manifest = JSON.parse(content);
        } catch (readErr) {
          debugLogger.warn(
            "Corrupt spool manifest file, deleting",
            { manifestFile, error: readErr.message },
            "audio-storage"
          );
          try {
            fs.unlinkSync(manifestPath);
          } catch {}
          continue;
        }

        const sessionId = manifest?.sessionId || path.basename(manifestFile, ".json");
        const audioFile = manifest?.audioFile || `${sessionId}.webm`;
        const audioPath = path.join(this.spoolDir, audioFile);

        let audioStats = null;
        try {
          if (fs.existsSync(audioPath)) {
            audioStats = fs.statSync(audioPath);
          }
        } catch (statErr) {
          debugLogger.warn(
            "Failed to stat spooled audio file",
            { audioFile, error: statErr.message },
            "audio-storage"
          );
        }

        if (!audioStats || audioStats.size < MIN_RECOVERABLE_BYTES) {
          debugLogger.info(
            "Discarding incomplete or empty spooled recording",
            { sessionId, size: audioStats?.size || 0 },
            "audio-storage"
          );
          try {
            if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
            if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
          } catch {}
          continue;
        }

        try {
          const audioBuffer = fs.readFileSync(audioPath);
          const startedAtMs = manifest.startedAt
            ? new Date(manifest.startedAt).getTime()
            : audioStats.birthtimeMs || Date.now();
          const durationMs =
            audioStats.mtimeMs > startedAtMs ? audioStats.mtimeMs - startedAtMs : null;

          const saveResult = databaseManager.saveTranscription("", null, {
            status: "failed",
            errorMessage: "Recording recovered after unexpected app shutdown",
            errorCode: "CRASH_RECOVERY",
            clientTranscriptionId: sessionId,
          });

          if (saveResult?.id) {
            const audioSaveResult = this.saveAudio(saveResult.id, audioBuffer, startedAtMs);
            if (audioSaveResult.success) {
              databaseManager.updateTranscriptionAudio(saveResult.id, {
                hasAudio: 1,
                audioDurationMs: durationMs ? Math.round(durationMs) : null,
                provider: null,
                model: null,
              });

              const item = databaseManager.getTranscriptionById(saveResult.id);
              if (item) {
                recovered.push(item);
              }
              debugLogger.info(
                "Successfully recovered orphaned recording",
                { id: saveResult.id, sessionId, size: audioBuffer.length, durationMs },
                "audio-storage"
              );
            }
          }

          try {
            if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
            if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
          } catch {}
        } catch (recoveryErr) {
          debugLogger.error(
            "Failed to recover orphaned recording",
            { sessionId, error: recoveryErr.message },
            "audio-storage"
          );
        }
      }

      // Clean up any dangling .webm files in spool without a manifest
      for (const file of files) {
        if (file.endsWith(".webm")) {
          const matchingManifest = path.join(this.spoolDir, `${path.basename(file, ".webm")}.json`);
          if (!fs.existsSync(matchingManifest)) {
            try {
              fs.unlinkSync(path.join(this.spoolDir, file));
            } catch {}
          }
        }
      }

      return recovered;
    } catch (error) {
      debugLogger.error(
        "Error during orphaned recordings recovery",
        { error: error.message },
        "audio-storage"
      );
      return [];
    }
  }
}

module.exports = AudioStorageManager;
