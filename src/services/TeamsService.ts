import { cloudGet, cloudPost, cloudDelete, type DataWrap } from "./cloudApi.js";
import type { Team, TeamMember } from "../types/electron";

async function list(workspaceId: string): Promise<Team[]> {
  const res = await cloudGet<DataWrap<Team[]>>(`/api/workspaces/${workspaceId}/teams`);
  return res.data;
}

async function create(
  workspaceId: string,
  input: { name: string; description?: string }
): Promise<Team> {
  const res = await cloudPost<DataWrap<Team>>(`/api/workspaces/${workspaceId}/teams`, input);
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
  list,
  create,
  remove,
  listMembers,
  addMember,
  removeMember,
};
