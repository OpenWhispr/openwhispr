import { useAuth } from "./useAuth";
import { useTeamSpacesCapability } from "./useTeamSpacesCapability";
import { useWorkspace } from "./useWorkspace";
import { canManageWorkspace } from "../lib/spacePermissions";

/**
 * Whether to offer "new team space". The server 403s team creation for plain
 * members; users with no workspace yet get the create funnel in the dialog.
 */
export function useCanCreateTeamSpace(): boolean {
  const { isSignedIn } = useAuth();
  const teamSpacesAvailable = useTeamSpacesCapability(isSignedIn);
  const { workspaces, loaded } = useWorkspace();
  return (
    teamSpacesAvailable &&
    loaded &&
    (workspaces.length === 0 || workspaces.some((w) => canManageWorkspace(w.role)))
  );
}
