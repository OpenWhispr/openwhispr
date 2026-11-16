import { create } from "zustand";
export interface RetiredModelSwitch {
  provider: string;
  /** Provider display name, for retirements published in the model catalog. */
  providerName?: string;
  /** Display name of the model the provider retired. */
  from: string;
  /** Display name of the model we moved the user to. */
  to: string;
  /** The message to show, when it isn't the provider's usual "retired" one. */
  messageKey?: string;
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

// Every window reconciles catalog changes, usually while the control panel is closed or
// in the tray, so these wait in storage until the panel is in front of the user.
export const QUEUED_SWITCHES_KEY = "retiredModelSwitchesQueue";

function readQueuedSwitches(): RetiredModelSwitch[] {
  try {
    const queued = JSON.parse(localStorage.getItem(QUEUED_SWITCHES_KEY) ?? "[]");
    return Array.isArray(queued) ? queued : [];
  } catch {
    return [];
  }
}

export function queueRetiredModelSwitch(event: RetiredModelSwitch): void {
  const queued = readQueuedSwitches();
  // Several scopes, or two windows at once, can make the same move.
  if (
    queued.some(
      ({ provider, from, to }) =>
        [provider, from, to].join("\0") === [event.provider, event.from, event.to].join("\0")
    )
  )
    return;
  localStorage.setItem(QUEUED_SWITCHES_KEY, JSON.stringify([...queued, event]));
  // Same-window writes fire no storage event, so wake this window's listener directly.
  useRetiredModelSwitchStore.setState((state) => ({ events: [...state.events] }));
}

export function takeQueuedRetiredModelSwitches(): RetiredModelSwitch[] {
  const queued = readQueuedSwitches();
  if (localStorage.getItem(QUEUED_SWITCHES_KEY) !== null)
    localStorage.removeItem(QUEUED_SWITCHES_KEY);
  return queued;
}
