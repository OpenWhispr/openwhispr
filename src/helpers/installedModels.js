const fs = require("node:fs");
const path = require("node:path");
const { getRegistryData } = require("../models/registryData.js");
const { isModelSupported } = require("../models/registrySelection.js");
const { acceptCatalog } = require("../models/registrySchema.cjs");

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

function parseKey(key) {
  try {
    const [section, providerId, modelId] = JSON.parse(key);
    // The record is a local file, so nothing in it reaches the catalog on trust.
    const validPlace =
      section === "localProviders"
        ? typeof providerId === "string" && providerId !== ""
        : (section === "whisperModels" || section === "parakeetModels") && providerId === "";
    if (!validPlace || typeof modelId !== "string" || !modelId || modelId === "__proto__")
      return null;
    return { section, providerId, modelId };
  } catch {
    return null;
  }
}

function forgetInstalledModels(section, providerId, modelId) {
  const record = readRecord();
  for (const key of Object.keys(record)) {
    const entry = parseKey(key);
    if (
      entry?.section === section &&
      (providerId === undefined || entry.providerId === providerId) &&
      (modelId === undefined || entry.modelId === modelId)
    )
      delete record[key];
  }
  writeRecord(record);
}

// After a bulk delete, keep only the models whose files survived it (a file held open
// by a running server cannot be removed on Windows).
function pruneInstalledModels(section, isStillInstalled) {
  const record = readRecord();
  for (const [key, model] of Object.entries(record)) {
    const entry = parseKey(key);
    if (entry?.section === section && !isStillInstalled(entry.modelId, model)) delete record[key];
  }
  writeRecord(record);
}

// A model needing a newer app (after a downgrade) stays out, as the catalog keeps it out.
// The record is a file on disk, so each entry is read on its own the way a catalog entry is
// (acceptCatalog): one this app can't read, or with an unsafe name, is skipped.
function withInstalledModels(data, appVersion) {
  let merged = null;
  for (const [key, entry] of Object.entries(readRecord())) {
    const parsed = parseKey(key);
    if (!parsed || !entry || typeof entry !== "object" || !isModelSupported(entry, appVersion))
      continue;
    const { section, providerId, modelId } = parsed;
    const provider = providerId && data[section]?.find?.((item) => item?.id === providerId);
    const listed = providerId
      ? !provider?.models || provider.models.some((model) => model.id === modelId)
      : !data[section] || Object.hasOwn(data[section], modelId);
    if (listed) continue;

    const addition = providerId
      ? { [section]: [{ id: providerId, models: [{ ...entry, id: modelId }] }] }
      : { [section]: { [modelId]: entry } };
    const accepted = acceptCatalog(addition, data, appVersion);
    merged ??= structuredClone(data);
    if (providerId) {
      const model = accepted[section]
        .find((item) => item.id === providerId)
        ?.models.find((item) => item.id === modelId);
      if (model) merged[section].find((item) => item.id === providerId).models.push(model);
    } else if (Object.hasOwn(accepted[section], modelId)) {
      merged[section][modelId] = accepted[section][modelId];
    }
  }
  return merged ?? data;
}

module.exports = {
  configureInstalledModels,
  rememberInstalledModel,
  forgetInstalledModels,
  pruneInstalledModels,
  withInstalledModels,
};
