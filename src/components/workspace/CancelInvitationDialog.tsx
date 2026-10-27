import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { ConfirmActionEvent, ConfirmActionState } from "../../lib/confirmActionFlow";
import { classifyRowActionError, type RowActionError } from "../../lib/workspaceErrors";
import { InvitationsService } from "../../services/InvitationsService";
import type { WorkspaceInvitation } from "../../types/electron";
import { isolate } from "../../utils/bidiIsolate";
import { useToast } from "../ui/useToast";
import { WorkspaceActionDialog } from "./WorkspaceActionDialog";

interface CancelInvitationDialogProps {
  workspaceId: string;
  state: ConfirmActionState<WorkspaceInvitation>;
  dispatch: (event: ConfirmActionEvent<WorkspaceInvitation>) => void;
  /** The invitation is gone; the tab reloads its list. */
  onCanceled: () => void;
}

export function CancelInvitationDialog({
  workspaceId,
  state,
  dispatch,
  onCanceled,
}: CancelInvitationDialogProps): ReactElement | null {
  const { t } = useTranslation();
  const { toast } = useToast();

  if (state.kind === "closed") return null;

  const invitation = state.subject;
  const busy = state.kind === "running";

  const run = async (): Promise<void> => {
    dispatch({ type: "confirm" });
    try {
      await InvitationsService.revoke(workspaceId, invitation.id);
    } catch (error) {
      const failure = classifyRowActionError(error);
      // An invitation that is already gone is the outcome the user asked for.
      if (failure.kind !== "gone") {
        dispatch({ type: "failed", error: failure });
        return;
      }
    }
    toast({ title: t("workspaces.cancelInvitation.done") });
    dispatch({ type: "succeeded" });
    onCanceled();
  };

  const errorLine = (error: RowActionError): string =>
    error.kind === "refused" ? error.message : t("workspaces.cancelInvitation.failed");

  return (
    <WorkspaceActionDialog
      open
      icon="trash"
      title={t("workspaces.cancelInvitation.title", { email: isolate(invitation.email) })}
      body={t("workspaces.cancelInvitation.body")}
      error={state.kind === "failed" ? errorLine(state.error) : null}
      primary={{
        label: busy
          ? t("workspaces.cancelInvitation.canceling")
          : state.kind === "failed"
            ? t("workspaces.exit.tryAgain")
            : t("settingsPage.workspace.people.invitations.cancel"),
        onClick: () => void run(),
        tone: "destructive",
      }}
      cancelLabel={t("workspaces.cancelInvitation.keep")}
      busy={busy}
      onDismiss={() => dispatch({ type: "dismiss" })}
    />
  );
}
