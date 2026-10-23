import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, Code2, Copy, FileText, MessageSquare, Trash2 } from "../icons";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { MarkdownRenderer } from "../ui/MarkdownRenderer";
import { SectionLabel, SettingsPanel } from "../ui/SettingsSection";
import { Toggle } from "../ui/toggle";
import { useToast } from "../ui/useToast";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { refreshSkills, setSkillEnabled, useSkillsStore } from "../../stores/skillsStore";
import { useCloudBackupActive } from "../../hooks/useCloudBackupActive";
import { syncAfterLocalWrite } from "../../services/syncAfterLocalWrite";
import type { SkillDetail, SkillFileInfo } from "../../types/skills";
import { SkillActionsMenu } from "./SkillActionsMenu";
import { SkillTile } from "./SkillCards";
import { problemKey, writeFailedToast } from "./skillCopy";

function SkillFileRow({
  skillName,
  file,
}: {
  skillName: string;
  file: SkillFileInfo;
}): ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { copied, copyText, confirmCopied } = useCopyFeedback("");

  const copy = async () => {
    const result = await window.electronAPI?.skillsReadFile?.(skillName, file.path);
    if (result && (await copyText(result.text))) confirmCopied(result.text);
    else toast({ title: t("skills.toasts.copyFailed"), variant: "destructive" });
  };

  const Icon = file.script ? Code2 : FileText;
  return (
    <div className="flex items-center gap-2.5 px-3 py-2">
      <Icon size={14} className="shrink-0 text-muted-foreground/70" />
      <span dir="ltr" className="flex-1 min-w-0 truncate font-mono text-xs text-foreground">
        {file.path}
      </span>
      {file.script && (
        <span className="text-[10px] text-muted-foreground/70">{t("skills.detail.neverRun")}</span>
      )}
      {file.text && (
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={
            copied ? t("common.copied") : t("skills.detail.copyFile", { path: file.path })
          }
          className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground/70 hover:text-muted-foreground hover:bg-muted/50 active:scale-95 transition-all"
        >
          {copied ? (
            <Check className="w-3.5 h-3.5 text-success" />
          ) : (
            <Copy className="w-3.5 h-3.5" />
          )}
        </button>
      )}
    </div>
  );
}

interface SkillDetailDialogProps {
  name: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens on the Uninstall confirmation, as Manage's menu does. */
  initialConfirmUninstall?: boolean;
  /** Where focus goes when the control that opened the pop-up is gone, as after an uninstall. */
  focusFallback?: () => void;
  /** Opens a new chat with this skill; absent where the assistant isn't allowed. */
  onTryNow?: (skill: { name: string; displayName: string }) => void;
}

