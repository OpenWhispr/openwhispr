import { useReducer, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { useToast } from "../ui/useToast";
import { WorkspaceActionDialog } from "../workspace/WorkspaceActionDialog";
import { confirmActionReducer } from "../../lib/confirmActionFlow";
import { localMutationErrorKey } from "../../lib/localMutationError";
import { classifySpaceError, rowActionErrorOf } from "../../lib/workspaceErrors";
import { deleteSpace, restoreSpace } from "../../services/spaceActions";
import { isolate } from "../../utils/bidiIsolate";
import type { SpaceItem } from "../../types/electron";

// Longer than a note edit's Undo: this delete removes the teamspace for everyone, and the plain
// confirm asks for no name, so the toast is what catches a slip.
const DELETE_UNDO_WINDOW_MS = 10_000;

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
 * Deletes a (team) space. A teamspace on the server asks once and shows the delete running; one
 * that only exists on this device asks for its name, since nothing restores it.
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
        cloudSpaceId={space.cloud_space_id}
        onClose={onClose}
        onDeleted={onDeleted}
      />
    );
  }
  return <LocalDeleteSpaceDialog space={space} onClose={onClose} />;
}

interface CloudDeleteSpaceDialogProps {
  space: SpaceItem;
  cloudSpaceId: string;
  onClose: () => void;
  onDeleted?: () => void;
}

// The server finishes the delete even if this window goes away, as any single request does, so
// the dialog stays only to report how it went.
function CloudDeleteSpaceDialog({
  space,
  cloudSpaceId,
  onClose,
  onDeleted,
}: CloudDeleteSpaceDialogProps): ReactElement {
  const { t } = useTranslation();
  const { toast, dismiss } = useToast();
  const [state, dispatch] = useReducer(confirmActionReducer<SpaceItem>, {
    kind: "confirm",
    subject: space,
  });
  const name = isolate(space.name);
  const busy = state.kind === "running";
  const failed = state.kind === "failed";

  // Runs from the toast, which outlives this dialog.
  const offerUndo = (cloudSpaceId: string): void => {
    let restoring = false;
    const toastId = toast({
      title: t("settingsPage.workspace.teamspaces.exit.deleted", { space: name }),
      duration: DELETE_UNDO_WINDOW_MS,
      actions: [
        {
          label: t("app.toasts.undo"),
          // A failed restore keeps the toast up for another try.
          dismissOnClick: false,
          onClick: async () => {
            if (restoring) return;
            restoring = true;
            try {
              await restoreSpace(cloudSpaceId);
              dismiss(toastId);
              toast({
                title: t("settingsPage.workspace.teamspaces.exit.restored", { space: name }),
              });
            } catch (error) {
              const copy =
                classifySpaceError(error).kind === "nameTaken"
                  ? "settingsPage.workspace.teamspaces.exit.restoreNameTaken"
                  : "settingsPage.workspace.teamspaces.exit.restoreFailed";
              toast({ title: t(copy, { space: name }), variant: "destructive" });
            } finally {
              restoring = false;
            }
          },
        },
      ],
    });
  };

  const run = async (): Promise<void> => {
    dispatch({ type: "confirm" });
    try {
      const result = await deleteSpace(space);
      if (!result.success) {
        dispatch({ type: "failed", error: rowActionErrorOf(result.failure) });
        return;
      }
    } catch {
      dispatch({ type: "failed", error: { kind: "failed" } });
      return;
    }
    offerUndo(cloudSpaceId);
    dispatch({ type: "succeeded" });
    onDeleted?.();
    onClose();
  };

  let title = t("settingsPage.workspace.teamspaces.exit.deleteTitle", { space: name });
  let body = t("settingsPage.workspace.teamspaces.exit.deleteBody", { space: name });
  let action = t("settingsPage.workspace.teamspaces.settings.deleteAction");
  if (busy) {
    title = t("settingsPage.workspace.teamspaces.exit.deletingTitle", { space: name });
    body = t("settingsPage.workspace.teamspaces.exit.deletingBody");
    action = t("settingsPage.workspace.teamspaces.exit.deletingAction");
  } else if (failed) {
    title = t("settingsPage.workspace.teamspaces.exit.deleteFailedTitle", { space: name });
    body = t("settingsPage.workspace.teamspaces.exit.deleteFailedBody");
    action = t("workspaces.exit.tryAgain");
  }

  return (
    <WorkspaceActionDialog
      open
      icon="trash"
      title={title}
      body={body}
      error={state.kind === "failed" && state.error.kind === "refused" ? state.error.message : null}
      primary={{
        label: action,
        onClick: () => void run(),
        tone: failed ? "primary" : "destructive",
      }}
      cancelLabel={t("common.cancel")}
      busy={busy}
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
