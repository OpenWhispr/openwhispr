import { Building2, ChevronRight, FolderOpen, Lock, Users } from "lucide-react";
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

interface NotesStructureIntroDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function NotesStructureIntroDialog({
  open,
  onOpenChange,
}: NotesStructureIntroDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md p-6 gap-5">
        <DialogHeader>
          <DialogTitle>{t("notes.structureIntro.title")}</DialogTitle>
          <DialogDescription>{t("notes.structureIntro.description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-xl border border-border/50 bg-foreground/[0.025] dark:bg-white/[0.025] p-3.5">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-foreground/5 text-foreground/50 dark:bg-white/5">
                <Lock size={13} />
              </div>
              <div>
                <p className="text-xs font-medium text-foreground">
                  {t("notes.structureIntro.personal.title")}
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  {t("notes.structureIntro.personal.description")}
                </p>
              </div>
            </div>
          </div>

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

                <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/40 bg-background/70 px-3 py-2.5">
                  <ChevronRight size={12} className="shrink-0 text-foreground/25" />
                  <Users size={13} className="shrink-0 text-primary/60" />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-foreground/80">
                      {t("notes.structureIntro.teamSpace.title")}
                    </p>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      {t("notes.structureIntro.teamSpace.description")}
                    </p>
                  </div>
                </div>

                <div className="mt-2 flex items-center gap-2 pl-5 text-[11px] text-muted-foreground">
                  <FolderOpen size={12} className="shrink-0" />
                  {t("notes.structureIntro.contents")}
                </div>
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
