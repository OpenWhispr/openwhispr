import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Users } from "../icons";
import { cn } from "../lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { workspaceCan } from "../../lib/capabilities";
import { isolate } from "../../utils/bidiIsolate";
import type { Workspace } from "../../types/electron";

export interface TeamPaywallDialogProps {
  workspace: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Two equal capsules, as the other workspace dialogs' footers.
const BUTTON_BASE =
  "flex h-10 w-full items-center justify-center rounded-full px-4 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";
const PRIMARY_BUTTON = cn(BUTTON_BASE, "bg-primary text-primary-foreground hover:bg-primary/90");
const SECONDARY_BUTTON = cn(
  BUTTON_BASE,
  "bg-surface-1 text-muted-foreground hover:bg-surface-3 hover:text-foreground"
);

/**
 * What a workspace below Business sees when it tries to create a team. It never reads a plan
 * name: `manage_billing` says who can buy, and everyone else is told who to ask.
 */
export default function TeamPaywallDialog({
  workspace,
  open,
  onOpenChange,
}: TeamPaywallDialogProps): ReactElement {
  const { t } = useTranslation();
  const canUpgrade = workspaceCan(workspace, "manage_billing");
  const owner = workspace.billing_manager;

  // A named section remounts Settings, so this also works from inside Settings.
  const handleUpgrade = (): void => {
    onOpenChange(false);
    void window.electronAPI?.openSettingsSection?.("plansBilling");
  };

  const body = canUpgrade
    ? t("settingsPage.workspace.teams.paywall.body")
    : owner
      ? t("settingsPage.workspace.teams.paywall.bodyAskOwner", { owner: isolate(owner) })
      : t("settingsPage.workspace.teams.paywall.bodyAskOwnerUnknown");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideCloseButton
        className="w-[320px] max-w-[calc(100vw-32px)] grid-cols-1 items-stretch gap-5 rounded-[28px] p-5 sm:max-w-[320px]"
      >
        <DialogHeader className="items-center gap-3 space-y-0 text-center sm:text-center">
          <div className="flex size-[42px] items-center justify-center rounded-full bg-surface-3 text-foreground">
            <Users className="size-3.5" aria-hidden="true" />
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <DialogTitle className="text-lg font-medium tracking-normal leading-snug">
              {t("settingsPage.workspace.teams.paywall.title")}
            </DialogTitle>
            <DialogDescription className="text-sm leading-normal">{body}</DialogDescription>
          </div>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {canUpgrade ? (
            <>
              <button type="button" onClick={handleUpgrade} className={PRIMARY_BUTTON}>
                {t("settingsPage.workspace.teams.paywall.upgrade")}
              </button>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className={SECONDARY_BUTTON}
              >
                {t("settingsPage.workspace.teams.paywall.notNow")}
              </button>
            </>
          ) : (
            <button type="button" onClick={() => onOpenChange(false)} className={SECONDARY_BUTTON}>
              {t("common.close")}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
