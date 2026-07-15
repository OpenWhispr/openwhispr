import { useSpaces } from "../stores/noteStore";

/** Phase-2 gate for local-only team-space mutations (create/delete). */
export function hasTeamSpacesDevOverride(): boolean {
  return localStorage.getItem("teamSpacesDevOverride") === "true";
}

/**
 * Whether the TEAM SPACES section should render. Phase 2: dev override or
 * locally known team spaces; Phase 3 swaps in the server capability probe.
 */
export function useTeamSpacesCapability(): boolean {
  const spaces = useSpaces();
  return hasTeamSpacesDevOverride() || spaces.some((space) => space.kind === "team");
}
