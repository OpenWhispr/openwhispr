import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../ui/useToast";
import { WorkspaceActionDialog } from "../workspace/WorkspaceActionDialog";
import { rowActionErrorOf } from "../../lib/workspaceErrors";
import { holdTeamDelete } from "../../services/spaceActions";
import type { TeamDeleteHold } from "../../services/spaceActionsCore";
import { isolate } from "../../utils/bidiIsolate";
import type { Team } from "../../types/electron";

const KEY = "settingsPage.workspace.teams.exit";
// The same window as a teamspace delete: the team goes for everyone, the confirm asks for no
// name, and the API has no restore, so the toast's Undo is the only way back.
const DELETE_UNDO_WINDOW_MS = 10_000;
// Long enough to read why, and to reach Try again.
const DELETE_FAILED_TOAST_MS = 8_000;

interface DeleteTeamDialogProps {
  team: Team;
  onClose: () => void;
  /** The delete was confirmed, so a dialog stacked beneath this one (its settings) closes too. */
  onDeleted?: () => void;
}

// The dialog only asks. The delete itself waits in the toast, which outlives this dialog, and
// reports how it went from there.
export default function DeleteTeamDialog({
  team,
  onClose,
  onDeleted,
}: DeleteTeamDialogProps): ReactElement {
  const { t } = useTranslation();
  const { toast, dismiss } = useToast();
  const name = isolate(team.name);

  const finishDelete = async (hold: TeamDeleteHold): Promise<void> => {
    const result = await hold.commit();
    if (!result || result.success) return;
    const error = rowActionErrorOf(result.failure);
    const mayRetry = error.kind !== "notAllowed" && error.kind !== "ssoRequired";
    let description = t(`${KEY}.deleteFailedBody`);
    if (error.kind === "refused") description = error.message;
    else if (!mayRetry) description = t(`${KEY}.deleteNotAllowed`, { team: name });
    toast({
      title: t(`${KEY}.deleteFailedTitle`, { team: name }),
      description,
      variant: "destructive",
      duration: DELETE_FAILED_TOAST_MS,
      actions: mayRetry
        ? [
            {
              label: t("workspaces.exit.tryAgain"),
              onClick: () => {
                const retry = hold.again();
                if (retry) void finishDelete(retry);
              },
            },
          ]
        : undefined,
    });
  };

  const confirm = (): void => {
    const hold = holdTeamDelete(team);
    const toastId = toast({
      title: t(`${KEY}.deleted`, { team: name }),
      duration: DELETE_UNDO_WINDOW_MS,
      // However the toast goes, the window is over; after an Undo this does nothing.
      onSettled: () => void finishDelete(hold),
      actions: [
        {
          label: t("app.toasts.undo"),
          // Undo first: dismissing the toast is what lets the delete go ahead.
          dismissOnClick: false,
          onClick: async () => {
            await hold.undo();
            dismiss(toastId);
          },
        },
      ],
    });
    onDeleted?.();
    onClose();
  };

  return (
    <WorkspaceActionDialog
      open
      icon="trash"
      title={t(`${KEY}.deleteConfirmTitle`, { team: name })}
      body={t(`${KEY}.deleteConfirmBody`, { team: name })}
      primary={{ label: t(`${KEY}.deleteAction`), onClick: confirm, tone: "destructive" }}
      cancelLabel={t("common.cancel")}
      onDismiss={onClose}
    />
  );
}
