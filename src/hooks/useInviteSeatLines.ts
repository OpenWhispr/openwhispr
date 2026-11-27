import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { getValidatedAuthGeneration, subscribeAuthRequestContext } from "../lib/authRequestContext";
import { workspaceCan } from "../lib/capabilities";
import { WorkspacesService, type SeatPreview } from "../services/WorkspacesService";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { Workspace } from "../types/electron";
import { formatAmount } from "../utils/formatAmount";

const SEAT_PREVIEW_DEBOUNCE_MS = 300;

interface InviteQuoteScope {
  workspaceId: string;
  generation: number;
}

interface InviteQuotes {
  scope: InviteQuoteScope;
  single: SeatPreview;
  batches: ReadonlyMap<number, SeatPreview>;
}

interface InviteSeatLines {
  workspace: Workspace | undefined;
  purchasedLeft: number | null;
  seatLine: string | null;
  seatCostLine: string | null;
}

/**
 * The seats left and what new invitations would cost, for anywhere addresses can be invited.
 * `pricedCount` is how many invitations to price; null prices none.
 */
export function useInviteSeatLines(
  workspaceId: string,
  open: boolean,
  pricedCount: number | null
): InviteSeatLines {
  const { t } = useTranslation();
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const generation = useSyncExternalStore(
    subscribeAuthRequestContext,
    getValidatedAuthGeneration,
    () => null
  );
  const canManageBilling = workspaceCan(workspace, "manage_billing");
  const scope = useMemo(
    (): InviteQuoteScope | null =>
      open && canManageBilling && generation !== null ? { workspaceId, generation } : null,
    [open, canManageBilling, workspaceId, generation]
  );
  const [storedQuotes, setQuotes] = useState<InviteQuotes | null>(null);
  const quotes = storedQuotes?.scope === scope ? storedQuotes : null;
  const seatPreview = quotes?.single ?? null;

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
    if (open && generation !== null) {
      void useWorkspaceStore.getState().refresh({ fresh: true });
    }
  }, [open, generation]);

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    WorkspacesService.previewSeats(scope.workspaceId, 1, scope.generation)
      .then((preview): void => {
        if (!cancelled && preview && getValidatedAuthGeneration() === scope.generation) {
          setQuotes({ scope, single: preview, batches: new Map() });
        }
      })
      // A workspace without a subscription cannot preview. The usage line still uses the list.
      .catch(() => undefined);
    return (): void => {
      cancelled = true;
    };
  }, [scope]);

  // Seats this send would add if every invitation is accepted: those it needs beyond the
  // subscription's free ones.
  const billedSeats =
    seatPreview === null || pricedCount === null
      ? 0
      : Math.max(0, seatPreview.seats_used + pricedCount - seatPreview.current_quantity);

  const batchPreview = billedSeats > 1 ? quotes?.batches.get(billedSeats) : undefined;
  useEffect(() => {
    if (!scope || billedSeats <= 1 || batchPreview) return;
    let cancelled = false;
    const timer = setTimeout((): void => {
      if (getValidatedAuthGeneration() !== scope.generation) return;
      WorkspacesService.previewSeats(scope.workspaceId, billedSeats, scope.generation)
        .then((preview): void => {
          if (cancelled || !preview || getValidatedAuthGeneration() !== scope.generation) return;
          setQuotes((current): InviteQuotes | null =>
            current?.scope === scope
              ? { ...current, batches: new Map(current.batches).set(billedSeats, preview) }
              : current
          );
        })
        // The line still says how many seats are added, just without a price.
        .catch(() => undefined);
    }, SEAT_PREVIEW_DEBOUNCE_MS);
    return (): void => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [scope, billedSeats, batchPreview]);

  // The list's count includes pending invitations, as the seat warning's does. A free workspace's
  // `seats` is a placeholder, so "Using 12 of 1 seats" would read wrong.
  const seatLine =
    purchasedLeft !== null
      ? t("workspaces.invite.seatUsage", { used: workspaceSeatsUsed, seats: workspace?.seats })
      : null;
  // The opening preview prices one added seat; more come from their own preview.
  let seatCostLine: string | null = null;
  const priced = billedSeats === 1 ? seatPreview : batchPreview;
  if (billedSeats > 0) {
    // Legacy amount_due is the whole invoice. Only a split quote can price the added seats.
    if (priced?.proration_amount == null) {
      seatCostLine = t("workspaces.invite.seatCostManyUnpriced", { count: billedSeats });
    } else {
      const amount = formatAmount(priced.proration_amount, priced.currency);
      seatCostLine =
        billedSeats === 1
          ? t("workspaces.invite.seatCost", { amount })
          : t("workspaces.invite.seatCostMany", { count: billedSeats, amount });
    }
  }

  return { workspace, purchasedLeft, seatLine, seatCostLine };
}
