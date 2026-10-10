import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "./icons";
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
import { useDelayedFlag } from "../hooks/useDelayedFlag";
import { useToast } from "./ui/useToast";
import { useDialogSession } from "../hooks/useDialogSession";

interface Props {
  defaultName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (workspaceId: string) => void;
  onReconciled?: (workspaceId: string) => void | Promise<void>;
}

export default function CreateWorkspaceDialog({
  defaultName,
  open,
  onOpenChange,
  onCreated,
  onReconciled,
}: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace);
  const setActive = useWorkspaceStore((s) => s.setActiveWorkspaceId);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const showSpinner = useDelayedFlag(submitting);
  const { sessionKey, capture, invalidate, bindSession } = useDialogSession(open);
  const draftOwner = JSON.stringify([sessionKey, defaultName]);
  const [previousOwner, setPreviousOwner] = useState("");
  if (previousOwner !== draftOwner) {
    setPreviousOwner(draftOwner);
    setName(open ? (defaultName ?? "") : "");
    setSubmitting(false);
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) invalidate();
    onOpenChange(next);
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || submitting) return;
    const completion = capture();
    setSubmitting(true);
    try {
      const workspace = await createWorkspace(name.trim());
      if (!workspace) return;
      if (completion.isAccountCurrent()) {
        setActive(workspace.id);
        await onReconciled?.(workspace.id);
      }
      if (!completion.isCurrent()) return;
      handleOpenChange(false);
      toast({
        title: t("workspaces.created.title"),
        description: t("workspaces.created.description", { name: workspace.name }),
      });
      onCreated?.(workspace.id);
    } catch (error) {
      if (!completion.isCurrent()) return;
      toast({
        title: t("workspaces.create.errorTitle"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      if (completion.isCurrent()) setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("workspaces.create.title")}</DialogTitle>
          <DialogDescription>{t("workspaces.create.description")}</DialogDescription>
        </DialogHeader>
        <form ref={bindSession} onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="workspace-name" className="text-xs font-medium">
              {t("workspaces.create.nameLabel")}
            </Label>
            <Input
              dir="auto"
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
              onClick={() => handleOpenChange(false)}
              disabled={submitting}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!name.trim() || submitting}>
              {showSpinner && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
              {submitting ? t("workspaces.create.submitting") : t("workspaces.create.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
