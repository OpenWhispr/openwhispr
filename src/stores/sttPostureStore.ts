import { create } from "zustand";

export type SttPosture = "unknown" | "unconfigured" | "cloud-only" | "local-ready";

interface SttPostureState {
  posture: SttPosture;
}

export const useSttPostureStore = create<SttPostureState>(() => ({
  posture: "unknown",
}));

export function setSttPosture(posture: SttPosture): void {
  useSttPostureStore.setState({ posture });
}

export function getSttPosture(): SttPosture {
  return useSttPostureStore.getState().posture;
}

export function isCloudOnlyPosture(): boolean {
  return getSttPosture() === "cloud-only";
}
