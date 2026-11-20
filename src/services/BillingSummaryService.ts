import type { BillingIdentity } from "../lib/billingRequestIdentity";
import { cloudGetForAuthGeneration, type DataWrap } from "./cloudApi";

export interface BillingSummary {
  next_invoice?: { date: string | null; amount: number; currency: string } | null;
  outstanding_invoice?: {
    amount_remaining: number;
    currency: string;
    next_payment_attempt: string | null;
  } | null;
  cancel_at_period_end?: boolean;
  billing_email?: string | null;
}

export interface WorkspaceBillingSummary extends BillingSummary {
  interval?: "monthly" | "annual" | null;
  unit_amount?: number | null;
}

export async function getBillingSummary(
  identity: BillingIdentity | null
): Promise<WorkspaceBillingSummary | undefined> {
  if (!identity) return undefined;
  const { workspaceId, authGeneration } = identity;
  const path =
    workspaceId === null
      ? "/api/billing/summary"
      : `/api/workspaces/${encodeURIComponent(workspaceId)}/billing/summary`;
  try {
    const response = await cloudGetForAuthGeneration<DataWrap<WorkspaceBillingSummary | null>>(
      path,
      authGeneration,
      "no-store"
    );
    return response?.data ?? undefined;
  } catch {
    // Legacy servers and unavailable summaries leave the rest of the plan usable.
    return undefined;
  }
}
