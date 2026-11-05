import { useReducer, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { WorkspaceActionDialog } from "../workspace/WorkspaceActionDialog";
import { useToast } from "../ui/useToast";
import { confirmActionReducer } from "../../lib/confirmActionFlow";
import { formatList } from "../../lib/formatList";
import { teamsUserCanLeave } from "../../lib/spacePermissions";
import { classifySpaceError, rowActionErrorOf } from "../../lib/workspaceErrors";
import { leaveSpace, leaveTeam } from "../../services/spaceActions";
import { isolate } from "../../utils/bidiIsolate";
import type { SpaceItem } from "../../types/electron";

interface LeaveSpaceDialogProps {
  space: SpaceItem;
  userId: string;
  /** Named by the line for a session that needs single sign-on. */
  workspaceName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** undefined: the directory row isn't loaded, so the server is asked by trying. */
  soleAdmin: boolean | undefined;
  /** Someone besides the user is an admin, so the teamspace carries on without them. */
  otherAdmins: boolean;
  /** The block's way out: the Members tab, where another admin can be made. */
  onManageMembers: () => void;
  /** The user is out, so whatever hosts the teamspace's settings can close. */
  onLeft: () => void;
}

// Asks, runs, and answers for leaving a teamspace: the confirm, the block for its only admin,
// and a failure with Try again. It stacks over the settings dialog, which stays open until the
// leave is done.
export function LeaveSpaceDialog({
  space,
  userId,
  workspaceName,
  open,
  onOpenChange,
  soleAdmin,
  otherAdmins,
  onManageMembers,
  onLeft,
}: LeaveSpaceDialogProps): ReactElement | null {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const [state, dispatch] = useReducer(confirmActionReducer<SpaceItem>, { kind: "closed" });
  // Set when the row says this user is the only admin, or when the server says so on a leave.
  // It isn't a state of the reducer's, since it replaces the confirm and the failure alike.
  const [blocked, setBlocked] = useState(false);
  const [wasOpen, setWasOpen] = useState(false);

  // Each opening starts over at the confirm (or the block, when the row already says so).
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      dispatch({ type: "open", subject: space });
      setBlocked(soleAdmin === true);
    } else {
      dispatch({ type: "dismiss" });
    }
  }

  if (!open || state.kind === "closed") return null;

  const name = isolate(space.name);
  const busy = state.kind === "running";
  const direct = space.my_direct_role != null;
  const leaveTeams = teamsUserCanLeave(space);

  const dismiss = (): void => {
    dispatch({ type: "dismiss" });
    onOpenChange(false);
  };

  const finish = (): void => {
    dispatch({ type: "succeeded" });
    onOpenChange(false);
  };

  // A direct grant is dropped on its own and access through groups is left where it is: groups
  // are managed in the group. Leaving through groups is the way out only when they are the sole
  // grant.
  const leaveAll = async (): Promise<{ stillViaTeams: string[] }> => {
    if (direct) {
      const { still_via_teams } = await leaveSpace(space, userId);
      return { stillViaTeams: still_via_teams.map((team) => team.name) };
    }
    for (const team of leaveTeams) await leaveTeam(team.id, userId);
    return { stillViaTeams: [] };
  };

  const run = async (): Promise<void> => {
    dispatch({ type: "confirm" });
    try {
      const { stillViaTeams } = await leaveAll();
      if (stillViaTeams.length > 0) {
        toast({
          title: t("notes.spaces.stillViaGroups", {
            space: name,
            groups: formatList(i18n.language, stillViaTeams.map(isolate)),
          }),
        });
        finish();
        return;
      }
    } catch (error) {
      const failure = classifySpaceError(error);
      if (failure.kind === "lastAdmin") setBlocked(true);
      dispatch({ type: "failed", error: rowActionErrorOf(failure) });
      return;
    }
    toast({ title: t("settingsPage.workspace.teamspaces.exit.left", { space: name }) });
    finish();
    onLeft();
  };

  if (blocked) {
    return (
      <WorkspaceActionDialog
        open
        icon="info"
        title={t("settingsPage.workspace.teamspaces.exit.blockedTitle")}
        body={t("settingsPage.workspace.teamspaces.exit.blockedBody", { space: name })}
        primary={{
          label: t("settingsPage.workspace.teamspaces.exit.blockedAction"),
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
    // No connection to check and nothing to try again: this user can't do this any more.
    const ended = state.error.kind === "notAllowed" || state.error.kind === "ssoRequired";
    return (
      <WorkspaceActionDialog
        open
        icon="info"
        title={t("settingsPage.workspace.teamspaces.exit.leaveFailedTitle", { space: name })}
        body={
          state.error.kind === "notAllowed"
            ? t("settingsPage.workspace.teamspaces.members.notAllowed", { space: name })
            : state.error.kind === "ssoRequired"
              ? t("workspaces.ssoRequired", { workspace: isolate(workspaceName) })
              : t("settingsPage.workspace.teamspaces.exit.leaveFailedBody")
        }
        error={state.error.kind === "refused" ? state.error.message : null}
        primary={
          ended
            ? { label: t("common.close"), onClick: dismiss, tone: "primary" }
            : {
                label: t("workspaces.exit.tryAgain"),
                onClick: () => void run(),
                tone: "primary",
              }
        }
        cancelLabel={ended ? undefined : t("common.cancel")}
        onDismiss={dismiss}
      />
    );
  }

  const groupNames = formatList(
    i18n.language,
    leaveTeams.map((team) => isolate(team.name))
  );
  // Leaving through a group names the groups; a direct grant says what stays, and what goes.
  let body: string;
  if (!direct) {
    body = t("notes.spaces.leaveConfirmDescription", { teams: groupNames });
  } else {
    body =
      leaveTeams.length > 0
        ? t("settingsPage.workspace.teamspaces.exit.leaveBodyKeeps", { groups: groupNames })
        : t("settingsPage.workspace.teamspaces.exit.leaveBodyLoses", { space: name });
    if (space.my_direct_role === "admin" && otherAdmins) {
      body += ` ${t("settingsPage.workspace.teamspaces.exit.leaveBodyAdmins")}`;
    }
  }

  return (
    <WorkspaceActionDialog
      open
      icon="info"
      title={t("settingsPage.workspace.teamspaces.exit.leaveTitle", { space: name })}
      body={body}
      primary={{
        label: t("settingsPage.workspace.teamspaces.settings.leaveAction"),
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
