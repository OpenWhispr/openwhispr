import { create } from "zustand";

export type LocalColdStartHint = "cold-start" | "no-gpu" | null;

interface LocalColdStartState {
  hint: LocalColdStartHint;
}

export const useLocalColdStartStore = create<LocalColdStartState>(() => ({
  hint: null,
}));

export function setLocalColdStartHint(hint: LocalColdStartHint): void {
  useLocalColdStartStore.setState({ hint });
}

export function getLocalColdStartHint(): LocalColdStartHint {
  return useLocalColdStartStore.getState().hint;
}
