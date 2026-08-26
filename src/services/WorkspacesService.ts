import { cloudGet, cloudPost, cloudPatch, cloudDelete, type DataWrap } from "./cloudApi.js";
import type {
  JoinableWorkspace,
  Workspace,
  WorkspaceJoinRequest,
  WorkspaceMember,
} from "../types/electron";

export interface SeatPreview {
  next_quantity: number;
  current_quantity: number;
  seats_used: number;
  amount_due: number;
  currency: string;
}

export interface EnterpriseUpgradePreview {
  // Prorated difference in cents, collected on the next invoice (Stripe
  // create_prorations), not charged at confirmation time.
  prorated_amount: number;
  currency: string;
  current_price_amount: number | null;
  new_price_amount: number | null;
  interval: "monthly" | "annual";
  quantity: number;
  next_billing_date: string | null;
}

async function list(): Promise<Workspace[]> {
  const res = await cloudGet<DataWrap<Workspace[]>>("/api/workspaces");
  return res.data;
}

async function create(name: string): Promise<Workspace> {
  const res = await cloudPost<DataWrap<Workspace>>("/api/workspaces", { name });
  return res.data;
}

async function update(workspaceId: string, patch: { name?: string }): Promise<Workspace> {
  const res = await cloudPatch<DataWrap<Workspace>>(`/api/workspaces/${workspaceId}`, patch);
  return res.data;
}

async function remove(workspaceId: string): Promise<void> {
  await cloudDelete(`/api/workspaces/${workspaceId}`);
}

async function listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  const res = await cloudGet<DataWrap<WorkspaceMember[]>>(`/api/workspaces/${workspaceId}/members`);
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
  interval: "monthly" | "annual" = "monthly",
  options?: { tier?: "business" | "enterprise"; additionalSeats?: number }
): Promise<string> {
  const res = await cloudPost<DataWrap<{ url: string }>>(
    `/api/workspaces/${workspaceId}/billing/checkout`,
    {
      interval,
      ...(options?.tier ? { tier: options.tier } : {}),
      ...(options?.additionalSeats ? { additional_seats: options.additionalSeats } : {}),
    }
  );
  return res.data.url;
}

async function billingPortal(workspaceId: string): Promise<string> {
  const res = await cloudPost<DataWrap<{ url: string }>>(
    `/api/workspaces/${workspaceId}/billing/portal`
  );
  return res.data.url;
}

async function previewSeats(workspaceId: string, additionalSeats: number): Promise<SeatPreview> {
  const res = await cloudPost<DataWrap<SeatPreview>>(
    `/api/workspaces/${workspaceId}/billing/preview-seats`,
    {
      additional_seats: additionalSeats,
    }
  );
  return res.data;
}

async function previewEnterpriseUpgrade(workspaceId: string): Promise<EnterpriseUpgradePreview> {
  const res = await cloudPost<DataWrap<EnterpriseUpgradePreview>>(
    `/api/workspaces/${workspaceId}/billing/preview-upgrade`
  );
  return res.data;
}

async function upgradeToEnterprise(workspaceId: string): Promise<void> {
  await cloudPost<DataWrap<{ plan: string }>>(`/api/workspaces/${workspaceId}/billing/upgrade`);
}

async function updateSeats(
  workspaceId: string,
  quantity: number
): Promise<{ quantity: number; seats_used: number }> {
  const res = await cloudPost<DataWrap<{ quantity: number; seats_used: number }>>(
    `/api/workspaces/${workspaceId}/billing/seats`,
    { quantity }
  );
  return res.data;
}

/** Invitations the caller can accept and company-domain workspaces they can ask to join. */
async function listJoinable(): Promise<JoinableWorkspace[]> {
  const res = await cloudGet<DataWrap<JoinableWorkspace[]>>("/api/me/joinable");
  return res.data;
}

async function join(workspaceId: string): Promise<{ workspace_id: string; role: string }> {
  const res = await cloudPost<DataWrap<{ workspace_id: string; role: string }>>(
    "/api/me/joinable",
    { workspace_id: workspaceId }
  );
  return res.data;
}

/** Ask a workspace's admins for access. Grants nothing until one approves. */
async function requestJoin(workspaceId: string): Promise<void> {
  await cloudPost("/api/me/joinable/request", { workspace_id: workspaceId });
}

async function listJoinRequests(workspaceId: string): Promise<WorkspaceJoinRequest[]> {
  const res = await cloudGet<DataWrap<WorkspaceJoinRequest[]>>(
    `/api/workspaces/${workspaceId}/join-requests`
  );
  return res.data;
}

async function decideJoinRequest(
  workspaceId: string,
  requestId: string,
  decision: "approve" | "deny"
): Promise<void> {
  await cloudPatch(`/api/workspaces/${workspaceId}/join-requests/${requestId}`, { decision });
}

export const WorkspacesService = {
  listJoinable,
  join,
  requestJoin,
  listJoinRequests,
  decideJoinRequest,
  list,
  create,
  update,
  remove,
  listMembers,
  updateMemberRole,
  removeMember,
  billingCheckout,
  billingPortal,
  previewSeats,
  previewEnterpriseUpgrade,
  upgradeToEnterprise,
  updateSeats,
};
