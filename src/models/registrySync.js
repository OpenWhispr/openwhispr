import { replaceRegistryData } from "./registryData.js";

const active = new WeakMap();
export function startRegistrySync(api) {
  if (!api?.onModelRegistryUpdated) return () => {};
  let state = active.get(api);
  if (!state) {
    // Preload obtained this snapshot from verified main state before any settings
    // module evaluated. Subscribing before the async reconciliation closes the race.
    if (api.initialModelRegistrySnapshot) replaceRegistryData(api.initialModelRegistrySnapshot);
    state = { count: 0, stopped: false, unsubscribe: null };
    const accept = (snapshot) => {
      if (!state.stopped) replaceRegistryData(snapshot);
    };
    state.unsubscribe = api.onModelRegistryUpdated(accept);
    active.set(api, state);
    api
      .getModelRegistry?.()
      .then(accept)
      .catch(() => {});
  }
  state.count++;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (--state.count === 0) {
      state.stopped = true;
      state.unsubscribe?.();
      active.delete(api);
    }
  };
}
