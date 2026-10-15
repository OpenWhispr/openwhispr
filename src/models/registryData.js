import bundled from "./modelRegistryData.json" with { type: "json" };
import { selectCatalogForVersion } from "./registrySelection.js";
import appPackage from "../../package.json" with { type: "json" };
import metadata from "./registryMetadata.json" with { type: "json" };

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

// A stable top-level reference keeps existing CJS and ESM readers live. Each
// replacement owns immutable child objects, so in-flight work keeps its config.
export const registryData = { ...freeze(selectCatalogForVersion(bundled, {}, appPackage.version)) };
let version = metadata.manifestVersion;
const listeners = new Set();
export const getRegistryData = () => registryData;
export const getRegistryVersion = () => version;
export const getRegistrySnapshot = () => ({
  data: structuredClone(registryData),
  manifestVersion: version,
});
export function subscribeRegistry(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Only the verified main loader and its preload/IPC mirror call this boundary.
// Signature and compatibility checks belong in main, never in the renderer.
export function replaceRegistryData(snapshot) {
  if (!Number.isSafeInteger(snapshot?.manifestVersion) || snapshot.manifestVersion <= version)
    return false;
  if (!snapshot.data || Object.keys(bundled).some((key) => !Object.hasOwn(snapshot.data, key)))
    return false;
  const next = freeze(structuredClone(snapshot.data));
  Object.assign(registryData, next);
  version = snapshot.manifestVersion;
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error("Model registry subscriber failed", error);
    }
  }
  return true;
}
