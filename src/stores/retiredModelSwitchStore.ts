import { create } from "zustand";
import type { RetiredModelProvider } from "../config/retiredCloudModels";

export interface RetiredModelSwitch {
  provider: RetiredModelProvider;
  /** Display name of the model the provider retired. */
  from: string;
  /** Display name of the model we moved the user to. */
  to: string;
}

interface RetiredModelSwitchState {
  events: RetiredModelSwitch[];
}

export const useRetiredModelSwitchStore = create<RetiredModelSwitchState>(() => ({
  events: [],
}));

export function recordRetiredModelSwitch(event: RetiredModelSwitch): void {
  useRetiredModelSwitchStore.setState((state) => ({ events: [...state.events, event] }));
}

export function consumeRetiredModelSwitches(): RetiredModelSwitch[] {
  const { events } = useRetiredModelSwitchStore.getState();
  if (events.length > 0) {
    useRetiredModelSwitchStore.setState({ events: [] });
  }
  return events;
}
