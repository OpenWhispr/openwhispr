import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useToast } from "./ui/useToast";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (workspaceId: string) => void;
}

export default function CreateWorkspaceDialog({ open, onOpenChange, onCreated }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace);
  const setActive = useWorkspaceStore((s) => s.setActiveWorkspaceId);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      const workspace = await createWorkspace(name.trim());
      setActive(workspace.id);
      onCreated?.(workspace.id);
      onOpenChange(false);
      setName("");
      toast({
        title: t("workspaces.created.title"),
        description: t("workspaces.created.description", { name: workspace.name }),
      });
    } catch (error) {
      toast({
        title: t("workspaces.create.errorTitle"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("workspaces.create.title")}</DialogTitle>
          <DialogDescription>{t("workspaces.create.description")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="workspace-name" className="text-xs font-medium">
              {t("workspaces.create.nameLabel")}
            </Label>
            <Input
              id="workspace-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("workspaces.create.namePlaceholder")}
              maxLength={80}
            />
          </div>
          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!name.trim() || submitting}>
              {submitting ? t("workspaces.create.submitting") : t("workspaces.create.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
