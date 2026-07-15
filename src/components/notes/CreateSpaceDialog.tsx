import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useToast } from "../ui/useToast";
import { createSpace } from "../../stores/noteStore";

interface CreateSpaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function CreateSpaceDialog({ open, onOpenChange }: CreateSpaceDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setName("");
      setEmoji("");
    }
  };

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed || isCreating) return;
    setIsCreating(true);
    try {
      const result = await createSpace(trimmed, emoji.trim() || null);
      if (result.success) {
        handleOpenChange(false);
      } else if (result.error) {
        toast({
          title: t("notes.spaces.couldNotCreate"),
          description: result.error,
          variant: "destructive",
        });
      }
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-95 p-6 gap-5">
        <DialogHeader>
          <DialogTitle>{t("notes.spaces.createTitle")}</DialogTitle>
        </DialogHeader>

        <div className="flex gap-3">
          <div className="space-y-1.5 w-14 shrink-0">
            <label className="text-xs font-medium text-foreground/50">
              {t("notes.spaces.emojiLabel")}
            </label>
            <Input
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
              maxLength={4}
              className="text-center"
            />
          </div>
          <div className="space-y-1.5 flex-1">
            <label className="text-xs font-medium text-foreground/50">
              {t("notes.spaces.nameLabel")}
            </label>
            <Input
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
              }}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)}>
            {t("notes.upload.cancel")}
          </Button>
          <Button onClick={handleCreate} disabled={!name.trim() || isCreating}>
            {t("notes.spaces.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
