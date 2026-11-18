import type { ReactElement, ReactNode } from "react";
import { Building2, ChevronRight, FolderOpen, Lock, Users } from "../icons";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { useModalGate } from "../../stores/modalGateStore";

function StructureRow({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}): ReactElement {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/70 px-3 py-2.5">
      <ChevronRight size={12} className="shrink-0 text-foreground/45 rtl:rotate-180" />
      {icon}
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground/80">{title}</p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

interface NotesStructureIntroDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function NotesStructureIntroDialog({
  open,
  onOpenChange,
}: NotesStructureIntroDialogProps) {
  const { t } = useTranslation();
  useModalGate("notesStructureIntro", open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md p-6 gap-5">
        <DialogHeader>
          <DialogTitle>{t("notes.structureIntro.title")}</DialogTitle>
          <DialogDescription>{t("notes.structureIntro.description")}</DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border border-primary/15 bg-primary/[0.025] p-3.5">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/8 text-primary/70">
              <Building2 size={13} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-foreground">
                {t("notes.structureIntro.workspace.title")}
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {t("notes.structureIntro.workspace.description")}
              </p>

              {/* Every workspace has its own Private beside its teamspaces. */}
              <div className="mt-3 space-y-2">
                <StructureRow
                  icon={<Lock size={13} className="shrink-0 text-foreground/50" />}
                  title={t("notes.structureIntro.personal.title")}
                  description={t("notes.structureIntro.personal.description")}
                />
                <StructureRow
                  icon={<Users size={13} className="shrink-0 text-primary/60" />}
                  title={t("notes.structureIntro.teamSpace.title")}
                  description={t("notes.structureIntro.teamSpace.description")}
                />
              </div>

              <div className="mt-2 flex items-center gap-2 ps-5 text-[11px] text-muted-foreground">
                <FolderOpen size={12} className="shrink-0" />
                {t("notes.structureIntro.contents")}
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            {t("notes.structureIntro.done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
