// Pure selection logic shared by Node validation and the renderer's offline
// bootstrap. Version syntax is the desktop's canonical major.minor.patch form.
export function isModelSupported(model, appVersion) {
  if (!model.minAppVersion) return true;
  const running = appVersion.split(".").map(Number);
  const required = model.minAppVersion.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (running[i] !== required[i]) return running[i] > required[i];
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
              (item) =>
                item.id === model.id && isModelSupported(item, appVersion),
            ) || [],
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
