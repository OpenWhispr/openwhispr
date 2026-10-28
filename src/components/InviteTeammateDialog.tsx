import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "./ui/dialog";
import { InvitePeopleView, SUGGESTION_MIN_CHARS } from "./workspace/InvitePeopleView";
import {
  createInviteFlow,
  inviteReducer,
  inviteSuggestions,
  inviteSummary,
  type InviteFlowEvent,
  type InviteFlowState,
} from "../lib/inviteFlow";
import { workspaceCan } from "../lib/capabilities";
import { invitePeople } from "../services/invitePeople";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { WorkspacesService, type SeatPreview } from "../services/WorkspacesService";
import { formatAmount } from "../utils/formatAmount";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workspaceName: string;
  /** Called after each send that invited anyone, with the normalized addresses it invited. */
  onInvited?: (emails: string[]) => void;
  cancelLabel?: string;
  /** Teams the invitee joins on accept (threaded into the invitation). */
  teamIds?: string[];
  /** Spaces the invitee is added to directly on accept. */
  spaceIds?: string[];
  initialEmail?: string;
  /** Addresses that can't be invited again; their chips are blocked before anything is sent. */
  knownEmails?: { members: string[]; invited: string[] };
  /** Opens Plan & Billing from the seats warning; the warning offers no Upgrade without it. */
  onUpgrade?: () => void;
}

interface Roster {
  memberEmails: string[];
  invitedEmails: string[];
}

type Contact = { email: string; name: string | null };

const SUGGESTION_DEBOUNCE_MS = 150;
const SEAT_PREVIEW_DEBOUNCE_MS = 300;

