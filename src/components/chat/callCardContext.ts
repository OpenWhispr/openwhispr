import { createContext, useContext } from "react";

/**
 * Where a card shows in a voice call: above the call's pill, or in its
 * transcript. There cards follow the call's designs; outside a call (null)
 * they keep the chat's.
 */
type CallCardPlacement = "compact" | "transcript" | null;

export const CallCardContext = createContext<CallCardPlacement>(null);

export function useCallCardPlacement(): CallCardPlacement {
  return useContext(CallCardContext);
}
