import {
  CloudApiError,
  cloudGet,
  cloudPost,
  cloudPostForAuthGeneration,
  cloudPatch,
  cloudDelete,
  type DataWrap,
} from "./cloudApi.js";
import type {
  JoinableWorkspace,
  MemberRemovalPreview,
  MemberRemovalResult,
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
  member_seats?: number;
  pending_seats?: number;
  unit_amount?: number | null;
  interval?: "monthly" | "annual" | null;
  proration_amount?: number;
  next_invoice_amount?: number;
  next_invoice_date?: string | null;
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

/**
 * The account's default workspace, made with `name` the first time and returned as it is after
 * that. Null for an Enterprise member (`reason: "enterprise_managed"`), who gets none.
 */
async function ensureDefault(name: string): Promise<Workspace | null> {
  const res = await cloudPost<{ data: Workspace | null; reason?: "enterprise_managed" }>(
    "/api/workspaces/default",
    { name }
  );
  return res.data ?? null;
}

/**
 * Whether the account is no longer in the workspace. A list can leave out one it still has (an
 * empty or stale answer), so only the workspace's own 404 says so; any other failure throws.
 */
async function isLost(workspaceId: string): Promise<boolean> {
  try {
    await cloudGet(`/api/workspaces/${workspaceId}`, "no-store");
    return false;
  } catch (error) {
    if (error instanceof CloudApiError && error.status === 404) return true;
    throw error;
  }
}

async function update(workspaceId: string, patch: { name?: string }): Promise<Workspace> {
  const res = await cloudPatch<DataWrap<Workspace>>(`/api/workspaces/${workspaceId}`, patch);
  return res.data;
}

async function uploadIcon(
  workspaceId: string,
  data: string,
  authGeneration: number
): Promise<Workspace> {
  const res = await cloudPostForAuthGeneration<DataWrap<Workspace>>(
    `/api/workspaces/${workspaceId}/icon`,
    { data },
    authGeneration
  );
  return res.data;
}

async function removeIcon(workspaceId: string): Promise<Workspace> {
  const res = await cloudDelete<DataWrap<Workspace>>(`/api/workspaces/${workspaceId}/icon`);
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

// The server answers a preview with the same ownership counts a refused removal would, without
// removing anyone.
async function previewMemberRemoval(
  workspaceId: string,
  userIds: string[]
): Promise<MemberRemovalPreview> {
  const res = await cloudPost<DataWrap<MemberRemovalPreview>>(
    `/api/workspaces/${workspaceId}/members/remove`,
    { user_ids: userIds, preview: true }
  );
  return res.data;
}

async function removeMembers(
  workspaceId: string,
  input: { userIds: string[]; transferTo?: string }
): Promise<MemberRemovalResult> {
  const res = await cloudPost<DataWrap<MemberRemovalResult>>(
    `/api/workspaces/${workspaceId}/members/remove`,
    {
      user_ids: input.userIds,
      ...(input.transferTo ? { transfer_to: input.transferTo } : {}),
    }
  );
  return res.data;
}

interface WorkspacePeopleCounts {
  seats?: number;
  billable_members?: number;
  member_count: number;
  pending_invitations: number;
}

async function getPeopleCounts(workspaceId: string): Promise<WorkspacePeopleCounts> {
  const res = await cloudGet<DataWrap<WorkspacePeopleCounts>>(
    `/api/workspaces/${workspaceId}/stats`,
    "no-store"
  );
  const counts = res.data;
  if (!Number.isInteger(counts?.member_count) || !Number.isInteger(counts?.pending_invitations)) {
    throw new Error("Workspace people counts are unavailable");
  }
  return counts;
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

async function billingPortal(workspaceId: string, authGeneration?: number): Promise<string> {
  const path = `/api/workspaces/${workspaceId}/billing/portal`;
  const res =
    authGeneration === undefined
      ? await cloudPost<DataWrap<{ url: string }>>(path)
      : await cloudPostForAuthGeneration<DataWrap<{ url: string }>>(
          path,
          undefined,
          authGeneration
        );
  return res.data.url;
}

/** With an auth generation the quote is fenced to that sign-in. */
async function previewSeats(
  workspaceId: string,
  additionalSeats: number,
  authGeneration?: number
): Promise<SeatPreview> {
  const path = `/api/workspaces/${workspaceId}/billing/preview-seats`;
  const body = { additional_seats: additionalSeats };
  const res =
    authGeneration === undefined
      ? await cloudPost<DataWrap<SeatPreview>>(path, body)
      : await cloudPostForAuthGeneration<DataWrap<SeatPreview>>(path, body, authGeneration);
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

/** With an auth generation the change is fenced to that sign-in. */
async function updateSeats(
  workspaceId: string,
  quantity: number,
  authGeneration?: number
): Promise<{ quantity: number; seats_used: number }> {
  const path = `/api/workspaces/${workspaceId}/billing/seats`;
  const body = { quantity };
  const res =
    authGeneration === undefined
      ? await cloudPost<DataWrap<{ quantity: number; seats_used: number }>>(path, body)
      : await cloudPostForAuthGeneration<DataWrap<{ quantity: number; seats_used: number }>>(
          path,
          body,
          authGeneration
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
  ensureDefault,
  isLost,
  update,
  uploadIcon,
  removeIcon,
  remove,
  listMembers,
  updateMemberRole,
  removeMember,
  previewMemberRemoval,
  removeMembers,
  getPeopleCounts,
  billingCheckout,
  billingPortal,
  previewSeats,
  previewEnterpriseUpgrade,
  upgradeToEnterprise,
  updateSeats,
};
