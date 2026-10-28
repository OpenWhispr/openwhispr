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
  workspaceName: string;
  state: ConfirmActionState<WorkspaceInvitation>;
  dispatch: (event: ConfirmActionEvent<WorkspaceInvitation>) => void;
  /**
   * The invitation is no longer pending; the tab reloads its list. `gone` means it had already
   * been accepted or canceled elsewhere, so the member list may have changed too.
   */
  onCanceled: (outcome: "canceled" | "gone") => void;
}

export function CancelInvitationDialog({
  workspaceId,
  workspaceName,
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
    let outcome: "canceled" | "gone" = "canceled";
    try {
      await InvitationsService.revoke(workspaceId, invitation.id);
    } catch (error) {
      const failure = classifyRowActionError(error);
      // The API answers the same for an invitation canceled elsewhere and one already accepted,
      // so this can't say it was canceled, but nothing is left to cancel either.
      if (failure.kind !== "gone") {
        dispatch({ type: "failed", error: failure });
        return;
      }
      outcome = "gone";
    }
    toast({
      title:
        outcome === "canceled"
          ? t("workspaces.cancelInvitation.done")
          : t("settingsPage.workspace.people.invitations.noLongerPending", {
              email: isolate(invitation.email),
            }),
    });
    dispatch({ type: "succeeded" });
    onCanceled(outcome);
  };

  const errorLine = (error: RowActionError): string => {
    const workspace = isolate(workspaceName);
    switch (error.kind) {
      case "refused":
        return error.message;
      case "notAllowed":
        return t("workspaces.cancelInvitation.notAllowed", { workspace });
      case "ssoRequired":
        return t("workspaces.ssoRequired", { workspace });
      default:
        return t("workspaces.cancelInvitation.failed");
    }
  };

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
