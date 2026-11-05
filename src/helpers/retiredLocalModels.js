const fs = require("fs");
const path = require("path");
const { getRegistryData, listRetiredModels } = require("../models/registryData.js");
const { forgetInstalledModels } = require("./installedModels");

// Retired models leave every list, so their rows, and the per-model delete behind them,
// are gone while the files stay on disk. A file an offered model also uses is kept.
function retiredModelFiles({ whisperDir, parakeetDir, llamaDir }) {
  const data = getRegistryData();
  const offeredGguf = new Set(
    data.localProviders.flatMap(({ models }) =>
      models.flatMap((model) => [model.fileName, model.draftFileName])
    )
  );
  const offeredWhisper = new Set(Object.values(data.whisperModels).map((m) => m.fileName));
  const inDir = (dir, names, offered) =>
    names
      .filter((name) => name && !offered.has(name) && path.basename(name) === name)
      .map((name) => path.join(dir, name));

  return listRetiredModels().flatMap(({ section, providerId, id, model }) => {
    let paths = [];
    if (section === "localProviders")
      paths = inDir(llamaDir, [model.fileName, model.draftFileName], offeredGguf);
    else if (section === "whisperModels")
      paths = inDir(whisperDir, [model.fileName], offeredWhisper);
    else if (section === "parakeetModels") paths = inDir(parakeetDir, [id], new Set());
    const onDisk = paths.filter((file) => fs.existsSync(file));
    return onDisk.length ? [{ section, providerId, id, name: model.name, paths: onDisk }] : [];
  });
}

function listRetiredLocalModels(dirs) {
  return retiredModelFiles(dirs).map(({ id, name }) => ({ id, name }));
}

function deleteRetiredLocalModels(dirs) {
  let failed = 0;
  for (const { section, providerId, id, paths } of retiredModelFiles(dirs)) {
    try {
      for (const file of paths) fs.rmSync(file, { recursive: true, force: true });
      forgetInstalledModels(section, providerId, id);
    } catch {
      // Windows refuses a file a running server still holds.
      failed += 1;
    }
  }
  return { success: failed === 0 };
}

module.exports = { listRetiredLocalModels, deleteRetiredLocalModels };