/** The one pop-up of the Skills page: a skill's instructions, files and switch. */
export function SkillDetailDialog({
  name,
  open,
  onOpenChange,
  initialConfirmUninstall = false,
  focusFallback,
  onTryNow,
}: SkillDetailDialogProps): ReactElement {
  const { t } = useTranslation();
  const backedUp = useCloudBackupActive();
  const { toast } = useToast();
  const summary = useSkillsStore((state) => state.skills.find((skill) => skill.name === name));
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  // Null follows initialConfirmUninstall; reset whenever the pop-up closes.
  const [confirmChoice, setConfirmChoice] = useState<boolean | null>(null);
  const confirming = confirmChoice ?? initialConfirmUninstall;
  // Opened on its confirm, as Manage's ⋯ Uninstall does: backing out returns to Manage.
  const openedToUninstall = confirmChoice === null && initialConfirmUninstall;
  const cancelRef = useRef<HTMLButtonElement>(null);
  const uninstallRef = useRef<HTMLButtonElement>(null);
  const uninstalled = useRef(false);
  const uninstalling = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  // The dialog keeps the Escape handler it first rendered with, so the handler reads this;
  // the read below closes the pop-up through the latest onOpenChange the same way.
  const confirmingNow = useRef(confirming);
  const openedToUninstallNow = useRef(openedToUninstall);
  const onOpenChangeNow = useRef(onOpenChange);
  useLayoutEffect(() => {
    confirmingNow.current = confirming;
    openedToUninstallNow.current = openedToUninstall;
    onOpenChangeNow.current = onOpenChange;
  });
  // A read is shown only for the skill it was made for, never for the next one opened.
  const shown = detail?.name === name ? detail : null;
  // The list's copy stays live, but a read that couldn't get at the files marks it for fixing.
  const skill =
    summary && shown && !shown.valid
      ? { ...summary, valid: false, problem: shown.problem }
      : (summary ?? shown);
  const problem = skill && !skill.valid ? skill.problem : undefined;

  // Reread on open, and when the skill changes on disk while it's open. A skill that is
  // gone, as when it was removed outside the app, closes the pop-up.
  useEffect(() => {
    if (!open || !name) return;
    let current = true;
    void window.electronAPI
      ?.skillsGet?.(name)
      .then((result) => {
        if (!current) return;
        setDetail(result ?? null);
        if (result) return;
        setConfirmChoice(null);
        onOpenChangeNow.current(false);
      })
      .catch(() => {
        if (current) setDetail(null);
      });
    return () => {
      current = false;
    };
  }, [open, name, summary?.updatedAt]);

  // Asking moves focus to Cancel; cancelling moves it back to Uninstall.
  useEffect(() => {
    if (confirmChoice === true) cancelRef.current?.focus();
    if (confirmChoice === false) uninstallRef.current?.focus();
  }, [confirmChoice]);

  const close = () => {
    setConfirmChoice(null);
    onOpenChange(false);
  };

  const switchSkill = async (skillName: string, next: boolean) => {
    if (!(await setSkillEnabled(skillName, next))) toast(writeFailedToast(t));
  };

  // A second press while the uninstall runs would uninstall and toast twice.
  const uninstall = async () => {
    if (!name || uninstalling.current) return;
    uninstalling.current = true;
    try {
      const result = await window.electronAPI?.skillsUninstall?.(name);
      if (!result?.ok) {
        toast(writeFailedToast(t, result && "error" in result ? result.error : undefined));
        return;
      }
      uninstalled.current = true;
      syncAfterLocalWrite("syncSkillsNow");
      close();
      toast({
        title: t("skills.toasts.uninstalled", { name: skill?.displayName }),
        description: t("skills.toasts.removedFromComputer"),
        variant: "success",
      });
      void refreshSkills();
    } finally {
      uninstalling.current = false;
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent
        className="max-w-xl max-h-[calc(100%-48px)] grid-rows-[auto_auto_minmax(0,1fr)_auto]"
        onOpenAutoFocus={(event) => {
          // Opened by state rather than a trigger, so the opener is remembered here.
          opener.current = document.activeElement as HTMLElement | null;
          if (!confirming) return;
          event.preventDefault();
          cancelRef.current?.focus();
        }}
        onEscapeKeyDown={(event) => {
          if (!confirmingNow.current || openedToUninstallNow.current) return;
          event.preventDefault();
          setConfirmChoice(false);
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const back = uninstalled.current ? null : opener.current;
          uninstalled.current = false;
          // The page itself had focus when the button that opened it went away.
          if (back?.isConnected && back !== document.body) back.focus();
          else focusFallback?.();
        }}
      >
        {skill && name && (
          <>
            <div className="flex items-center gap-2 pe-8">
              <SkillTile
                name={name}
                on={skill.enabled && skill.valid}
                className="w-10 h-10 rounded-xl"
                iconSize={20}
              />
              <div className="flex-1" />
              <Toggle
                checked={skill.enabled && skill.valid}
                onChange={(next) => void switchSkill(name, next)}
                disabled={!skill.valid}
                ariaLabel={t("skills.detail.toggle", { name: skill.displayName })}
              />
              <SkillActionsMenu skill={skill} markdown={shown?.markdown} />
            </div>
            <div className="flex flex-col space-y-1.5 text-start">
              <DialogTitle>
                <span dir="auto">{skill.displayName}</span>{" "}
                <span className="ms-1 align-middle text-xs font-normal tracking-normal text-muted-foreground">
                  {t("skills.detail.skillLabel")}
                </span>
              </DialogTitle>
              <DialogDescription dir="auto">{skill.description}</DialogDescription>
            </div>
            <div className="min-h-0 overflow-y-auto space-y-4 -mx-1 px-1">
              {problem && (
                <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 dark:bg-warning/10 px-3.5 py-2 text-xs text-foreground/85 leading-relaxed">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
                  <p>
                    {t("skills.detail.problem", {
                      reason: t(problemKey(problem), problem.values),
                    })}
                  </p>
                </div>
              )}
              {/* A read that found nothing, as for a skill whose files can't be read, has no box. */}
              {shown?.markdown && (
                <div className="rounded-lg border border-border/70 dark:border-border-subtle/70 bg-background/60 dark:bg-surface-1/60 px-4 py-3">
                  <MarkdownRenderer
                    hideFrontmatter
                    content={shown.markdown}
                    className="text-[13px] leading-relaxed text-foreground [&_p]:text-[13px] [&_li]:text-[13px]"
                  />
                </div>
              )}
              {shown && shown.files.length > 0 && (
                <div>
                  <SectionLabel>{t("skills.detail.files")}</SectionLabel>
                  <SettingsPanel>
                    {shown.files.map((file) => (
                      <SkillFileRow key={file.path} skillName={name} file={file} />
                    ))}
                  </SettingsPanel>
                </div>
              )}
            </div>
            {confirming ? (
              <div
                role="alert"
                className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/25 bg-destructive/5 dark:bg-destructive/10 ps-3.5 pe-2 py-2"
              >
                <p className="flex-1 basis-56 min-w-0 text-xs text-foreground/85 leading-relaxed">
                  {t(
                    backedUp
                      ? "skills.detail.uninstallConfirmSynced"
                      : "skills.detail.uninstallConfirm",
                    { name: skill.displayName }
                  )}
                </p>
                <Button
                  ref={cancelRef}
                  variant="ghost"
                  size="sm"
                  onClick={() => (openedToUninstall ? close() : setConfirmChoice(false))}
                >
                  {t("common.cancel")}
                </Button>
                <Button variant="destructive" size="sm" onClick={() => void uninstall()}>
                  {t("skills.detail.uninstall")}
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <Button
                  ref={uninstallRef}
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmChoice(true)}
                  className="-ms-2 text-destructive hover:bg-destructive/10 dark:text-destructive dark:hover:bg-destructive/10"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("skills.detail.uninstall")}
                </Button>
                {/* A chat can't use a skill that is off or needs fixing. */}
                {onTryNow && skill.enabled && skill.valid && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onTryNow({ name, displayName: skill.displayName })}
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                    {t("skills.detail.tryNow")}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
