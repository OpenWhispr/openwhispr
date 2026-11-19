import { cloudGet, cloudPost, cloudPatch, cloudDelete, type DataWrap } from "./cloudApi.js";
import type { Team, TeamInvitation, TeamMember } from "../types/electron";

async function list(workspaceId: string): Promise<Team[]> {
  const res = await cloudGet<DataWrap<Team[]>>(`/api/workspaces/${workspaceId}/teams`);
  return res.data;
}

async function create(
  workspaceId: string,
  input: { name: string; description?: string; member_ids?: string[] }
): Promise<Team> {
  const res = await cloudPost<DataWrap<Team>>(`/api/workspaces/${workspaceId}/teams`, input);
  return res.data;
}

async function update(teamId: string, updates: { name: string }): Promise<Team> {
  const res = await cloudPatch<DataWrap<Team>>(`/api/teams/${teamId}`, updates);
  return res.data;
}

async function remove(teamId: string): Promise<void> {
  await cloudDelete(`/api/teams/${teamId}`);
}

async function listMembers(teamId: string): Promise<TeamMember[]> {
  const res = await cloudGet<DataWrap<TeamMember[]>>(`/api/teams/${teamId}/members`);
  return res.data;
}

// Changes the role of someone already on the team. Unlike POST /members, which adds whoever it is
// sent, a role picked from a roster that is out of date can't bring back someone removed since: the
// API answers 404 "Member not found".
async function setMemberRole(
  teamId: string,
  userId: string,
  role: "admin" | "member"
): Promise<void> {
  await cloudPatch(`/api/teams/${teamId}/members/${userId}`, { role });
}

async function addMembers(
  teamId: string,
  userIds: string[]
): Promise<{ added: string[]; already_members: string[] }> {
  const res = await cloudPost<DataWrap<{ added: string[]; already_members: string[] }>>(
    `/api/teams/${teamId}/members/batch`,
    { user_ids: userIds }
  );
  return res.data;
}

async function listInvitations(teamId: string): Promise<TeamInvitation[]> {
  const res = await cloudGet<DataWrap<TeamInvitation[]>>(`/api/teams/${teamId}/invitations`);
  return res.data;
}

async function removeMember(teamId: string, userId: string): Promise<void> {
  await cloudDelete(`/api/teams/${teamId}/members/${userId}`);
}

export const TeamsService = {
  list,
  create,
  update,
  remove,
  listMembers,
  setMemberRole,
  addMembers,
  listInvitations,
  removeMember,
};
