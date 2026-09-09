const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");
const { downloadFile, createDownloadSignal, checkDiskSpace } = require("./downloadUtils");
const registry = require("../models/modelRegistryData.json");

async function verify(file, info) {
  if ((await fsp.stat(file)).size !== info.expectedSizeBytes)
    throw new Error("Orukeet model size mismatch");
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  if (hash.digest("hex") !== info.sha256) throw new Error("Orukeet model checksum mismatch");
}

async function installOrukeetModel(manager, modelName, progressCallback) {
  const info = registry.parakeetModels[modelName];
  const directory = manager.getModelPath(modelName);
  const { signal, abort } = createDownloadSignal();
  const state = {
    model: modelName,
    abort,
    phase: "progress",
    percentage: 0,
    downloadedBytes: 0,
    totalBytes: info.expectedSizeBytes,
  };
  manager.currentDownloadProcess = state;
  let temporary;
  try {
    await fsp.mkdir(directory, { recursive: true });
    const space = await checkDiskSpace(directory, info.expectedSizeBytes * 1.1);
    if (!space.ok) throw new Error("Not enough disk space to install Orukeet");
    temporary = path.join(directory, `${info.fileName}.${crypto.randomUUID()}.part`);
    // An optional local fixture supports offline testing with the same integrity checks.
    if (process.env.OPENWHISPR_ORUKEET_MODEL) {
      await fsp.copyFile(path.resolve(process.env.OPENWHISPR_ORUKEET_MODEL), temporary);
    } else {
      await downloadFile(info.downloadUrl, temporary, {
        signal,
        timeout: 600000,
        onProgress(downloadedBytes, totalBytes) {
          Object.assign(state, {
            downloadedBytes,
            totalBytes,
            percentage: totalBytes ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
          });
          progressCallback?.({
            type: "progress",
            model: modelName,
            downloaded_bytes: downloadedBytes,
            total_bytes: totalBytes,
            percentage: state.percentage,
          });
        },
      });
    }
    if (signal.aborted)
      throw Object.assign(new Error("Download interrupted by user"), {
        code: "DOWNLOAD_CANCELLED",
      });
    state.phase = "installing";
    progressCallback?.({ type: "installing", model: modelName, percentage: 100 });
    await verify(temporary, info);
    if (signal.aborted)
      throw Object.assign(new Error("Download interrupted by user"), {
        code: "DOWNLOAD_CANCELLED",
      });
    await fsp.rename(temporary, path.join(directory, info.fileName));
    progressCallback?.({ type: "complete", model: modelName, percentage: 100 });
    // A completed install must not replace an in-flight model. Startup handles prewarming.
    return { model: modelName, downloaded: true, path: directory, success: true };
  } catch (error) {
    if (signal.aborted)
      throw Object.assign(new Error("Download interrupted by user"), {
        code: "DOWNLOAD_CANCELLED",
      });
    throw error;
  } finally {
    if (temporary) await fsp.rm(temporary, { force: true });
    if (manager.currentDownloadProcess === state) manager.currentDownloadProcess = null;
  }
}
module.exports = { installOrukeetModel, verify };
