// Free disk space for onboarding's local setup, with the room each kind of
// download reserves. The factors are the ones each download path checks before
// it starts, so the screen never says "fits" for a download that then refuses.
const fs = require("fs");

function localSetupDiskFactors() {
  // Required on first use, as ipcHandlers loads the model managers lazily.
  return {
    whisper: require("./whisper").WHISPER_DISK_SPACE_FACTOR,
    parakeet: require("./parakeet").PARAKEET_DISK_SPACE_FACTOR,
    llm: require("./modelManagerBridge").LLM_DISK_SPACE_FACTOR,
    llamaVulkan: require("./gpuBinaryManager").DISK_SPACE_MULTIPLIER,
  };
}

async function readLocalSetupSpace({
  getCacheRoot = () => require("./modelDirUtils").getCacheRoot(),
  checkDiskSpace = require("./downloadUtils").checkDiskSpace,
  factors = localSetupDiskFactors(),
} = {}) {
  const root = getCacheRoot();
  // On a fresh install the folder doesn't exist yet, and checkDiskSpace reports
  // Infinity for a folder it can't stat. Create it so the real disk is read.
  await fs.promises.mkdir(root, { recursive: true }).catch(() => {});
  const { availableBytes } = await checkDiskSpace(root, 0);
  return { availableBytes, factors };
}

module.exports = { readLocalSetupSpace, localSetupDiskFactors };
