import { useReducer, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { WorkspaceActionDialog } from "../workspace/WorkspaceActionDialog";
import { useToast } from "../ui/useToast";
import { confirmActionReducer } from "../../lib/confirmActionFlow";
import { classifyTeamError, rowActionErrorOf } from "../../lib/workspaceErrors";
import { leaveTeam } from "../../services/spaceActions";
import { isolate } from "../../utils/bidiIsolate";
import type { Team } from "../../types/electron";

const KEY = "settingsPage.workspace.teams.exit";

interface LeaveTeamDialogProps {
  team: Team;
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** undefined: the row isn't loaded, so the server is asked by trying. */
  soleAdmin: boolean | undefined;
  /** Someone besides the user is an admin, so the team carries on without them. */
  otherAdmins: boolean;
  /** The block's way out: the Members tab, where another admin can be made. */
  onManageMembers: () => void;
  /** The user is out, so whatever hosts the team's settings can react. */
  onLeft: () => void;
}

// Asks, runs, and answers for leaving a team: the confirm, the block for its only admin, and a
// failure with Try again. It stacks over the settings dialog, which stays open until the leave
// is done.
export default function LeaveTeamDialog({
  team,
  userId,
  open,
  onOpenChange,
  soleAdmin,
  otherAdmins,
  onManageMembers,
  onLeft,
}: LeaveTeamDialogProps): ReactElement | null {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [state, dispatch] = useReducer(confirmActionReducer<Team>, { kind: "closed" });
  // Set when the row says this user is the only admin, or when the server says so on a leave.
  // It isn't a state of the reducer's, since it replaces the confirm and the failure alike.
  const [blocked, setBlocked] = useState(false);
  const [wasOpen, setWasOpen] = useState(false);

  // Each opening starts over at the confirm (or the block, when the row already says so).
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      dispatch({ type: "open", subject: team });
      setBlocked(soleAdmin === true);
    } else {
      dispatch({ type: "dismiss" });
    }
  }

  if (!open || state.kind === "closed") return null;

  const name = isolate(team.name);
  const busy = state.kind === "running";

  const dismiss = (): void => {
    dispatch({ type: "dismiss" });
    onOpenChange(false);
  };

  const run = async (): Promise<void> => {
    dispatch({ type: "confirm" });
    try {
      await leaveTeam(team.id, userId);
    } catch (error) {
      const failure = classifyTeamError(error);
      // A team that no longer has this user in it is a team they have left.
      if (failure.kind !== "gone") {
        if (failure.kind === "lastAdmin") setBlocked(true);
        dispatch({ type: "failed", error: rowActionErrorOf(failure) });
        return;
      }
    }
    toast({ title: t(`${KEY}.left`, { team: name }) });
    dispatch({ type: "succeeded" });
    onOpenChange(false);
    onLeft();
  };

  if (blocked) {
    return (
      <WorkspaceActionDialog
        open
        icon="info"
        title={t(`${KEY}.blockedTitle`)}
        body={t(`${KEY}.blockedBody`, { team: name })}
        primary={{
          label: t(`${KEY}.manageMembers`),
          onClick: () => {
            dismiss();
            onManageMembers();
          },
          tone: "primary",
        }}
        cancelLabel={t("common.cancel")}
        onDismiss={dismiss}
      />
    );
  }

  if (state.kind === "failed") {
    return (
      <WorkspaceActionDialog
        open
        icon="info"
        title={t(`${KEY}.leaveFailedTitle`, { team: name })}
        body={t(`${KEY}.leaveFailedBody`)}
        error={state.error.kind === "refused" ? state.error.message : null}
        primary={{
          label: t("workspaces.exit.tryAgain"),
          onClick: () => void run(),
          tone: "primary",
        }}
        cancelLabel={t("common.cancel")}
        onDismiss={dismiss}
      />
    );
  }

  return (
    <WorkspaceActionDialog
      open
      icon="info"
      title={t(`${KEY}.leaveConfirmTitle`, { team: name })}
      body={t(otherAdmins ? `${KEY}.leaveConfirmBody` : `${KEY}.leaveConfirmBodyNoOtherAdmin`)}
      primary={{
        label: t(`${KEY}.leaveAction`),
        onClick: () => void run(),
        tone: "destructive",
        pending: busy,
      }}
      cancelLabel={t("common.cancel")}
      busy={busy}
      onDismiss={dismiss}
    />
  );
}
