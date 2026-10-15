import { startRegistrySync } from "./registrySync.js";

// This must be the first entrypoint import: settings-store migrations run as
// modules evaluate and must recognize previously selected remote-added models.
const stop = startRegistrySync(globalThis.window?.electronAPI);
if (import.meta.hot) import.meta.hot.dispose(stop);
