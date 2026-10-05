import { useSyncExternalStore } from "react";
import { useSpaces } from "../stores/noteStore";
import {
  readTeamSpacesAvailable,
  subscribeTeamSpacesCapability,
} from "../lib/teamSpacesCapability";

/**
 * Whether the TEAM SPACES section should render. Every signed-in user gets it;
 * the only thing that removes it is an API without the spaces endpoint, and
 * even then locally mirrored team spaces keep it visible so their content
 * stays reachable.
 */
export function useTeamSpacesCapability(isSignedIn: boolean): boolean {
  const spaces = useSpaces();
  const available = useSyncExternalStore(subscribeTeamSpacesCapability, readTeamSpacesAvailable);
  return isSignedIn && (available || spaces.some((space) => space.kind === "team"));
}
