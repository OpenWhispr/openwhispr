// Free disk space for onboarding's local setup, with the room each kind of
// download reserves. The factors are the ones each download path checks before
// it starts, so the screen never says "fits" for a download that then refuses.
const fs = require("fs");
const path = require("path");

function localSetupDiskFactors() {
  // Required on first use, as ipcHandlers loads the model managers lazily.
  return {
    whisper: require("./whisper").WHISPER_DISK_SPACE_FACTOR,
    parakeet: require("./parakeet").PARAKEET_DISK_SPACE_FACTOR,
    llm: require("./modelManagerBridge").LLM_DISK_SPACE_FACTOR,
    llamaVulkan: require("./gpuBinaryManager").DISK_SPACE_MULTIPLIER,
  };
}

// The folder itself, or the closest parent that exists: the disk it will live on.
async function nearestExistingFolder(dir) {
  let current = path.resolve(dir);
  for (;;) {
    try {
      await fs.promises.access(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

async function readLocalSetupSpace({
  getCacheRoot = () => require("./modelDirUtils").getCacheRoot(),
  checkDiskSpace = require("./downloadUtils").checkDiskSpace,
  factors = localSetupDiskFactors(),
  mkdir = (dir) => fs.promises.mkdir(dir, { recursive: true }),
  warn = (message, meta) => require("./debugLogger").warn(message, meta, "onboarding"),
} = {}) {
  const root = getCacheRoot();
  // On a fresh install the folder doesn't exist yet, and checkDiskSpace reports
  // Infinity for a folder it can't stat. Create it so the real disk is read; if
  // that fails, read the disk through the nearest folder that does exist.
  let dir = root;
  try {
    await mkdir(root);
  } catch (error) {
    warn("Could not create the models folder to read free space", { root, error: error?.message });
    dir = await nearestExistingFolder(root);
  }
  const { availableBytes } = await checkDiskSpace(dir, 0);
  return { availableBytes, factors };
}

module.exports = { readLocalSetupSpace, localSetupDiskFactors };
