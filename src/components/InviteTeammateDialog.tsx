import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "./ui/dialog";
import { InvitePeopleView } from "./workspace/InvitePeopleView";
import {
  createInviteFlow,
  inviteReducer,
  inviteSuggestions,
  type InviteFlowEvent,
  type InviteFlowState,
} from "../lib/inviteFlow";
import { invitePeople } from "../services/invitePeople";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { WorkspacesService, type SeatPreview } from "../services/WorkspacesService";
import { formatAmount } from "../utils/formatAmount";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workspaceName: string;
  /** Called once per address, with its normalized email, as its invitation succeeds. */
  onInvited?: (email: string) => void;
  cancelLabel?: string;
  /** Teams the invitee joins on accept (threaded into the invitation). */
  teamIds?: string[];
  /** Spaces the invitee is added to directly on accept. */
  spaceIds?: string[];
  initialEmail?: string;
  /** Addresses that can't be invited again; their chips are blocked before anything is sent. */
  knownEmails?: { members: string[]; invited: string[] };
}

interface Roster {
  memberEmails: string[];
  invitedEmails: string[];
}

type Contact = { email: string; display_name: string | null };

const SUGGESTION_DEBOUNCE_MS = 150;
const SUGGESTION_MIN_CHARS = 2;

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
}: Props): ReactElement {
  const { t } = useTranslation();
  const [state, setState] = useState<InviteFlowState>(() => createInviteFlow({ initialEmail }));
  const [wasOpen, setWasOpen] = useState(open);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [seatsUsed, setSeatsUsed] = useState<number | null>(null);
  const [seatPreview, setSeatPreview] = useState<SeatPreview | null>(null);
  const running = useRef(false);
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const seats = workspace?.seats ?? null;

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
    };
  }, [open, workspaceId]);

  const query = state.draft.trim();
  useEffect(() => {
    if (!open || query.length < SUGGESTION_MIN_CHARS) {
      setContacts([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => window.electronAPI.searchContacts(query))
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
  }, [open, query]);

  const suggestions = useMemo(
    () =>
      inviteSuggestions(contacts, [
        ...state.recipients.map((recipient) => recipient.email),
        ...state.sent.map((entry) => entry.email),
        ...roster.memberEmails,
        ...roster.invitedEmails,
      ]),
    [contacts, state.recipients, state.sent, roster]
  );

  // A subscribed workspace already at capacity bills a seat if an invite is accepted. Both sides
  // of the comparison come from the same preview, so a stale store can't misprice it.
  const addsBilledSeat =
    seatPreview !== null && seatPreview.seats_used >= seatPreview.current_quantity;
  const seatLine =
    seatsUsed !== null && seats !== null
      ? t("workspaces.invite.seatUsage", { used: seatsUsed, seats })
      : null;
  const seatCostLine = addsBilledSeat
    ? t("workspaces.invite.seatCost", {
        amount: formatAmount(seatPreview.amount_due, seatPreview.currency),
      })
    : null;

  const handleSend = async (): Promise<void> => {
    if (running.current) return;
    // The same transition the reducer makes, run here to learn which chips this send took.
    const next = inviteReducer(state, { type: "send" });
    setState(next);
    if (next.phase !== "sending") return;

    running.current = true;
    const emails = next.recipients
      .filter((recipient) => recipient.state.status === "sending")
      .map((recipient) => recipient.email);
    try {
      await invitePeople.sendInvitations({
        workspaceId,
        emails,
        role: next.role,
        teamIds,
        spaceIds,
        onResult: (email, outcome) => {
          dispatch({ type: "result", email, outcome });
          if (outcome.ok === true) onInvited?.(email);
        },
      });
    } finally {
      running.current = false;
      dispatch({ type: "finished" });
      // The reducer drops a roster that arrives mid-send, so the latest one is applied now.
      dispatch({ type: "roster", ...latestRoster.current });
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
        cancelLabel={cancelLabel ?? t("common.cancel")}
        onCancel={close}
        onSend={() => void handleSend()}
        onDone={close}
      />
    </Dialog>
  );
}
