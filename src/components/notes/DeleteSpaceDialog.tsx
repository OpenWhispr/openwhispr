import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../ui/dialog";
import { Input } from "../ui/input";
import type { SpaceItem } from "../../types/electron";

interface DeleteSpaceDialogProps {
  space: SpaceItem | null;
  onClose: () => void;
  onConfirm: (space: SpaceItem) => void;
}

/** Type-the-name destructive confirm for deleting a (team) space. */
export default function DeleteSpaceDialog({ space, onClose, onConfirm }: DeleteSpaceDialogProps) {
  const { t } = useTranslation();
  const [nameInput, setNameInput] = useState("");
  const [forSpaceId, setForSpaceId] = useState<number | null>(null);
  if ((space?.id ?? null) !== forSpaceId) {
    setForSpaceId(space?.id ?? null);
    setNameInput("");
  }
  const confirmMatch = space != null && nameInput.trim() === space.name;

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
        if (space) onConfirm(space);
      }}
    >
      {space && (
        <div className="space-y-1.5">
          <label htmlFor="delete-space-name" className="text-xs font-medium text-foreground/50">
            {t("notes.spaces.deleteTypeName", { space: space.name })}
          </label>
          <Input
            id="delete-space-name"
            autoFocus
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder={space.name}
            onKeyDown={(e) => {
              if (e.key === "Enter" && confirmMatch) {
                onConfirm(space);
                onClose();
              }
            }}
          />
        </div>
      )}
    </ConfirmDialog>
  );
}