export default function InviteTeammateDialog({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
  onInvited,
  cancelLabel,
  teamIds,
  spaceIds,
  initialEmail,
  knownEmails,
  onUpgrade,
}: Props): ReactElement {
  const { t } = useTranslation();
  const [state, setState] = useState<InviteFlowState>(() => createInviteFlow({ initialEmail }));
  const [wasOpen, setWasOpen] = useState(open);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [seatsUsed, setSeatsUsed] = useState<number | null>(null);
  const [seatPreview, setSeatPreview] = useState<SeatPreview | null>(null);
  // Prices for adding more than one seat, by seat count.
  const [batchPreviews, setBatchPreviews] = useState<ReadonlyMap<number, SeatPreview>>(
    () => new Map()
  );
  const running = useRef(false);
  const runController = useRef<AbortController | null>(null);
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const seats = workspace?.seats ?? null;
  const canManageBilling = workspaceCan(workspace, "manage_billing");
  const billingManager = workspace?.billing_manager ?? null;

  // A free workspace's `seats` is a placeholder, so only a subscription has purchased seats left.
  const workspaceSeatsUsed = workspace?.seats_used;
  const purchasedLeft =
    workspace?.has_subscription === true &&
    typeof workspace.seats === "number" &&
    typeof workspaceSeatsUsed === "number"
      ? workspace.seats - workspaceSeatsUsed
      : null;
  const ceilingLeft =
    typeof workspace?.seat_limit === "number" && typeof workspaceSeatsUsed === "number"
      ? workspace.seat_limit - workspaceSeatsUsed
      : null;

  // A fresh flow on every open, set during render so the first frame never shows the last run.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setState(createInviteFlow({ initialEmail }));
      setContacts([]);
    }
  }

  const dispatch = useCallback((event: InviteFlowEvent): void => {
    setState((current) => inviteReducer(current, event));
  }, []);

  // Callers may build `knownEmails` on every render; only a change of addresses re-judges chips.
  const rosterKey = JSON.stringify([knownEmails?.members ?? [], knownEmails?.invited ?? []]);
  const roster = useMemo((): Roster => {
    const [memberEmails, invitedEmails] = JSON.parse(rosterKey) as [string[], string[]];
    return { memberEmails, invitedEmails };
  }, [rosterKey]);
  const latestRoster = useRef(roster);
  useEffect(() => {
    latestRoster.current = roster;
    if (open) dispatch({ type: "roster", ...roster });
  }, [open, roster, dispatch]);

  // Re-sent on every open, since a fresh flow starts with nothing known. The reducer drops one
  // that arrives mid-send; the refresh after a seat refusal brings a newer one.
  useEffect(() => {
    if (open) dispatch({ type: "seats", purchasedLeft, ceilingLeft });
  }, [open, purchasedLeft, ceilingLeft, dispatch]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    WorkspacesService.previewSeats(workspaceId, 1)
      .then((preview) => {
        if (cancelled) return;
        setSeatPreview(preview);
        setSeatsUsed(preview.seats_used);
      })
      .catch(async () => {
        // Free workspace — the preview needs a subscription. Fall back to the
        // member count so the seat line still renders, with nothing to bill.
        try {
          const members = await WorkspacesService.listMembers(workspaceId);
          if (!cancelled) setSeatsUsed(members.length);
        } catch {
          if (!cancelled) setSeatsUsed(null);
        }
      });
    return () => {
      cancelled = true;
      setSeatsUsed(null);
      setSeatPreview(null);
      setBatchPreviews(new Map());
    };
  }, [open, workspaceId]);

  // A dialog unmounted mid-run (its workspace dropped out, or the page re-keyed) sends no more.
  useEffect(() => () => runController.current?.abort(), []);

  // Addresses with nothing left to suggest: on a chip, already invited here, or on the roster.
  const excludedKey = JSON.stringify([
    ...state.recipients.map((recipient) => recipient.email),
    ...state.sent.map((entry) => entry.email),
    ...roster.memberEmails,
    ...roster.invitedEmails,
  ]);
  const excluded = useMemo((): string[] => JSON.parse(excludedKey) as string[], [excludedKey]);

  const query = state.draft.trim();
  useEffect(() => {
    if (!open || query.length < SUGGESTION_MIN_CHARS) {
      setContacts([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => window.electronAPI.searchInviteContacts(query, excluded))
        .then((result) => {
          if (!cancelled) setContacts(result?.success ? result.contacts : []);
        })
        .catch(() => {
          if (!cancelled) setContacts([]);
        });
    }, SUGGESTION_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query, excluded]);

  // Filtered again here: an answer can land just after a chip or the roster changed.
  const suggestions = useMemo(() => inviteSuggestions(contacts, excluded), [contacts, excluded]);

  // Seats this send would add if every invitation is accepted: those it needs beyond the
  // subscription's free ones. An empty field still prices one, as the old single invite did.
  const sendableCount = state.phase === "editing" ? inviteSummary(state).sendable.length : 0;
  const billedSeats =
    seatPreview === null || state.phase !== "editing"
      ? 0
      : Math.max(
          0,
          seatPreview.seats_used + Math.max(1, sendableCount) - seatPreview.current_quantity
        );

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

  const seatLine =
    seatsUsed !== null && seats !== null
      ? t("workspaces.invite.seatUsage", { used: seatsUsed, seats })
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

  const handleSend = async (): Promise<void> => {
    if (running.current) return;
    // The same transition the reducer makes, run here to learn which chips this send took.
    const next = inviteReducer(state, { type: "send" });
    setState(next);
    if (next.phase !== "sending") return;

    running.current = true;
    const controller = new AbortController();
    runController.current = controller;
    const emails = next.recipients
      .filter((recipient) => recipient.state.status === "sending")
      .map((recipient) => recipient.email);
    const invited: string[] = [];
    let seatRefused = false;
    try {
      await invitePeople.sendInvitations({
        workspaceId,
        emails,
        role: next.role,
        teamIds,
        spaceIds,
        signal: controller.signal,
        onResult: (email, outcome) => {
          dispatch({ type: "result", email, outcome });
          if (outcome.ok === true) invited.push(email);
          else if (outcome.kind === "seatLimit") seatRefused = true;
        },
      });
    } finally {
      running.current = false;
      runController.current = null;
      if (!controller.signal.aborted) {
        dispatch({ type: "finished" });
        // The reducer drops a roster that arrives mid-send, so the latest one is applied now.
        dispatch({ type: "roster", ...latestRoster.current });
      }
    }
    if (controller.signal.aborted) return;
    if (invited.length > 0) onInvited?.(invited);
    // The workspace list's seats_used is what the seats left and the room under the ceiling are
    // worked out from: it is behind this run's invitations, and after a seat refusal behind
    // whoever else invited people meanwhile.
    if (seatRefused || invited.length > 0) {
      void useWorkspaceStore.getState().refresh({ fresh: true });
    }
  };

  const close = (): void => onOpenChange(false);

  // Invitations in flight can't be taken back, so the dialog stays until the run reports.
  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen && state.phase === "sending") return;
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <InvitePeopleView
        workspaceName={workspaceName}
        state={state}
        dispatch={dispatch}
        suggestions={suggestions}
        seatLine={seatLine}
        seatCostLine={seatCostLine}
        canManageBilling={canManageBilling}
        billingManager={billingManager}
        onUpgrade={onUpgrade}
        cancelLabel={cancelLabel ?? t("common.cancel")}
        onCancel={close}
        onSend={() => void handleSend()}
        onDone={close}
      />
    </Dialog>
  );
}
