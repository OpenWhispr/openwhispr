const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { finished } = require("stream/promises");

const DEFAULTS = Object.freeze({ keepOriginalAudio: true, retentionDays: 0 });
function validateSettings(value) {
  if (
    typeof value?.keepOriginalAudio !== "boolean" ||
    !Number.isInteger(value.retentionDays) ||
    ![0, 7, 30, 90, 365].includes(value.retentionDays)
  ) {
    throw new Error("Invalid meeting audio retention settings");
  }
  return { keepOriginalAudio: value.keepOriginalAudio, retentionDays: value.retentionDays };
}
function wavHeader(bytes) {
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(bytes + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(bytes, 40);
  return header;
}
class MeetingAudioStorage {
  constructor(root, onError = () => {}) {
    this.root = root;
    this.onError = onError;
    this.active = null;
    fs.mkdirSync(root, { recursive: true });
    this.settings = { ...DEFAULTS };
    try {
      this.settings = validateSettings(
        JSON.parse(fs.readFileSync(path.join(root, "settings.json"), "utf8"))
      );
    } catch (error) {
      if (error.code !== "ENOENT") this.onError(error);
    }
  }
  saveJson(file, data) {
    const temporary = file + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
    fs.renameSync(temporary, file);
  }
  setSettings(value) {
    const settings = validateSettings(value);
    this.saveJson(path.join(this.root, "settings.json"), settings);
    this.settings = settings;
    // Apply changes to subsequent recordings; never truncate a live capture.
    return settings;
  }
  start(noteId) {
    if (this.active) throw new Error("A meeting audio recording is still active");
    this.cleanup();
    if (!this.settings.keepOriginalAudio || !Number.isSafeInteger(noteId) || noteId < 1) return;
    const id = randomUUID();
    const directory = path.join(this.root, id);
    fs.mkdirSync(directory);
    const manifest = { id, noteId, createdAt: Date.now(), tracks: [], error: null };
    this.saveJson(path.join(directory, "recording.json"), manifest);
    this.active = { directory, manifest, tracks: new Map() };
  }
  append(source, pcm, capturedAt = Date.now()) {
    const recording = this.active;
    if (!recording || recording.manifest.error || !["mic", "system"].includes(source)) return;
    try {
      if (pcm.length % 2) throw new Error("Invalid PCM sample alignment");
      let track = recording.tracks.get(source);
      if (!track) {
        const file = path.join(recording.directory, source + ".wav");
        const stream = fs.createWriteStream(file, { flags: "wx" });
        track = { stream, file, bytes: 0 };
        recording.tracks.set(source, track);
        stream.on("error", (error) => this.fail(recording, error));
        stream.write(wavHeader(0));
        recording.manifest.tracks.push({
          source,
          startedAt: Number.isFinite(capturedAt) ? capturedAt : Date.now(),
        });
        this.saveJson(path.join(recording.directory, "recording.json"), recording.manifest);
      }
      if (track.stream.writableLength > 8 * 1024 * 1024 || track.bytes + pcm.length > 0xffffff00) {
        throw new Error("Meeting audio storage cannot keep up or WAV size limit reached");
      }
      track.stream.write(pcm);
      track.bytes += pcm.length;
    } catch (error) {
      this.fail(recording, error);
    }
  }
  fail(recording, error) {
    if (recording.manifest.error) return;
    recording.manifest.error = error.message;
    this.onError(error);
    try {
      this.saveJson(path.join(recording.directory, "recording.json"), recording.manifest);
    } catch {}
  }
  async stop() {
    const recording = this.active;
    this.active = null;
    if (!recording) return;
    await Promise.all(
      [...recording.tracks.values()].map(async (track) => {
        try {
          track.stream.end();
          await finished(track.stream);
          this.repairHeader(track.file);
          const entry = recording.manifest.tracks.find((entry) =>
            track.file.endsWith(entry.source + ".wav")
          );
          if (entry) entry.durationSeconds = (fs.statSync(track.file).size - 44) / 48000;
        } catch (error) {
          this.fail(recording, error);
        }
      })
    );
    recording.manifest.completedAt = Date.now();
    this.saveJson(path.join(recording.directory, "recording.json"), recording.manifest);
  }
  repairHeader(file) {
    const size = fs.statSync(file).size;
    if (size < 44) throw new Error("Incomplete WAV header");
    const bytes = size - 44;
    const fd = fs.openSync(file, "r+");
    try {
      fs.writeSync(fd, wavHeader(bytes - (bytes % 2)), 0, 44, 0);
    } finally {
      fs.closeSync(fd);
    }
  }
  recordings() {
    return fs.readdirSync(this.root, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) return [];
      try {
        const record = JSON.parse(
          fs.readFileSync(path.join(this.root, entry.name, "recording.json"), "utf8")
        );
        return record.id === entry.name ? [record] : [];
      } catch {
        return [];
      }
    });
  }
  list(noteId) {
    return this.recordings().filter((record) => record.noteId === noteId);
  }
  resolveTrack(noteId, id, source) {
    if (!/^[a-f0-9-]{36}$/.test(id) || !["mic", "system"].includes(source))
      throw new Error("Invalid recording");
    const record = this.list(noteId).find((record) => record.id === id);
    if (!record || !record.tracks.some((track) => track.source === source))
      throw new Error("Recording not found");
    if (this.active?.manifest.id === id) throw new Error("Stop recording before playback");
    const file = path.join(this.root, id, source + ".wav");
    this.repairHeader(file); // Recover recordings left open by a crash.
    return file;
  }
  cleanup(now = Date.now()) {
    if (!this.settings.retentionDays) return;
    const cutoff = now - this.settings.retentionDays * 86400000;
    for (const record of this.recordings()) {
      if (record.id === this.active?.manifest.id || record.createdAt >= cutoff) continue;
      const directory = path.resolve(this.root, record.id);
      if (path.dirname(directory) !== path.resolve(this.root)) continue;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}
module.exports = { MeetingAudioStorage, validateSettings, wavHeader };
