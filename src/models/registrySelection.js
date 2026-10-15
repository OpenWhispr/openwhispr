// Pure selection logic shared by Node validation and the renderer's offline bootstrap.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match = SEMVER.exec(value);
  if (!match) return null;
  const core = match.slice(1, 4).map(Number);
  if (!core.every(Number.isSafeInteger)) return null;
  return { core, prerelease: match[4]?.split(".") || [] };
}

export function isRegistryVersion(value) {
  return parseVersion(value) !== null;
}

export function isModelSupported(model, appVersion) {
  if (!model.minAppVersion) return true;
  const running = parseVersion(appVersion);
  const required = parseVersion(model.minAppVersion);
  if (!running || !required) return false;
  for (let i = 0; i < 3; i++) {
    if (running.core[i] !== required.core[i]) return running.core[i] > required.core[i];
  }
  if (!running.prerelease.length) return true;
  if (!required.prerelease.length) return false;
  for (let i = 0; i < Math.max(running.prerelease.length, required.prerelease.length); i++) {
    const left = running.prerelease[i];
    const right = required.prerelease[i];
    if (left === right) continue;
    if (left === undefined) return false;
    if (right === undefined) return true;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric !== rightNumeric) return !leftNumeric;
    // Numeric prerelease identifiers have no size limit in SemVer.
    if (leftNumeric && left.length !== right.length) return left.length > right.length;
    return left > right;
  }
  return true;
}
export function selectCatalogForVersion(input, fallback, appVersion) {
  const data = structuredClone(input);
  for (const section of [
    "cloudProviders",
    "enterpriseProviders",
    "transcriptionProviders",
    "localProviders",
  ]) {
    for (const provider of data[section]) {
      const old = fallback[section]?.find((item) => item.id === provider.id);
      provider.models = provider.models.flatMap((model) =>
        isModelSupported(model, appVersion)
          ? [model]
          : old?.models.filter(
              (item) => item.id === model.id && isModelSupported(item, appVersion)
            ) || []
      );
    }
  }
  for (const section of ["whisperModels", "parakeetModels"]) {
    for (const [id, model] of Object.entries(data[section]))
      if (!isModelSupported(model, appVersion)) {
        if (
          Object.hasOwn(fallback[section] || {}, id) &&
          isModelSupported(fallback[section][id], appVersion)
        )
          data[section][id] = structuredClone(fallback[section][id]);
        else delete data[section][id];
      }
  }
  return data;
}
