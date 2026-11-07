import { useRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Copy, FolderOpen, MoreHorizontal, Trash2 } from "../icons";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { useToast } from "../ui/useToast";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { refreshSkills } from "../../stores/skillsStore";
import { getCachedPlatform, showInFolderLabelKey } from "../../utils/platform";
import type { SkillSummary } from "../../types/skills";

// A row's ⋯ menu items, as ConversationItem's.
const ITEM_CLASS = "text-xs gap-2 rounded-lg px-2.5 py-1.5 cursor-pointer focus:bg-foreground/5";

interface SkillActionsMenuProps {
  skill: SkillSummary;
  /** The SKILL.md the pop-up already holds, so Copy markdown needn't read the skill again. */
  markdown?: string;
  /** Adds Uninstall, which Manage shows and the detail pop-up keeps in its footer. */
  onUninstall?: () => void;
}

export function SkillActionsMenu({
  skill,
  markdown,
  onUninstall,
}: SkillActionsMenuProps): ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { copyText } = useCopyFeedback("");
  const trigger = useRef<HTMLButtonElement>(null);
  // The pop-up Uninstall opens returns focus to what had it. The open menu keeps focus inside,
  // and the item goes away with it, so the pop-up opens once the menu has closed, with focus
  // on the menu's button.
  const uninstallPicked = useRef(false);

  // Copies SKILL.md exactly as it's stored, so it pastes into another app unchanged.
  const copyMarkdown = async () => {
    const text =
      markdown ?? (await window.electronAPI?.skillsGet?.(skill.name)?.catch(() => null))?.markdown;
    const copied = text !== undefined ? await copyText(text) : false;
    toast(
      copied
        ? { title: t("skills.toasts.copiedMarkdown"), variant: "success" }
        : { title: t("skills.toasts.copyFailed"), variant: "destructive" }
    );
  };

  // The folder can be gone, moved or deleted outside the app, so the list is read again.
  const reveal = async () => {
    const result = await window.electronAPI?.skillsReveal?.(skill.name)?.catch(() => null);
    if (result?.ok) return;
    toast({ title: t("skills.toasts.revealFailed"), variant: "destructive" });
    void refreshSkills();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          ref={trigger}
          variant="ghost"
          size="sm"
          aria-label={t("skills.detail.more", { name: skill.displayName })}
          className="h-7 w-7 px-0 rounded-full text-muted-foreground/70 hover:text-foreground"
        >
          <MoreHorizontal size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={4}
        className="min-w-44"
        onCloseAutoFocus={(event) => {
          if (!uninstallPicked.current) return;
          uninstallPicked.current = false;
          event.preventDefault();
          trigger.current?.focus();
          onUninstall?.();
        }}
      >
        <DropdownMenuItem onSelect={() => void reveal()} className={ITEM_CLASS}>
          <FolderOpen size={12} className="text-muted-foreground/80" />
          {t(showInFolderLabelKey(getCachedPlatform()))}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void copyMarkdown()} className={ITEM_CLASS}>
          <Copy size={12} className="text-muted-foreground/80" />
          {t("skills.menu.copyMarkdown")}
        </DropdownMenuItem>
        {onUninstall && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                uninstallPicked.current = true;
              }}
              className="text-xs gap-2 rounded-lg px-2.5 py-1.5 text-destructive focus:text-destructive focus:bg-destructive/10 cursor-pointer"
            >
              <Trash2 size={12} />
              {t("skills.menu.uninstall")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
