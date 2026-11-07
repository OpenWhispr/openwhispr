import { useSyncExternalStore } from "react";
import { getRegistryVersion, subscribeRegistry } from "../models/registryData";

export function useRegistryVersion(): number {
  return useSyncExternalStore(subscribeRegistry, getRegistryVersion, getRegistryVersion);
}
