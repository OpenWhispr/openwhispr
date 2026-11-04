import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { useToast } from "../ui/useToast";
import { WorkspaceActionDialog } from "../workspace/WorkspaceActionDialog";
import { localMutationErrorKey } from "../../lib/localMutationError";
import { rowActionErrorOf } from "../../lib/workspaceErrors";
import { deleteSpace, holdSpaceDelete } from "../../services/spaceActions";
import type { SpaceDeleteHold } from "../../services/spaceActionsCore";
import { isolate } from "../../utils/bidiIsolate";
import type { SpaceItem } from "../../types/electron";

// Longer than a note edit's Undo: this delete removes the teamspace for everyone, and the plain
// confirm asks for no name, so the toast is what catches a slip.
const DELETE_UNDO_WINDOW_MS = 10_000;
// Long enough to read why, and to reach Try again.
const DELETE_FAILED_TOAST_MS = 8_000;

interface DeleteSpaceDialogProps {
  space: SpaceItem | null;
  onClose: () => void;
  /**
   * A cloud teamspace was deleted, so a dialog stacked beneath this one (its settings) closes with
   * it. A cancel only calls `onClose`.
   */
  onDeleted?: () => void;
}

/**
 * Deletes a (team) space. A teamspace on the server asks once, then goes when its Undo window ends;
 * one that only exists on this device asks for its name, since nothing restores it.
 */
export default function DeleteSpaceDialog({
  space,
  onClose,
  onDeleted,
}: DeleteSpaceDialogProps): ReactElement {
  if (space?.cloud_space_id) {
    // Keyed by the teamspace so each one starts at the confirm, whatever the last one ended on.
    return (
      <CloudDeleteSpaceDialog
        key={space.id}
        space={space}
        onClose={onClose}
        onDeleted={onDeleted}
      />
    );
  }
  return <LocalDeleteSpaceDialog space={space} onClose={onClose} />;
}

interface CloudDeleteSpaceDialogProps {
  space: SpaceItem;
  onClose: () => void;
  onDeleted?: () => void;
}

// The dialog only asks. The delete itself waits in the toast, which outlives this dialog, and
// reports how it went from there.
function CloudDeleteSpaceDialog({
  space,
  onClose,
  onDeleted,
}: CloudDeleteSpaceDialogProps): ReactElement {
  const { t } = useTranslation();
  const { toast, dismiss } = useToast();
  const name = isolate(space.name);

  const finishDelete = async (hold: SpaceDeleteHold): Promise<void> => {
    const result = await hold.commit();
    if (!result) return;
    if (result.success) {
      if (result.relocatedCount) {
        toast({
          title: t("settingsPage.workspace.teamspaces.exit.movedToPersonal", {
            count: result.relocatedCount,
          }),
        });
      }
      return;
    }
    const error = rowActionErrorOf(result.failure);
    const mayRetry = error.kind !== "notAllowed" && error.kind !== "ssoRequired";
    let description = t("settingsPage.workspace.teamspaces.exit.deleteFailedBody");
    if (error.kind === "refused") description = error.message;
    else if (!mayRetry) {
      description = t("settingsPage.workspace.teamspaces.exit.deleteNotAllowed", { space: name });
    }
    toast({
      title: t("settingsPage.workspace.teamspaces.exit.deleteFailedTitle", { space: name }),
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
    const hold = holdSpaceDelete(space);
    const toastId = toast({
      title: t("settingsPage.workspace.teamspaces.exit.deleted", { space: name }),
      duration: DELETE_UNDO_WINDOW_MS,
      // However the toast goes, the window is over; after an Undo this does nothing.
      onSettled: () => void finishDelete(hold),
      actions: [
        {
          label: t("app.toasts.undo"),
          // Undo first: dismissing the toast is what lets the delete go ahead.
          dismissOnClick: false,
          onClick: async () => {
            const restored = await hold.undo();
            dismiss(toastId);
            if (!restored) return;
            toast({ title: t("settingsPage.workspace.teamspaces.exit.restored", { space: name }) });
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
      title={t("settingsPage.workspace.teamspaces.exit.deleteTitle", { space: name })}
      body={t("settingsPage.workspace.teamspaces.exit.deleteBody", { space: name })}
      primary={{
        label: t("settingsPage.workspace.teamspaces.settings.deleteAction"),
        onClick: confirm,
        tone: "destructive",
      }}
      cancelLabel={t("common.cancel")}
      onDismiss={onClose}
    />
  );
}

/** Type-the-name destructive confirm that deletes a space that lives on this device only. */
function LocalDeleteSpaceDialog({
  space,
  onClose,
}: {
  space: SpaceItem | null;
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [nameInput, setNameInput] = useState("");
  const [forSpaceId, setForSpaceId] = useState<number | null>(null);
  if ((space?.id ?? null) !== forSpaceId) {
    setForSpaceId(space?.id ?? null);
    setNameInput("");
  }
  const confirmMatch = space != null && nameInput.trim() === space.name;

  const confirmDelete = async (target: SpaceItem) => {
    onClose();
    const result = await deleteSpace(target);
    if (!result.success) {
      toast({
        title: t("notes.spaces.couldNotDelete"),
        description: t(localMutationErrorKey(result.error)),
        variant: "destructive",
      });
      return;
    }
    toast({ title: t("notes.spaces.deleted", { space: target.name }) });
    if (result.relocatedCount) {
      toast({
        title: t("settingsPage.workspace.teamspaces.exit.movedToPersonal", {
          count: result.relocatedCount,
        }),
      });
    }
  };

  return (
    <ConfirmDialog
      open={space != null}
      onOpenChange={(open) => !open && onClose()}
      title={t("notes.spaces.deleteConfirmTitle")}
      description={
        space ? t("notes.spaces.deleteConfirmDescription", { space: space.name }) : undefined
      }
      confirmText={t("notes.spaces.deleteSpace")}
      variant="destructive"
      confirmDisabled={!confirmMatch}
      onConfirm={() => {
        if (space) void confirmDelete(space);
      }}
    >
      {space && (
        <div className="space-y-1.5">
          <label htmlFor="delete-space-name" className="text-xs font-medium text-foreground/50">
            {t("notes.spaces.deleteTypeName", { space: space.name })}
          </label>
          <Input
            dir="auto"
            id="delete-space-name"
            autoFocus
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder={space.name}
            onKeyDown={(e) => {
              if (e.key === "Enter" && confirmMatch) void confirmDelete(space);
            }}
          />
        </div>
      )}
    </ConfirmDialog>
  );
}
