import { useSpaces } from "../stores/noteStore";

/** Phase-2 gate for local-only team-space mutations (create/delete). */
export function hasTeamSpacesDevOverride(): boolean {
  return localStorage.getItem("teamSpacesDevOverride") === "true";
}

/**
 * Whether the TEAM SPACES section should render: the cached server capability
 * probe (written by the spaces sync pass), the dev override, or locally known
 * team spaces.
 */
export function useTeamSpacesCapability(): boolean {
  const spaces = useSpaces();
  return (
    hasTeamSpacesDevOverride() ||
    localStorage.getItem("teamSpacesCapability") === "true" ||
    spaces.some((space) => space.kind === "team")
  );
}
