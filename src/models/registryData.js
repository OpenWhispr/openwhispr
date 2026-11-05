import bundled from "./modelRegistryData.json" with { type: "json" };

const PROVIDER_SECTIONS = [
  "cloudProviders",
  "enterpriseProviders",
  "transcriptionProviders",
  "localProviders",
];
const MAP_SECTIONS = ["whisperModels", "parakeetModels"];

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

const retiredKey = (section, providerId, modelId) => `${section}\0${providerId}\0${modelId}`;

// Retired models leave the catalog every picker and route reads, so nothing can offer or
// select them; the index keeps what lifecycle code needs to move selections on.
function splitRetired(catalog) {
  const visible = structuredClone(catalog);
  const retired = new Map();
  for (const section of PROVIDER_SECTIONS)
    for (const provider of visible[section] ?? []) {
      for (const model of provider.models)
        if (model.retired) retired.set(retiredKey(section, provider.id, model.id), model);
      provider.models = provider.models.filter((model) => !model.retired);
    }
  for (const section of MAP_SECTIONS)
    for (const [id, model] of Object.entries(visible[section] ?? {}))
      if (model.retired) {
        retired.set(retiredKey(section, "", id), model);
        delete visible[section][id];
      }
  return { visible, retired };
}

// A stable top-level reference keeps existing CJS and ESM readers live. Each
// replacement owns immutable child objects, so in-flight work keeps its config.
// Until main applies its version-filtered catalog (before any window opens, and to the
// renderer through preload), this holds the bundled data at version -1.
const initial = splitRetired(bundled);
export const registryData = { ...freeze(initial.visible) };
let retired = initial.retired;
let snapshotData = bundled;
let version = -1;
let pending = false;
const listeners = new Set();
export const getRegistryData = () => registryData;
export const getRegistryVersion = () => version;
// The full catalog, retired entries included, as main verified it.
export const getRegistrySnapshot = () => ({
  data: structuredClone(snapshotData),
  manifestVersion: version,
  pending,
});
// A catalog this app accepted before could not be loaded yet (see registryLoader).
export const isCatalogPending = () => pending;
export const getRetiredModel = (section, providerId, modelId) =>
  retired.get(retiredKey(section, providerId ?? "", modelId));
export const listRetiredModels = () =>
  [...retired].map(([key, model]) => {
    const [section, providerId, id] = key.split("\0");
    return { section, providerId, id, model };
  });
export function subscribeRegistry(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Only the verified main loader and its preload/IPC mirror call this boundary.
// Signature and compatibility checks belong in main, never in the renderer.
export function replaceRegistryData(snapshot) {
  // The one change at the same version: a catalog that was pending has settled. Subscribers
  // run again, so the repairs it held back happen now.
  const settles = snapshot?.manifestVersion === version && pending && snapshot.pending !== true;
  if (
    !Number.isSafeInteger(snapshot?.manifestVersion) ||
    (snapshot.manifestVersion <= version && !settles)
  )
    return false;
  if (!snapshot.data || Object.keys(bundled).some((key) => !Object.hasOwn(snapshot.data, key)))
    return false;
  const next = splitRetired(snapshot.data);
  snapshotData = freeze(structuredClone(snapshot.data));
  retired = next.retired;
  Object.assign(registryData, freeze(next.visible));
  version = snapshot.manifestVersion;
  pending = snapshot.pending === true;
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error("Model registry subscriber failed", error);
    }
  }
  return true;
}
