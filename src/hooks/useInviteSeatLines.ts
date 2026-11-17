import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { WorkspacesService, type SeatPreview } from "../services/WorkspacesService";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { formatAmount } from "../utils/formatAmount";

const SEAT_PREVIEW_DEBOUNCE_MS = 300;

/**
 * The seats left and what new invitations would cost, for anywhere addresses can be invited.
 * `pricedCount` is how many invitations to price; null prices none.
 */
export function useInviteSeatLines(workspaceId: string, open: boolean, pricedCount: number | null) {
  const { t } = useTranslation();
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const [seatPreview, setSeatPreview] = useState<SeatPreview | null>(null);
  // Prices for adding more than one seat, by seat count.
  const [batchPreviews, setBatchPreviews] = useState<ReadonlyMap<number, SeatPreview>>(
    () => new Map()
  );

  // A free workspace's `seats` is a placeholder, so only a subscription has purchased seats left.
  const workspaceSeatsUsed = workspace?.seats_used;
  const purchasedLeft =
    workspace?.has_subscription === true &&
    typeof workspace.seats === "number" &&
    typeof workspaceSeatsUsed === "number"
      ? workspace.seats - workspaceSeatsUsed
      : null;

  // The seat line, the warning and the ceiling all read the list's seats_used, which canceled
  // invitations and other admins change without this device reading it again.
  useEffect(() => {
    if (open) void useWorkspaceStore.getState().refresh({ fresh: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    WorkspacesService.previewSeats(workspaceId, 1)
      .then((preview) => {
        if (!cancelled) setSeatPreview(preview);
      })
      // A free workspace, or an admin: the preview needs a subscription and the owner. The seat
      // line reads the workspace list's count instead.
      .catch(() => undefined);
    return () => {
      cancelled = true;
      setSeatPreview(null);
      setBatchPreviews(new Map());
    };
  }, [open, workspaceId]);

  // Seats this send would add if every invitation is accepted: those it needs beyond the
  // subscription's free ones.
  const billedSeats =
    seatPreview === null || pricedCount === null
      ? 0
      : Math.max(0, seatPreview.seats_used + pricedCount - seatPreview.current_quantity);

  useEffect(() => {
    if (!open || billedSeats <= 1 || batchPreviews.has(billedSeats)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      WorkspacesService.previewSeats(workspaceId, billedSeats)
        .then((preview) => {
          if (!cancelled) setBatchPreviews((current) => new Map(current).set(billedSeats, preview));
        })
        // The line still says how many seats are added, just without a price.
        .catch(() => undefined);
    }, SEAT_PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, workspaceId, billedSeats, batchPreviews]);

  // The list's count includes pending invitations, as the seat warning's does. A free workspace's
  // `seats` is a placeholder, so "Using 12 of 1 seats" would read wrong.
  const seatLine =
    purchasedLeft !== null
      ? t("workspaces.invite.seatUsage", { used: workspaceSeatsUsed, seats: workspace?.seats })
      : null;
  // The opening preview prices one added seat; more come from their own preview.
  const batchPreview = billedSeats > 1 ? batchPreviews.get(billedSeats) : undefined;
  let seatCostLine: string | null = null;
  if (billedSeats === 1 && seatPreview) {
    seatCostLine = t("workspaces.invite.seatCost", {
      amount: formatAmount(seatPreview.amount_due, seatPreview.currency),
    });
  } else if (billedSeats > 1) {
    seatCostLine = batchPreview
      ? t("workspaces.invite.seatCostMany", {
          count: billedSeats,
          amount: formatAmount(batchPreview.amount_due, batchPreview.currency),
        })
      : t("workspaces.invite.seatCostManyUnpriced", { count: billedSeats });
  }

  return { workspace, purchasedLeft, seatLine, seatCostLine };
}
