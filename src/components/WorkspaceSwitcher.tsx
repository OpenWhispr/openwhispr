import React, { Suspense, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { Check, ChevronsUpDown, Loader2, Plus, UserCircle, UserPlus } from "./icons";
import MemberAvatar from "./MemberAvatar";
import CreateWorkspaceDialog from "./CreateWorkspaceDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { cn } from "./lib/utils";
import { useAuth } from "../hooks/useAuth";
import { useWorkspace } from "../hooks/useWorkspace";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { WorkspacesService } from "../services/WorkspacesService";
import { resolveWorkspaceSwitcher } from "../lib/workspaceSwitcher";
import {
  markWorkspaceIntroSeen,
  shouldShowWorkspaceIntro,
  workspaceIntroKey,
} from "../lib/workspaceIntro";
import { usePolicyStore } from "../stores/policyStore";
import { selectGatedModalOpen, useModalGateStore } from "../stores/modalGateStore";
import { WorkspaceIntroDialog } from "./workspace/WorkspaceIntroDialog";
import type { Workspace } from "../types/electron";

const InviteTeammateDialog = React.lazy(() => import("./InviteTeammateDialog"));

const triggerClass =
  "group flex items-center gap-2.5 w-full h-10 px-2 rounded-md text-start outline-none hover:bg-foreground/4 dark:hover:bg-white/4 active:bg-foreground/6 data-[state=open]:bg-foreground/5 dark:data-[state=open]:bg-white/6 focus-visible:ring-1 focus-visible:ring-primary/30 transition-colors duration-150";
const compactTriggerClass =
  "group flex items-center justify-center w-9 h-9 rounded-md outline-none hover:bg-foreground/4 dark:hover:bg-white/4 active:bg-foreground/6 data-[state=open]:bg-foreground/5 dark:data-[state=open]:bg-white/6 focus-visible:ring-1 focus-visible:ring-primary/30 transition-colors duration-150";
const nameClass = "flex-1 min-w-0 truncate text-sm font-medium text-foreground";
const itemClass = "gap-3 px-2 py-2 text-[13px] rounded-lg";
// Counting members fetches the whole roster, so each workspace's count is reused for a while.
const MEMBER_COUNT_TTL_MS = 5 * 60_000;

interface WorkspaceSwitcherProps {
  /** "settings" is the picker at the top of the Settings nav, so its menu opens below. */
  placement?: "sidebar" | "settings";
  /** Avatar-only trigger, named by aria-label, for the compact Settings rail. */
  compact?: boolean;
  /** Controls the menu from outside, e.g. Settings' "Choose workspace". */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Whether the first-use intro may show; honored for the sidebar placement only. */
  introAllowed?: boolean;
}

export default function WorkspaceSwitcher({
  placement = "sidebar",
  compact = false,
  open,
  onOpenChange,
  introAllowed = false,
}: WorkspaceSwitcherProps = {}): React.ReactElement | null {
  const { t } = useTranslation();
  const { isSignedIn } = useAuth();
  const { workspaces, setActive, refresh } = useWorkspace();
  const { activeWorkspaceId, loaded, loading, error } = useWorkspaceStore(
    useShallow((s) => ({
      activeWorkspaceId: s.activeWorkspaceId,
      loaded: s.loaded,
      loading: s.loading,
      error: s.error,
    }))
  );
  const [createOpen, setCreateOpen] = useState(false);
  // Right after creating a workspace the invite is optional, so it offers Skip.
  const [invite, setInvite] = useState<{ workspace: Workspace; afterCreate: boolean } | null>(null);
  const accountId = usePolicyStore((s) => s.accountId);
  const gatedModalOpen = useModalGateStore(selectGatedModalOpen);
  // Hides the intro once finished even when storage can't remember it, so it can't reopen at once.
  const [finishedIntroKey, setFinishedIntroKey] = useState<string | null>(null);
  const [memberCounts, setMemberCounts] = useState<Record<string, number>>({});
  const memberCountRequestedAt = useRef<Record<string, number>>({});

  const state = resolveWorkspaceSwitcher({
    isSignedIn: Boolean(isSignedIn),
    loaded,
    error,
    workspaces,
    activeWorkspaceId,
  });

  // Derived on every render, so it follows the active workspace, the account and every modal below.
  const introKey =
    accountId && state.kind === "workspace" ? workspaceIntroKey(accountId, state.current.id) : null;
  const showIntro =
    introKey !== null &&
    introKey !== finishedIntroKey &&
    shouldShowWorkspaceIntro({
      storage: localStorage,
      accountId,
      switcher: state,
      // Settings has its own picker, the create → invite chain owns the screen until it ends, and
      // modals that open on their own (joining a workspace, migration) go first.
      blocked:
        placement !== "sidebar" || !introAllowed || createOpen || invite !== null || gatedModalOpen,
    });

  if (state.kind === "hidden") return null;

  if (state.kind === "loading") {
    return (
      <div
        className={cn("flex items-center gap-2.5 h-10 px-2", compact && "justify-center")}
        aria-hidden="true"
      >
        <span className="w-7 h-7 rounded-full bg-foreground/6 dark:bg-white/8 animate-pulse" />
        {!compact && (
          <span className="h-2.5 w-20 rounded bg-foreground/6 dark:bg-white/8 animate-pulse" />
        )}
      </div>
    );
  }

  if (state.kind === "error" && compact) {
    return (
      <button
        type="button"
        onClick={() => void refresh()}
        disabled={loading}
        aria-label={t("settingsPage.workspace.loadError.retry")}
        title={t("settingsPage.workspace.loadError.title")}
        className={cn(compactTriggerClass, "disabled:opacity-60")}
      >
        {loading ? (
          <Loader2 size={14} className="animate-spin text-muted-foreground" />
        ) : (
          <UserCircle size={24} className="text-foreground/50" />
        )}
      </button>
    );
  }

  if (state.kind === "error") {
    return (
      <button
        type="button"
        onClick={() => void refresh()}
        disabled={loading}
        className={cn(triggerClass, "h-auto min-h-10 py-1.5 disabled:opacity-60")}
      >
        {/* Stacked, so long translations wrap instead of truncating beside Retry. */}
        <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-xs leading-snug">
          <span className="text-muted-foreground">
            {t("settingsPage.workspace.loadError.title")}
          </span>
          {loading ? (
            <Loader2 size={12} className="animate-spin text-muted-foreground" />
          ) : (
            <span className="font-medium text-primary">
              {t("settingsPage.workspace.loadError.retry")}
            </span>
          )}
        </span>
      </button>
    );
  }

  const current = state.kind === "workspace" ? state.current : null;
  const currentMemberCount = current ? (memberCounts[current.id] ?? null) : null;

  const triggerLabel = current ? current.name : t("notes.spaces.personal");

  const handleOpenChange = (nextOpen: boolean): void => {
    onOpenChange?.(nextOpen);
    if (!nextOpen || !current) return;
    const workspaceId = current.id;
    const now = Date.now();
    if (now - (memberCountRequestedAt.current[workspaceId] ?? 0) < MEMBER_COUNT_TTL_MS) return;
    memberCountRequestedAt.current[workspaceId] = now;
    WorkspacesService.listMembers(workspaceId).then(
      (members) => setMemberCounts((counts) => ({ ...counts, [workspaceId]: members.length })),
      // The count is decoration; the menu works without it. Ask again on the next open.
      () => {
        delete memberCountRequestedAt.current[workspaceId];
      }
    );
  };

  return (
    <>
      <DropdownMenu modal={false} open={open} onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger
          className={compact ? compactTriggerClass : triggerClass}
          aria-label={compact ? triggerLabel : undefined}
        >
          {current ? (
            <MemberAvatar name={current.name} email={null} />
          ) : (
            <UserCircle size={24} className="w-7 shrink-0 text-foreground/50" />
          )}
          {!compact && (
            <>
              <span dir="auto" className={nameClass}>
                {triggerLabel}
              </span>
              <ChevronsUpDown
                size={14}
                className="shrink-0 text-foreground/45 group-hover:text-foreground/70 transition-colors duration-150"
              />
            </>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={placement === "settings" ? "bottom" : "top"}
          align="start"
          sideOffset={8}
          // Wider than the sidebar, as in the design, so names and the invite button have room.
          className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-60 overflow-y-auto"
        >
          {current && (
            <>
              <div className="flex items-center gap-3 px-2 pt-1.5 pb-2.5">
                <MemberAvatar name={current.name} email={null} />
                <div className="min-w-0">
                  <p dir="auto" className="truncate text-sm font-medium text-foreground">
                    {current.name}
                  </p>
                  {currentMemberCount !== null && (
                    <p className="text-xs text-muted-foreground">
                      {t("workspaces.join.memberCount", { count: currentMemberCount })}
                    </p>
                  )}
                </div>
              </div>
              {/* The last refresh failed, so this is the list from memory or the cache. */}
              {error && (
                <DropdownMenuItem
                  onSelect={(event) => {
                    // Stay open so the spinner, then the refreshed list, shows in place.
                    event.preventDefault();
                    void refresh();
                  }}
                  disabled={loading}
                  className="mx-1 mb-1.5 flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-xs leading-snug"
                >
                  <span className="text-muted-foreground">
                    {t("settingsPage.workspace.staleList")}
                  </span>
                  {loading ? (
                    <Loader2 size={12} className="animate-spin text-muted-foreground" />
                  ) : (
                    <span className="font-medium text-primary">
                      {t("settingsPage.workspace.loadError.retry")}
                    </span>
                  )}
                </DropdownMenuItem>
              )}
              {state.kind === "workspace" && state.canInvite && (
                <DropdownMenuItem
                  onSelect={() => setInvite({ workspace: current, afterCreate: false })}
                  className="mx-1 mb-1.5 justify-center gap-1.5 rounded-lg py-2 text-[13px] text-foreground/80 bg-foreground/5 dark:bg-white/6 focus:bg-foreground/8 dark:focus:bg-white/10"
                >
                  <UserPlus size={14} />
                  {t("workspaces.switcher.invitePeople")}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator className="-mx-1.5 my-1.5" />
            </>
          )}
          {current ? (
            workspaces.map((workspace) => (
              <DropdownMenuItem
                key={workspace.id}
                onSelect={() => setActive(workspace.id)}
                className={itemClass}
              >
                <MemberAvatar name={workspace.name} email={null} />
                <span dir="auto" className="flex-1 min-w-0 truncate">
                  {workspace.name}
                </span>
                {workspace.id === current.id && (
                  <Check size={16} className="shrink-0 text-primary" />
                )}
              </DropdownMenuItem>
            ))
          ) : (
            <DropdownMenuItem className={itemClass} disabled>
              <UserCircle size={24} className="w-7 shrink-0 text-foreground/50" />
              <span className="flex-1">{t("notes.spaces.personal")}</span>
              <Check size={16} className="shrink-0 text-primary" />
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={() => setCreateOpen(true)}
            className={cn(itemClass, "text-muted-foreground focus:text-foreground")}
          >
            <span className="flex w-7 shrink-0 justify-center">
              <Plus size={16} />
            </span>
            {t("workspaces.switcher.add")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {current && (
        <WorkspaceIntroDialog
          open={showIntro}
          workspaceId={current.id}
          workspaceName={current.name}
          onFinish={(workspaceId) => {
            if (!accountId) return;
            markWorkspaceIntroSeen(localStorage, accountId, workspaceId);
            setFinishedIntroKey(workspaceIntroKey(accountId, workspaceId));
          }}
        />
      )}
      <CreateWorkspaceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(workspaceId) => {
          const created = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId);
          if (created) setInvite({ workspace: created, afterCreate: true });
        }}
      />
      {invite && (
        <Suspense fallback={null}>
          <InviteTeammateDialog
            open
            onOpenChange={(open) => {
              if (!open) setInvite(null);
            }}
            workspaceId={invite.workspace.id}
            workspaceName={invite.workspace.name}
            cancelLabel={invite.afterCreate ? t("common.skip") : undefined}
          />
        </Suspense>
      )}
    </>
  );
}
