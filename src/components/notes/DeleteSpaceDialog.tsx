import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { useToast } from "../ui/useToast";
import { localMutationErrorKey } from "../../lib/localMutationError";
import { deleteSpace } from "../../services/spaceActions";
import type { SpaceItem } from "../../types/electron";

interface DeleteSpaceDialogProps {
  space: SpaceItem | null;
  onClose: () => void;
}

/** Type-the-name destructive confirm that deletes a (team) space. */
export default function DeleteSpaceDialog({ space, onClose }: DeleteSpaceDialogProps) {
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
        space
          ? t(
              space.cloud_space_id
                ? "notes.spaces.deleteConfirmTeamDescription"
                : "notes.spaces.deleteConfirmDescription",
              { space: space.name }
            )
          : undefined
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
