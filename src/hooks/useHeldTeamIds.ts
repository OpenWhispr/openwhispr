import { useSyncExternalStore } from "react";
import { heldTeamIds, subscribeHeldTeams } from "../lib/heldTeamDeletes";

export function useHeldTeamIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeHeldTeams, heldTeamIds, heldTeamIds);
}
