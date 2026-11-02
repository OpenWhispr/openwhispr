import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { ExitEvent, ExitState } from "../../lib/workspaceExitFlow";
import { serverRefusalMessage } from "../../services/cloudApi";
import { WorkspaceActionDialog } from "./WorkspaceActionDialog";

interface WorkspaceExitDialogProps {
  state: ExitState;
  dispatch: (event: ExitEvent) => void;
  /** Bound by the caller to the active workspace and the signed-in user. */
  onConfirmLeave: () => Promise<void>;
  onConfirmDelete: () => Promise<void>;
  /** Primary of the Left and Deleted outcomes. */
  onChooseWorkspace: () => void;
}

export function WorkspaceExitDialog({
  state,
  dispatch,
  onConfirmLeave,
  onConfirmDelete,
  onChooseWorkspace,
}: WorkspaceExitDialogProps): ReactElement | null {
  const { t } = useTranslation();

  if (state.kind === "closed") return null;

  const { name } = state;
  const dismiss = (): void => dispatch({ type: "dismiss" });

  const run = async (action: () => Promise<void>): Promise<void> => {
    dispatch({ type: "confirm" });
    try {
      await action();
      dispatch({ type: "succeeded" });
    } catch (error) {
      dispatch({ type: "failed", reason: serverRefusalMessage(error) });
    }
  };

  // Leaving the outcome dialogs by any route hands the user to the workspace
  // picker, since the workspace they were in no longer exists for them.
  const chooseWorkspace = (): void => {
    onChooseWorkspace();
    dismiss();
  };

  const cancelLabel = t("common.cancel");
  const common = { open: true, onDismiss: dismiss };
  const leaveCopy = {
    title: t("workspaces.exit.leave.title", { name }),
    body: t("workspaces.exit.leave.body"),
  };

  switch (state.kind) {
    case "confirmLeave":
      return (
        <WorkspaceActionDialog
          {...common}
          icon="info"
          {...leaveCopy}
          primary={{
            label: t("settingsPage.workspace.general.leave"),
            onClick: () => void run(onConfirmLeave),
            tone: "destructive",
          }}
          cancelLabel={cancelLabel}
        />
      );
    case "leaving":
      return (
        <WorkspaceActionDialog
          {...common}
          icon="info"
          {...leaveCopy}
          primary={{
            label: t("settingsPage.workspace.general.leaving"),
            onClick: () => {},
            tone: "destructive",
          }}
          busy
        />
      );
    case "leaveFailed":
      return (
        <WorkspaceActionDialog
          {...common}
          icon="info"
          {...leaveCopy}
          error={state.reason ?? t("workspaces.exit.leave.failed", { name })}
          primary={{
            label: t("workspaces.exit.tryAgain"),
            onClick: () => void run(onConfirmLeave),
            tone: "destructive",
          }}
          cancelLabel={cancelLabel}
        />
      );
    case "left":
      return (
        <WorkspaceActionDialog
          open
          onDismiss={chooseWorkspace}
          icon="info"
          title={t("workspaces.exit.left.title", { name })}
          body={t("workspaces.exit.chooseAnother")}
          primary={{
            label: t("workspaces.exit.chooseWorkspace"),
            onClick: chooseWorkspace,
            tone: "primary",
          }}
        />
      );
    case "confirmDelete":
      return (
        <WorkspaceActionDialog
          {...common}
          icon="trash"
          title={t("workspaces.exit.delete.title", { name })}
          body={t("workspaces.exit.delete.body")}
          primary={{
            label: t("settingsPage.workspace.general.delete"),
            onClick: () => void run(onConfirmDelete),
            tone: "destructive",
          }}
          cancelLabel={cancelLabel}
        />
      );
    case "deleting":
      return (
        <WorkspaceActionDialog
          {...common}
          icon="trash"
          title={t("workspaces.exit.deleting.title", { name })}
          body={t("workspaces.exit.deleting.body")}
          primary={{
            label: t("settingsPage.workspace.general.deleting"),
            onClick: () => {},
            tone: "destructive",
          }}
          busy
        />
      );
    case "deleteFailed":
      return (
        <WorkspaceActionDialog
          {...common}
          icon="info"
          title={t("workspaces.exit.deleteFailed.title")}
          body={state.reason ?? t("workspaces.exit.deleteFailed.body", { name })}
          primary={{
            label: t("workspaces.exit.tryAgain"),
            onClick: () => void run(onConfirmDelete),
            tone: "primary",
          }}
          cancelLabel={cancelLabel}
        />
      );
    case "deleted":
      return (
        <WorkspaceActionDialog
          open
          onDismiss={chooseWorkspace}
          icon="info"
          title={t("workspaces.exit.deleted.title", { name })}
          body={t("workspaces.exit.chooseAnother")}
          primary={{
            label: t("workspaces.exit.chooseWorkspace"),
            onClick: chooseWorkspace,
            tone: "primary",
          }}
        />
      );
  }
}
