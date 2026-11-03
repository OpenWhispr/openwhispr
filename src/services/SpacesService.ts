import {
  cloudGet,
  cloudGetForAuthValidation,
  cloudPost,
  cloudPatch,
  cloudDelete,
  type DataWrap,
} from "./cloudApi.js";
import type {
  SpaceCapabilities,
  SpaceInvitation,
  SpaceTeamRef,
  TeamMember,
  TeamRole,
  WorkspaceSpace,
} from "../types/electron";

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
  // Server-computed permissions; absent from older APIs.
  capabilities?: SpaceCapabilities;
  created_at: string;
  updated_at: string;
}

// PATCH /api/spaces/:id answers with the space row only, without the caller's access.
export type SpaceRecord = Pick<
  MySpace,
  "id" | "workspace_id" | "name" | "slug" | "description" | "emoji" | "created_at" | "updated_at"
>;

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
    is_default?: boolean;
    is_open?: boolean;
    member_ids: string[];
    team_ids: string[];
  }
): Promise<MySpace> {
  const res = await cloudPost<DataWrap<MySpace>>(`/api/workspaces/${workspaceId}/spaces`, input);
  return res.data;
}

async function update(
  spaceId: string,
  patch: {
    name?: string;
    description?: string | null;
    emoji?: string | null;
    is_default?: boolean;
    is_open?: boolean;
  }
): Promise<SpaceRecord> {
  const res = await cloudPatch<DataWrap<SpaceRecord>>(`/api/spaces/${spaceId}`, patch);
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

// The workspace's space directory: spaces the caller is not in appear too, with can_join and the
// admins to ask, so the pages can offer to join or request access.
async function listInWorkspace(workspaceId: string): Promise<WorkspaceSpace[]> {
  const res = await cloudGet<DataWrap<WorkspaceSpace[]>>(`/api/workspaces/${workspaceId}/spaces`);
  return res.data;
}

// How many of the given people are already in each space, for the Add people picker.
async function coverage(
  workspaceId: string,
  userIds: string[]
): Promise<{ space_id: string; count: number }[]> {
  const res = await cloudPost<DataWrap<{ space_id: string; count: number }[]>>(
    `/api/workspaces/${workspaceId}/spaces/coverage`,
    { user_ids: userIds }
  );
  return res.data;
}

// Only an open space can be joined by the caller; joined is false when they were already in.
async function join(spaceId: string): Promise<{ joined: boolean }> {
  const res = await cloudPost<DataWrap<{ joined: boolean }>>(`/api/spaces/${spaceId}/join`);
  return res.data;
}

// Unlike addMember this never changes someone's role: people already in the space come back
// as already_members.
async function addMembers(
  spaceId: string,
  userIds: string[]
): Promise<{ added: string[]; already_members: string[] }> {
  const res = await cloudPost<DataWrap<{ added: string[]; already_members: string[] }>>(
    `/api/spaces/${spaceId}/members/batch`,
    { user_ids: userIds }
  );
  return res.data;
}

async function listInvitations(spaceId: string): Promise<SpaceInvitation[]> {
  const res = await cloudGet<DataWrap<SpaceInvitation[]>>(`/api/spaces/${spaceId}/invitations`);
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
  setMemberRole,
  removeMember,
  listInWorkspace,
  coverage,
  join,
  addMembers,
  listInvitations,
};
