import type {
  SpaceCapabilities,
  SpaceItem,
  Team,
  TeamCapabilities,
  Workspace,
  WorkspaceCapabilities,
  WorkspaceRole,
} from "../types/electron";

export type WorkspaceCapability = keyof WorkspaceCapabilities;
export type SpaceCapability = keyof SpaceCapabilities;

// Copy of the API's workspaceCapabilitiesFor, used only for workspaces cached
// before the API sent capabilities. The desktop has no SSO signal, so the
// session is assumed to satisfy Require SSO; the server still enforces.
function workspaceCapabilitiesForRole(role: WorkspaceRole): WorkspaceCapabilities {
  const isOwner = role === "owner";
  const isAdmin = isOwner || role === "admin";
  return {
    manage_members: isAdmin,
    manage_teams: isAdmin,
    create_spaces: isAdmin,
    manage_settings: isAdmin,
    manage_billing: isOwner,
    delete_workspace: isOwner,
    transfer_ownership: isOwner,
    // The owner must transfer ownership before leaving.
    leave: role !== "owner",
  };
}

/**
 * Whether the user may do something in a workspace. The server's capabilities
 * win; the role table covers rows cached before the API sent them. Client
 * checks are cosmetic: the server enforces.
 */
export function workspaceCan(
  workspace: Pick<Workspace, "role" | "capabilities"> | null | undefined,
  capability: WorkspaceCapability
): boolean {
  if (!workspace) return false;
  const capabilities = workspace.capabilities ?? workspaceCapabilitiesForRole(workspace.role);
  return capabilities[capability] === true;
}

// SpaceItem carries no workspace role (and older APIs no directory_synced), so
// the API's "not a workspace admin" and "not directory-synced" conditions on
// leave are applied by callers that know them.
function spaceCapabilitiesForRole(
  space: Pick<SpaceItem, "my_role" | "my_direct_role" | "teams">
): SpaceCapabilities {
  const isSpaceAdmin = space.my_role === "admin";
  return {
    edit_notes: true,
    manage_members: isSpaceAdmin,
    manage_settings: isSpaceAdmin,
    leave: space.my_direct_role != null || space.teams.some((team) => team.my_role != null),
  };
}

export function spaceCan(
  space:
    Pick<SpaceItem, "my_role" | "my_direct_role" | "teams" | "capabilities"> | null | undefined,
  capability: SpaceCapability
): boolean {
  if (!space) return false;
  const capabilities = space.capabilities ?? spaceCapabilitiesForRole(space);
  return capabilities[capability] === true;
}

export type TeamCreation = "allowed" | "paywall" | "unavailable";

/**
 * Whether the caller may create a team here, and if not, whether a plan or a permission is what
 * stands in the way. A missing `create_teams` reads as allowed: a workspace cached before the API
 * sent it must not show a paying customer a paywall, and the server still refuses when it should.
 * The role table can't know the plan, so it has no say in it.
 */
export function teamCreationFor(
  workspace: Pick<Workspace, "role" | "capabilities"> | null | undefined
): TeamCreation {
  if (!workspaceCan(workspace, "manage_teams")) return "unavailable";
  return workspace?.capabilities?.create_teams === false ? "paywall" : "allowed";
}

/**
 * Whether the caller may do something on a team. The server's capabilities win; an older API sent
 * none, so managing follows the workspace and leaving, which needs a row it can't see, is false.
 */
export function teamCan(
  team: Pick<Team, "capabilities">,
  workspace: Pick<Workspace, "role" | "capabilities"> | null | undefined,
  capability: keyof TeamCapabilities
): boolean {
  if (team.capabilities) return team.capabilities[capability] === true;
  return capability === "leave" ? false : workspaceCan(workspace, "manage_teams");
}
