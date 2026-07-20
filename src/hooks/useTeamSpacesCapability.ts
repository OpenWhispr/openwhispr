import { useSyncExternalStore } from "react";
import { useSpaces } from "../stores/noteStore";
import {
  readTeamSpacesCapability,
  subscribeTeamSpacesCapability,
} from "../lib/teamSpacesCapability";

/** Dev override forcing the TEAM SPACES section on without a server probe. */
function hasTeamSpacesDevOverride(): boolean {
  return localStorage.getItem("teamSpacesDevOverride") === "true";
}

/**
 * Whether the TEAM SPACES section should render: the cached server capability
 * probe (written by the spaces sync pass), the dev override, or locally known
 * team spaces.
 */
export function useTeamSpacesCapability(): boolean {
  const spaces = useSpaces();
  const capability = useSyncExternalStore(subscribeTeamSpacesCapability, readTeamSpacesCapability);
  return hasTeamSpacesDevOverride() || capability || spaces.some((space) => space.kind === "team");
}
