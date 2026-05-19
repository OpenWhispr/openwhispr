import { cloudGet, cloudPost, cloudPatch, cloudDelete } from "./cloudApi.js";
import type { Workspace, WorkspaceMember } from "../types/electron";

interface DataWrap<T> {
  data: T;
}

async function list(): Promise<Workspace[]> {
  const res = await cloudGet<DataWrap<Workspace[]>>("/api/workspaces");
  return res.data;
}

async function create(name: string): Promise<Workspace> {
  const res = await cloudPost<DataWrap<Workspace>>("/api/workspaces", { name });
  return res.data;
}

async function get(workspaceId: string): Promise<Workspace> {
  const res = await cloudGet<DataWrap<Workspace>>(`/api/workspaces/${workspaceId}`);
  return res.data;
}

async function update(
  workspaceId: string,
  patch: { name?: string; slug?: string }
): Promise<Workspace> {
  const res = await cloudPatch<DataWrap<Workspace>>(`/api/workspaces/${workspaceId}`, patch);
  return res.data;
}

async function remove(workspaceId: string): Promise<void> {
  await cloudDelete(`/api/workspaces/${workspaceId}`);
}

async function listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  const res = await cloudGet<DataWrap<WorkspaceMember[]>>(
    `/api/workspaces/${workspaceId}/members`
  );
  return res.data;
}

async function updateMemberRole(
  workspaceId: string,
  userId: string,
  role: "owner" | "admin" | "member"
): Promise<void> {
  await cloudPatch(`/api/workspaces/${workspaceId}/members/${userId}`, { role });
}

async function removeMember(workspaceId: string, userId: string): Promise<void> {
  await cloudDelete(`/api/workspaces/${workspaceId}/members/${userId}`);
}

async function billingCheckout(
  workspaceId: string,
  interval: "monthly" | "annual" = "monthly"
): Promise<string> {
  const res = await cloudPost<DataWrap<{ url: string }>>(
    `/api/workspaces/${workspaceId}/billing/checkout`,
    { interval }
  );
  return res.data.url;
}

async function billingPortal(workspaceId: string): Promise<string> {
  const res = await cloudPost<DataWrap<{ url: string }>>(
    `/api/workspaces/${workspaceId}/billing/portal`
  );
  return res.data.url;
}

async function previewSeats(
  workspaceId: string,
  additionalSeats: number
): Promise<{ next_quantity: number; amount_due: number; currency: string }> {
  const res = await cloudPost<
    DataWrap<{ next_quantity: number; amount_due: number; currency: string }>
  >(`/api/workspaces/${workspaceId}/billing/preview-seats`, {
    additional_seats: additionalSeats,
  });
  return res.data;
}

export const WorkspacesService = {
  list,
  create,
  get,
  update,
  remove,
  listMembers,
  updateMemberRole,
  removeMember,
  billingCheckout,
  billingPortal,
  previewSeats,
};
