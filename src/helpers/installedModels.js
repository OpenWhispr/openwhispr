const fs = require("node:fs");
const path = require("node:path");
const { getRegistryData } = require("../models/registryData.js");

// The catalog entry of each local model this app installed. Main merges entries a catalog
// does not list at all back into it, so an installed model keeps working and can be
// deleted when its entry is missing (a lost cache, or a remote addition this build does not
// bundle). A retired model is still listed, as retired, so it is never revived.
let recordPath = null;

const keyOf = (section, providerId, modelId) => JSON.stringify([section, providerId, modelId]);

function configureInstalledModels(file) {
  recordPath = file;
}

function readRecord() {
  if (!recordPath) return {};
  try {
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    return record && typeof record === "object" && !Array.isArray(record) ? record : {};
  } catch {
    return {};
  }
}

function writeRecord(record) {
  if (!recordPath) return;
  const temporary = `${recordPath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temporary, recordPath);
  } catch {
    // A missing record only matters if the catalog later loses this model too.
    fs.rmSync(temporary, { force: true });
  }
}

function catalogEntry(section, providerId, modelId) {
  const data = getRegistryData();
  return providerId
    ? data[section]
        ?.find((provider) => provider.id === providerId)
        ?.models.find((m) => m.id === modelId)
    : data[section]?.[modelId];
}

// `providerId` is the local provider for GGUF models, and "" for Whisper/Parakeet maps.
function rememberInstalledModel(section, providerId, modelId) {
  const entry = catalogEntry(section, providerId, modelId);
  if (!entry) return;
  writeRecord({ ...readRecord(), [keyOf(section, providerId, modelId)]: entry });
}

function forgetInstalledModels(section, providerId, modelId) {
  const record = readRecord();
  for (const key of Object.keys(record)) {
    const [entrySection, entryProvider, entryModel] = JSON.parse(key);
    if (
      entrySection === section &&
      (providerId === undefined || entryProvider === providerId) &&
      (modelId === undefined || entryModel === modelId)
    )
      delete record[key];
  }
  writeRecord(record);
}

function withInstalledModels(data) {
  const merged = structuredClone(data);
  for (const [key, entry] of Object.entries(readRecord())) {
    let section, providerId, modelId;
    try {
      [section, providerId, modelId] = JSON.parse(key);
    } catch {
      continue;
    }
    if (providerId) {
      const provider = merged[section]?.find((item) => item.id === providerId);
      if (provider && !provider.models.some((model) => model.id === modelId))
        provider.models.push({ ...entry, id: modelId });
    } else if (merged[section] && !Object.hasOwn(merged[section], modelId)) {
      merged[section][modelId] = entry;
    }
  }
  return merged;
}

module.exports = {
  configureInstalledModels,
  rememberInstalledModel,
  forgetInstalledModels,
  withInstalledModels,
};
