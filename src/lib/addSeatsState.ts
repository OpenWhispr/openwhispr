import type { WorkspaceBillingSummary } from "../services/BillingSummaryService";
import type { SeatPreview } from "../services/WorkspacesService";
import type { Workspace } from "../types/electron";
import { formatAmount } from "../utils/formatAmount";

export const LEGACY_WORKSPACE_SEAT_LIMIT = 500;
const MAX_SEAT_DELTA = 20;

type SeatInterval = NonNullable<SeatPreview["interval"]>;

interface SeatRow {
  kind: "inUse" | "pending" | "available" | "total";
  now: number;
  after: number;
}

interface SeatInvoice {
  amount: string;
  date: string | null;
}

interface AddSeatsInput {
  workspace: Pick<Workspace, "seats" | "seats_used" | "seat_limit">;
  selectedDelta?: number;
  preview?: SeatPreview | null;
  summary?: WorkspaceBillingSummary | null;
}

export interface AddSeatsState {
  delta: number;
  maxDelta: number;
  occupancyMinimum: number | null;
  rows: SeatRow[];
  nextQuantity: number | null;
  unitPrice: string | null;
  proration: string | null;
  invoice: SeatInvoice | null;
}

export function monthlyEquivalentSeatAmount(unitAmount: number, interval: SeatInterval): number {
  return interval === "annual" ? unitAmount / 12 : unitAmount;
}

export function addSeatsState({
  workspace,
  selectedDelta = 1,
  preview,
  summary,
}: AddSeatsInput): AddSeatsState {
  const purchased = preview?.current_quantity ?? workspace.seats;
  const seatLimit = workspace.seat_limit ?? LEGACY_WORKSPACE_SEAT_LIMIT;
  const occupied = preview?.seats_used ?? workspace.seats_used;
  // The API refuses a purchase below occupancy. A workspace with a larger existing
  // shortfall must be able to reach that floor in one explicitly confirmed change.
  const maxChange = Math.max(MAX_SEAT_DELTA, (occupied ?? purchased) - purchased);
  const maxDelta = Math.max(0, Math.min(maxChange, seatLimit - purchased));
  const delta = Math.min(maxDelta, Math.max(0, Math.trunc(selectedDelta)));
  const purchasedAfter = purchased + delta;
  const occupancyMinimum =
    delta > 0 && occupied != null && purchasedAfter < occupied ? occupied : null;
  const quote =
    delta > 0 && occupancyMinimum === null && preview?.next_quantity === purchasedAfter
      ? preview
      : null;

  const rows: SeatRow[] = [];
  if (preview?.member_seats != null) {
    rows.push({ kind: "inUse", now: preview.member_seats, after: preview.member_seats });
  }
  // Pending seat occupancy can include unlinked directory users as well as invitations.
  if (preview?.pending_seats != null) {
    rows.push({ kind: "pending", now: preview.pending_seats, after: preview.pending_seats });
  }
  if (occupied != null) {
    rows.push({
      kind: "available",
      now: Math.max(0, purchased - occupied),
      after: Math.max(0, purchasedAfter - occupied),
    });
  }
  rows.push({ kind: "total", now: purchased, after: purchasedAfter });

  const unchangedInvoice = delta === 0 ? summary?.next_invoice : null;
  const summaryPriceCurrency = unchangedInvoice?.currency;
  const priceSource = delta === 0 ? preview : quote;
  const useSummaryPrice =
    summaryPriceCurrency && summary?.unit_amount != null && summary.interval != null;
  const unitAmount = useSummaryPrice ? summary.unit_amount : priceSource?.unit_amount;
  const interval = useSummaryPrice ? summary.interval : priceSource?.interval;
  const priceCurrency = useSummaryPrice ? summaryPriceCurrency : priceSource?.currency;
  const invoiceAmount = quote
    ? (quote.next_invoice_amount ?? quote.amount_due)
    : unchangedInvoice?.amount;
  const invoiceCurrency = quote?.currency ?? unchangedInvoice?.currency;
  const prorationAmount = delta === 0 ? 0 : quote?.proration_amount;
  const prorationCurrency = quote?.currency ?? unchangedInvoice?.currency ?? priceSource?.currency;

  return {
    delta,
    maxDelta,
    occupancyMinimum,
    rows,
    nextQuantity: quote?.next_quantity ?? null,
    unitPrice:
      unitAmount != null && interval && priceCurrency
        ? formatAmount(monthlyEquivalentSeatAmount(unitAmount, interval), priceCurrency)
        : null,
    proration:
      prorationAmount != null && prorationCurrency
        ? formatAmount(prorationAmount, prorationCurrency)
        : null,
    invoice:
      invoiceAmount != null && invoiceCurrency
        ? {
            amount: formatAmount(invoiceAmount, invoiceCurrency),
            date: quote?.next_invoice_date ?? unchangedInvoice?.date ?? null,
          }
        : null,
  };
}
