// Store keys of every inference scope pointing at a local model that is no
// longer installed. Only "local" scopes are candidates — in every other mode the
// selected id names a remote model, which the local model cache knows nothing
// about. `scopes` is Object.values(INFERENCE_SCOPES).
export function findStaleLocalModelKeys(scopes, settings, isInstalled) {
  return scopes
    .filter(({ storeKeys }) => {
      const selected = settings[storeKeys.model];
      return settings[storeKeys.mode] === "local" && !!selected && !isInstalled(selected);
    })
    .map(({ storeKeys }) => storeKeys.model);
}
