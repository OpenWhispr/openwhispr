import React, { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Check, ChevronsUpDown, UserCircle } from "../../icons";
import MemberAvatar from "../../MemberAvatar";
import { RetryMenuItem } from "../../WorkspaceSwitcher";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { useAuth } from "../../../hooks/useAuth";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { withDefaultFirst } from "../../../lib/workspaceSwitcher";
import type { PlansBillingRequest } from "../../../lib/settingsNav";

interface PlansBillingPickerProps {
  request: PlansBillingRequest;
  onChange: (request: PlansBillingRequest) => void;
  personalPlanLabel: string | null;
}

const triggerClass =
  "group inline-flex max-w-full items-center gap-2 h-8 px-2 rounded-md text-start outline-none hover:bg-foreground/4 dark:hover:bg-white/4 active:bg-foreground/6 data-[state=open]:bg-foreground/5 dark:data-[state=open]:bg-white/6 focus-visible:ring-1 focus-visible:ring-primary/30 transition-colors duration-150";
const itemClass = "gap-3 px-2 py-2 text-[13px] rounded-lg";
const badgeClass = "shrink-0 text-[11px] text-muted-foreground";

/** Chooses which plan the page shows. Only the view changes, never the active workspace. */
export function PlansBillingPicker({
  request,
  onChange,
  personalPlanLabel,
}: PlansBillingPickerProps): React.ReactElement {
  const { t } = useTranslation();
  const { isSignedIn, isOfflineAccount } = useAuth();
  const { workspaces, defaultWorkspaceId, loaded, loading, error, refresh } = useWorkspaceStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      defaultWorkspaceId: s.defaultWorkspaceId,
      loaded: s.loaded,
      loading: s.loading,
      error: s.error,
      refresh: s.refresh,
    }))
  );
  useEffect(() => {
    if (isSignedIn && !isOfflineAccount && !loaded) void refresh();
  }, [isSignedIn, isOfflineAccount, loaded, refresh]);

  const viewedId = request.kind === "workspace" ? request.workspaceId : null;
  const viewed = viewedId ? (workspaces.find((w) => w.id === viewedId) ?? null) : null;
  const listed = withDefaultFirst(workspaces, defaultWorkspaceId);
  const planBadge = (plan: string): string =>
    t(`settingsPage.workspace.billing.planLabel.${plan}`, { defaultValue: plan });

  return (
    <div className="flex items-center gap-2">
      <span className="shrink-0 text-xs text-muted-foreground">
        {t("settingsPage.billing.picker.label")}
      </span>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger className={triggerClass}>
          {request.kind === "personal" ? (
            <>
              <UserCircle size={18} className="shrink-0 text-foreground/50" />
              <span className="truncate text-sm font-medium text-foreground">
                {t("settingsPage.billing.picker.personal")}
              </span>
            </>
          ) : viewed ? (
            <>
              <MemberAvatar name={viewed.name} email={null} image={viewed.icon_url} size="sm" />
              <span dir="auto" className="truncate text-sm font-medium text-foreground">
                {viewed.name}
              </span>
            </>
          ) : loaded ? (
            // Listed without the requested workspace (a failed list): nothing to name, nothing to wait for.
            <span className="truncate text-sm font-medium text-foreground">
              {t("settingsPage.billing.picker.workspaces")}
            </span>
          ) : (
            <span
              className="h-2.5 w-20 rounded bg-foreground/6 dark:bg-white/8 animate-pulse"
              aria-hidden="true"
            />
          )}
          <ChevronsUpDown
            size={14}
            className="shrink-0 text-foreground/45 group-hover:text-foreground/70 transition-colors duration-150"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="bottom"
          align="start"
          sideOffset={6}
          className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-64 overflow-y-auto"
        >
          <DropdownMenuItem onSelect={() => onChange({ kind: "personal" })} className={itemClass}>
            <span className="flex w-7 shrink-0 justify-center">
              <UserCircle size={18} className="text-foreground/50" />
            </span>
            <span className="flex-1 min-w-0 truncate">
              {t("settingsPage.billing.picker.personal")}
            </span>
            {personalPlanLabel && <span className={badgeClass}>{personalPlanLabel}</span>}
            {request.kind === "personal" && <Check size={16} className="shrink-0 text-primary" />}
          </DropdownMenuItem>
          <DropdownMenuSeparator className="-mx-1.5 my-1.5" />
          <DropdownMenuLabel className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
            {t("settingsPage.billing.picker.workspaces")}
          </DropdownMenuLabel>
          {error && (
            <RetryMenuItem
              message={t("settingsPage.billing.picker.loadFailed")}
              loading={loading}
              onRetry={() => void refresh()}
            />
          )}
          {!loaded ? (
            <div
              data-billing-picker-skeleton=""
              className="flex items-center gap-3 px-2 py-2"
              aria-hidden="true"
            >
              <span className="w-7 h-7 rounded-full bg-foreground/6 dark:bg-white/8 animate-pulse" />
              <span className="h-2.5 w-24 rounded bg-foreground/6 dark:bg-white/8 animate-pulse" />
            </div>
          ) : (
            listed.map((workspace) => (
              <DropdownMenuItem
                key={workspace.id}
                onSelect={() => onChange({ kind: "workspace", workspaceId: workspace.id })}
                className={itemClass}
              >
                <MemberAvatar name={workspace.name} email={null} image={workspace.icon_url} />
                <span dir="auto" className="flex-1 min-w-0 truncate">
                  {workspace.name}
                </span>
                <span className={badgeClass}>{planBadge(workspace.plan)}</span>
                {workspace.id === viewedId && <Check size={16} className="shrink-0 text-primary" />}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
