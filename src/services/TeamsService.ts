import { cloudGet, cloudPost, cloudPatch, cloudDelete } from "./cloudApi.js";
import type { Team, TeamMember } from "../types/electron";

interface DataWrap<T> {
  data: T;
}

export interface MyTeam {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  emoji: string | null;
  my_role: "admin" | "member";
  member_count: number;
  created_at: string;
  updated_at: string;
}

// Every team the caller can access across all their workspaces (explicit
// membership or implicit workspace owner/admin). Drives the spaces sync pass.
async function myTeams(): Promise<MyTeam[]> {
  const res = await cloudGet<DataWrap<MyTeam[]>>("/api/me/teams");
  return res.data;
}

async function list(workspaceId: string): Promise<Team[]> {
  const res = await cloudGet<DataWrap<Team[]>>(`/api/workspaces/${workspaceId}/teams`);
  return res.data;
}

async function create(
  workspaceId: string,
  input: { name: string; description?: string; emoji?: string | null }
): Promise<Team> {
  const res = await cloudPost<DataWrap<Team>>(`/api/workspaces/${workspaceId}/teams`, input);
  return res.data;
}

async function update(
  teamId: string,
  patch: { name?: string; description?: string; emoji?: string | null }
): Promise<Team> {
  const res = await cloudPatch<DataWrap<Team>>(`/api/teams/${teamId}`, patch);
  return res.data;
}

async function remove(teamId: string): Promise<void> {
  await cloudDelete(`/api/teams/${teamId}`);
}

async function listMembers(teamId: string): Promise<TeamMember[]> {
  const res = await cloudGet<DataWrap<TeamMember[]>>(`/api/teams/${teamId}/members`);
  return res.data;
}

async function addMember(
  teamId: string,
  userId: string,
  role: "admin" | "member" = "member"
): Promise<void> {
  await cloudPost(`/api/teams/${teamId}/members`, { user_id: userId, role });
}

async function removeMember(teamId: string, userId: string): Promise<void> {
  await cloudDelete(`/api/teams/${teamId}/members/${userId}`);
}

export const TeamsService = {
  myTeams,
  list,
  create,
  update,
  remove,
  listMembers,
  addMember,
  removeMember,
};
