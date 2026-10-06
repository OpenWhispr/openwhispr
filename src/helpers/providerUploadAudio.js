const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { convertToMp3 } = require("./ffmpegUtils");
const { getSafeTempDir } = require("./safeTempDir");

// Containers every transcription provider we post to accepts as-is. Anything
// else the upload picker admits is re-encoded to MP3 before it leaves the app,
// so a .mov or .aiff upload never reaches a provider that would reject it.
const AUDIO_MIME_TYPES = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  webm: "audio/webm",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  opus: "audio/ogg",
};

function uploadExtension(filePath) {
  return path.extname(filePath).slice(1).toLowerCase();
}

function providerContentType(filePath) {
  return AUDIO_MIME_TYPES[uploadExtension(filePath)] || "audio/mpeg";
}

// Resolves to the path to upload plus a cleanup for any temp file it created.
async function prepareProviderUpload(sourcePath, { signal } = {}) {
  if (Object.hasOwn(AUDIO_MIME_TYPES, uploadExtension(sourcePath))) {
    return { path: sourcePath, cleanup() {} };
  }

  const mp3Path = path.join(
    getSafeTempDir(),
    `ow-upload-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp3`
  );
  await convertToMp3(sourcePath, mp3Path, { signal });
  return {
    path: mp3Path,
    cleanup() {
      fs.rmSync(mp3Path, { force: true });
    },
  };
}

module.exports = { AUDIO_MIME_TYPES, providerContentType, prepareProviderUpload };
