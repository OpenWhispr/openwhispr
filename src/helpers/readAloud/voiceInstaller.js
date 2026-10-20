// Downloads, extracts and removes read-aloud voices under
// <cache>/tts-models/<archive>/, reusing the app's download and bzip2 tooling.
// Voices that share an archive share that directory (see voices.js).
const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");
const { pipeline } = require("stream/promises");
const debugLogger = require("../debugLogger");
const { downloadFile } = require("../downloadUtils");
const { getModelsDirForService } = require("../modelDirUtils");
const { getVoice, getVoiceArchive, getVoiceUrl } = require("./voices");
const { hasRequiredFiles } = require("./voiceEngine");

function getVoicesDir() {
  return getModelsDirForService("tts");
}

function getVoiceDir(voiceId) {
  return path.join(getVoicesDir(), getVoiceArchive(voiceId));
}

function isVoiceInstalled(voiceId) {
  const voice = getVoice(voiceId);
  if (!voice) return false;
  try {
    return hasRequiredFiles(voice, fs.readdirSync(getVoiceDir(voiceId)));
  } catch {
    return false;
  }
}

let activeInstall = null;

async function installVoice(voiceId, onProgress) {
  const voice = getVoice(voiceId);
  if (!voice) throw new Error(`Unknown voice: ${voiceId}`);
  if (isVoiceInstalled(voiceId)) return { alreadyInstalled: true };
  if (activeInstall) throw new Error("Another voice download is in progress");

  const voicesDir = getVoicesDir();
  const archive = getVoiceArchive(voiceId);
  const archivePath = path.join(voicesDir, `${archive}.tar.bz2`);
  const extractDir = path.join(voicesDir, `temp-extract-${archive}`);
  activeInstall = voiceId;
  try {
    await fsPromises.mkdir(voicesDir, { recursive: true });
    await downloadFile(getVoiceUrl(voiceId), archivePath, {
      timeout: 600000,
      expectedSize: voice.sizeBytes,
      onProgress: (downloaded, total) => {
        const totalBytes = total || voice.sizeBytes;
        onProgress?.({
          phase: "downloading",
          percentage: totalBytes ? Math.round((downloaded / totalBytes) * 100) : 0,
        });
      },
    });

    onProgress?.({ phase: "installing", percentage: 100 });
    await fsPromises.rm(extractDir, { recursive: true, force: true });
    await fsPromises.mkdir(extractDir, { recursive: true });
    // Windows' bsdtar may lack bz2 support, so extract in JS like parakeet.js.
    const unbzip2 = require("unbzip2-stream");
    const tar = require("tar");
    await pipeline(fs.createReadStream(archivePath), unbzip2(), tar.x({ cwd: extractDir }));

    const extracted = path.join(extractDir, archive);
    if (!fs.existsSync(extracted)) {
      throw new Error(`Archive did not contain ${archive}/`);
    }
    const target = getVoiceDir(voiceId);
    await fsPromises.rm(target, { recursive: true, force: true });
    await fsPromises.rename(extracted, target);
    if (!isVoiceInstalled(voiceId)) throw new Error("Installed voice is missing files");

    debugLogger.info("Read aloud voice installed", { voiceId }, "read-aloud");
    return { installed: true };
  } finally {
    activeInstall = null;
    await fsPromises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    await fsPromises.rm(archivePath, { force: true }).catch(() => {});
  }
}

async function removeVoice(voiceId) {
  if (!getVoice(voiceId)) throw new Error(`Unknown voice: ${voiceId}`);
  await fsPromises.rm(getVoiceDir(voiceId), { recursive: true, force: true });
}

module.exports = { getVoiceDir, isVoiceInstalled, installVoice, removeVoice };
