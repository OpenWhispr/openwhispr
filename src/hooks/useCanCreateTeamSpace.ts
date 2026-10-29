import { useAuth } from "./useAuth";
import { useTeamSpacesCapability } from "./useTeamSpacesCapability";
import { useWorkspace } from "./useWorkspace";
import { workspaceCan } from "../lib/capabilities";

/**
 * Whether to offer "new team space". The server 403s team creation for plain
 * members; users with no workspace yet get the create funnel in the dialog.
 * The notes tree shows only the active workspace, so that's the one that
 * counts once there is one.
 */
export function useCanCreateTeamSpace(): boolean {
  const { isSignedIn } = useAuth();
  const teamSpacesAvailable = useTeamSpacesCapability(isSignedIn);
  const { workspaces, active, loaded } = useWorkspace();
  const canCreate = active
    ? workspaceCan(active, "create_spaces")
    : workspaces.length === 0 || workspaces.some((w) => workspaceCan(w, "create_spaces"));
  return teamSpacesAvailable && loaded && canCreate;
}
