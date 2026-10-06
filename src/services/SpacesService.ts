import {
  cloudGet,
  cloudGetForAuthValidation,
  cloudPost,
  cloudPatch,
  cloudDelete,
  type DataWrap,
} from "./cloudApi.js";
import type { SpaceTeamRef, TeamMember, TeamRole } from "../types/electron";

export interface MySpace {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  emoji: string | null;
  my_role: TeamRole;
  // Direct space_members grant; null when access is via teams or workspace role.
  my_direct_role: TeamRole | null;
  member_count: number;
  teams: SpaceTeamRef[];
  created_at: string;
  updated_at: string;
}

// Union roster entry: one row per user across direct members and all assigned
// teams, with attribution of which grant(s) convey the access. via_teams is
// [] for a direct-only member.
export interface SpaceMemberEntry extends TeamMember {
  direct_role: TeamRole | null;
  via_teams: {
    team_id: string;
    name: string;
    role: TeamRole;
    access?: TeamRole;
  }[];
}

// Every space the caller can access across all their workspaces (direct
// member, member of any assigned live team, or implicit workspace owner/admin).
// Drives the spaces sync pass.
async function mySpaces(): Promise<MySpace[]> {
  const res = await cloudGet<DataWrap<MySpace[]>>("/api/me/spaces");
  return res.data;
}

async function mySpacesForAuthValidation(generation: number): Promise<MySpace[]> {
  const res = await cloudGetForAuthValidation<DataWrap<MySpace[]>>("/api/me/spaces", generation);
  return res.data;
}

// The creator becomes a direct admin server-side; member_ids join as members.
async function create(
  workspaceId: string,
  input: {
    name: string;
    emoji?: string | null;
    description?: string;
    member_ids: string[];
    team_ids: string[];
  }
): Promise<MySpace> {
  const res = await cloudPost<DataWrap<MySpace>>(`/api/workspaces/${workspaceId}/spaces`, input);
  return res.data;
}

async function update(
  spaceId: string,
  patch: { name?: string; description?: string; emoji?: string | null }
): Promise<MySpace> {
  const res = await cloudPatch<DataWrap<MySpace>>(`/api/spaces/${spaceId}`, patch);
  return res.data;
}

async function remove(spaceId: string): Promise<void> {
  await cloudDelete(`/api/spaces/${spaceId}`);
}

// The teams POST upserts: with access it also updates an existing
// assignment's cap; without it the server keeps the current value.
async function assignTeam(spaceId: string, teamId: string, access?: TeamRole): Promise<void> {
  await cloudPost(`/api/spaces/${spaceId}/teams`, {
    team_id: teamId,
    ...(access ? { access } : {}),
  });
}

async function unassignTeam(spaceId: string, teamId: string): Promise<void> {
  await cloudDelete(`/api/spaces/${spaceId}/teams/${teamId}`);
}

async function listMembers(spaceId: string): Promise<SpaceMemberEntry[]> {
  const res = await cloudGet<DataWrap<SpaceMemberEntry[]>>(`/api/spaces/${spaceId}/members`);
  return res.data;
}

// The members POST upserts, so re-adding an existing direct member changes
// their role rather than failing.
async function addMember(
  spaceId: string,
  userId: string,
  role: TeamRole = "member"
): Promise<void> {
  await cloudPost(`/api/spaces/${spaceId}/members`, { user_id: userId, role });
}

// Promoting someone who is only present via a team creates their direct row.
async function setMemberRole(spaceId: string, userId: string, role: TeamRole): Promise<void> {
  await cloudPatch(`/api/spaces/${spaceId}/members/${userId}`, { role });
}

export interface SpaceMemberRemoval {
  removed: boolean;
  still_via_teams: { team_id: string; name: string }[];
}

// Deletes only the direct grant; still_via_teams names the teams that keep
// the user in the space, so callers can say so.
async function removeMember(spaceId: string, userId: string): Promise<SpaceMemberRemoval> {
  const res = await cloudDelete<DataWrap<SpaceMemberRemoval>>(
    `/api/spaces/${spaceId}/members/${userId}`
  );
  return res.data;
}

export const SpacesService = {
  mySpaces,
  mySpacesForAuthValidation,
  create,
  update,
  remove,
  assignTeam,
  unassignTeam,
  listMembers,
  addMember,
  setMemberRole,
  removeMember,
};
