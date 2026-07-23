import { cloudGet, cloudPost, cloudPatch, cloudDelete } from "./cloudApi.js";
import type { SpaceTeamRef, TeamMember } from "../types/electron";

interface DataWrap<T> {
  data: T;
}

export interface MySpace {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  emoji: string | null;
  my_role: "admin" | "member";
  member_count: number;
  teams: SpaceTeamRef[];
  created_at: string;
  updated_at: string;
}

// Union roster entry: one row per user across all assigned teams, with
// attribution of which team(s) grant the access.
export interface SpaceMemberEntry extends TeamMember {
  via_teams: { team_id: string; name: string; role: "admin" | "member" }[];
}

// Every space the caller can access across all their workspaces (member of any
// assigned live team, or implicit workspace owner/admin). Drives the spaces
// sync pass.
async function mySpaces(): Promise<MySpace[]> {
  const res = await cloudGet<DataWrap<MySpace[]>>("/api/me/spaces");
  return res.data;
}

async function create(
  workspaceId: string,
  input: { name: string; emoji?: string | null; description?: string; team_ids: string[] }
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

async function assignTeam(spaceId: string, teamId: string): Promise<void> {
  await cloudPost(`/api/spaces/${spaceId}/teams`, { team_id: teamId });
}

async function unassignTeam(spaceId: string, teamId: string): Promise<void> {
  await cloudDelete(`/api/spaces/${spaceId}/teams/${teamId}`);
}

async function listMembers(spaceId: string): Promise<SpaceMemberEntry[]> {
  const res = await cloudGet<DataWrap<SpaceMemberEntry[]>>(`/api/spaces/${spaceId}/members`);
  return res.data;
}

export const SpacesService = {
  mySpaces,
  create,
  update,
  remove,
  assignTeam,
  unassignTeam,
  listMembers,
};
