import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { ConfirmActionEvent, ConfirmActionState } from "../../lib/confirmActionFlow";
import { classifyRowActionError, type RowActionError } from "../../lib/workspaceErrors";
import { removeMember } from "../../services/workspaceActions";
import type { WorkspaceMember } from "../../types/electron";
import { isolate } from "../../utils/bidiIsolate";
import { useToast } from "../ui/useToast";
import { WorkspaceActionDialog } from "./WorkspaceActionDialog";

interface RemoveMemberDialogProps {
  workspaceId: string;
  workspaceName: string;
  state: ConfirmActionState<WorkspaceMember>;
  dispatch: (event: ConfirmActionEvent<WorkspaceMember>) => void;
}

export function RemoveMemberDialog({
  workspaceId,
  workspaceName,
  state,
  dispatch,
}: RemoveMemberDialogProps): ReactElement | null {
  const { t } = useTranslation();
  const { toast } = useToast();

  if (state.kind === "closed") return null;

  const member = state.subject;
  // Isolated: the dialog and toasts take plain strings, where <bdi> can't go.
  const name = isolate(member.name || member.email);
  const workspace = isolate(workspaceName);
  const busy = state.kind === "running";

  const run = async (): Promise<void> => {
    dispatch({ type: "confirm" });
    try {
      const outcome = await removeMember(workspaceId, member.user_id);
      toast({
        title:
          outcome === "removed"
            ? t("settingsPage.workspace.members.removed", { name })
            : t("workspaces.removeMember.alreadyRemoved", { name }),
      });
      dispatch({ type: "succeeded" });
    } catch (error) {
      dispatch({ type: "failed", error: classifyRowActionError(error) });
    }
  };

  const errorLine = (error: RowActionError): string => {
    if (error.kind === "refused") return error.message;
    if (error.kind === "notAllowed") {
      return t("workspaces.removeMember.notAllowed", { workspace });
    }
    if (error.kind === "ssoRequired") return t("workspaces.ssoRequired", { workspace });
    return t("workspaces.removeMember.failed", { name });
  };

  return (
    <WorkspaceActionDialog
      open
      icon="trash"
      title={t("workspaces.removeMember.title", { name, workspace })}
      body={t("workspaces.removeMember.body")}
      error={state.kind === "failed" ? errorLine(state.error) : null}
      primary={{
        label: busy
          ? t("workspaces.removeMember.removing")
          : state.kind === "failed"
            ? t("workspaces.exit.tryAgain")
            : t("workspaces.removeMember.confirm"),
        onClick: () => void run(),
        tone: "destructive",
      }}
      cancelLabel={t("common.cancel")}
      busy={busy}
      onDismiss={() => dispatch({ type: "dismiss" })}
    />
  );
}
