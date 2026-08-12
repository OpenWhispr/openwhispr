import { create } from "zustand";

export interface TinfoilModelSwitch {
  /** Display name of the model Tinfoil retired. */
  from: string;
  /** Display name of the model we moved the user to. */
  to: string;
}

interface TinfoilModelSwitchState {
  events: TinfoilModelSwitch[];
}

export const useTinfoilModelSwitchStore = create<TinfoilModelSwitchState>(() => ({
  events: [],
}));

export function recordTinfoilModelSwitch(event: TinfoilModelSwitch): void {
  useTinfoilModelSwitchStore.setState((state) => ({ events: [...state.events, event] }));
}

export function consumeTinfoilModelSwitches(): TinfoilModelSwitch[] {
  const { events } = useTinfoilModelSwitchStore.getState();
  if (events.length > 0) {
    useTinfoilModelSwitchStore.setState({ events: [] });
  }
  return events;
}
